/**
 * Install adaptor tests.
 *
 * Strategy: redirect HOME to a tmpdir for each test so we never touch the
 * developer's real config files. Auth is missing in the tmpdir, so most
 * runs return AUTH_MISSING — we test the remedy shape. Snippet-only
 * targets (openai-sdk, aider) bypass auth and let us exercise the writers.
 *
 * Where we do want to exercise the JSON writer, we use --uninstall on a
 * fresh tmpdir (which short-circuits the auth check in install.ts).
 */

import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInstall } from "../src/install.ts";

async function withTmpHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cgb-install-"));
	const prevHome = process.env.HOME;
	const prevUserprofile = process.env.USERPROFILE;
	const prevAppdata = process.env.APPDATA;
	const prevXdg = process.env.XDG_CONFIG_HOME;
	process.env.HOME = dir;
	process.env.USERPROFILE = dir;
	process.env.APPDATA = path.join(dir, "AppData", "Roaming");
	process.env.XDG_CONFIG_HOME = path.join(dir, ".config");
	try {
		return await fn(dir);
	} finally {
		process.env.HOME = prevHome;
		process.env.USERPROFILE = prevUserprofile;
		process.env.APPDATA = prevAppdata;
		process.env.XDG_CONFIG_HOME = prevXdg;
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

describe("install: snippet-only targets", () => {
	test("openai-sdk returns next_step snippet, writes nothing", async () => {
		await withTmpHome(async (home) => {
			const r = await runInstall("openai-sdk");
			expect(Array.isArray(r)).toBe(false);
			const single = r as { ok: boolean; next_step?: string };
			expect(single.ok).toBe(true);
			expect(single.next_step).toContain("base_url");
			// Nothing was written
			const entries = await fs.readdir(home);
			expect(entries.filter((e) => !e.startsWith("."))).toEqual([]);
		});
	});

	test("aider returns next_step snippet", async () => {
		await withTmpHome(async () => {
			const r = await runInstall("aider");
			const single = r as { ok: boolean; next_step?: string };
			expect(single.ok).toBe(true);
			expect(single.next_step).toContain("--openai-api-base");
		});
	});
});

describe("install: auth missing", () => {
	test("claude-code returns AUTH_MISSING with structured remedy", async () => {
		await withTmpHome(async () => {
			const r = await runInstall("claude-code");
			const single = r as {
				ok: boolean;
				error?: string;
				remedy?: { cmd?: string; interactive?: boolean; next?: string };
			};
			expect(single.ok).toBe(false);
			expect(single.error).toContain("auth.json not found");
			expect(single.remedy?.cmd).toBe("npx @openai/codex login");
			expect(single.remedy?.interactive).toBe(true);
			expect(single.remedy?.next).toBe("chatgpt-bridge install --for claude-code");
		});
	});
});

describe("install: uninstall is idempotent and bypasses auth", () => {
	test("uninstall on never-installed target returns ok", async () => {
		await withTmpHome(async () => {
			const r = await runInstall("cursor", { uninstall: true });
			const single = r as { ok: boolean; config_path?: string };
			expect(single.ok).toBe(true);
			expect(single.config_path).toContain(".cursor");
		});
	});

	test("install + uninstall round-trip writes then removes the entry", async () => {
		await withTmpHome(async (home) => {
			// Pre-seed a fake auth.json so install passes the auth check.
			const codexDir = path.join(home, ".codex");
			await fs.mkdir(codexDir, { recursive: true });
			// Build a minimal valid-looking auth.json. Auth.ensure() will try to
			// refresh because exp is unset and it'll fail at network — so we
			// short-circuit by setting a far-future exp via a fake JWT.
			const farFuture = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
			const enc = (o: unknown) =>
				Buffer.from(JSON.stringify(o)).toString("base64url").replace(/=+$/, "");
			const idTok = `${enc({ alg: "none" })}.${enc({
				exp: farFuture,
				"https://api.openai.com/auth": { chatgpt_account_id: "acc-test" },
			})}.sig`;
			const accessTok = `${enc({ alg: "none" })}.${enc({ exp: farFuture })}.sig`;
			await fs.writeFile(
				path.join(codexDir, "auth.json"),
				JSON.stringify({
					auth_mode: "chatgpt",
					tokens: {
						id_token: idTok,
						access_token: accessTok,
						refresh_token: "rt",
						account_id: "acc-test",
					},
					last_refresh: new Date().toISOString(),
				}),
				"utf-8",
			);

			// 1. Install: registers the entry
			const r1 = await runInstall("cursor");
			const s1 = r1 as { ok: boolean; config_path?: string; already_installed?: boolean };
			expect(s1.ok).toBe(true);
			expect(s1.already_installed).toBe(false);
			const cfg1 = JSON.parse(await fs.readFile(s1.config_path as string, "utf-8")) as {
				mcpServers: Record<string, { command: string; args: string[] }>;
			};
			expect(cfg1.mcpServers["chatgpt-bridge"]).toBeDefined();
			expect(cfg1.mcpServers["chatgpt-bridge"]?.command).toBe("npx");

			// 2. Re-install: idempotent, reports already_installed
			const r2 = await runInstall("cursor");
			const s2 = r2 as { ok: boolean; already_installed?: boolean };
			expect(s2.ok).toBe(true);
			expect(s2.already_installed).toBe(true);

			// 3. Uninstall: removes entry, preserves other keys
			const cfgPath = s1.config_path as string;
			const before = JSON.parse(await fs.readFile(cfgPath, "utf-8")) as {
				mcpServers: Record<string, unknown>;
				other?: string;
			};
			before.other = "preserve-me";
			await fs.writeFile(cfgPath, JSON.stringify(before), "utf-8");

			const r3 = await runInstall("cursor", { uninstall: true });
			const s3 = r3 as { ok: boolean };
			expect(s3.ok).toBe(true);
			const after = JSON.parse(await fs.readFile(cfgPath, "utf-8")) as {
				mcpServers: Record<string, unknown>;
				other?: string;
			};
			expect(after.mcpServers["chatgpt-bridge"]).toBeUndefined();
			expect(after.other).toBe("preserve-me");
		});
	});

	test("dry-run writes nothing", async () => {
		await withTmpHome(async (home) => {
			const r = await runInstall("cursor", { uninstall: true, dryRun: true });
			expect((r as { ok: boolean }).ok).toBe(true);
			const cursorDir = path.join(home, ".cursor");
			const exists = await fs
				.access(path.join(cursorDir, "mcp.json"))
				.then(() => true)
				.catch(() => false);
			expect(exists).toBe(false);
		});
	});
});

describe("install: refuses to overwrite garbage", () => {
	test("non-JSON existing file is preserved with structured error", async () => {
		await withTmpHome(async (home) => {
			// Pre-seed valid auth so we get past the auth gate.
			const codexDir = path.join(home, ".codex");
			await fs.mkdir(codexDir, { recursive: true });
			const farFuture = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
			const enc = (o: unknown) =>
				Buffer.from(JSON.stringify(o)).toString("base64url").replace(/=+$/, "");
			const idTok = `${enc({ alg: "none" })}.${enc({
				exp: farFuture,
				"https://api.openai.com/auth": { chatgpt_account_id: "acc-test" },
			})}.sig`;
			const accessTok = `${enc({ alg: "none" })}.${enc({ exp: farFuture })}.sig`;
			await fs.writeFile(
				path.join(codexDir, "auth.json"),
				JSON.stringify({
					auth_mode: "chatgpt",
					tokens: {
						id_token: idTok,
						access_token: accessTok,
						refresh_token: "rt",
						account_id: "acc-test",
					},
					last_refresh: new Date().toISOString(),
				}),
			);

			// Pre-seed a non-JSON cursor mcp.json (e.g. corrupted whitespace
			// from a prior tool). The install must refuse to overwrite it.
			const cursorDir = path.join(home, ".cursor");
			await fs.mkdir(cursorDir, { recursive: true });
			const cursorFile = path.join(cursorDir, "mcp.json");
			const garbage = "this is not JSON\nfoo bar baz\n";
			await fs.writeFile(cursorFile, garbage);

			const r = await runInstall("cursor");
			const single = r as {
				ok: boolean;
				error?: string;
				remedy?: { action?: string; path?: string };
			};
			expect(single.ok).toBe(false);
			expect(single.error).toMatch(/refus.*overwrite/i);
			expect(single.remedy?.path).toBe(cursorFile);

			// File contents preserved exactly.
			const after = await fs.readFile(cursorFile, "utf-8");
			expect(after).toBe(garbage);
		});
	});

	test("empty (whitespace-only) file is treated as absent and overwritten", async () => {
		await withTmpHome(async (home) => {
			// Pre-seed valid auth.
			const codexDir = path.join(home, ".codex");
			await fs.mkdir(codexDir, { recursive: true });
			const farFuture = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
			const enc = (o: unknown) =>
				Buffer.from(JSON.stringify(o)).toString("base64url").replace(/=+$/, "");
			const idTok = `${enc({ alg: "none" })}.${enc({
				exp: farFuture,
				"https://api.openai.com/auth": { chatgpt_account_id: "acc-test" },
			})}.sig`;
			const accessTok = `${enc({ alg: "none" })}.${enc({ exp: farFuture })}.sig`;
			await fs.writeFile(
				path.join(codexDir, "auth.json"),
				JSON.stringify({
					auth_mode: "chatgpt",
					tokens: {
						id_token: idTok,
						access_token: accessTok,
						refresh_token: "rt",
						account_id: "acc-test",
					},
					last_refresh: new Date().toISOString(),
				}),
			);

			const cursorDir = path.join(home, ".cursor");
			await fs.mkdir(cursorDir, { recursive: true });
			await fs.writeFile(path.join(cursorDir, "mcp.json"), "   \n   \t  ");

			const r = await runInstall("cursor");
			const single = r as { ok: boolean; already_installed?: boolean };
			expect(single.ok).toBe(true);
			expect(single.already_installed).toBe(false);
		});
	});
});

describe("install: --for all", () => {
	test("returns array, skips runtimes not present on disk", async () => {
		await withTmpHome(async () => {
			const r = await runInstall("all");
			expect(Array.isArray(r)).toBe(true);
			const arr = r as Array<{ for: string; skipped?: boolean; skip_reason?: string }>;
			// Every result is a skip because nothing exists in tmp home.
			for (const item of arr) {
				expect(item.skipped).toBe(true);
				expect(item.skip_reason).toBe("runtime not detected");
			}
			// 8 candidates (excludes openai-sdk + aider snippet-only).
			expect(arr.length).toBe(8);
		});
	});
});
