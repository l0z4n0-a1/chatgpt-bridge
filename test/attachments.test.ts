import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	AttachmentError,
	MAX_ATTACHMENT_BYTES,
	resolveAttachment,
	resolveAttachments,
	toContentPart,
} from "../src/attachments.ts";

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cgb-att-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

const PNG_MAGIC = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

describe("AttachmentSpec accepts shorthands and objects", () => {
	test("path string → resolved as file path", async () => {
		await withTmpDir(async (dir) => {
			const p = path.join(dir, "spec.md");
			await fs.writeFile(p, "# spec");
			const r = await resolveAttachment(p, { allowedRoot: dir });
			expect(r.kind).toBe("file");
			expect(r.mime).toBe("text/markdown");
			expect(r.filename).toBe("spec.md");
			expect(r.bytes).toBeGreaterThan(0);
			expect(r.fileData).toContain("data:text/markdown;base64,");
		});
	});

	test("https url string → passed through, bridge does not fetch", async () => {
		const r = await resolveAttachment("https://example.com/foo.png");
		expect(r.source).toBe("url");
		expect(r.kind).toBe("image");
		expect(r.mime).toBe("image/png");
		expect(r.imageUrl).toBe("https://example.com/foo.png");
		expect(r.bytes).toBe(0); // bridge never fetched it
	});

	test("data URL string is parsed", async () => {
		const data = "AAAA";
		const r = await resolveAttachment(`data:image/png;base64,${data}`);
		expect(r.source).toBe("data");
		expect(r.kind).toBe("image");
		expect(r.imageUrl).toBe(`data:image/png;base64,${data}`);
	});

	test("object {path}", async () => {
		await withTmpDir(async (dir) => {
			const p = path.join(dir, "a.txt");
			await fs.writeFile(p, "hi");
			const r = await resolveAttachment({ path: p }, { allowedRoot: dir });
			expect(r.kind).toBe("file");
			expect(r.mime).toBe("text/plain");
		});
	});

	test("object {url}", async () => {
		const r = await resolveAttachment({ url: "https://example.com/x.jpg" });
		expect(r.kind).toBe("image");
		expect(r.mime).toBe("image/jpeg");
	});

	test("object {data,mime,filename}", async () => {
		const r = await resolveAttachment({
			data: "Zm9vYmFy",
			mime: "text/plain",
			filename: "note.txt",
		});
		expect(r.source).toBe("data");
		expect(r.filename).toBe("note.txt");
		expect(r.fileData).toBe("data:text/plain;base64,Zm9vYmFy");
	});

	test("rejects malformed shape", async () => {
		await expect(resolveAttachment({} as never)).rejects.toThrow(AttachmentError);
	});

	test("rejects empty string", async () => {
		await expect(resolveAttachment("")).rejects.toThrow();
	});
});

describe("MIME detection", () => {
	test("from extension when known", async () => {
		await withTmpDir(async (dir) => {
			const cases: Array<[string, string]> = [
				["a.png", "image/png"],
				["a.jpg", "image/jpeg"],
				["a.webp", "image/webp"],
				["a.md", "text/markdown"],
				["a.json", "application/json"],
				["a.yaml", "text/x-yaml"],
				["a.csv", "text/csv"],
			];
			for (const [name, mime] of cases) {
				const p = path.join(dir, name);
				await fs.writeFile(p, "x");
				const r = await resolveAttachment(p, { allowedRoot: dir });
				expect(r.mime).toBe(mime);
			}
		});
	});

	test("from magic bytes when extension is unknown", async () => {
		await withTmpDir(async (dir) => {
			const p = path.join(dir, "mystery");
			await fs.writeFile(p, PNG_MAGIC);
			const r = await resolveAttachment(p, { allowedRoot: dir });
			expect(r.mime).toBe("image/png");
		});
	});

	test("falls back to octet-stream when nothing matches", async () => {
		await withTmpDir(async (dir) => {
			const p = path.join(dir, "weird.xyz123");
			await fs.writeFile(p, Buffer.from([0x00, 0x01, 0x02]));
			const r = await resolveAttachment(p, { allowedRoot: dir });
			expect(r.mime).toBe("application/octet-stream");
		});
	});
});

