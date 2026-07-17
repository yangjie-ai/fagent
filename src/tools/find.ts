import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "@earendil-works/pi-agent-core";

const DEFAULT_LIMIT = 1000;

const schema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

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

export const findTool: AgentTool<typeof schema> = {
	name: "find",
	label: "Find",
	description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
	parameters: schema,
	execute: async (_toolCallId, params: Static<typeof schema>, signal?: AbortSignal) => {
		const { pattern, path: searchDir, limit } = params;
		if (signal?.aborted) throw new Error("Operation aborted");

		const effectiveLimit = limit ?? DEFAULT_LIMIT;
		const searchPath = path.resolve(searchDir || ".");

		try {
			await stat(searchPath);
		} catch {
			throw new Error(`Path not found: ${searchPath}`);
		}

		// fd --glob matches the basename unless the pattern contains a slash, in which
		// case it matches the full relative path (with an implicit '**/' prefix so a
		// pattern like 'src/**/*.spec.ts' still matches nested candidates).
		const pathMode = pattern.includes("/");
		let effectivePattern = pattern;
		if (pathMode && !pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
			effectivePattern = `**/${pattern}`;
		}
		const pathRegex = pathMode ? globToRegex(effectivePattern) : null;
		const baseRegex = pathMode ? null : globToRegex(pattern);

		const results: string[] = [];
		let resultLimitReached = false;
		const stack: Array<{ dir: string; layers: IgnoreLayer[] }> = [];

		const loadLayer = async (dir: string, parentLayers: IgnoreLayer[]): Promise<IgnoreLayer[]> => {
			try {
				const gi = await readFile(path.join(dir, ".gitignore"), "utf-8");
				return buildIgnoreLayer(dir, gi, parentLayers);
			} catch {
				return parentLayers;
			}
		};

		stack.push({ dir: searchPath, layers: await loadLayer(searchPath, []) });

		while (stack.length > 0 && !resultLimitReached) {
			const { dir, layers } = stack.pop()!;
			let entries: import("node:fs").Dirent[];
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			entries.sort((a, b) => a.name.localeCompare(b.name));
			for (const entry of entries) {
				if (signal?.aborted) break;
				if (entry.name === ".git") continue;
				const abs = path.join(dir, entry.name);
				if (isIgnored(layers, abs)) continue;

				const rel = path.relative(searchPath, abs).split(path.sep).join("/");
				const matches = pathRegex ? pathRegex.test(rel) : baseRegex ? baseRegex.test(entry.name) : false;
				if (matches) {
					results.push(entry.isDirectory() ? `${rel}/` : rel);
					if (results.length >= effectiveLimit) {
						resultLimitReached = true;
						break;
					}
				}

				if (entry.isDirectory()) {
					stack.push({ dir: abs, layers: await loadLayer(abs, layers) });
				}
			}
		}

		if (signal?.aborted) throw new Error("Operation aborted");
		if (results.length === 0) {
			return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
		}

		const rawOutput = results.join("\n");
		const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
		let output = truncation.content;

		const notices: string[] = [];
		if (resultLimitReached) {
			notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
		}
		if (truncation.truncated) {
			notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		}
		if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

		return { content: [{ type: "text", text: output }], details: undefined };
	},
};
