import { readdir, stat } from "node:fs/promises";
import nodePath from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "@earendil-works/pi-agent-core";

const DEFAULT_LIMIT = 500;

const schema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

export const lsTool: AgentTool<typeof schema> = {
	name: "ls",
	label: "Ls",
	description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
	parameters: schema,
	execute: async (_toolCallId, params: Static<typeof schema>, signal?: AbortSignal) => {
		if (signal?.aborted) throw new Error("Operation aborted");
		const { path: target, limit } = params;
		const dirPath = nodePath.resolve(target || ".");
		const effectiveLimit = limit ?? DEFAULT_LIMIT;

		// Check if path exists.
		const dirStat = await stat(dirPath).catch(() => null);
		if (!dirStat) throw new Error(`Path not found: ${dirPath}`);
		if (!dirStat.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);

		// Read directory entries.
		let entries: string[];
		try {
			entries = await readdir(dirPath);
		} catch (e: any) {
			throw new Error(`Cannot read directory: ${e.message}`);
		}

		// Sort alphabetically, case-insensitive.
		entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

		// Format entries with directory indicators.
		const results: string[] = [];
		let entryLimitReached = false;
		for (const entry of entries) {
			if (signal?.aborted) break;
			if (results.length >= effectiveLimit) {
				entryLimitReached = true;
				break;
			}
			const fullPath = nodePath.join(dirPath, entry);
			let suffix = "";
			try {
				if ((await stat(fullPath)).isDirectory()) suffix = "/";
			} catch {
				continue; // skip entries we cannot stat
			}
			results.push(entry + suffix);
		}

		if (signal?.aborted) throw new Error("Operation aborted");
		if (results.length === 0) {
			return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };
		}

		const rawOutput = results.join("\n");
		// Apply byte truncation. No separate line limit because entry count is already capped.
		const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
		let output = truncation.content;

		const notices: string[] = [];
		if (entryLimitReached) {
			notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
		}
		if (truncation.truncated) {
			notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		}
		if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

		return { content: [{ type: "text", text: output }], details: undefined };
	},
};
