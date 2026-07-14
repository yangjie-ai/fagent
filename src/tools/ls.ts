import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const schema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
});

export const lsTool: AgentTool<typeof schema> = {
	name: "ls",
	label: "Ls",
	description: "List directory contents. Returns entries with [D] for directories and [F] for files.",
	parameters: schema,
	execute: async (_toolCallId, params: Static<typeof schema>) => {
		const dir = path.resolve(params.path ?? ".");
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		const lines = entries
			.sort((a, b) => {
				if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
				return a.name.localeCompare(b.name);
			})
			.map((e) => `${e.isDirectory() ? "[D]" : "[F]"} ${e.name}`);
		return {
			content: [{ type: "text", text: lines.join("\n") || "(empty)" }],
			details: { path: dir, count: entries.length },
		};
	},
};
