import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	applyEditsToNormalizedContent,
	type Edit,
	detectLineEnding,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";

const replaceEditSchema = Type.Object({
	oldText: Type.String({
		description:
			"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
	}),
	newText: Type.String({ description: "Replacement text for this targeted edit." }),
});

const schema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(replaceEditSchema, {
		description:
			"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
	}),
});

type EditToolInput = Static<typeof schema> & {
	// Legacy single-edit shape tolerated from some models.
	oldText?: unknown;
	newText?: unknown;
};

// Some models send edits as a JSON string instead of an array, or use the
// legacy single oldText/newText pair. Normalize both into the edits[] form.
function prepareEditArguments(input: unknown): Static<typeof schema> {
	if (!input || typeof input !== "object") {
		return input as Static<typeof schema>;
	}

	const args = input as Record<string, unknown>;
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
		} catch {}
	}

	const legacy = args as EditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as Static<typeof schema>;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as Static<typeof schema>;
}

function validateEditInput(input: Static<typeof schema>): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

export const editTool: AgentTool<typeof schema> = {
	name: "edit",
	label: "Edit",
	description:
		"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
	parameters: schema,
	prepareArguments: prepareEditArguments,
	execute: async (_toolCallId, input: Static<typeof schema>, signal?: AbortSignal) => {
		const { path: filePath, edits } = validateEditInput(input);
		const absolutePath = path.resolve(filePath);

		const throwIfAborted = (): void => {
			if (signal?.aborted) throw new Error("Operation aborted");
		};

		throwIfAborted();

		// Check if file exists and is writable.
		try {
			await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
		} catch (error: unknown) {
			throwIfAborted();
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			throw new Error(`Could not edit file: ${filePath}. ${errorMessage}.`);
		}
		throwIfAborted();

		// Read the file.
		const rawContent = await fsReadFile(absolutePath, "utf-8");
		throwIfAborted();

		// Strip BOM before matching. The model will not include an invisible BOM in oldText.
		const { bom, text: content } = stripBom(rawContent);
		const originalEnding = detectLineEnding(content);
		const normalizedContent = normalizeToLF(content);
		const { newContent } = applyEditsToNormalizedContent(normalizedContent, edits, filePath);
		throwIfAborted();

		const finalContent = bom + restoreLineEndings(newContent, originalEnding);
		await fsWriteFile(absolutePath, finalContent, "utf-8");
		throwIfAborted();

		return {
			content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${filePath}.` }],
			details: { path: absolutePath, blocksReplaced: edits.length },
		};
	},
};
