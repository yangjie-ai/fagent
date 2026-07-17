/**
 * OpenAI-compatible chat completions streaming client.
 *
 * Talks to any OpenAI-compatible endpoint (configured via BASE_URL). Reasoning
 * models stream thinking in the `reasoning_content` field (deepseek format:
 * `thinking` param + `reasoning_effort`). Emits the `AssistantMessageEvent`
 * protocol that the agent loop consumes.
 */
import OpenAI from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionMessageParam,
} from "openai/resources/chat/completions.js";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { saveModelTrace } from "../utils/trace.ts";
import { buildBaseOptions } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

function isTextContentBlock(block: { type: string }): block is TextContent {
	return block.type === "text";
}
function isThinkingContentBlock(block: { type: string }): block is ThinkingContent {
	return block.type === "thinking";
}
function isToolCallBlock(block: { type: string }): block is ToolCall {
	return block.type === "toolCall";
}
function isImageContentBlock(block: { type: string }): block is ImageContent {
	return block.type === "image";
}

function getClientApiKey(provider: string, apiKey: string | undefined): string {
	if (apiKey) return apiKey;
	throw new Error(`No API key for provider: ${provider}`);
}

function createClient(model: Model<"openai-completions">, apiKey: string, optionsHeaders?: Record<string, string | null>) {
	const headers: Record<string, string | null> = { ...model.headers };
	if (optionsHeaders) Object.assign(headers, optionsHeaders);
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: headers,
	});
}

function convertTools(tools: Tool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as any, // TypeBox already generates JSON Schema
			strict: false,
		},
	}));
}

function convertMessages(model: Model<"openai-completions">, context: Context): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];
	// Tool-call ids pass through unchanged (no Responses-API pipe normalization).
	const transformedMessages = transformMessages(context.messages, model);

	if (context.systemPrompt) {
		// Reasoning models use the "developer" role for the system prompt.
		const role = model.reasoning ? "developer" : "system";
		params.push({ role, content: sanitizeSurrogates(context.systemPrompt) });
	}

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				params.push({ role: "user", content: sanitizeSurrogates(msg.content) });
			} else {
				const content: ChatCompletionContentPart[] = msg.content.map((item): ChatCompletionContentPart => {
					if (item.type === "text") {
						return { type: "text", text: sanitizeSurrogates(item.text) } satisfies ChatCompletionContentPartText;
					}
					return {
						type: "image_url",
						image_url: { url: `data:${item.mimeType};base64,${item.data}` },
					} satisfies ChatCompletionContentPartImage;
				});
				if (content.length === 0) continue;
				params.push({ role: "user", content });
			}
		} else if (msg.role === "assistant") {
			const assistantMsg: ChatCompletionAssistantMessageParam = {
				role: "assistant",
				content: null,
			};

			const assistantTextParts = msg.content
				.filter(isTextContentBlock)
				.filter((block) => block.text.trim().length > 0)
				.map((block) => ({ type: "text", text: sanitizeSurrogates(block.text) }) satisfies ChatCompletionContentPartText);
			const assistantText = assistantTextParts.map((part) => part.text).join("");

			const nonEmptyThinkingBlocks = msg.content
				.filter(isThinkingContentBlock)
				.filter((block) => block.thinking.trim().length > 0);

			if (nonEmptyThinkingBlocks.length > 0) {
				// Assistant text is sent as a plain string (standard Chat Completions format).
				if (assistantText.length > 0) {
					assistantMsg.content = assistantText;
				}
				// Replay thinking via its recorded signature field (reasoning models: "reasoning_content").
				const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
				if (signature && signature.length > 0) {
					(assistantMsg as unknown as Record<string, unknown>)[signature] = nonEmptyThinkingBlocks
						.map((block) => block.thinking)
						.join("\n");
				}
			} else if (assistantText.length > 0) {
				assistantMsg.content = assistantText;
			}

			const toolCalls = msg.content.filter(isToolCallBlock);
			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((tc) => ({
					id: tc.id,
					type: "function" as const,
					function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
				}));
			}

			// Reasoning models require an (empty) reasoning_content field on every
			// assistant message when reasoning is enabled, even if this one had none.
			if (model.reasoning && (assistantMsg as { reasoning_content?: string }).reasoning_content === undefined) {
				(assistantMsg as { reasoning_content?: string }).reasoning_content = "";
			}

			// Skip empty assistant messages (no content, no tool calls).
			const content = assistantMsg.content;
			const hasContent =
				typeof content === "string" ? content.length > 0 : content !== null && content !== undefined && content.length > 0;
			if (!hasContent && !assistantMsg.tool_calls) continue;
			params.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
			let j = i;
			for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
				const toolMsg = transformedMessages[j] as ToolResultMessage;
				const textResult = toolMsg.content.filter(isTextContentBlock).map((block) => block.text).join("\n");
				const hasImages = toolMsg.content.some((c) => c.type === "image");
				const hasText = textResult.length > 0;
				const toolResultText = hasText ? textResult : hasImages ? "(see attached image)" : "(no tool output)";
				params.push({
					role: "tool",
					content: sanitizeSurrogates(toolResultText),
					tool_call_id: toolMsg.toolCallId,
				});
				if (hasImages && model.input.includes("image")) {
					for (const block of toolMsg.content) {
						if (isImageContentBlock(block)) {
							imageBlocks.push({
								type: "image_url",
								image_url: { url: `data:${block.mimeType};base64,${block.data}` },
							});
						}
					}
				}
			}
			i = j - 1;
			if (imageBlocks.length > 0) {
				params.push({
					role: "user",
					content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...imageBlocks],
				});
			}
			continue;
		}
	}

	return params;
}

