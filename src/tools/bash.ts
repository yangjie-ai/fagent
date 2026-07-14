import { execSync } from "node:child_process";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const MAX_BUFFER = 10 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

const schema = Type.Object({
	command: Type.String({ description: "The shell command to execute" }),
});

export const bashTool: AgentTool<typeof schema> = {
	name: "bash",
	label: "Bash",
	description: `Execute a shell command and return combined stdout+stderr. Timeout ${TIMEOUT_MS / 1000}s. Use for running tests, builds, git, etc.`,
	parameters: schema,
	execute: async (_toolCallId, params: Static<typeof schema>) => {
		try {
			const output = execSync(params.command, {
				encoding: "utf-8",
				timeout: TIMEOUT_MS,
				maxBuffer: MAX_BUFFER,
				stdio: ["pipe", "pipe", "pipe"],
			});
			return {
				content: [{ type: "text", text: output || "(no output)" }],
				details: { command: params.command, exitCode: 0 },
			};
		} catch (error: any) {
			const stdout = error.stdout ?? "";
			const stderr = error.stderr ?? error.message ?? "";
			return {
				content: [{ type: "text", text: `${stdout}${stderr}`.trim() || `(error, exit ${error.status ?? "?"})` }],
				details: { command: params.command, exitCode: error.status ?? 1 },
			};
		}
	},
};
