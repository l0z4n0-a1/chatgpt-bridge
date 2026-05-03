/**
 * Wire tests for the multimodal translator + image reference plumbing.
 * No upstream calls — we test the body builders / shape transforms.
 */

import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { translateChatMessages } from "../src/server.ts";

async function withTmpCwd<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cgb-srv-"));
	const prev = process.cwd();
	process.chdir(dir);
	try {
		return await fn(dir);
	} finally {
		process.chdir(prev);
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

const cfg = loadConfig();

describe("translateChatMessages: passthrough cases", () => {
	test("string content is preserved", async () => {
		const out = await translateChatMessages([{ role: "user", content: "hi" }], cfg);
		expect(out).toEqual([{ role: "user", content: "hi" }]);
	});

	test("system → developer; tool → user; user/assistant unchanged", async () => {
		const out = await translateChatMessages(
			[
				{ role: "system", content: "be terse" },
				{ role: "tool", content: "tool reply" },
				{ role: "user", content: "q" },
				{ role: "assistant", content: "a" },
			],
			cfg,
		);
		expect(out[0]?.role).toBe("developer");
		expect(out[1]?.role).toBe("user");
		expect(out[2]?.role).toBe("user");
		expect(out[3]?.role).toBe("assistant");
	});
});

describe("translateChatMessages: vision parts", () => {
	test("text part → input_text", async () => {
		const out = await translateChatMessages(
			[{ role: "user", content: [{ type: "text", text: "hello" }] }],
			cfg,
		);
		const parts = out[0]?.content as Array<Record<string, unknown>>;
		expect(parts).toEqual([{ type: "input_text", text: "hello" }]);
	});

	test("image_url part with object → input_image (URL passes through)", async () => {
		const out = await translateChatMessages(
			[
				{
					role: "user",
					content: [{ type: "image_url", image_url: { url: "https://example.com/x.png" } }],
				},
			],
			cfg,
		);
		const parts = out[0]?.content as Array<Record<string, unknown>>;
		expect(parts[0]).toEqual({ type: "input_image", image_url: "https://example.com/x.png" });
	});

	test("image_url part with string → input_image", async () => {
		const out = await translateChatMessages(
			[
				{
					role: "user",
					content: [{ type: "image_url", image_url: "data:image/png;base64,AAA" }],
				},
			],
			cfg,
		);
		const parts = out[0]?.content as Array<Record<string, unknown>>;
		expect(parts[0]).toEqual({
			type: "input_image",
			image_url: "data:image/png;base64,AAA",
		});
	});

	test("input_file part with {path} → resolved + base64", async () => {
		await withTmpCwd(async () => {
			await fs.writeFile("spec.md", "# spec");
			const out = await translateChatMessages(
				[
					{
						role: "user",
						content: [
							{ type: "text", text: "audit this" },
							{ type: "input_file", file: { path: "./spec.md" } },
						],
					},
				],
				cfg,
			);
			const parts = out[0]?.content as Array<Record<string, unknown>>;
			expect(parts[0]).toEqual({ type: "input_text", text: "audit this" });
			const filePart = parts[1] as { type: string; filename: string; file_data: string };
			expect(filePart.type).toBe("input_file");
			expect(filePart.filename).toBe("spec.md");
			expect(filePart.file_data).toContain("data:text/markdown;base64,");
		});
	});

	test("input_file with image extension → input_image (auto-routed)", async () => {
		await withTmpCwd(async () => {
			await fs.writeFile("pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
			const out = await translateChatMessages(
				[
					{
						role: "user",
						content: [{ type: "input_file", file: { path: "./pic.png" } }],
					},
				],
				cfg,
			);
			const parts = out[0]?.content as Array<Record<string, unknown>>;
			expect(parts[0]?.type).toBe("input_image");
		});
	});

	test("input_file part with {url} → URL passed through, no fetch", async () => {
		const out = await translateChatMessages(
			[
				{
					role: "user",
					content: [{ type: "input_file", file: { url: "https://example.com/page.md" } }],
				},
			],
			cfg,
		);
		const parts = out[0]?.content as Array<Record<string, unknown>>;
		const f = parts[0] as { type: string; file_data?: string };
		expect(f.type).toBe("input_file");
		expect(f.file_data).toBe("https://example.com/page.md");
	});

	test("Responses-native parts pass through verbatim", async () => {
		const out = await translateChatMessages(
			[
				{
					role: "user",
					content: [
						{ type: "input_text", text: "raw" },
						{ type: "input_image", image_url: "https://example.com/y.png" },
					],
				},
			],
			cfg,
		);
		const parts = out[0]?.content as Array<Record<string, unknown>>;
		expect(parts[0]).toEqual({ type: "input_text", text: "raw" });
		expect(parts[1]).toEqual({ type: "input_image", image_url: "https://example.com/y.png" });
	});

	test("unknown part types pass through (forward-compat)", async () => {
		const out = await translateChatMessages(
			[
				{
					role: "user",
					content: [{ type: "future_part_type", payload: { x: 1 } }],
				},
			],
			cfg,
		);
		const parts = out[0]?.content as Array<Record<string, unknown>>;
		expect(parts[0]).toEqual({ type: "future_part_type", payload: { x: 1 } });
	});

	test("input_file without file.path/url/data throws ATTACH_BAD_SHAPE", async () => {
		await expect(
			translateChatMessages(
				[
					{
						role: "user",
						content: [{ type: "input_file", file: {} }],
					},
				],
				cfg,
			),
		).rejects.toThrow(/file\.path|bad/i);
	});
});

describe("ImageRequest schema accepts reference_images", () => {
	test("validates with refs as strings/urls/objects", async () => {
		const { ImageRequest } = await import("../src/images.ts");
		const ok = ImageRequest.safeParse({
			prompt: "fox",
			reference_images: [
				"./mood.png",
				"https://example.com/style.jpg",
				{ data: "AAAA", mime: "image/png" },
				{ url: "https://example.com/y.png" },
				{ path: "./logo.svg" },
			],
		});
		expect(ok.success).toBe(true);
	});

	test("caps at 8 references", async () => {
		const { ImageRequest } = await import("../src/images.ts");
		const r = ImageRequest.safeParse({
			prompt: "x",
			reference_images: new Array(9).fill("./a.png"),
		});
		expect(r.success).toBe(false);
	});

	test("backward compat: no reference_images is valid", async () => {
		const { ImageRequest } = await import("../src/images.ts");
		const r = ImageRequest.safeParse({ prompt: "fox" });
		expect(r.success).toBe(true);
	});
});
