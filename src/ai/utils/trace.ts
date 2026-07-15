import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let currentLoopId = "";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Compact sortable timestamp, e.g. 20260715-145822693 (ms precision). */
function stamp(ts: number): string {
	const d = new Date(ts);
	return (
		`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
		`-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`
	);
}

/** Flatten a message's content (string or content-part array) to plain text. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(p): p is { type?: string; text?: string } =>
					typeof p === "object" && p !== null && (p as { type?: string }).type === "text",
			)
			.map((p) => p.text || "")
			.join("\n");
	}
	return "";
}

/** Last user message text from the request — the prompt this call answers. */
function extractInput(request: unknown): string {
	const messages = (request as { messages?: Array<{ role?: string; content?: unknown }> } | null)?.messages;
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") return contentText(messages[i].content);
	}
	return "";
}

/** Assistant text blocks joined — the answer this call produced. */
function extractOutput(response: { content?: Array<{ type?: string; text?: string }> }): string {
	if (!Array.isArray(response.content)) return "";
	return response.content
		.filter((b) => b.type === "text")
		.map((b) => b.text || "")
		.join("\n")
		.trim();
}

/**
 * Mark the start of a new agent loop (one user prompt = one loop). Every trace
 * written afterwards carries this id, so the viewer can group files by which
 * prompt produced them — no inference from stopReason or history. Call this
 * right before agent.prompt().
 */
export function beginLoop(): string {
	currentLoopId = stamp(Date.now());
	return currentLoopId;
}

/**
 * Persist one model call to ./data/<YYYYMMDD>/<loopId>.jsonl — one line per
 * call, one file per loop (one user prompt), grouped under a per-day folder so
 * ./data stays browsable by date without ever deleting history. Top-level
 * `input`/`output` are the plain-text Q&A (easy to spot at a glance); the full
 * `request`/`response` follow for debugging. Stamped with the current loop id.
 * Best-effort: filesystem failures never propagate into the model stream.
 */
export function saveModelTrace(
	request: unknown,
	response: { timestamp?: number; content?: Array<{ type?: string; text?: string }> },
): void {
	try {
		const ts = response.timestamp ?? Date.now();
		const loop = currentLoopId || stamp(ts);
		const dir = join("data", loop.slice(0, 8)); // YYYYMMDD per-day folder
		mkdirSync(dir, { recursive: true });
		const line =
			JSON.stringify({
				timestamp: ts,
				loopId: currentLoopId,
				input: extractInput(request),
				output: extractOutput(response),
				request,
				response,
			}) + "\n";
		appendFileSync(join(dir, `${loop}.jsonl`), line);
	} catch {
		// Best-effort trace: never disrupt the model stream.
	}
}
