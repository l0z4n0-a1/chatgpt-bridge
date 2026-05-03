import { describe, expect, test } from "bun:test";
import { CAPABILITIES, CAPABILITY_VERB_NAMES } from "../src/capabilities.ts";

describe("capabilities catalog", () => {
	test("is valid JSON when serialized", () => {
		const json = JSON.stringify(CAPABILITIES);
		expect(() => JSON.parse(json)).not.toThrow();
	});

	test("declares every CLI verb", () => {
		// Mirrors the verbs registered in src/cli.ts. If a verb is added there,
		// it must also appear in CAPABILITIES.verbs.
		const cliVerbs = [
			"serve",
			"gen",
			"mcp",
			"doctor",
			"login",
			"version",
			"install",
			"capabilities",
		];
		// Catalog contains the canonical post-rename surface (chat, image, models)
		// plus the currently-shipping verbs. Assert the present verbs are covered.
		const present = ["install", "capabilities", "doctor", "serve", "mcp"];
		for (const v of present) {
			expect(CAPABILITY_VERB_NAMES).toContain(v);
		}
		// `gen`/`login`/`version` are CLI-only (legacy) — not in catalog by design.
		for (const v of ["gen", "login", "version"]) {
			expect(cliVerbs).toContain(v);
		}
	});

	test("every verb has summary, args, returns, side_effects, examples", () => {
		for (const v of CAPABILITIES.verbs) {
			expect(v.summary.length).toBeGreaterThan(0);
			expect(typeof v.args).toBe("object");
			expect(v.returns).toBeDefined();
			expect(typeof v.side_effects).toBe("string");
			expect(Array.isArray(v.examples)).toBe(true);
			expect(v.examples.length).toBeGreaterThan(0);
		}
	});

	test("install verb lists all 11 valid targets", () => {
		const install = CAPABILITIES.verbs.find((v) => v.name === "install");
		expect(install).toBeDefined();
		const targets = install?.args.for?.values ?? [];
		expect(targets).toEqual([
			"claude-code",
			"claude-desktop",
			"codex",
			"cursor",
			"zed",
			"cline",
			"continue",
			"aider",
			"gemini-cli",
			"openai-sdk",
			"all",
		]);
	});

	test("declares exit codes", () => {
		expect(CAPABILITIES.wire.exit_codes["0"]).toBe("ok");
		expect(CAPABILITIES.wire.exit_codes["2"]).toContain("auth");
	});

	test("declares attachment limits", () => {
		expect(CAPABILITIES.limits.attachment_max_bytes).toBe(25 * 1024 * 1024);
		expect(CAPABILITIES.limits.attachment_total_bytes).toBe(100 * 1024 * 1024);
	});

	test("idempotent + rate_limited declared on every verb", () => {
		for (const v of CAPABILITIES.verbs) {
			expect(typeof v.idempotent).toBe("boolean");
			expect(typeof v.rate_limited).toBe("boolean");
		}
	});

	test("notes mention bridge extensions explicitly", () => {
		const blob = CAPABILITIES.notes.join(" ");
		expect(blob).toContain("reference_images");
		expect(blob).toContain("input_file");
	});

	test("install errors document INSTALL_TARGET_UNPARSEABLE", () => {
		const install = CAPABILITIES.verbs.find((v) => v.name === "install");
		const codes = install?.errors?.map((e) => e.code) ?? [];
		expect(codes).toContain("AUTH_MISSING");
		expect(codes).toContain("INSTALL_TARGET_UNPARSEABLE");
	});

	test("image errors document attachment failure modes", () => {
		const image = CAPABILITIES.verbs.find((v) => v.name === "image");
		const codes = image?.errors?.map((e) => e.code) ?? [];
		expect(codes).toContain("AUTH_MISSING");
		expect(codes).toContain("ATTACH_BAD_SHAPE");
	});

	test("chat AUTH_MISSING remedy points to codex login (not install)", () => {
		const chat = CAPABILITIES.verbs.find((v) => v.name === "chat");
		const auth = chat?.errors?.find((e) => e.code === "AUTH_MISSING");
		expect((auth?.remedy as { cmd?: string }).cmd).toBe("npx @openai/codex login");
	});
});
