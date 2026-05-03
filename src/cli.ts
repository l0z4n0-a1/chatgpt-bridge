#!/usr/bin/env node
/**
 * chatgpt-bridge CLI.
 *
 * Verbs (8): serve, gen, mcp, doctor, login, version, install, capabilities.
 * `gen` will be renamed to `image` in PR#3 with a deprecation warning.
 *
 * Output convention (agent-native):
 *   - JSON to stdout on success when not a tty (or when --json is set).
 *   - Structured JSON to stderr on error, including a `remedy` field when
 *     an automated next step exists.
 *   - Exit codes: 0=ok, 1=user-error, 2=auth, 3=upstream, 4=rate-limited.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { Auth, tokenExpiryMs } from "./auth.ts";
import { CAPABILITIES } from "./capabilities.ts";
import { loadConfig } from "./config.ts";
import { generateImage } from "./images.ts";
import { type InstallResult, type Target, runInstall } from "./install.ts";
import { VERSION, createApp, startServer } from "./server.ts";
import { Upstream } from "./upstream.ts";

const program = new Command();
program
	.name("chatgpt-bridge")
	.description(
		"Localhost OpenAI-compatible HTTP proxy that uses your ChatGPT subscription via OAuth.",
	)
	.version(VERSION);

program
	.command("serve")
	.description("Start the local HTTP server")
	.option("--port <number>", "port", (v) => Number.parseInt(v, 10))
	.option("--host <ip>", "bind host")
	.action(async (opts) => {
		const cfg = loadConfig({
			...(opts.port ? { port: opts.port } : {}),
			...(opts.host ? { host: opts.host } : {}),
		});
		await startServer(cfg);
	});

program
	.command("gen <prompt>")
	.description("Generate one image to a file (one-shot, no separate serve)")
	.option("--out <path>", "output PNG path")
	.option("--quality <q>", "low|medium|high|auto", "high")
	.option("--size <s>", "1024x1024|1024x1536|1536x1024|auto", "1024x1024")
	.action(async (prompt: string, opts) => {
		const cfg = loadConfig();
		const auth = new Auth(cfg);
		const upstream = new Upstream(cfg, auth);
		const t0 = Date.now();
		const img = await generateImage(cfg, upstream, {
			prompt,
			quality: opts.quality,
			size: opts.size,
			n: 1,
			response_format: "b64_json",
			moderation: "low",
		});
		const ms = Date.now() - t0;
		const outPath = path.resolve(opts.out ?? `chatgpt-bridge-${Date.now()}.png`);
		await fs.mkdir(path.dirname(outPath), { recursive: true }).catch(() => {});
		await fs.writeFile(outPath, Buffer.from(img.b64, "base64"));
		process.stdout.write(
			`${JSON.stringify(
				{
					ok: true,
					file: outPath,
					latency_ms: ms,
					bytes: Buffer.byteLength(img.b64, "base64"),
					revised_prompt: img.revisedPrompt ?? null,
				},
				null,
				2,
			)}\n`,
		);
	});

program
	.command("mcp")
	.description(
		"Run as a Model Context Protocol server over stdio (for Claude Desktop, Cursor, Zed, Cline, etc.)",
	)
	.action(async () => {
		const cfg = loadConfig();
		const { startMcpServer } = await import("./mcp.ts");
		await startMcpServer(cfg);
	});

program
	.command("doctor")
	.description("Run health checks; exit 0 if everything is OK")
	.action(async () => {
		const cfg = loadConfig();
		const auth = new Auth(cfg);
		const upstream = new Upstream(cfg, auth);
		const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
		const remedy: Array<{ check: string; cmd: string; interactive?: boolean; why?: string }> = [];

		checks.push({
			name: "runtime",
			ok: true,
			detail: typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`,
		});

		try {
			const t = await auth.ensure();
			const exp = tokenExpiryMs(t.accessToken);
			checks.push({
				name: "auth",
				ok: true,
				detail: `loaded from ${t.sourcePath} · expires in ${
					typeof exp === "number" ? Math.max(0, Math.floor((exp - Date.now()) / 1000)) : 0
				}s`,
			});
		} catch (e) {
			checks.push({ name: "auth", ok: false, detail: (e as Error).message });
			remedy.push({
				check: "auth",
				cmd: "npx @openai/codex login",
				interactive: true,
				why: "OAuth flow opens browser; user signs in to ChatGPT once",
			});
		}

		const authOk = checks.find((c) => c.name === "auth")?.ok === true;
		if (authOk) {
			try {
				const res = await upstream.call({
					path: `/models?client_version=${encodeURIComponent(cfg.clientVersion)}`,
					method: "GET",
				});
				checks.push({
					name: "upstream",
					ok: res.ok,
					detail: `HTTP ${res.status}`,
				});
				if (!res.ok) {
					remedy.push({
						check: "upstream",
						cmd: "chatgpt-bridge doctor",
						why: "Re-run after a brief wait; transient upstream errors are common.",
					});
				}
				await res.body?.cancel();
			} catch (e) {
				checks.push({ name: "upstream", ok: false, detail: (e as Error).message });
				remedy.push({
					check: "upstream",
					cmd: "chatgpt-bridge doctor",
					why: "Network or upstream issue — retry.",
				});
			}
		} else {
			checks.push({ name: "upstream", ok: false, detail: "skipped (auth failed)" });
		}

		const allOk = checks.every((c) => c.ok);
		const out: Record<string, unknown> = {
			status: allOk ? "healthy" : "unhealthy",
			checks,
		};
		if (remedy.length > 0) out.remedy = remedy;
		process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
		process.exit(allOk ? 0 : 1);
	});

program
	.command("login")
	.description("Authenticate by running `npx @openai/codex login` (writes ~/.codex/auth.json)")
	.action(async () => {
		console.error("Running: npx @openai/codex login");
		await new Promise<void>((resolve) => {
			const child = spawn("npx", ["@openai/codex", "login"], {
				stdio: "inherit",
				shell: true,
			});
			child.on("exit", () => resolve());
		});
	});

program
	.command("version")
	.description("Print version + runtime info")
	.action(() => {
		const cfg = loadConfig();
		process.stdout.write(
			`${JSON.stringify(
				{
					name: "chatgpt-bridge",
					version: VERSION,
					runtime: typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`,
					default_port: cfg.port,
					upstream: cfg.upstreamBase,
				},
				null,
				2,
			)}\n`,
		);
	});

program
	.command("install")
	.description(
		"Register the bridge with an IDE/agent runtime. Idempotent. Use --for <target> or --for all.",
	)
	.requiredOption(
		"--for <target>",
		"claude-code|claude-desktop|codex|cursor|zed|cline|continue|aider|gemini-cli|openai-sdk|all",
	)
	.option("--uninstall", "remove the bridge entry from the target", false)
	.option("--dry-run", "print what would change without writing", false)
	.action(async (opts: { for: string; uninstall: boolean; dryRun: boolean }) => {
		const installVerb = CAPABILITIES.verbs.find((v) => v.name === "install");
		const valid = installVerb?.args.for?.values?.includes(opts.for);
		if (!valid) {
			process.stderr.write(
				`${JSON.stringify({
					ok: false,
					error: `invalid --for target: ${opts.for}`,
					remedy: { cmd: "chatgpt-bridge capabilities", why: "list all valid targets" },
				})}\n`,
			);
			process.exit(1);
		}
		const result = await runInstall(opts.for as Target, {
			uninstall: opts.uninstall,
			dryRun: opts.dryRun,
		});
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		const failed = Array.isArray(result)
			? result.some((r) => !r.ok)
			: !(result as InstallResult).ok;
		process.exit(failed ? 1 : 0);
	});

program
	.command("capabilities")
	.description("Print the machine-readable capability catalog (agents read this once).")
	.action(() => {
		process.stdout.write(`${JSON.stringify(CAPABILITIES, null, 2)}\n`);
	});

// Public createApp export-friendly: enable `chatgpt-bridge fetch` for tests.
program.parseAsync(process.argv).catch((e) => {
	const err = e as Error;
	// Structured error to stderr — agents can parse this. Humans see the message.
	process.stderr.write(
		`${JSON.stringify({
			ok: false,
			error: err.message ?? String(e),
			remedy:
				err.message?.includes("auth.json") || err.message?.includes("access_token")
					? { cmd: "npx @openai/codex login", interactive: true }
					: err.message?.includes("ENEEDAUTH")
						? { cmd: "chatgpt-bridge install --for openai-sdk" }
						: { cmd: "chatgpt-bridge doctor", why: "for diagnosis" },
		})}\n`,
	);
	process.exit(1);
});

// Avoid unused-import warning on the createApp re-export.
void createApp;
