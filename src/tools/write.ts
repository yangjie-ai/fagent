import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const schema = Type.Object({
	path: Type.String({ description: "Path to the file to write" }),
	content: Type.String({ description: "The full content to write" }),
});

export const writeTool: AgentTool<typeof schema> = {
	name: "write",
	label: "Write",
	description: "Create a file with the given content, or overwrite an existing file. Creates parent directories if needed.",
	parameters: schema,
	execute: async (_toolCallId, params: Static<typeof schema>) => {
		const resolved = path.resolve(params.path);
		fs.mkdirSync(path.dirname(resolved), { recursive: true });
		fs.writeFileSync(resolved, params.content);
		return {
			content: [{ type: "text", text: `Wrote ${params.content.length} bytes to ${resolved}` }],
			details: { path: resolved, bytes: params.content.length },
		};
	},
};
