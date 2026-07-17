#!/usr/bin/env node
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AgentHarness, JsonlSessionRepo, type Session } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import { streamSimple as compatStreamSimple, type Model } from "@earendil-works/pi-ai/compat";
import { NodeExecutionEnv } from "./agent/harness/env/nodejs.ts";
import { tools } from "./tools/index.ts";
import { beginLoop, saveToolTrace } from "./ai/utils/trace.ts";

// Load `.env` next to this file if present (Node 20.12+). Ignored if missing or unreadable.
try {
	process.loadEnvFile();
} catch {}

// OpenAI-compatible endpoint config. Defaults mirror a reasoning model
// (mimo-v2.5); point BASE_URL at any OpenAI-compatible backend.
const BASE_URL = process.env.BASE_URL ?? "https://api.xiaomimimo.com/v1";
const MODEL_ID = process.env.MODEL_ID ?? "mimo-v2.5";
// REASONING declares whether the model supports thinking (deepseek format:
// thinking param + reasoning_content). Set false for non-reasoning models.
const REASONING_RAW = (process.env.REASONING ?? "true").trim().toLowerCase();
const REASONING = !["false", "0", "no", "off"].includes(REASONING_RAW);
const CONTEXT_WINDOW = Number(process.env.CONTEXT_WINDOW ?? 1048576);
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 131072);

const SYSTEM_PROMPT = `You are a coding assistant running in a terminal. You can read, write, and edit files, run shell commands, and search code.

Available tools:
- read: Read a file (truncated to 2000 lines)
- write: Create or overwrite a file
- edit: Replace a unique string in a file
- bash: Execute a shell command (30s timeout)
- grep: Search file contents by regex
- ls: List directory contents
- find: Find files by name pattern

Always explore before acting: use ls/grep/read to understand the codebase before making changes. Prefer edit over write for modifying existing files.`;

const model: Model<"openai-completions"> = {
	id: MODEL_ID,
	name: MODEL_ID,
	api: "openai-completions",
	provider: "openai-compatible",
	baseUrl: BASE_URL,
	reasoning: REASONING,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: CONTEXT_WINDOW,
	maxTokens: MAX_TOKENS,
};

const apiKey = process.env.API_KEY;
if (!apiKey) {
	console.error("Missing API_KEY environment variable.");
	console.error("Put it in .env:  API_KEY=your-key");
	process.exit(1);
}

// harness 内部 FS/Shell 抽象：给 session repo 当 fs 用，也供 harness 自身
// （skills/templates 加载、compaction file-ops）。本 CLI 不传 skills、不开 compaction，
// 所以这里主要让 JsonlSessionRepo 能在 .sessions/ 下读写 jsonl。
const env = new NodeExecutionEnv({ cwd: process.cwd() });

// 精简版 Models 接口（src/ai/models.ts：只要 streamSimple + completeSimple）。
// streamSimple 转调现有 compat 层，apiKey 走 process.env.API_KEY（同裸 Agent 时一致）。
// completeSimple 是 compaction/分支摘要的非流式入口——本次不开 compaction 不会被调用，
// 用 streamSimple 跑完取最终消息做兜底即可。
const models: Models = {
	streamSimple: (m, context, options) => compatStreamSimple(m, context, options),
	completeSimple: async (m, context, options) => compatStreamSimple(m, context, options).result(),
};

// 会话持久化：每个 cwd 的历史落到 .sessions/<encodeCwd(cwd)>/<ts>_<id>.jsonl，
// harness 在每条 message_end 后自动追加（session.appendMessage），无需手动 save。
const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: ".sessions" });

let printedLength = 0;

// Per-turn usage accumulator. Listeners are awaited (agent.ts), so this is
// fully settled before harness.prompt() resolves — safe to read the total after.
let turnUsage = { input: 0, output: 0, cacheRead: 0, calls: 0 };

function fmtTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

// 取一条消息里的纯文本（text blocks 拼接）。工具结果/纯工具调用/纯思考会返回空 → 回显跳过。
function messageText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.filter(
				(b): b is { type: "text"; text: string } =>
					typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
			)
			.map((b) => b.text || "")
			.join("\n")
			.trim();
	}
	return "";
}

// 截断长文本，避免历史回显刷屏。保留结尾（最近的内容对"接着聊"最有用），省略开头。
function clip(s: string, max = 2000): string {
	if (s.length <= max) return s;
	const tail = s.slice(s.length - max).trimStart();
	return `…(共 ${s.length} 字，前略) ${tail}`;
}

// 单行预览：折叠空白、超长截断（取开头作为主题，用于会话列表）。
function oneLinePreview(s: string, max = 70): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// 取会话里第一条用户提问的文本。用 getEntries 而非 buildContext：
// 即便发生过 compaction，也能拿到最初的那个问题（buildContext 可能把早期消息替换成摘要）。
async function firstUserQuestion(session: Session): Promise<string> {
	const entries = await session.getEntries();
	for (const e of entries) {
		if (e.type !== "message") continue;
		const msg = e.message as { role: string; content: unknown };
		if (msg.role === "user") {
			const t = messageText(msg.content);
			if (t) return t;
		}
	}
	return "";
}

