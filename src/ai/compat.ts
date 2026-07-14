/**
 * MiMo-only compat layer.
 *
 * Provides the global streamSimple/complete/getModel/getModels/getProviders
 * API surface that agent-core imports via "@earendil-works/pi-ai/compat".
 * All non-MiMo providers have been pruned.
 */

export * from "./index.ts";
export * from "./env-api-keys.ts";
export * from "./api/openai-completions.lazy.ts";

import type {
	Api,
	ApiStreamOptions,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "./types.ts";
import { createModels, type MutableModels } from "./models.ts";
import { getEnvApiKey } from "./env-api-keys.ts";
import { xiaomiProvider } from "./providers/xiaomi.ts";
import { xiaomiTokenPlanAmsProvider } from "./providers/xiaomi-token-plan-ams.ts";
import { xiaomiTokenPlanCnProvider } from "./providers/xiaomi-token-plan-cn.ts";
import { xiaomiTokenPlanSgpProvider } from "./providers/xiaomi-token-plan-sgp.ts";

const compatModels: MutableModels = createModels();
compatModels.setProvider(xiaomiProvider());
compatModels.setProvider(xiaomiTokenPlanAmsProvider());
compatModels.setProvider(xiaomiTokenPlanCnProvider());
compatModels.setProvider(xiaomiTokenPlanSgpProvider());

export function getModel(provider: string, id: string): Model<Api> | undefined {
	return compatModels.getModel(provider, id);
}

export function getModels(provider?: string): readonly Model<Api>[] {
	return compatModels.getModels(provider);
}

export function getProviders(): readonly { id: string; name: string }[] {
	return compatModels.getProviders();
}

const AMBIENT_AUTH_MARKER = "<authenticated>";

function hasExplicitApiKey(apiKey: string | undefined): apiKey is string {
	return typeof apiKey === "string" && apiKey.trim().length > 0;
}

function withEnvApiKey<TOptions extends { apiKey?: string }>(
	model: Model<Api>,
	options: TOptions | undefined,
): TOptions | undefined {
	if (hasExplicitApiKey(options?.apiKey)) return options;
	const apiKey = getEnvApiKey(model.provider);
	if (!apiKey || apiKey === AMBIENT_AUTH_MARKER) return options;
	return { ...options, apiKey } as TOptions;
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ApiStreamOptions<TApi>,
): AssistantMessageEventStream {
	return compatModels.stream(model, context, withEnvApiKey(model, options));
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ApiStreamOptions<TApi>,
): Promise<AssistantMessage> {
	return stream(model, context, options).result();
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	return compatModels.streamSimple(model, context, withEnvApiKey(model, options));
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	return streamSimple(model, context, options).result();
}
