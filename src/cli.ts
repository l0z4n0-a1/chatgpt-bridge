#!/usr/bin/env node
/**
 * chatgpt-bridge CLI.
 *
 * Verbs (10):
 *   serve, mcp, doctor, login, version, install, capabilities,  (existing)
 *   chat, image, models                                          (added in 0.3.x)
 *   gen                                                          (deprecated → image)
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
import { resolveAttachments } from "./attachments.ts";
import { Auth, tokenExpiryMs } from "./auth.ts";
import { CAPABILITIES } from "./capabilities.ts";
import { type Config, DEFAULT_CHAT_MODEL, loadConfig } from "./config.ts";
import { generateImage } from "./images.ts";
import { type InstallResult, type Target, runInstall } from "./install.ts";
import {
	classifyExitCode,
	parseStdin,
	readStdin,
	resolveAtFile,
	writeError,
	writeJson,
} from "./io.ts";
import { VERSION, createApp, startServer } from "./server.ts";
import { Upstream, type UpstreamError, parseSSE } from "./upstream.ts";

const program = new Command();
program
	.name("chatgpt-bridge")
	.description(
		"Localhost OpenAI-compatible HTTP proxy that uses your ChatGPT subscription via OAuth.",
	)
	.version(VERSION);

/* ------------------------------- serve ----------------------------------- */

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

/* ------------------------------- mcp ------------------------------------ */

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

/* ------------------------------- doctor --------------------------------- */

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
				// Drain the body. Don't call body.cancel(): the abort path
				// interacts with the libuv issue described at the bottom of
				// this handler.
				await res.text().catch(() => {});
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
		writeJson(out);
		// Windows + Node 24 libuv quirk: calling process.exit(0) immediately
		// after a fetch can trigger a UV_HANDLE_CLOSING assertion (because the
		// global fetch's keep-alive socket is still being torn down) and
		// abort the process with a non-zero exit code despite success. Let
		// Node drain handles naturally on the success path; only schedule a
		// deferred exit on failure.
		if (!allOk) setImmediate(() => process.exit(1));
	});

/* ------------------------------- login ---------------------------------- */

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

/* ------------------------------- version -------------------------------- */

