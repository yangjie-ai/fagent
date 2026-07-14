import { execSync } from "node:child_process";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const MAX_BUFFER = 10 * 1024 * 1024;

const schema = Type.Object({
	pattern: Type.String({ description: "File name glob, e.g. '*.ts' or '*test*'" }),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
});

export const findTool: AgentTool<typeof schema> = {
	name: "find",
	label: "Find",
	description: "Find files by name pattern. Uses shell glob matching.",
	parameters: schema,
	execute: async (_toolCallId, params: Static<typeof schema>) => {
		const dir = params.path ?? ".";
		const cmd = `find "${dir}" -type f -name "${params.pattern}"`;
		try {
			const output = execSync(cmd, {
				encoding: "utf-8",
				timeout: 30_000,
				maxBuffer: MAX_BUFFER,
				stdio: ["pipe", "pipe", "pipe"],
			});
			return {
				content: [{ type: "text", text: output || "No files found" }],
				details: { pattern: params.pattern, path: dir },
			};
		} catch (error: any) {
			return {
				content: [{ type: "text", text: `Error: ${error.message}` }],
				details: { pattern: params.pattern, path: dir, error: error.message },
			};
		}
	},
};
