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
import { AttachmentSpec, resolveAttachments } from "./attachments.ts";
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
		// Bridge extension (non-portable to api.openai.com): reference images
		// shape style/composition. Each entry can be a path, URL, data-URL, or
		// a structured {path|url|data,mime} object.
		reference_images: z.array(AttachmentSpec).max(8).optional(),
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

const DEVELOPER_PROMPT_WITH_REFS =
	"You are an image-generation assistant. The user has provided one or more reference images. Inspect them, then invoke the image_generation tool to render a NEW image whose style, composition, palette, and mood are coherent with the references — without copying them verbatim. Render at maximum technical quality. Do not add disclaimers.";

async function buildBody(cfg: Config, req: ImageRequest): Promise<Record<string, unknown>> {
	const refs = req.reference_images ?? [];
	const hasRefs = refs.length > 0;

	const userContent: Array<Record<string, unknown>> = [];
	if (hasRefs) {
		const { parts } = await resolveAttachments(refs, {}, cfg);
		// Reference images first so the model "sees" them before reading the
		// instruction. Empirically this produces stronger style transfer.
		for (const p of parts) {
			if (p.type === "input_image") userContent.push(p);
		}
		userContent.push({ type: "input_text", text: `Generate an image: ${req.prompt}` });
	}

	return {
		model: cfg.imageModel,
		input: [
			{ role: "developer", content: hasRefs ? DEVELOPER_PROMPT_WITH_REFS : DEVELOPER_PROMPT },
			hasRefs
				? { role: "user", content: userContent }
				: { role: "user", content: `Generate an image: ${req.prompt}` },
		],
		tools: [
			{
				type: "image_generation",
				quality: req.quality,
				size: req.size,
				moderation: req.moderation,
			},
		],
		// With references present the model needs latitude to look before
		// invoking the tool. Without refs we keep the strict tool_choice.
		tool_choice: hasRefs ? "auto" : "required",
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
	const body = await buildBody(cfg, req);
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
