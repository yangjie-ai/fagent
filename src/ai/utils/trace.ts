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
 * Append one trace line to ./data/<YYYYMMDD>/<loopId>.jsonl — shared by model
 * and tool events. One file per loop (one user prompt), grouped under a per-day
 * folder. Best-effort: filesystem failures never propagate into the agent.
 */
function appendTrace(obj: Record<string, unknown>): void {
	try {
		const ts = (obj.timestamp as number) || Date.now();
		const loop = currentLoopId || stamp(ts);
		const dir = join("data", loop.slice(0, 8)); // YYYYMMDD per-day folder
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, `${loop}.jsonl`), JSON.stringify(obj) + "\n");
	} catch {
		// Best-effort trace: never disrupt the agent.
	}
}

/**
 * Persist one LLM call — the request sent and the response produced (content
 * blocks: thinking/text/toolCall, plus usage & stopReason). Top-level
 * `input`/`output` are the plain-text Q&A summary; the full `request`/
 * `response` follow for debugging.
 */
export function saveModelTrace(
	request: unknown,
	response: { timestamp?: number; content?: Array<{ type?: string; text?: string }> },
): void {
	appendTrace({
		type: "model",
		timestamp: response.timestamp ?? Date.now(),
		loopId: currentLoopId,
		input: extractInput(request),
		output: extractOutput(response),
		request,
		response,
	});
}

/** Persist one tool execution — name, args, result, error flag, duration. */
export function saveToolTrace(event: {
	toolCallId: string;
	toolName: string;
	args: unknown;
	result: unknown;
	isError: boolean;
	durationMs: number;
}): void {
	appendTrace({
		type: "tool",
		timestamp: Date.now(),
		loopId: currentLoopId,
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		args: event.args,
		result: event.result,
		isError: event.isError,
		durationMs: event.durationMs,
	});
}
