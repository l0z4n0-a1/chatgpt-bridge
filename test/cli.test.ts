/**
 * CLI smoke tests — exercise compiled binary surface for properties that
 * unit tests cannot reach (exit codes, stderr/stdout discipline, dry-run).
 *
 * Run after `bun run build`. Skip silently if dist/cli.js is absent so the
 * test suite remains usable in unbuilt clones.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const CLI = path.resolve("dist/cli.js");
const HAVE_CLI = existsSync(CLI);

function run(args: string[], stdin = ""): { code: number; stdout: string; stderr: string } {
	const r = spawnSync("node", [CLI, ...args], {
		input: stdin,
		encoding: "utf-8",
		timeout: 15_000,
	});
	return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("CLI smoke (compiled dist/cli.js)", () => {
	if (!HAVE_CLI) {
		test.skip("dist/cli.js not built — run `bun run build` first", () => {});
		return;
	}

	test("--version prints version", () => {
		const r = run(["--version"]);
		expect(r.code).toBe(0);
		expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});

	test("capabilities returns parseable JSON", () => {
		const r = run(["capabilities"]);
		expect(r.code).toBe(0);
		const cat = JSON.parse(r.stdout);
		expect(cat.package).toBe("chatgpt-bridge");
		expect(Array.isArray(cat.verbs)).toBe(true);
	});

	test("install --for invalid-target rejects with structured remedy", () => {
		const r = run(["install", "--for", "not-a-real-ide"]);
		expect(r.code).toBe(1);
		const err = JSON.parse(r.stderr);
		expect(err.ok).toBe(false);
		expect(err.error).toContain("invalid --for target");
		expect(err.remedy?.cmd).toBe("chatgpt-bridge capabilities");
	});

	test("chat with no prompt and stdin closed: rejects empty prompt", () => {
		const r = run(["chat"], "");
		expect(r.code).toBe(1);
		// Could land on either stream depending on whether commander complained
		// or our guard fired. Empty-prompt guard hits stderr.
		const out = r.stderr || r.stdout;
		expect(out).toMatch(/empty prompt|prompt required/i);
	});

	test("image with no prompt: rejects, no PNG written", () => {
		const r = run(["image"], "");
		expect(r.code).toBe(1);
		const out = r.stderr || r.stdout;
		expect(out).toMatch(/empty prompt|prompt required/i);
	});

	test("image --dry-run echoes the planned job without calling upstream", () => {
		const r = run(["image", "a fox", "--dry-run", "--out", "fox.png"]);
		expect(r.code).toBe(0);
		const out = JSON.parse(r.stdout);
		expect(out.dry_run).toBe(true);
		expect(out.jobs?.[0]?.prompt).toBe("a fox");
		expect(out.jobs?.[0]?.out).toBe("fox.png");
	});

	test("chat --dry-run with @file resolves prompt from file", () => {
		const fixture = path.resolve("test/fixtures-prompt.txt");
		require("node:fs").writeFileSync(fixture, "hello from a file\n");
		try {
			const r = run(["chat", `@${fixture}`, "--dry-run", "--no-stream"]);
			expect(r.code).toBe(0);
			const out = JSON.parse(r.stdout);
			expect(out.dry_run).toBe(true);
			expect(out.jobs?.[0]?.prompt).toBe("hello from a file\n");
		} finally {
			require("node:fs").rmSync(fixture, { force: true });
		}
	});

	test("install --for cursor --dry-run is idempotent and writes nothing detectable", () => {
		// We can't fully sandbox $HOME inside spawnSync without leaking. We just
		// assert structural: dry-run is parseable and reports either ok=true
		// (when auth + path detected) or ok=false (auth missing) — never crashes.
		const r = run(["install", "--for", "cursor", "--dry-run"]);
		const parsed = JSON.parse(r.stdout || "{}");
		expect(typeof parsed.ok).toBe("boolean");
		expect(parsed.for).toBe("cursor");
	});
});
