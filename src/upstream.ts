/**
 * Single fetch wrapper to chatgpt.com/backend-api/codex.
 * Adds OAuth headers, normalizes /responses bodies, surfaces errors.
 */

import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";

export interface UpstreamCallOpts {
	path: string;
	method?: "GET" | "POST";
	body?: Record<string, unknown>;
	signal?: AbortSignal;
	stream?: boolean;
}

export class UpstreamError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly upstreamCode?: string,
	) {
		super(message);
		this.name = "UpstreamError";
	}
}

/**
 * The Codex /responses endpoint requires a couple of fields default-set.
 * Public observation: omitting `instructions` returns 400, omitting `store` is
 * fine but explicit is safer. `max_output_tokens` is rejected.
 */
export function normalizeResponsesBody(body: Record<string, unknown>): Record<string, unknown> {
	const { max_output_tokens: _drop, ...rest } = body;
	const out = { ...rest };
	if (typeof out.instructions !== "string") out.instructions = "";
	if (out.store === undefined) out.store = false;
	return out;
}

export class Upstream {
	constructor(
		private readonly cfg: Config,
		private readonly auth: Auth,
	) {}

	async call(opts: UpstreamCallOpts): Promise<Response> {
		const url = `${this.cfg.upstreamBase}${opts.path}`;
		const headers: Record<string, string> = await this.auth.headers();
		if (opts.body !== undefined) headers["Content-Type"] = "application/json";
		if (opts.stream) headers.Accept = "text/event-stream";

		const init: RequestInit = {
			method: opts.method ?? (opts.body ? "POST" : "GET"),
			headers,
		};
		if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
		if (opts.signal) init.signal = opts.signal;

		const res = await fetch(url, init);
		return res;
	}

	async raiseForStatus(res: Response): Promise<void> {
		if (res.ok) return;
		let detail = "";
		let code: string | undefined;
		try {
			const t = await res.text();
			detail = t.slice(0, 500);
			const j = JSON.parse(t) as { error?: { code?: string; message?: string } };
			if (j?.error?.message) detail = j.error.message;
			if (j?.error?.code) code = j.error.code;
		} catch {
			/* keep raw */
		}
		throw new UpstreamError(
			`Upstream ${res.status}: ${detail || res.statusText}`,
			res.status,
			code,
		);
	}
}

/**
 * Minimal SSE parser yielding {type, data} per event.
 * Spec: https://html.spec.whatwg.org/multipage/server-sent-events.html
 */
export async function* parseSSE(
	res: Response,
): AsyncGenerator<{ type: string; data: Record<string, unknown> }> {
	if (!res.body) return;
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let bound = buf.indexOf("\n\n");
		while (bound !== -1) {
			const block = buf.slice(0, bound);
			buf = buf.slice(bound + 2);
			let payload = "";
			for (const line of block.split("\n")) {
				if (line.startsWith("data: ")) payload += line.slice(6);
				else if (line.startsWith("data:")) payload += line.slice(5);
			}
			if (payload && payload !== "[DONE]") {
				try {
					const obj = JSON.parse(payload) as Record<string, unknown>;
					yield { type: typeof obj.type === "string" ? obj.type : "unknown", data: obj };
				} catch {
					/* ignore */
				}
			}
			bound = buf.indexOf("\n\n");
		}
	}
}
