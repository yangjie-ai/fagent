import { execSync } from "node:child_process";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const MAX_BUFFER = 10 * 1024 * 1024;

const schema = Type.Object({
	pattern: Type.String({ description: "Regular expression pattern" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	include: Type.Optional(Type.String({ description: "File name glob filter, e.g. '*.ts'" })),
});

export const grepTool: AgentTool<typeof schema> = {
	name: "grep",
	label: "Grep",
	description: "Search file contents by regex. Returns matching lines with file paths and line numbers. Recursive by default.",
	parameters: schema,
	execute: async (_toolCallId, params: Static<typeof schema>) => {
		const dir = params.path ?? ".";
		const include = params.include ? `--include="${params.include}"` : "";
		const cmd = `grep -rn ${include} -- "${params.pattern}" "${dir}"`;
		try {
			const output = execSync(cmd, {
				encoding: "utf-8",
				timeout: 30_000,
				maxBuffer: MAX_BUFFER,
				stdio: ["pipe", "pipe", "pipe"],
			});
			return {
				content: [{ type: "text", text: output || "No matches" }],
				details: { pattern: params.pattern, path: dir },
			};
		} catch (error: any) {
			if (error.status === 1) {
				return {
					content: [{ type: "text", text: "No matches" }],
					details: { pattern: params.pattern, path: dir },
				};
			}
			return {
				content: [{ type: "text", text: `Error: ${error.message}` }],
				details: { pattern: params.pattern, path: dir, error: error.message },
			};
		}
	},
};
