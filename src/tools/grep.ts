import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-agent-core";

const DEFAULT_LIMIT = 100;
// Soft per-file size guard so a huge minified file cannot dominate matching.
const MAX_FILE_CHARS = 5_000_000;

const schema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Convert a glob into a RegExp. Supports *, **, ?, and [abc] character classes. */
function globToRegex(glob: string): RegExp {
	let i = 0;
	let out = "^";
	while (i < glob.length) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				i += 2;
				if (glob[i] === "/") i++;
				out += ".*";
			} else {
				out += "[^/]*";
			}
		} else if (c === "?") {
			out += "[^/]";
		} else if (c === "[") {
			const end = glob.indexOf("]", i);
			if (end === -1) {
				out += "\\[";
			} else {
				out += glob.slice(i, end + 1);
				i = end;
			}
		} else if ("/.*+?^${}()|\\".includes(c)) {
			out += "\\" + c;
		} else {
			out += c;
		}
		i++;
	}
	return new RegExp(out + "$");
}

interface IgnoreLayer {
	dir: string;
	ig: ReturnType<typeof ignore>;
}

function buildIgnoreLayer(dir: string, rules: string, parentLayers: IgnoreLayer[]): IgnoreLayer[] {
	if (!rules.trim()) return parentLayers;
	return [...parentLayers, { dir, ig: ignore().add(rules) }];
}

function isIgnored(layers: IgnoreLayer[], absPath: string): boolean {
	for (const { dir, ig } of layers) {
		let rel = path.relative(dir, absPath);
		if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
		rel = rel.split(path.sep).join("/");
		if (ig.ignores(rel)) return true;
	}
	return false;
}

async function* walkFiles(
	root: string,
	signal?: AbortSignal,
): AsyncGenerator<{ abs: string; layers: IgnoreLayer[] }> {
	const stack: Array<{ dir: string; layers: IgnoreLayer[] }> = [];
	let rootLayers: IgnoreLayer[] = [];
	try {
		const rootGitignore = await readFile(path.join(root, ".gitignore"), "utf-8");
		rootLayers = buildIgnoreLayer(root, rootGitignore, rootLayers);
	} catch {}
	stack.push({ dir: root, layers: rootLayers });

	while (stack.length > 0) {
		const { dir, layers } = stack.pop()!;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (signal?.aborted) return;
			if (entry.name === ".git") continue;
			const abs = path.join(dir, entry.name);
			if (isIgnored(layers, abs)) continue;
			if (entry.isDirectory()) {
				let childLayers = layers;
				try {
					const gi = await readFile(path.join(abs, ".gitignore"), "utf-8");
					childLayers = buildIgnoreLayer(abs, gi, layers);
				} catch {}
				stack.push({ dir: abs, layers: childLayers });
			} else if (entry.isFile()) {
				yield { abs, layers };
			}
		}
	}
}