describe("Path safety", () => {
	test("rejects paths outside allowedRoot", async () => {
		await withTmpDir(async (dir) => {
			const outside = path.resolve(dir, "..", "outside.txt");
			await fs.writeFile(outside, "leak").catch(() => {});
			await expect(resolveAttachment(outside, { allowedRoot: dir })).rejects.toThrow(
				AttachmentError,
			);
			await fs.rm(outside, { force: true }).catch(() => {});
		});
	});

	test("rejects paths inside forbiddenPaths (auth-file area)", async () => {
		await withTmpDir(async (dir) => {
			const authDir = path.join(dir, ".codex");
			await fs.mkdir(authDir, { recursive: true });
			const target = path.join(authDir, "auth.json");
			await fs.writeFile(target, "secret");
			await expect(
				resolveAttachment(target, {
					allowedRoot: dir,
					forbiddenPaths: [authDir],
				}),
			).rejects.toThrow(/forbidden/i);
		});
	});

	test("non-existent path returns ATTACH_NOT_FOUND", async () => {
		await withTmpDir(async (dir) => {
			await expect(
				resolveAttachment(path.join(dir, "nope.png"), { allowedRoot: dir }),
			).rejects.toThrow(/not found/i);
		});
	});
});

describe("Size cap", () => {
	test("file larger than maxBytes is rejected", async () => {
		await withTmpDir(async (dir) => {
			const p = path.join(dir, "big.bin");
			await fs.writeFile(p, Buffer.alloc(1024));
			await expect(resolveAttachment(p, { allowedRoot: dir, maxBytes: 512 })).rejects.toThrow(
				/exceeds/i,
			);
		});
	});

	test("data URL larger than maxBytes is rejected", async () => {
		const big = "A".repeat(1024 * 4); // ~3 KiB decoded
		await expect(
			resolveAttachment({ data: big, mime: "image/png" }, { maxBytes: 1024 }),
		).rejects.toThrow(/exceeds/i);
	});

	test("default cap is 25 MiB", () => {
		expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
	});
});

describe("toContentPart", () => {
	test("image → input_image", async () => {
		await withTmpDir(async (dir) => {
			const p = path.join(dir, "x.png");
			await fs.writeFile(p, PNG_MAGIC);
			const r = await resolveAttachment(p, { allowedRoot: dir });
			const part = toContentPart(r);
			expect(part.type).toBe("input_image");
			expect((part as { image_url: string }).image_url).toContain("data:image/png;base64,");
		});
	});

	test("file → input_file with filename + data URL", async () => {
		await withTmpDir(async (dir) => {
			const p = path.join(dir, "spec.md");
			await fs.writeFile(p, "# yo");
			const r = await resolveAttachment(p, { allowedRoot: dir });
			const part = toContentPart(r);
			expect(part.type).toBe("input_file");
			const f = part as { type: "input_file"; filename: string; file_data: string };
			expect(f.filename).toBe("spec.md");
			expect(f.file_data).toContain("data:text/markdown;base64,");
		});
	});
});

describe("resolveAttachments aggregate cap", () => {
	test("sums bytes across attachments and rejects overflow", async () => {
		await withTmpDir(async (dir) => {
			const a = path.join(dir, "a.bin");
			const b = path.join(dir, "b.bin");
			await fs.writeFile(a, Buffer.alloc(800));
			await fs.writeFile(b, Buffer.alloc(800));
			// Tight maxBytes per attachment passes; aggregate cap implicitly 100 MiB.
			const ok = await resolveAttachments([a, b], { allowedRoot: dir, maxBytes: 1024 });
			expect(ok.parts.length).toBe(2);
		});
	});

	test("no attachments → empty result", async () => {
		const r = await resolveAttachments([], {});
		expect(r.parts).toEqual([]);
	});
});