program
	.command("version")
	.description("Print version + runtime info")
	.action(() => {
		const cfg = loadConfig();
		writeJson({
			name: "chatgpt-bridge",
			version: VERSION,
			runtime: typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`,
			default_port: cfg.port,
			upstream: cfg.upstreamBase,
		});
	});

/* ------------------------------- install -------------------------------- */

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
			process.exit(
				writeError(`invalid --for target: ${opts.for}`, {
					remedy: { cmd: "chatgpt-bridge capabilities", why: "list all valid targets" },
				}),
			);
		}
		const result = await runInstall(opts.for as Target, {
			uninstall: opts.uninstall,
			dryRun: opts.dryRun,
		});
		writeJson(result);
		const failed = Array.isArray(result)
			? result.some((r) => !r.ok)
			: !(result as InstallResult).ok;
		process.exit(failed ? 1 : 0);
	});

/* ------------------------------- capabilities --------------------------- */

program
	.command("capabilities")
	.description("Print the machine-readable capability catalog (agents read this once).")
	.action(() => {
		writeJson(CAPABILITIES);
	});

/* ------------------------------- chat ----------------------------------- */

interface ChatJob extends Record<string, unknown> {
	prompt: string;
	attach?: string[];
	system?: string;
	model?: string;
}

async function runChatOnce(
	cfg: Config,
	upstream: Upstream,
	job: ChatJob,
	stream: boolean,
): Promise<
	{ ok: true; text: string; latency_ms: number; model: string } | { ok: false; error: string }
> {
	const t0 = Date.now();

	// Build content parts: text first, then attachments (each attachment is
	// resolved into an input_image or input_file part).
	const userContent: Array<Record<string, unknown>> = [{ type: "input_text", text: job.prompt }];
	if (job.attach && job.attach.length > 0) {
		try {
			const { parts } = await resolveAttachments(job.attach, {}, cfg);
			for (const p of parts) userContent.push(p);
		} catch (e) {
			return { ok: false, error: (e as Error).message };
		}
	}

	const input: Array<Record<string, unknown>> = [];
	if (job.system) input.push({ role: "developer", content: job.system });
	input.push({ role: "user", content: userContent });

	const body: Record<string, unknown> = {
		model: job.model ?? DEFAULT_CHAT_MODEL,
		input,
		stream: true,
		store: false,
		instructions: "",
	};

	let res: Response;
	try {
		res = await upstream.call({ path: "/responses", method: "POST", body, stream: true });
		await upstream.raiseForStatus(res);
	} catch (e) {
		return { ok: false, error: (e as UpstreamError).message ?? String(e) };
	}

	let text = "";
	for await (const ev of parseSSE(res)) {
		if (ev.type === "response.output_text.delta") {
			const delta = (ev.data as { delta?: unknown }).delta;
			if (typeof delta === "string") {
				text += delta;
				if (stream) process.stdout.write(delta);
			}
		}
	}
	if (stream) process.stdout.write("\n");
	return { ok: true, text, latency_ms: Date.now() - t0, model: job.model ?? DEFAULT_CHAT_MODEL };
}

program
	.command("chat [prompt]")
	.description("Send a text or multimodal message; receive the assistant reply.")
	.option(
		"--attach <path>",
		"local path or URL (repeatable). Auto-detects image/text.",
		(v: string, prev: string[] = []) => prev.concat([v]),
		[] as string[],
	)
	.option("--system <text|@file>", "system prompt; '@path' reads file")
	.option("--model <id>", "model id", DEFAULT_CHAT_MODEL)
	.option("--stream", "stream tokens to stdout (default if tty)")
	.option("--no-stream", "force non-streaming JSON output")
	.option("--json", "force JSON output even if streaming would be possible")
	.option("--dry-run", "validate args without calling upstream", false)
	.action(
		async (
			promptArg: string | undefined,
			opts: {
				attach: string[];
				system?: string;
				model: string;
				stream?: boolean;
				json?: boolean;
				dryRun: boolean;
			},
		) => {
			const cfg = loadConfig();
			try {
				let job: ChatJob | undefined;
				let jobs: ChatJob[] | undefined;

				if (promptArg === "-" || (promptArg === undefined && !process.stdin.isTTY)) {
					const raw = await readStdin();
					const parsed = parseStdin<ChatJob>(raw);
					if (parsed.batch) {
						jobs = parsed.jobs;
					} else {
						job = {
							prompt: parsed.prompt,
							attach: opts.attach,
							...(opts.system ? { system: await resolveAtFile(opts.system) } : {}),
							model: opts.model,
						};
					}
				} else {
					if (!promptArg) {
						process.exit(
							writeError("prompt required (positional arg, '-' for stdin, or JSONL on stdin)", {
								remedy: { cmd: "chatgpt-bridge chat 'your prompt here'" },
							}),
						);
					}
					const promptResolved = await resolveAtFile(promptArg);
					job = {
						prompt: promptResolved,
						attach: opts.attach,
						...(opts.system ? { system: await resolveAtFile(opts.system) } : {}),
						model: opts.model,
					};
				}

				// Guard: refuse empty prompt. Stdin closed without input, or a
				// batch line with empty `prompt`, are user errors — not silent
				// upstream calls that would burn quota.
				if (job && !job.prompt.trim()) {
					process.exit(
						writeError("empty prompt", {
							remedy: { cmd: "chatgpt-bridge chat 'your prompt here'" },
						}),
					);
				}
				if (jobs) {
					const empty = jobs.findIndex((j) => !j.prompt || !String(j.prompt).trim());
					if (empty >= 0) {
						process.exit(
							writeError(`empty prompt on stdin job #${empty + 1}`, {
								remedy: { action: "ensure each JSONL line has a non-empty 'prompt' field" },
							}),
						);
					}
				}

				if (opts.dryRun) {
					writeJson({
						ok: true,
						dry_run: true,
						jobs: jobs ?? (job ? [job] : []),
						model: opts.model,
					});
					return;
				}

				const auth = new Auth(cfg);
				const upstream = new Upstream(cfg, auth);

				// stream default = tty AND single-job AND not --json AND not --no-stream.
				const wantStream =
					opts.json !== true &&
					opts.stream !== false &&
					!jobs &&
					(opts.stream === true || Boolean(process.stdout.isTTY));

				if (jobs) {
					// Resolve --system @file once, not per job. JSONL's per-line
					// `system` field is taken verbatim (no @file expansion) so
					// each line is self-contained and reproducible.
					const cliSystem = opts.system ? await resolveAtFile(opts.system) : undefined;
					let anyOk = false;
					for (const j of jobs) {
						const merged: ChatJob = {
							prompt: j.prompt,
							attach: j.attach ?? opts.attach,
							...(j.system !== undefined
								? { system: j.system }
								: cliSystem !== undefined
									? { system: cliSystem }
									: {}),
							model: j.model ?? opts.model,
						};
						const r = await runChatOnce(cfg, upstream, merged, false);
						process.stdout.write(`${JSON.stringify(r)}\n`);
						if (r.ok) anyOk = true;
					}
					process.exit(anyOk ? 0 : 1);
				}

				const r = await runChatOnce(cfg, upstream, job as ChatJob, wantStream);
				if (!wantStream) writeJson(r);
				process.exit(r.ok ? 0 : 1);
			} catch (e) {
				const err = e as Error;
				process.exit(writeError(err.message, { exitCode: classifyExitCode(err) }));
			}
		},
	);

