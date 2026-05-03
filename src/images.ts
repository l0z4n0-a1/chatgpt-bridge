/**
 * /v1/images/generations — translates the OpenAI Images request to a
 * /v1/responses call with the image_generation built-in tool, then extracts
 * the base64 result from the SSE stream.
 *
 * Discovery: the OpenAI Responses API exposes `image_generation` as a tool
 * (documented at developers.openai.com/api/docs/guides/image-generation).
 * The same tool is available through the OAuth-authenticated upstream.
 *
 * Original developer prompt below. Short, direct. No clever guardrails —
 * the upstream model already enforces safety.
 */

import { z } from "zod";
import type { Config } from "./config.ts";
import { type Upstream, UpstreamError, parseSSE } from "./upstream.ts";

export const ImageRequest = z
	.object({
		model: z.string().optional(),
		prompt: z.string().min(1).max(32_000),
		n: z.number().int().min(1).max(1).optional().default(1),
		size: z.enum(["1024x1024", "1024x1536", "1536x1024", "auto"]).optional().default("1024x1024"),
		quality: z.enum(["low", "medium", "high", "auto"]).optional().default("high"),
		response_format: z.enum(["b64_json", "url"]).optional().default("b64_json"),
		moderation: z.enum(["low", "auto"]).optional().default("low"),
		user: z.string().optional(),
	})
	.passthrough();

export type ImageRequest = z.infer<typeof ImageRequest>;

export interface ImageResult {
	b64: string;
	revisedPrompt?: string;
	usage?: unknown;
}

const DEVELOPER_PROMPT =
	"You are an image-generation assistant. Always invoke the image_generation tool. Pass the user's prompt through unchanged unless it is genuinely underspecified. Render at maximum technical quality for the chosen style. Do not add disclaimers.";

function buildBody(cfg: Config, req: ImageRequest): Record<string, unknown> {
	return {
		model: cfg.imageModel,
		input: [
			{ role: "developer", content: DEVELOPER_PROMPT },
			{ role: "user", content: `Generate an image: ${req.prompt}` },
		],
		tools: [
			{
				type: "image_generation",
				quality: req.quality,
				size: req.size,
				moderation: req.moderation,
			},
		],
		tool_choice: "required",
		reasoning: { effort: "low" },
		stream: true,
		store: false,
		instructions: "",
	};
}

export async function generateImage(
	cfg: Config,
	upstream: Upstream,
	req: ImageRequest,
	signal?: AbortSignal,
): Promise<ImageResult> {
	const body = buildBody(cfg, req);
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
	const composed = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;
	try {
		const res = await upstream.call({
			path: "/responses",
			method: "POST",
			body,
			stream: true,
			signal: composed,
		});
		await upstream.raiseForStatus(res);

		let b64: string | undefined;
		let revisedPrompt: string | undefined;
		let usage: unknown;
		let events = 0;

		for await (const ev of parseSSE(res)) {
			events++;
			if (ev.type === "response.output_item.done") {
				const item = (ev.data as { item?: Record<string, unknown> }).item;
				if (item && item.type === "image_generation_call") {
					if (typeof item.result === "string" && item.result.length > 0) {
						b64 = item.result;
					}
					if (typeof item.revised_prompt === "string") {
						revisedPrompt = item.revised_prompt;
					}
				}
			}
			if (ev.type === "response.completed") {
				usage = (ev.data as { response?: { usage?: unknown } }).response?.usage;
			}
			if (ev.type === "error") {
				throw new UpstreamError("Upstream stream returned error", 502);
			}
		}

		if (!b64) {
			throw new UpstreamError(`No image data after ${events} stream events`, 502);
		}
		const result: ImageResult = { b64 };
		if (revisedPrompt) result.revisedPrompt = revisedPrompt;
		if (usage) result.usage = usage;
		return result;
	} finally {
		clearTimeout(timer);
	}
}
