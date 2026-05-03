import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseStdin, resolveAtFile } from "../src/io.ts";

describe("resolveAtFile", () => {
	test("returns the value verbatim when no @ prefix", async () => {
		expect(await resolveAtFile("hello world")).toBe("hello world");
	});

	test("reads file when value starts with @", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cgb-io-"));
		try {
			const p = path.join(dir, "prompt.md");
			await fs.writeFile(p, "# hello\n");
			const out = await resolveAtFile(`@${p}`);
			expect(out).toBe("# hello\n");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("@ prefix on missing file throws", async () => {
		await expect(resolveAtFile("@/nonexistent/path/xyz.txt")).rejects.toThrow();
	});
});

describe("parseStdin", () => {
	test("empty input → empty prompt, batch=false", () => {
		const r = parseStdin("");
		expect(r).toEqual({ batch: false, prompt: "" });
	});

	test("plain text → single prompt, batch=false", () => {
		const r = parseStdin("hello there\n");
		expect(r).toEqual({ batch: false, prompt: "hello there" });
	});

	test("multi-line plain text stays a single prompt", () => {
		const r = parseStdin("line one\nline two\nline three");
		expect(r).toEqual({ batch: false, prompt: "line one\nline two\nline three" });
	});

	test("JSONL → batch with parsed jobs", () => {
		const r = parseStdin('{"prompt":"a"}\n{"prompt":"b","out":"x.png"}\n');
		expect(r.batch).toBe(true);
		if (r.batch) {
			expect(r.jobs.length).toBe(2);
			expect(r.jobs[0]).toEqual({ prompt: "a" });
			expect(r.jobs[1]).toEqual({ prompt: "b", out: "x.png" });
		}
	});

	test("JSONL with blank lines is tolerated", () => {
		const r = parseStdin('{"prompt":"a"}\n\n{"prompt":"b"}\n');
		expect(r.batch).toBe(true);
		if (r.batch) expect(r.jobs.length).toBe(2);
	});

	test("malformed JSONL throws with line number", () => {
		expect(() => parseStdin('{"prompt":"a"}\nNOT JSON\n')).toThrow(/line 2/);
	});

	test("first line not starting with { → treated as plain prompt", () => {
		const r = parseStdin('hello\n{"prompt":"a"}\n');
		expect(r.batch).toBe(false);
	});
});
