/**
 * HTTP server. Six routes, all in this file. Total ~150 lines.
 *
 *   GET  /health                  — auth + rate snapshot
 *   GET  /v1/models               — list models (with synthetic image aliases)
 *   POST /v1/responses            — pass-through with body normalization
 *   POST /v1/chat/completions     — thin Chat→Responses translator
 *   POST /v1/images/generations   — generate image via image_generation tool
 *   ALL  /v1/*                    — passthrough for forward-compat
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Auth, tokenExpiryMs } from "./auth.ts";
import type { Config } from "./config.ts";
import { ImageRequest, generateImage } from "./images.ts";
import type { UpstreamError } from "./upstream.ts";
import { Upstream, normalizeResponsesBody, parseSSE } from "./upstream.ts";

interface Hits {
	hits: number[];
}
const rateState: Hits = { hits: [] };

function rateUsed(): number {
	const cutoff = Date.now() - 60 * 60 * 1000;
	rateState.hits = rateState.hits.filter((t) => t > cutoff);
	return rateState.hits.length;
}

function rateRecord(): void {
	rateState.hits.push(Date.now());
}

function errBody(message: string, code: string, status: number) {
	return { error: { type: "invalid_request_error", code, message }, _status: status };
}

function asResponse(c: any, body: ReturnType<typeof errBody>) {
	const { _status, ...rest } = body;
	return c.json(rest, _status);
}

export function createApp(cfg: Config) {
	const auth = new Auth(cfg);
	const upstream = new Upstream(cfg, auth);
	const app = new Hono();

	app.get("/health", async (c) => {
		try {
			const t = await auth.ensure();
			const exp = tokenExpiryMs(t.accessToken);
			const used = rateUsed();
			return c.json({
				ok: true,
				version: VERSION,
				auth: {
					loaded: true,
					source_path: t.sourcePath,
					last_refresh: t.lastRefresh ?? null,
					expires_in_seconds:
						typeof exp === "number" ? Math.max(0, Math.floor((exp - Date.now()) / 1000)) : null,
				},
				rate_limit: { hourly_used: used, hourly_hard: cfg.rateHourlyHard },
			});
		} catch (e) {
			return c.json({ ok: false, error: (e as Error).message }, 503);
		}
	});

	app.get("/v1/models", async (c) => {
		try {
			const res = await upstream.call({
				path: `/models?client_version=${encodeURIComponent(cfg.clientVersion)}`,
				method: "GET",
			});
			await upstream.raiseForStatus(res);
			const j = (await res.json()) as { models?: Array<{ slug?: unknown }> };
			const real = (j.models ?? [])
				.map((m) => m.slug)
				.filter((s): s is string => typeof s === "string");
			const synthetic = ["gpt-image-2", "gpt-image-1", "dall-e-3"];
			const ids = Array.from(new Set([...real, ...synthetic]));
			return c.json({
				object: "list",
				data: ids.map((id) => ({
					id,
					object: "model",
					created: 0,
					owned_by: "chatgpt-bridge",
				})),
			});
		} catch (e) {
			return asResponse(c, errBody((e as Error).message, "MODELS_FAILED", 502));
		}
	});

	app.post("/v1/responses", async (c) => {
		let body: Record<string, unknown>;
		try {
			body = (await c.req.json()) as Record<string, unknown>;
		} catch {
			return asResponse(c, errBody("invalid JSON body", "BAD_REQUEST", 400));
		}
		const wantStream = body.stream === true;
		try {
			const res = await upstream.call({
				path: "/responses",
				method: "POST",
				body: normalizeResponsesBody(body),
				stream: wantStream,
			});
			await upstream.raiseForStatus(res);
			if (wantStream && res.headers.get("content-type")?.includes("text/event-stream")) {
				return new Response(res.body, {
					status: 200,
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
					},
				});
			}
			const text = await res.text();
			return new Response(text, {
				status: 200,
				headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" },
			});
		} catch (e) {
			const u = e as UpstreamError;
			return asResponse(c, errBody(u.message, u.upstreamCode ?? "UPSTREAM_ERROR", u.status ?? 502));
		}
	});

	app.post("/v1/chat/completions", async (c) => {
		let body: any;
		try {
			body = await c.req.json();
		} catch {
			return asResponse(c, errBody("invalid JSON body", "BAD_REQUEST", 400));
		}
		if (!Array.isArray(body?.messages)) {
			return asResponse(c, errBody("messages must be an array", "BAD_REQUEST", 400));
		}
		const wantStream = body.stream === true;
		// Upstream Codex /responses requires stream:true. Always force it; if the
		// caller wanted non-stream, we aggregate the SSE and return a single Chat
		// completion object.
		const upstreamBody: Record<string, unknown> = {
			model: body.model ?? "gpt-5.2",
			input: body.messages.map((m: any) => ({
				role: m.role === "system" ? "developer" : m.role === "tool" ? "user" : m.role,
				content: m.content,
			})),
			stream: true,
			store: false,
			instructions: "",
		};
		if (typeof body.temperature === "number") upstreamBody.temperature = body.temperature;
		if (typeof body.top_p === "number") upstreamBody.top_p = body.top_p;

		try {
			const res = await upstream.call({
				path: "/responses",
				method: "POST",
				body: upstreamBody,
				stream: true,
			});
			await upstream.raiseForStatus(res);

			if (!wantStream) {
				let text = "";
				let usage: unknown;
				for await (const ev of parseSSE(res)) {
					if (ev.type === "response.output_text.delta") {
						const delta = (ev.data as any).delta ?? "";
						if (typeof delta === "string") text += delta;
					}
					if (ev.type === "response.completed") {
						usage = (ev.data as any).response?.usage;
					}
				}
				return c.json({
					id: `chatcmpl_${crypto.randomUUID()}`,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model: body.model ?? "gpt-5.2",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: text || null },
							finish_reason: "stop",
						},
					],
					usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
				});
			}

			const id = `chatcmpl_${crypto.randomUUID()}`;
			const enc = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					try {
						for await (const ev of parseSSE(res)) {
							if (ev.type === "response.output_text.delta") {
								const delta = (ev.data as any).delta ?? "";
								if (delta) {
									controller.enqueue(
										enc.encode(
											`data: ${JSON.stringify({
												id,
												object: "chat.completion.chunk",
												created: Math.floor(Date.now() / 1000),
												model: body.model ?? "gpt-5.2",
												choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
											})}\n\n`,
										),
									);
								}
							}
							if (ev.type === "response.completed") {
								controller.enqueue(
									enc.encode(
										`data: ${JSON.stringify({
											id,
											object: "chat.completion.chunk",
											created: Math.floor(Date.now() / 1000),
											model: body.model ?? "gpt-5.2",
											choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
										})}\n\n`,
									),
								);
							}
						}
						controller.enqueue(enc.encode("data: [DONE]\n\n"));
						controller.close();
					} catch (e) {
						controller.error(e);
					}
				},
			});
			return new Response(stream, {
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				},
			});
		} catch (e) {
			const u = e as UpstreamError;
			return asResponse(c, errBody(u.message, u.upstreamCode ?? "UPSTREAM_ERROR", u.status ?? 502));
		}
	});

	app.post("/v1/images/generations", async (c) => {
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			return asResponse(c, errBody("invalid JSON body", "BAD_REQUEST", 400));
		}
		const parsed = ImageRequest.safeParse(raw);
		if (!parsed.success) {
			const msg = parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
			return asResponse(c, errBody(msg, "BAD_REQUEST", 400));
		}
		const used = rateUsed();
		if (used >= cfg.rateHourlyHard) {
			return asResponse(
				c,
				errBody(
					`Hourly limit reached (${used}/${cfg.rateHourlyHard}). Retry in <1h.`,
					"RATE_LIMITED",
					429,
				),
			);
		}
		try {
			const result = await generateImage(cfg, upstream, parsed.data);
			rateRecord();
			return c.json({
				created: Math.floor(Date.now() / 1000),
				data: [
					{
						b64_json: result.b64,
						...(result.revisedPrompt ? { revised_prompt: result.revisedPrompt } : {}),
					},
				],
				usage: result.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
			});
		} catch (e) {
			const u = e as UpstreamError;
			return asResponse(
				c,
				errBody(
					u.message ?? "image generation failed",
					u.upstreamCode ?? "GENERATION_FAILED",
					u.status ?? 502,
				),
			);
		}
	});

	app.all("/v1/*", async (c) => {
		const url = new URL(c.req.url);
		let p = url.pathname;
		if (p.startsWith("/v1/")) p = p.slice(3);
		else if (p === "/v1") p = "/";
		if (url.search) p += url.search;
		let body: Record<string, unknown> | undefined;
		if (c.req.method === "POST") {
			try {
				body = (await c.req.json()) as Record<string, unknown>;
			} catch {
				/* ignore */
			}
		}
		try {
			const res = await upstream.call({
				path: p,
				method: c.req.method as "GET" | "POST",
				body,
			});
			await upstream.raiseForStatus(res);
			const text = await res.text();
			return new Response(text, {
				status: res.status,
				headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" },
			});
		} catch (e) {
			const u = e as UpstreamError;
			return asResponse(c, errBody(u.message, u.upstreamCode ?? "UPSTREAM_ERROR", u.status ?? 502));
		}
	});

	return { app, auth, upstream };
}

export const VERSION = "0.2.0";

// Re-exported with this constant; /health and CLI both use it.
// Bumping a release: change here + package.json + CHANGELOG.md.

export async function startServer(cfg: Config): Promise<{ close: () => Promise<void> }> {
	const { app } = createApp(cfg);
	const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port });
	console.error(`chatgpt-bridge listening on http://${cfg.host}:${cfg.port}/v1`);

	const shutdown = () => {
		console.error("shutting down");
		server.close();
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	return {
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}