// 恢复历史会话后，把之前的对话主线（用户提问 / 模型文本回复）回显到终端，
// 这样接着聊时能看到上下文。新建会话时 messages 为空，什么都不打印。
async function printHistory(session: Session): Promise<void> {
	const { messages } = await session.buildContext();
	const lines: string[] = [];
	for (const m of messages) {
		const t = messageText((m as { content: unknown }).content);
		if (!t) continue;
		lines.push(m.role === "assistant" ? `🤖 ${clip(t)}` : `🧑 ${clip(t)}`);
	}
	if (lines.length === 0) return;
	console.log(`─── 历史对话（${lines.length} 条，仅显示文本主线）───`);
	for (const l of lines) console.log(l);
	console.log("─── 接着聊（exit 退出）───\n");
}

// Tool-execution timing: args arrive on tool_execution_start, the result on
// tool_execution_end — stitch them together here, keyed by toolCallId.
const toolPending = new Map<string, { start: number; args: unknown }>();

const rl = readline.createInterface({ input: stdin, output: stdout, prompt: "" });

// 启动时让用户选择继续哪条历史会话，或新建。按 createdAt 降序列出该 cwd 的会话。
async function pickSession(): Promise<Session> {
	const cwd = process.cwd();
	const list = await repo.list({ cwd });
	if (list.length === 0) {
		console.log("（无历史会话，新建）\n");
		return repo.create({ cwd });
	}
	console.log("历史会话（该目录，按时间倒序）：");
	for (let i = 0; i < list.length; i++) {
		const m = list[i];
		const d = new Date(m.createdAt);
		const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		const sess = await repo.open(m);
		const q = oneLinePreview(await firstUserQuestion(sess));
		console.log(`  [${i + 1}] ${stamp}  ·  ${q || "(无文本内容)"}`);
	}
	console.log("  [0] 新建会话");
	while (true) {
		const ans = await rl.question(`选择 [0-${list.length}]: `).catch(() => null);
		if (ans === null) process.exit(0);
		const trimmed = ans.trim();
		const n = Number(trimmed);
		if (trimmed === "0") return repo.create({ cwd });
		if (Number.isInteger(n) && n >= 1 && n <= list.length) return repo.open(list[n - 1]);
		console.log("无效选择，请重试。");
	}
}

const session = await pickSession();
await printHistory(session);

const harness = new AgentHarness({
	env,
	session,
	models,
	model,
	tools,
	systemPrompt: SYSTEM_PROMPT,
});

harness.subscribe(async (event) => {
	switch (event.type) {
		case "tool_execution_start": {
			toolPending.set(event.toolCallId, { start: Date.now(), args: event.args });
			const args = JSON.stringify(event.args);
			const preview = args.length > 200 ? `${args.slice(0, 200)}...` : args;
			process.stdout.write(`\n  [${event.toolName}] ${preview}\n`);
			break;
		}
		case "tool_execution_end": {
			const pending = toolPending.get(event.toolCallId);
			toolPending.delete(event.toolCallId);
			saveToolTrace({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: pending?.args,
				result: event.result,
				isError: event.isError,
				durationMs: pending ? Date.now() - pending.start : 0,
			});
			if (event.isError) {
				process.stdout.write(`  [${event.toolName}] ✗ error\n`);
			}
			break;
		}
		case "message_update": {
			if (event.message.role === "assistant") {
				for (const block of event.message.content) {
					if (block.type === "text") {
						if (block.text.length > printedLength) {
							process.stdout.write(block.text.slice(printedLength));
							printedLength = block.text.length;
						}
					} else if (block.type === "thinking" && block.thinking) {
						if (block.thinking.length > printedLength) {
							process.stdout.write(block.thinking.slice(printedLength));
							printedLength = block.thinking.length;
						}
					}
				}
			}
			break;
		}
		case "message_end": {
			if (event.message.role === "assistant") {
				const u = event.message.usage;
				turnUsage.input += u.input;
				turnUsage.output += u.output;
				turnUsage.cacheRead += u.cacheRead;
				turnUsage.calls += 1;
				if (event.message.stopReason === "error" && event.message.errorMessage) {
					process.stderr.write(`\n[error] ${event.message.errorMessage}\n`);
				} else {
					process.stdout.write(
						`\n  [usage] in ${fmtTokens(u.input + u.cacheRead)} · cache ${fmtTokens(u.cacheRead)} · out ${fmtTokens(u.output)}\n`,
					);
				}
				printedLength = 0;
			}
			break;
		}
	}
});

console.log(`sgagent — OpenAI-compatible coding agent (${MODEL_ID} @ ${BASE_URL})`);
console.log("Type 'exit' to quit.\n");

while (true) {
	const input = await rl.question("> ").catch(() => null);
	if (input === null) break;
	const trimmed = input.trim();
	if (!trimmed) continue;
	if (trimmed === "exit" || trimmed === "quit") break;

	printedLength = 0;
	turnUsage = { input: 0, output: 0, cacheRead: 0, calls: 0 };
	const loopId = beginLoop();
	try {
		await harness.prompt(trimmed);
	} catch (error: any) {
		console.error(`\n[error] ${error.message ?? error}`);
	}
	if (turnUsage.calls > 0) {
		const t = turnUsage;
		process.stdout.write(
			`  [total] in ${fmtTokens(t.input + t.cacheRead)} · cache ${fmtTokens(t.cacheRead)} · out ${fmtTokens(t.output)}  (${t.calls} call${t.calls > 1 ? "s" : ""} · loop ${loopId})\n`,
		);
	}
	console.log();
}

rl.close();
process.exit(0);
