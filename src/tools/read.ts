import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const MAX_LINES = 2000;

const schema = Type.Object({
	path: Type.String({ description: "Path to the file to read" }),
});

export const readTool: AgentTool<typeof schema> = {
	name: "read",
	label: "Read",
	description: `Read the contents of a file. Paths are relative to the current working directory. Output is truncated to ${MAX_LINES} lines.`,
	parameters: schema,
	execute: async (_toolCallId, params: Static<typeof schema>) => {
		const resolved = path.resolve(params.path);
		const content = fs.readFileSync(resolved, "utf-8");
		const lines = content.split("\n");
		const truncated = lines.length > MAX_LINES;
		const visible = truncated ? lines.slice(0, MAX_LINES).join("\n") : content;
		const suffix = truncated ? `\n\n... (${lines.length - MAX_LINES} more lines, truncated)` : "";
		return {
			content: [{ type: "text", text: visible + suffix }],
			details: { path: resolved, lines: lines.length, truncated },
		};
	},
};
