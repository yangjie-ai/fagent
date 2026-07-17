import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import path from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const schema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export const writeTool: AgentTool<typeof schema> = {
	name: "write",
	label: "Write",
	description:
		"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
	parameters: schema,
	execute: async (_toolCallId, params: Static<typeof schema>, signal?: AbortSignal) => {
		const { path: filePath, content } = params;
		const absolutePath = path.resolve(filePath);
		const dir = dirname(absolutePath);

		const throwIfAborted = (): void => {
			if (signal?.aborted) throw new Error("Operation aborted");
		};

		throwIfAborted();
		// Create parent directories if needed.
		await mkdir(dir, { recursive: true });
		throwIfAborted();

		// Write the file contents.
		await writeFile(absolutePath, content, "utf-8");
		throwIfAborted();

		return {
			content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${filePath}` }],
			details: { path: absolutePath, bytes: content.length },
		};
	},
};
