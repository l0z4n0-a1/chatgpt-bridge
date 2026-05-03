/**
 * `install` verb — one-shot, idempotent registration of the bridge with an
 * IDE / agent runtime. Each adaptor knows the config path + format for its
 * target. The user runs:
 *
 *   chatgpt-bridge install --for claude-code
 *
 * …and the agent never has to hand-edit JSON / TOML / settings ever again.
 *
 * Adaptors are pure functions: read current config, merge the bridge entry,
 * write it back atomically. Uninstall removes only the bridge entry. Other
 * keys are preserved verbatim.
 *
 * Adaptor budget: ~30 LOC each. If you find yourself writing more, split.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { Auth, tokenExpiryMs } from "./auth.ts";
import { type Config, homeDir, loadConfig } from "./config.ts";

const MCP_ENTRY_NAME = "chatgpt-bridge";
const MCP_COMMAND = { command: "npx", args: ["-y", "chatgpt-bridge", "mcp"] } as const;

export type Target =
	| "claude-code"
	| "claude-desktop"
	| "codex"
	| "cursor"
	| "zed"
	| "cline"
	| "continue"
	| "aider"
	| "gemini-cli"
	| "openai-sdk"
	| "all";

export interface InstallResult {
	ok: boolean;
	for: Target;
	config_path?: string;
	already_installed?: boolean;
	auth?: { valid: boolean; expires_in_seconds: number | null };
	next_step?: string;
	error?: string;
	remedy?: Record<string, unknown>;
	skipped?: boolean;
	skip_reason?: string;
}

export interface InstallOptions {
	uninstall?: boolean;
	dryRun?: boolean;
}

/* ------------------------- platform path helpers ------------------------- */

function appDataDir(appName: string): string {
	if (process.platform === "darwin") {
		return path.join(homeDir(), "Library", "Application Support", appName);
	}
	if (process.platform === "win32") {
		return path.join(process.env.APPDATA ?? path.join(homeDir(), "AppData", "Roaming"), appName);
	}
	return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homeDir(), ".config"), appName);
}

/* ------------------------------ JSON safe I/O ----------------------------- */

type JsonReadResult<T> =
	| { state: "ok"; data: T }
	| { state: "absent" }
	| { state: "unparseable"; cause: string };

