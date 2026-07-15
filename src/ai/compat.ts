/**
 * OpenAI-compatible compat layer.
 *
 * Exposes the streamSimple surface that agent-core imports via
 * "@earendil-works/pi-ai/compat", and re-exports the shared types and
 * utilities from ./index.ts. The model itself is built from env in main.ts;
 * this layer only handles streaming.
 */

export * from "./index.ts";

import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "./types.ts";
import { streamSimple as openaiStreamSimple } from "./api/openai-completions.ts";

function hasExplicitApiKey(apiKey: string | undefined): apiKey is string {
	return typeof apiKey === "string" && apiKey.trim().length > 0;
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	let resolvedOptions = options;
	// Fall back to the env key when no explicit key was passed (e.g. direct
	// streamSimple use). The agent path always injects one via main.ts.
	if (!hasExplicitApiKey(options?.apiKey)) {
		const envKey = process.env.API_KEY;
		if (envKey && envKey.trim().length > 0) {
			resolvedOptions = { ...options, apiKey: envKey } as SimpleStreamOptions;
		}
	}
	return openaiStreamSimple(model as Model<"openai-completions">, context, resolvedOptions);
}