/* ------------------------------- image ---------------------------------- */

interface ImageJob extends Record<string, unknown> {
	prompt: string;
	out?: string;
	ref?: string[];
	size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
	quality?: "low" | "medium" | "high" | "auto";
	moderation?: "low" | "auto";
}

async function runImageOnce(
	cfg: Config,
	upstream: Upstream,
	job: ImageJob,
): Promise<
	| {
			ok: true;
			file: string;
			bytes: number;
			latency_ms: number;
			revised_prompt: string | null;
	  }
	| { ok: false; error: string }
> {
	const t0 = Date.now();
	try {
		const img = await generateImage(cfg, upstream, {
			prompt: job.prompt,
			size: job.size ?? "1024x1024",
			quality: job.quality ?? "high",
			moderation: job.moderation ?? "low",
			n: 1,
			response_format: "b64_json",
			...(job.ref && job.ref.length > 0 ? { reference_images: job.ref } : {}),
		});
		const outPath = path.resolve(job.out ?? `chatgpt-bridge-${Date.now()}.png`);
		await fs.mkdir(path.dirname(outPath), { recursive: true }).catch(() => {});
		await fs.writeFile(outPath, Buffer.from(img.b64, "base64"));
		return {
			ok: true,
			file: outPath,
			bytes: Buffer.byteLength(img.b64, "base64"),
			latency_ms: Date.now() - t0,
			revised_prompt: img.revisedPrompt ?? null,
		};
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

function registerImageCommand(name: "image" | "gen", deprecated: boolean): void {
	program
		.command(`${name} [prompt]`)
		.description(
			deprecated
				? "[deprecated: use 'image'] Generate one image to a file (or batch via JSONL stdin)"
				: "Generate one image to a file. Optional --ref shapes the style. Batch via JSONL on stdin.",
		)
		.option("--out <path>", "output PNG path")
		.option(
			"--ref <path>",
			"reference image (path/URL/data-URL). Repeatable, max 8.",
			(v: string, prev: string[] = []) => prev.concat([v]),
			[] as string[],
		)
		.option("--size <s>", "1024x1024|1024x1536|1536x1024|auto", "1024x1024")
		.option("--quality <q>", "low|medium|high|auto", "high")
		.option("--moderation <m>", "low|auto", "low")
		.option("--dry-run", "validate args without calling upstream", false)
		.action(
			async (
				promptArg: string | undefined,
				opts: {
					out?: string;
					ref: string[];
					size: ImageJob["size"];
					quality: ImageJob["quality"];
					moderation: ImageJob["moderation"];
					dryRun: boolean;
				},
			) => {
				if (deprecated) {
					process.stderr.write("warn: 'gen' is deprecated, use 'image'.\n");
				}
				const cfg = loadConfig();
				try {
					let job: ImageJob | undefined;
					let jobs: ImageJob[] | undefined;

					if (promptArg === "-" || (promptArg === undefined && !process.stdin.isTTY)) {
						const raw = await readStdin();
						const parsed = parseStdin<ImageJob>(raw);
						if (parsed.batch) jobs = parsed.jobs;
						else
							job = {
								prompt: parsed.prompt,
								out: opts.out,
								ref: opts.ref,
								size: opts.size,
								quality: opts.quality,
								moderation: opts.moderation,
							};
					} else {
						if (!promptArg) {
							process.exit(
								writeError("prompt required (positional arg, '-' for stdin, or JSONL)", {
									remedy: { cmd: "chatgpt-bridge image 'a fox' --out fox.png" },
								}),
							);
						}
						const promptResolved = await resolveAtFile(promptArg);
						job = {
							prompt: promptResolved,
							out: opts.out,
							ref: opts.ref,
							size: opts.size,
							quality: opts.quality,
							moderation: opts.moderation,
						};
					}

					// Guard: refuse empty prompt. An empty image prompt would still
					// generate an image at full cost, so we fail fast.
					if (job && !job.prompt.trim()) {
						process.exit(
							writeError("empty prompt", {
								remedy: { cmd: "chatgpt-bridge image 'a fox' --out fox.png" },
							}),
						);
					}
					if (jobs) {
						const empty = jobs.findIndex((j) => !j.prompt || !String(j.prompt).trim());
						if (empty >= 0) {
							process.exit(
								writeError(`empty prompt on stdin job #${empty + 1}`, {
									remedy: { action: "ensure each JSONL line has a non-empty 'prompt' field" },
								}),
							);
						}
					}

					if (opts.dryRun) {
						writeJson({ ok: true, dry_run: true, jobs: jobs ?? (job ? [job] : []) });
						return;
					}

					const auth = new Auth(cfg);
					const upstream = new Upstream(cfg, auth);

					if (jobs) {
						let anyOk = false;
						for (const j of jobs) {
							const merged: ImageJob = {
								prompt: j.prompt,
								out: j.out ?? opts.out,
								ref: j.ref ?? opts.ref,
								size: j.size ?? opts.size,
								quality: j.quality ?? opts.quality,
								moderation: j.moderation ?? opts.moderation,
							};
							const r = await runImageOnce(cfg, upstream, merged);
							process.stdout.write(`${JSON.stringify(r)}\n`);
							if (r.ok) anyOk = true;
						}
						process.exit(anyOk ? 0 : 1);
					}

					const r = await runImageOnce(cfg, upstream, job as ImageJob);
					writeJson(r);
					process.exit(r.ok ? 0 : 1);
				} catch (e) {
					const err = e as Error;
					process.exit(writeError(err.message, { exitCode: classifyExitCode(err) }));
				}
			},
		);
}

registerImageCommand("image", false);
registerImageCommand("gen", true); // deprecated alias

/* ------------------------------- models --------------------------------- */

program
	.command("models")
	.description("List available models (chat + image, including bridge synthetic aliases).")
	.action(async () => {
		const cfg = loadConfig();
		try {
			const auth = new Auth(cfg);
			const upstream = new Upstream(cfg, auth);
			const res = await upstream.call({
				path: `/models?client_version=${encodeURIComponent(cfg.clientVersion)}`,
				method: "GET",
			});
			await upstream.raiseForStatus(res);
			const j = (await res.json()) as { models?: Array<{ slug?: unknown }> };
			const real = (j.models ?? [])
				.map((m) => m.slug)
				.filter((s): s is string => typeof s === "string");
			const synthetic = ["gpt-image-2", "gpt-image-1", "dall-e-3"];
			const ids = Array.from(new Set([...real, ...synthetic])).sort();
			writeJson({ models: ids });
		} catch (e) {
			const err = e as Error;
			process.exit(writeError(err.message, { exitCode: classifyExitCode(err) }));
		}
	});

/* --------------------- top-level error handler ------------------------- */

program.parseAsync(process.argv).catch((e) => {
	const err = e as Error;
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
	process.exit(classifyExitCode(err));
});

// Avoid unused-import warning on the createApp re-export.
void createApp;