async function readJson<T>(p: string): Promise<JsonReadResult<T>> {
	let raw: string;
	try {
		raw = await fs.readFile(p, "utf-8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
		return { state: "unparseable", cause: (e as Error).message };
	}
	if (raw.trim().length === 0) {
		// Treat an empty (or whitespace-only) file as absent: it's safe to
		// write a fresh JSON document over content that has no information.
		return { state: "absent" };
	}
	try {
		return { state: "ok", data: JSON.parse(raw) as T };
	} catch (e) {
		return { state: "unparseable", cause: (e as Error).message };
	}
}

/** Pretty-print JSON to disk, atomically respecting --dry-run. */
async function writeJsonFile(p: string, data: unknown, dryRun: boolean): Promise<void> {
	if (dryRun) return;
	await fs.mkdir(path.dirname(p), { recursive: true });
	await fs.writeFile(p, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

/* ----------------------------- adaptor: MCP ------------------------------- */

interface McpFile {
	mcpServers?: Record<string, unknown>;
	[k: string]: unknown;
}

class InstallTargetError extends Error {
	constructor(
		message: string,
		readonly remedy: Record<string, unknown>,
	) {
		super(message);
		this.name = "InstallTargetError";
	}
}

async function applyMcpJson(
	configPath: string,
	options: InstallOptions,
): Promise<{ already: boolean }> {
	const read = await readJson<McpFile>(configPath);
	if (read.state === "unparseable") {
		throw new InstallTargetError(
			`Refusing to overwrite ${configPath}: existing file is not valid JSON (${read.cause}).`,
			{
				action: "Inspect or remove the file manually, then re-run install.",
				path: configPath,
			},
		);
	}
	const current = read.state === "ok" ? read.data : {};
	const servers = (current.mcpServers ?? {}) as Record<string, unknown>;
	const present = Object.hasOwn(servers, MCP_ENTRY_NAME);

	if (options.uninstall) {
		if (!present) return { already: false };
		delete servers[MCP_ENTRY_NAME];
		await writeJsonFile(configPath, { ...current, mcpServers: servers }, options.dryRun ?? false);
		return { already: false };
	}

	if (present) return { already: true };
	servers[MCP_ENTRY_NAME] = MCP_COMMAND;
	await writeJsonFile(configPath, { ...current, mcpServers: servers }, options.dryRun ?? false);
	return { already: false };
}

/* -------------------------- per-target installers ------------------------- */

function pathClaudeCode(): string {
	// User-global config that Claude Code reads for all projects.
	// Project-scoped install (./claude.json) is left to the user.
	return path.join(homeDir(), ".claude.json");
}

function pathClaudeDesktop(): string {
	return path.join(appDataDir("Claude"), "claude_desktop_config.json");
}

function pathCursor(): string {
	return path.join(homeDir(), ".cursor", "mcp.json");
}

function pathZed(): string {
	return path.join(homeDir(), ".config", "zed", "settings.json");
}

function pathCline(): string {
	// VS Code's user globalStorage. appDataDir("Code") resolves correctly on
	// all three platforms (uses APPDATA on win32, ~/Library/... on darwin,
	// $XDG_CONFIG_HOME (or ~/.config) on linux).
	return path.join(
		appDataDir("Code"),
		"User",
		"globalStorage",
		"saoudrizwan.claude-dev",
		"settings",
		"cline_mcp_settings.json",
	);
}

function pathContinue(): string {
	return path.join(homeDir(), ".continue", "config.json");
}

function pathGeminiCli(): string {
	return path.join(homeDir(), ".gemini", "settings.json");
}

function pathCodex(): string {
	return path.join(homeDir(), ".codex", "config.toml");
}

/* ---------------- adaptor: Codex (TOML, not JSON) ------------------------- */

async function applyCodexToml(options: InstallOptions): Promise<InstallResult> {
	const p = pathCodex();
	const block = `\n[mcp_servers.${MCP_ENTRY_NAME}]\ncommand = "npx"\nargs = ["-y", "chatgpt-bridge", "mcp"]\n`;
	const marker = `[mcp_servers.${MCP_ENTRY_NAME}]`;

	let current = "";
	try {
		current = await fs.readFile(p, "utf-8");
	} catch {
		current = "";
	}
	const present = current.includes(marker);

	if (options.uninstall) {
		if (!present) return { ok: true, for: "codex", config_path: p, already_installed: false };
		const lines = current.split(/\r?\n/);
		const out: string[] = [];
		let skipping = false;
		for (const line of lines) {
			if (line.trim() === marker) {
				skipping = true;
				continue;
			}
			if (skipping && /^\s*\[/.test(line)) {
				skipping = false;
			}
			if (!skipping) out.push(line);
		}
		if (!options.dryRun) {
			await fs.mkdir(path.dirname(p), { recursive: true });
			await fs.writeFile(p, out.join("\n").replace(/\n{3,}/g, "\n\n"), "utf-8");
		}
		return { ok: true, for: "codex", config_path: p };
	}

	if (present) {
		return { ok: true, for: "codex", config_path: p, already_installed: true };
	}
	if (!options.dryRun) {
		await fs.mkdir(path.dirname(p), { recursive: true });
		await fs.writeFile(p, current + block, "utf-8");
	}
	return {
		ok: true,
		for: "codex",
		config_path: p,
		already_installed: false,
		next_step: "Restart Codex CLI; tools 'chat', 'generate_image', 'health' will be available.",
	};
}

/* ---------------- adaptor: openai-sdk / aider (snippet only) -------------- */

function snippetOpenaiSdk(): InstallResult {
	return {
		ok: true,
		for: "openai-sdk",
		next_step:
			"This target writes nothing. Set base_url='http://127.0.0.1:10531/v1' and api_key='unused' in your OpenAI client. Start the bridge with `chatgpt-bridge serve`.",
	};
}

function snippetAider(): InstallResult {
	return {
		ok: true,
		for: "aider",
		next_step:
			"Aider has no MCP. Run with `aider --openai-api-base http://127.0.0.1:10531/v1 --openai-api-key unused` after `chatgpt-bridge serve`.",
	};
}

/* ----------------------- detection (used by 'all') ------------------------ */

async function detectInstalled(target: Target): Promise<boolean> {
	switch (target) {
		case "claude-code":
			return fileExists(pathClaudeCode());
		case "claude-desktop":
			return fileExists(path.dirname(pathClaudeDesktop()));
		case "codex":
			return fileExists(path.join(homeDir(), ".codex"));
		case "cursor":
			return fileExists(path.join(homeDir(), ".cursor"));
		case "zed":
			return fileExists(path.join(homeDir(), ".config", "zed"));
		case "cline":
			return fileExists(path.dirname(pathCline()));
		case "continue":
			return fileExists(path.join(homeDir(), ".continue"));
		case "gemini-cli":
			return fileExists(path.join(homeDir(), ".gemini"));
		case "aider":
		case "openai-sdk":
			return true; // always "installable" — they emit snippets
		case "all":
			return false;
	}
}

/* --------------------------- main install dispatch ------------------------ */

async function authStatus(
	cfg: Config,
): Promise<{ valid: boolean; expires_in_seconds: number | null }> {
	try {
		const auth = new Auth(cfg);
		const t = await auth.ensure();
		const exp = tokenExpiryMs(t.accessToken);
		return {
			valid: true,
			expires_in_seconds:
				typeof exp === "number" ? Math.max(0, Math.floor((exp - Date.now()) / 1000)) : null,
		};
	} catch {
		return { valid: false, expires_in_seconds: null };
	}
}

function authMissingResult(target: Target): InstallResult {
	return {
		ok: false,
		for: target,
		error: "auth.json not found",
		remedy: {
			cmd: "npx @openai/codex login",
			interactive: true,
			why: "OAuth flow opens browser; user signs in to ChatGPT once",
			next: `chatgpt-bridge install --for ${target}`,
		},
	};
}

async function installSingle(
	target: Exclude<Target, "all">,
	options: InstallOptions,
	cfg: Config,
): Promise<InstallResult> {
	// Snippet-only targets bypass auth check (they're informational).
	if (target === "openai-sdk") return snippetOpenaiSdk();
	if (target === "aider") return snippetAider();

	const auth = await authStatus(cfg);
	if (!auth.valid && !options.uninstall) return authMissingResult(target);

	if (target === "codex") {
		const r = await applyCodexToml(options);
		return { ...r, auth };
	}

	const configPath = (() => {
		// Exhaustive: aider/openai-sdk/codex/all are handled before this point;
		// the `never` assertion catches any new Target that forgets a path.
		switch (target) {
			case "claude-code":
				return pathClaudeCode();
			case "claude-desktop":
				return pathClaudeDesktop();
			case "cursor":
				return pathCursor();
			case "zed":
				return pathZed();
			case "cline":
				return pathCline();
			case "continue":
				return pathContinue();
			case "gemini-cli":
				return pathGeminiCli();
			default: {
				const _exhaustive: never = target;
				throw new Error(`Unhandled install target: ${String(_exhaustive)}`);
			}
		}
	})();

	try {
		const { already } = await applyMcpJson(configPath, options);
		const verb = options.uninstall ? "removed from" : already ? "already in" : "registered with";
		return {
			ok: true,
			for: target,
			config_path: configPath,
			already_installed: already && !options.uninstall,
			auth,
			next_step: options.uninstall
				? `Restart ${target} to drop the bridge entry.`
				: `Restart ${target} to load the bridge MCP server. ${verb} ${configPath}.`,
		};
	} catch (e) {
		if (e instanceof InstallTargetError) {
			return {
				ok: false,
				for: target,
				config_path: configPath,
				error: e.message,
				remedy: e.remedy,
				auth,
			};
		}
		throw e;
	}
}

/**
 * Public entry. `target = "all"` runs every adaptor whose runtime is detected
 * on disk (skips absent ones). Snippet-only targets (openai-sdk/aider) are
 * skipped from `all` to avoid noise.
 */
export async function runInstall(
	target: Target,
	options: InstallOptions = {},
): Promise<InstallResult | InstallResult[]> {
	const cfg = loadConfig();

	if (target !== "all") {
		return installSingle(target, options, cfg);
	}

	const candidates: Exclude<Target, "all" | "openai-sdk" | "aider">[] = [
		"claude-code",
		"claude-desktop",
		"codex",
		"cursor",
		"zed",
		"cline",
		"continue",
		"gemini-cli",
	];
	const results: InstallResult[] = [];
	for (const t of candidates) {
		const detected = await detectInstalled(t);
		if (!detected) {
			results.push({ ok: true, for: t, skipped: true, skip_reason: "runtime not detected" });
			continue;
		}
		results.push(await installSingle(t, options, cfg));
	}
	return results;
}
