#!/usr/bin/env node
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple, getModel, getProviders } from "@earendil-works/pi-ai/compat";
import { tools } from "./tools/index.ts";

const PROVIDER = "xiaomi-token-plan-ams";
const MODEL_ID = "mimo-v2.5";

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

const model = getModel(PROVIDER, MODEL_ID);
if (!model) {
	console.error(`Model not found: ${PROVIDER}/${MODEL_ID}`);
	console.error("Available providers:", getProviders().map((p) => p.id).join(", "));
	const all = (await import("@earendil-works/pi-ai/compat")).getModels();
	console.error("Available models:", all.map((m) => `${m.provider}/${m.id}`).join(", "));
	process.exit(1);
}

const apiKey = process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY;
if (!apiKey) {
	console.error("Missing XIAOMI_TOKEN_PLAN_AMS_API_KEY environment variable.");
	console.error("Get one at https://xiaomimimo.com and export it:");
	console.error("  export XIAOMI_TOKEN_PLAN_AMS_API_KEY='your-key'");
	process.exit(1);
}

const agent = new Agent({
	streamFn: streamSimple,
	getApiKey: (provider) => {
		if (provider === "xiaomi-token-plan-ams") return apiKey;
		return process.env[`${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`];
	},
	initialState: {
		systemPrompt: SYSTEM_PROMPT,
		model,
		tools,
	},
});

let printedLength = 0;

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
				process.stdout.write("\n");
				printedLength = 0;
			}
			break;
		}
	}
});

const rl = readline.createInterface({ input: stdin, output: stdout, prompt: "" });

console.log(`sgagent — MiMo coding agent (${PROVIDER}/${MODEL_ID})`);
console.log("Type 'exit' to quit.\n");

while (true) {
	const input = await rl.question("> ").catch(() => null);
	if (input === null) break;
	const trimmed = input.trim();
	if (!trimmed) continue;
	if (trimmed === "exit" || trimmed === "quit") break;

	printedLength = 0;
	try {
		await agent.prompt(trimmed);
	} catch (error: any) {
		console.error(`\n[error] ${error.message ?? error}`);
	}
	console.log();
}

rl.close();
process.exit(0);
