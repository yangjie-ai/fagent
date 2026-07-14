import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const schema = Type.Object({
	path: Type.String({ description: "Path to the file to edit" }),
	old_string: Type.String({ description: "The exact text to find (must be unique in the file)" }),
	new_string: Type.String({ description: "The replacement text" }),
});

export const editTool: AgentTool<typeof schema> = {
	name: "edit",
	label: "Edit",
	description: "Replace a unique occurrence of old_string with new_string in a file. The old_string must match exactly once; include surrounding context if it appears multiple times.",
	parameters: schema,
	execute: async (_toolCallId, params: Static<typeof schema>) => {
		const resolved = path.resolve(params.path);
		const content = fs.readFileSync(resolved, "utf-8");
		const count = content.split(params.old_string).length - 1;
		if (count === 0) {
			return {
				content: [{ type: "text", text: `Error: old_string not found in ${resolved}` }],
				details: { path: resolved, matched: 0 },
			};
		}
		if (count > 1) {
			return {
				content: [{ type: "text", text: `Error: old_string matched ${count} times in ${resolved}. Provide a longer snippet to make it unique.` }],
				details: { path: resolved, matched: count },
			};
		}
		fs.writeFileSync(resolved, content.replace(params.old_string, params.new_string));
		return {
			content: [{ type: "text", text: `Edited ${resolved}` }],
			details: { path: resolved, matched: 1 },
		};
	},
};
