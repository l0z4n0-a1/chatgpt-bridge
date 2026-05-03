#!/usr/bin/env node
/**
 * chatgpt-bridge CLI.
 *
 * Six commands: serve, gen, mcp, doctor, login, version.
 * Login simply runs `npx @openai/codex login` for the user — the official
 * OAuth flow that mints auth.json. We don't reimplement it.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { Auth, tokenExpiryMs } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { generateImage } from "./images.ts";
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
		}

		const authOk = checks[0]?.ok === true;
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
				await res.body?.cancel();
			} catch (e) {
				checks.push({ name: "upstream", ok: false, detail: (e as Error).message });
			}
		} else {
			checks.push({ name: "upstream", ok: false, detail: "skipped (auth failed)" });
		}

		const allOk = checks.every((c) => c.ok);
		process.stdout.write(
			`${JSON.stringify({ status: allOk ? "healthy" : "unhealthy", checks }, null, 2)}\n`,
		);
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
					? "Run: npx @openai/codex login"
					: err.message?.includes("ENEEDAUTH")
						? "Run: chatgpt-bridge login"
						: "Run: chatgpt-bridge doctor  (for diagnosis)",
		})}\n`,
	);
	process.exit(1);
});

// Avoid unused-import warning on the createApp re-export.
void createApp;
