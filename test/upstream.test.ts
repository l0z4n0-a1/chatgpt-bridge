import { describe, expect, test } from "bun:test";
import { normalizeResponsesBody, parseSSE } from "../src/upstream.ts";

describe("normalizeResponsesBody", () => {
	test("defaults instructions and store, drops max_output_tokens", () => {
		const out = normalizeResponsesBody({
			model: "gpt-5.4-mini",
			input: [],
			max_output_tokens: 1000,
		});
		expect(out.instructions).toBe("");
		expect(out.store).toBe(false);
		expect(out.max_output_tokens).toBeUndefined();
	});

	test("preserves provided values", () => {
		const out = normalizeResponsesBody({
			instructions: "be brief",
			store: true,
		});
		expect(out.instructions).toBe("be brief");
		expect(out.store).toBe(true);
	});
});

describe("parseSSE", () => {
	test("parses two events split by \\n\\n", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				const enc = new TextEncoder();
				c.enqueue(enc.encode('data: {"type":"a","x":1}\n\ndata: {"type":"b","y":2}\n\n'));
				c.close();
			},
		});
		const res = new Response(stream);
		const events: { type: string; data: any }[] = [];
		for await (const ev of parseSSE(res)) events.push(ev);
		expect(events.length).toBe(2);
		expect(events[0]?.type).toBe("a");
		expect(events[1]?.data.y).toBe(2);
	});

	test("ignores [DONE] sentinel", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				const enc = new TextEncoder();
				c.enqueue(enc.encode("data: [DONE]\n\n"));
				c.close();
			},
		});
		const res = new Response(stream);
		const events: { type: string; data: any }[] = [];
		for await (const ev of parseSSE(res)) events.push(ev);
		expect(events.length).toBe(0);
	});
});
