#!/usr/bin/env node
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple, type Model } from "@earendil-works/pi-ai/compat";
import { tools } from "./tools/index.ts";
import { beginLoop } from "./ai/utils/trace.ts";

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

const agent = new Agent({
	streamFn: streamSimple,
	getApiKey: () => apiKey,
	initialState: {
		systemPrompt: SYSTEM_PROMPT,
		model,
		tools,
	},
});

let printedLength = 0;

// Per-turn usage accumulator. Listeners are awaited (agent.ts), so this is
// fully settled before agent.prompt() resolves — safe to read the total after.
let turnUsage = { input: 0, output: 0, cacheRead: 0, calls: 0 };

function fmtTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

agent.subscribe(async (event) => {
	switch (event.type) {
		case "tool_execution_start": {
			const args = JSON.stringify(event.args);
			const preview = args.length > 200 ? `${args.slice(0, 200)}...` : args;
			process.stdout.write(`\n  [${event.toolName}] ${preview}\n`);
			break;
		}
		case "tool_execution_end": {
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

const rl = readline.createInterface({ input: stdin, output: stdout, prompt: "" });

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
		await agent.prompt(trimmed);
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