export const grepTool: AgentTool<typeof schema> = {
	name: "grep",
	label: "Grep",
	description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
	parameters: schema,
	execute: async (_toolCallId, params: Static<typeof schema>, signal?: AbortSignal) => {
		const { pattern, path: searchDir, glob, ignoreCase, literal, context, limit } = params;
		if (signal?.aborted) throw new Error("Operation aborted");

		const flags = ignoreCase ? "gi" : "g";
		const source = literal ? escapeRegex(pattern) : pattern;
		let regex: RegExp;
		try {
			regex = new RegExp(source, flags);
		} catch (err) {
			throw new Error(`Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`);
		}

		const contextValue = context && context > 0 ? context : 0;
		const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
		const globFilter = glob ? globToRegex(glob) : undefined;

		const searchPath = path.resolve(searchDir || ".");
		let isDirectory: boolean;
		try {
			isDirectory = (await stat(searchPath)).isDirectory();
		} catch {
			throw new Error(`Path not found: ${searchPath}`);
		}

		const formatPath = (filePath: string): string => {
			if (isDirectory) {
				const relative = path.relative(searchPath, filePath);
				if (relative && !relative.startsWith("..")) return relative.split(path.sep).join("/");
			}
			return path.basename(filePath);
		};

		const matches: Array<{ filePath: string; lineNumber: number; lineText: string }> = [];
		let matchCount = 0;
		let matchLimitReached = false;
		let linesTruncated = false;

		const consider = (filePath: string, lineNumber: number, lineText: string): boolean => {
			matches.push({ filePath, lineNumber, lineText });
			matchCount++;
			if (matchCount >= effectiveLimit) {
				matchLimitReached = true;
				return false;
			}
			return true;
		};

		const scanFile = async (filePath: string): Promise<boolean> => {
			if (signal?.aborted) return false;
			let content: string;
			try {
				content = await readFile(filePath, "utf-8");
			} catch {
				return true; // skip unreadable, continue
			}
			if (content.length > MAX_FILE_CHARS || content.includes("\u0000")) return true; // skip binary/huge
			const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			for (let i = 0; i < lines.length; i++) {
				if (signal?.aborted) return false;
				regex.lastIndex = 0;
				if (!regex.test(lines[i])) continue;
				if (!consider(filePath, i + 1, lines[i])) return false;
			}
			return true;
		};

		if (isDirectory) {
			for await (const { abs } of walkFiles(searchPath, signal)) {
				if (signal?.aborted) break;
				if (globFilter) {
					const rel = path.relative(searchPath, abs).split(path.sep).join("/");
					const base = path.basename(abs);
					if (!globFilter.test(rel) && !globFilter.test(base)) continue;
				}
				const keep = await scanFile(abs);
				if (!keep) break;
			}
		} else {
			await scanFile(searchPath);
		}

		if (signal?.aborted) throw new Error("Operation aborted");
		if (matchCount === 0) {
			return { content: [{ type: "text", text: "No matches found" }], details: undefined };
		}

		// Format matches with optional context lines.
		const outputLines: string[] = [];
		if (contextValue === 0) {
			for (const m of matches) {
				const relPath = formatPath(m.filePath);
				const sanitized = m.lineText.replace(/\r/g, "");
				const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
				if (wasTruncated) linesTruncated = true;
				outputLines.push(`${relPath}:${m.lineNumber}: ${truncatedText}`);
			}
		} else {
			const fileCache = new Map<string, string[]>();
			for (const m of matches) {
				const relPath = formatPath(m.filePath);
				let lines = fileCache.get(m.filePath);
				if (!lines) {
					try {
						const content = await readFile(m.filePath, "utf-8");
						lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
					} catch {
						lines = [];
					}
					fileCache.set(m.filePath, lines);
				}
				if (!lines.length) {
					outputLines.push(`${relPath}:${m.lineNumber}: (unable to read file)`);
					continue;
				}
				const start = Math.max(1, m.lineNumber - contextValue);
				const end = Math.min(lines.length, m.lineNumber + contextValue);
				for (let current = start; current <= end; current++) {
					const lineText = (lines[current - 1] ?? "").replace(/\r/g, "");
					const { text: truncatedText, wasTruncated } = truncateLine(lineText);
					if (wasTruncated) linesTruncated = true;
					if (current === m.lineNumber) outputLines.push(`${relPath}:${current}: ${truncatedText}`);
					else outputLines.push(`${relPath}-${current}- ${truncatedText}`);
				}
			}
		}

		const rawOutput = outputLines.join("\n");
		// Apply byte truncation. No line limit here because the match limit already capped rows.
		const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
		let output = truncation.content;

		const notices: string[] = [];
		if (matchLimitReached) {
			notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
		}
		if (truncation.truncated) {
			notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		}
		if (linesTruncated) {
			notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
		}
		if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

		return { content: [{ type: "text", text: output }], details: undefined };
	},
};
