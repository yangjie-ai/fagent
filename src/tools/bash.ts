import { spawn } from "node:child_process";
import process from "node:process";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult } from "@earendil-works/pi-agent-core";
import { OutputAccumulator } from "./output-accumulator.ts";

const DEFAULT_TIMEOUT_SEC = 30;

const schema = Type.Object({
	command: Type.String({ description: "The shell command to execute" }),
	timeout: Type.Optional(
		Type.Number({ description: `Maximum execution time in seconds (default ${DEFAULT_TIMEOUT_SEC})` }),
	),
});

export interface BashToolDetails {
	command: string;
	exitCode: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Execute a bash command with streaming output capture.
 *
 * Ported from pi's coding-agent bash tool: stdout+stderr are accumulated with an
 * OutputAccumulator (bounded tail window + optional /tmp full-output file), then
 * tail-truncated to DEFAULT_MAX_LINES / DEFAULT_MAX_BYTES. Non-zero exit, timeout,
 * and abort are reported as thrown errors whose message embeds the captured output
 * (the harness turns these into error tool results the model can read).
 */
export const bashTool: AgentTool<typeof schema, BashToolDetails> = {
	name: "bash",
	label: "Bash",
	description: `Execute a bash command in the current working directory. Returns combined stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); the full output is saved to a temp file when truncated. Optionally provide a timeout in seconds.`,
	parameters: schema,
	execute: async (_toolCallId, params: Static<typeof schema>, signal?: AbortSignal) => {
		const timeoutSec = params.timeout && params.timeout > 0 ? params.timeout : DEFAULT_TIMEOUT_SEC;
		const acc = new OutputAccumulator({ tempFilePrefix: "fagent-bash" });

		// detached = own process group on Unix so we can kill the whole tree on timeout/abort.
		const detached = process.platform !== "win32";
		const child = spawn(params.command, {
			shell: process.env.SHELL || "/bin/sh",
			detached,
			stdio: ["ignore", "pipe", "pipe"],
			cwd: process.cwd(),
			env: process.env,
			windowsHide: true,
		});

		let timedOut = false;
		let aborted = false;

		const killTree = () => {
			try {
				if (detached && child.pid) {
					process.kill(-child.pid, "SIGKILL");
				} else {
					child.kill("SIGKILL");
				}
			} catch {
				// process already exited
			}
		};

		const timer = setTimeout(() => {
			timedOut = true;
			killTree();
		}, timeoutSec * 1000);

		const onAbort = () => {
			aborted = true;
			killTree();
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (chunk: Buffer) => acc.append(chunk));
		child.stderr?.on("data", (chunk: Buffer) => acc.append(chunk));

		const exitCode: number = await new Promise((resolve, reject) => {
			child.on("error", reject);
			child.on("close", (code) => resolve(code ?? 0));
		});

		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);

		acc.finish();
		await acc.closeTempFile();
		const snap = acc.snapshot({ persistIfTruncated: true });

		let text = snap.content || "(no output)";
		if (snap.truncation.truncated) {
			const notice = snap.fullOutputPath
				? `[Showing last ${snap.truncation.outputLines} of ${snap.truncation.totalLines} lines. Full output: ${snap.fullOutputPath}]`
				: `[Showing last ${snap.truncation.outputLines} of ${snap.truncation.totalLines} lines]`;
			text += `\n\n${notice}`;
		}

		if (aborted && signal?.aborted) throw new Error("Operation aborted");
		if (timedOut) throw new Error(`Command timed out after ${timeoutSec} seconds:\n${text}`);
		if (exitCode !== 0) throw new Error(`Command exited with code ${exitCode}:\n${text}`);

		return {
			content: [{ type: "text", text }],
			details: {
				command: params.command,
				exitCode,
				truncation: snap.truncation,
				fullOutputPath: snap.fullOutputPath,
			},
		};
	},
};
