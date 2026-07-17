/**
 * Pure text-replacement helpers for the edit tool.
 *
 * Ported from pi's packages/coding-agent/src/core/tools/edit-diff.ts with the
 * display-only diff/patch generators removed (they depended on the `diff`
 * library, which fagent does not ship). Everything here is dependency-free
 * string manipulation: BOM handling, line-ending normalization, exact + fuzzy
 * matching, uniqueness/overlap checks, and applying one or more replacements
 * while preserving unchanged line blocks.
 */

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Strip trailing whitespace per line
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// Smart single quotes → '
			.replace(/[‘’‚‛]/g, "'")
			// Smart double quotes → "
			.replace(/[“”„‟]/g, '"')
			// Various dashes/hyphens → -
			.replace(/[‐‑‒–—―−]/g, "-")
			// Special spaces → regular space
			.replace(/[  -   　]/g, " ")
	);
}

function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
	start: number;
	end: number;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;

	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (replacementStart >= line.start && replacementStart < line.end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content.");
	}

	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacementEnd) {
		endLine++;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}

	return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

/**
 * Apply replacements matched against `baseContent` to `originalContent` while
 * preserving unchanged line blocks from the original.
 */
export function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: TextReplacement[],
): string {
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sortedReplacements) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}

	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");

		const groupStartOffset = baseLines[group.startLine].start;
		const groupEndOffset = baseLines[group.endLine - 1].end;
		result += applyReplacements(
			baseContent.slice(groupStartOffset, groupEndOffset),
			group.replacements,
			groupStartOffset,
		);
		originalLineIndex = group.endLine;
	}
	result += originalLines.slice(originalLineIndex).join("");

	return result;
}

export interface FuzzyMatchResult {
	found: boolean;
	index: number;
	matchLength: number;
	usedFuzzyMatch: boolean;
	contentForReplacement: string;
}

export interface Edit {
	oldText: string;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("﻿") ? { bom: "﻿", text: content.slice(1) } : { bom: "", text: content };
}

function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. If any edit needs
 * fuzzy matching, the operation runs in fuzzy-normalized content space and then
 * overlays those line-level changes onto the original content so unchanged line
 * blocks keep their original bytes.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
	const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
		if (!matchResult.found) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}

		const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	const baseContent = normalizedContent;
	const newContent = usedFuzzyMatch
		? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
		: applyReplacements(replacementBaseContent, matchedEdits);

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
}