function buildParams(
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
	const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(model, context),
		stream: true,
		store: false,
	} as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
	const extra = params as unknown as Record<string, unknown>;
	extra.stream_options = { include_usage: true };

	if (options?.maxTokens) {
		params.max_completion_tokens = options.maxTokens;
	}
	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}
	if (context.tools && context.tools.length > 0) {
		params.tools = convertTools(context.tools);
	}
	if (options?.toolChoice) {
		params.tool_choice = options.toolChoice;
	}

	// deepseek thinkingFormat: enabled via reasoning_effort, disabled otherwise.
	if (model.reasoning) {
		if (options?.reasoningEffort) {
			extra.thinking = { type: "enabled" };
			extra.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		} else if (model.thinkingLevelMap?.off !== null) {
			extra.thinking = { type: "disabled" };
		}
	}

	return params;
}

function parseChunkUsage(
	rawUsage: {
		prompt_tokens?: number;
		completion_tokens?: number;
		prompt_cache_hit_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
		completion_tokens_details?: { reasoning_tokens?: number };
	},
	model: Model<"openai-completions">,
): AssistantMessage["usage"] {
	const promptTokens = rawUsage.prompt_tokens || 0;
	const cacheReadTokens = rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? 0;
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	const outputTokens = rawUsage.completion_tokens || 0;
	const usage: AssistantMessage["usage"] = {
		input,
		output: outputTokens,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || 0,
		totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
	stopReason: StopReason;
	errorMessage?: string;
} {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		case "network_error":
			return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
		default:
			return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason}` };
	}
}

export const stream: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const eventStream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming | undefined;

		try {
			const apiKey = getClientApiKey(model.provider, options?.apiKey);
			const client = createClient(model, apiKey, options?.headers);
			params = buildParams(model, context, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: options?.maxRetries ?? Number(process.env.RETRY_MAX_ATTEMPTS ?? 5),
			};
			const { data: openaiStream, response } = await client.chat.completions
				.create(params, requestOptions)
				.withResponse();
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			eventStream.push({ type: "start", partial: output });

			interface StreamingToolCallBlock extends ToolCall {
				partialArgs?: string;
				streamIndex?: number;
			}
			type StreamingBlock = TextContent | ThinkingContent | StreamingToolCallBlock;
			type StreamingToolCallDelta = NonNullable<ChatCompletionChunk.Choice.Delta["tool_calls"]>[number];

			let textBlock: TextContent | null = null;
			let thinkingBlock: ThinkingContent | null = null;
			let hasFinishReason = false;
			const toolCallBlocksByIndex = new Map<number, StreamingToolCallBlock>();
			const toolCallBlocksById = new Map<string, StreamingToolCallBlock>();
			const blocks = output.content as StreamingBlock[];
			const getContentIndex = (block: StreamingBlock) => blocks.indexOf(block);

			const finishBlock = (block: StreamingBlock) => {
				const contentIndex = getContentIndex(block);
				if (contentIndex === -1) return;
				if (block.type === "text") {
					eventStream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
				} else if (block.type === "thinking") {
					eventStream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
				} else if (block.type === "toolCall") {
					block.arguments = parseStreamingJson(block.partialArgs);
					delete block.partialArgs;
					delete block.streamIndex;
					eventStream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
				}
			};
			const ensureTextBlock = () => {
				if (!textBlock) {
					textBlock = { type: "text", text: "" };
					blocks.push(textBlock);
					eventStream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
				}
				return textBlock;
			};
			const ensureThinkingBlock = (thinkingSignature: string) => {
				if (!thinkingBlock) {
					thinkingBlock = { type: "thinking", thinking: "", thinkingSignature };
					blocks.push(thinkingBlock);
					eventStream.push({ type: "thinking_start", contentIndex: getContentIndex(thinkingBlock), partial: output });
				}
				return thinkingBlock;
			};
			const ensureToolCallBlock = (toolCall: StreamingToolCallDelta) => {
				const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
				let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
				if (!block && toolCall.id) block = toolCallBlocksById.get(toolCall.id);
				if (!block) {
					block = {
						type: "toolCall",
						id: toolCall.id || "",
						name: toolCall.function?.name || "",
						arguments: {},
						partialArgs: "",
						streamIndex,
					};
					if (streamIndex !== undefined) toolCallBlocksByIndex.set(streamIndex, block);
					if (toolCall.id) toolCallBlocksById.set(toolCall.id, block);
					blocks.push(block);
					eventStream.push({ type: "toolcall_start", contentIndex: getContentIndex(block), partial: output });
				}
				if (streamIndex !== undefined && block.streamIndex === undefined) {
					block.streamIndex = streamIndex;
					toolCallBlocksByIndex.set(streamIndex, block);
				}
				if (toolCall.id) toolCallBlocksById.set(toolCall.id, block);
				return block;
			};

			for await (const chunk of openaiStream) {
				if (!chunk || typeof chunk !== "object") continue;

				output.responseId ||= chunk.id;
				if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
					output.responseModel ||= chunk.model;
				}
				if (chunk.usage) {
					output.usage = parseChunkUsage(chunk.usage, model);
				}

				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) continue;

				if (choice.finish_reason) {
					const finishReasonResult = mapStopReason(choice.finish_reason);
					output.stopReason = finishReasonResult.stopReason;
					if (finishReasonResult.errorMessage) output.errorMessage = finishReasonResult.errorMessage;
					hasFinishReason = true;
				}

				if (choice.delta) {
					if (choice.delta.content !== null && choice.delta.content !== undefined && choice.delta.content.length > 0) {
						const block = ensureTextBlock();
						block.text += choice.delta.content;
						eventStream.push({
							type: "text_delta",
							contentIndex: getContentIndex(block),
							delta: choice.delta.content,
							partial: output,
						});
					}

					// Reasoning models stream thinking in `reasoning_content`.
					const reasoning = (choice.delta as Record<string, unknown>).reasoning_content;
					if (typeof reasoning === "string" && reasoning.length > 0) {
						const block = ensureThinkingBlock("reasoning_content");
						block.thinking += reasoning;
						eventStream.push({ type: "thinking_delta", contentIndex: getContentIndex(block), delta: reasoning, partial: output });
					}

					if (choice.delta.tool_calls) {
						for (const toolCall of choice.delta.tool_calls) {
							const block = ensureToolCallBlock(toolCall);
							if (!block.id && toolCall.id) {
								block.id = toolCall.id;
								toolCallBlocksById.set(toolCall.id, block);
							}
							if (!block.name && toolCall.function?.name) block.name = toolCall.function.name;

							let delta = "";
							if (toolCall.function?.arguments) {
								delta = toolCall.function.arguments;
								block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
								block.arguments = parseStreamingJson(block.partialArgs);
							}
							eventStream.push({ type: "toolcall_delta", contentIndex: getContentIndex(block), delta, partial: output });
						}
					}
				}
			}

			for (const block of blocks) finishBlock(block);

			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "aborted") throw new Error("Request was aborted");
			if (output.stopReason === "error") throw new Error(output.errorMessage || "Provider returned an error stop reason");
			if (!hasFinishReason) throw new Error("Stream ended without finish_reason");

			eventStream.push({ type: "done", reason: output.stopReason, message: output });
			eventStream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { partialArgs?: string }).partialArgs;
				delete (block as { streamIndex?: number }).streamIndex;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			eventStream.push({ type: "error", reason: output.stopReason, error: output });
			eventStream.end();
		}

		saveModelTrace(params, output);
	})();

	return eventStream;
};

export const streamSimple: StreamFunction<"openai-completions", SimpleStreamOptions> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	getClientApiKey(model.provider, options?.apiKey);
	const base = buildBaseOptions(model, context, options, options?.apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
	const toolChoice = (options as OpenAICompletionsOptions | undefined)?.toolChoice;
	return stream(model, context, { ...base, reasoningEffort, toolChoice } satisfies OpenAICompletionsOptions);
};
