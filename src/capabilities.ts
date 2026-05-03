/**
 * Machine-readable capability catalog.
 *
 * Agents call `chatgpt-bridge capabilities` once and learn the entire surface:
 * verbs, args, returns, idempotency, side effects, latency, errors, examples.
 *
 * The catalog is a single const so it cannot drift from the implementation —
 * a test (test/capabilities.test.ts) asserts every CLI verb appears here.
 */

import { VERSION } from "./server.ts";

export interface CapabilityArg {
	type: string;
	required?: boolean;
	default?: string | number | boolean;
	doc?: string;
	values?: readonly string[];
	repeatable?: boolean;
}

export interface CapabilityVerb {
	name: string;
	summary: string;
	args: Record<string, CapabilityArg>;
	returns: Record<string, unknown> | string;
	side_effects: string;
	idempotent: boolean;
	rate_limited: boolean;
	typical_latency_seconds?: [number, number];
	cache_seconds?: number;
	examples: ReadonlyArray<{ cmd: string; purpose?: string }>;
	errors?: ReadonlyArray<{ code: string; remedy: Record<string, unknown> }>;
}

export interface Capabilities {
	version: string;
	package: "chatgpt-bridge";
	wire: {
		stdout: "json-on-pipe-or-flag";
		stderr: "json-on-error";
		exit_codes: Record<string, string>;
	};
	global_flags: Record<string, CapabilityArg>;
	verbs: CapabilityVerb[];
	limits: Record<string, number>;
	notes: string[];
}

const EXIT_CODES = {
	"0": "ok",
	"1": "user_error (bad args, missing file)",
	"2": "auth_error (auth.json missing or refresh failed)",
	"3": "upstream_error (chatgpt.com 4xx/5xx)",
	"4": "rate_limited (hourly cap reached)",
	"5": "quota_exhausted (subscription limit)",
} as const;

const GLOBAL_FLAGS: Record<string, CapabilityArg> = {
	json: { type: "bool", default: "true if not tty", doc: "Force structured JSON output." },
	"dry-run": { type: "bool", default: false, doc: "Validate args + auth without upstream call." },
	timeout: { type: "number", default: 400, doc: "Request timeout in seconds." },
};

export const CAPABILITIES: Capabilities = {
	version: VERSION,
	package: "chatgpt-bridge",
	wire: {
		stdout: "json-on-pipe-or-flag",
		stderr: "json-on-error",
		exit_codes: EXIT_CODES,
	},
	global_flags: GLOBAL_FLAGS,
	limits: {
		rate_per_hour: 200,
		attachment_max_bytes: 25 * 1024 * 1024,
		attachment_total_bytes: 100 * 1024 * 1024,
	},
	notes: [
		"All verbs default to JSON output when stdout is not a tty.",
		"Errors include a structured `remedy` field whenever an automated next step exists.",
		"Stdin '-' for chat/image accepts a single prompt or JSONL for batch (one job per line).",
		"Any string flag accepting `@path` will read the file contents (e.g. --system @prompt.md).",
		"Bridge extensions (non-portable to api.openai.com): `reference_images[]` on /v1/images/generations, `input_file` content-part on /v1/chat/completions.",
	],
	verbs: [
		{
			name: "install",
			summary:
				"Register the bridge with an IDE/agent runtime (writes its MCP/config file). Idempotent.",
			args: {
				for: {
					type: "enum",
					required: true,
					values: [
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
					],
					doc: "Target runtime. 'all' tries every detected runtime, skips absent ones.",
				},
				uninstall: { type: "bool", default: false, doc: "Remove the bridge entry." },
			},
			returns: {
				ok: "bool",
				for: "string",
				config_path: "absolute path",
				already_installed: "bool",
				auth: { valid: "bool", expires_in_seconds: "number" },
				next_step: "string",
			},
			side_effects: "Writes to one IDE-specific config file. --uninstall reverts.",
			idempotent: true,
			rate_limited: false,
			examples: [
				{ cmd: "chatgpt-bridge install --for claude-code", purpose: "register with Claude Code" },
				{
					cmd: "chatgpt-bridge install --for all",
					purpose: "register with every detected runtime",
				},
				{
					cmd: "chatgpt-bridge install --for cursor --dry-run",
					purpose: "preview without writing",
				},
				{ cmd: "chatgpt-bridge install --for cursor --uninstall", purpose: "remove entry" },
			],
			errors: [
				{
					code: "AUTH_MISSING",
					remedy: {
						cmd: "npx @openai/codex login",
						interactive: true,
						why: "OAuth flow opens browser; user signs in to ChatGPT once",
					},
				},
			],
		},
		{
			name: "capabilities",
			summary: "Print this catalog. Agent reads once, knows everything.",
			args: {},
			returns: { catalog: "object (this document)" },
			side_effects: "none",
			idempotent: true,
			rate_limited: false,
			cache_seconds: 0,
			examples: [{ cmd: "chatgpt-bridge capabilities" }],
		},
		{
			name: "chat",
			summary: "Send a text or multimodal message; receive the assistant reply.",
			args: {
				prompt: {
					type: "string|@file|stdin",
					required: true,
					doc: "User message. '@path' reads file. '-' reads stdin (single prompt or JSONL batch).",
				},
				attach: {
					type: "string[]",
					repeatable: true,
					doc: "Local paths or URLs. Auto-detects image/text. Max 25 MiB each.",
				},
				system: { type: "string|@file", doc: "Optional system prompt." },
				model: { type: "string", default: "gpt-5.2" },
				stream: { type: "bool", default: "true if tty" },
			},
			returns: {
				single: {
					ok: "bool",
					text: "string",
					model: "string",
					usage: "object",
					latency_ms: "number",
				},
				batch: "one JSON object per line",
			},
			side_effects: "Reads attached files. One upstream call per invocation (or per batch line).",
			idempotent: false,
			rate_limited: true,
			typical_latency_seconds: [1, 30],
			examples: [
				{ cmd: "chatgpt-bridge chat 'explain REST'", purpose: "minimal text" },
				{ cmd: "chatgpt-bridge chat 'audit this' --attach spec.md", purpose: "with file context" },
				{ cmd: "chatgpt-bridge chat 'what font?' --attach screenshot.png", purpose: "vision" },
				{ cmd: "echo 'hello' | chatgpt-bridge chat -", purpose: "stdin prompt" },
			],
			errors: [
				{ code: "AUTH_MISSING", remedy: { cmd: "chatgpt-bridge install --for openai-sdk" } },
				{ code: "RATE_LIMITED", remedy: { wait_seconds: "varies" } },
				{ code: "ATTACH_TOO_LARGE", remedy: { action: "split or compress attachment" } },
			],
		},
		{
			name: "image",
			summary: "Generate one image. Optional reference images shape the style.",
			args: {
				prompt: {
					type: "string|@file|stdin",
					required: true,
					doc: "What to draw. '@path' reads file. '-' reads stdin (prompt or JSONL batch).",
				},
				out: { type: "path", default: "./chatgpt-bridge-<ts>.png" },
				ref: {
					type: "string[]",
					repeatable: true,
					doc: "Reference image paths or URLs. Influences style/composition.",
				},
				size: {
					type: "enum",
					values: ["1024x1024", "1024x1536", "1536x1024", "auto"],
					default: "1024x1024",
				},
				quality: {
					type: "enum",
					values: ["low", "medium", "high", "auto"],
					default: "high",
				},
				moderation: { type: "enum", values: ["low", "auto"], default: "low" },
			},
			returns: {
				ok: "bool",
				file: "absolute path",
				bytes: "number",
				latency_ms: "number",
				revised_prompt: "string?",
			},
			side_effects: "Writes one PNG to <out>. Creates parent dir if missing.",
			idempotent: false,
			rate_limited: true,
			typical_latency_seconds: [8, 90],
			examples: [
				{ cmd: "chatgpt-bridge image 'a fox' --out fox.png" },
				{
					cmd: "chatgpt-bridge image 'hero shot, this style' --ref mood.png --ref logo.svg --out hero.png",
				},
				{ cmd: "chatgpt-bridge image 'fox' --dry-run", purpose: "validate without spending quota" },
			],
		},
		{
			name: "models",
			summary: "List available models (chat + image, including upstream + bridge aliases).",
			args: {},
			returns: { models: "string[]" },
			side_effects: "none",
			idempotent: true,
			rate_limited: false,
			cache_seconds: 300,
			examples: [{ cmd: "chatgpt-bridge models" }],
		},
		{
			name: "doctor",
			summary: "Health check. Returns remedy[] for any failing check.",
			args: {},
			returns: {
				status: "healthy|unhealthy",
				checks: "array of {name, ok, detail}",
				remedy: "array of {check, cmd, interactive?, why?} (only when unhealthy)",
			},
			side_effects: "Read-only. One upstream GET to /models for liveness.",
			idempotent: true,
			rate_limited: false,
			examples: [{ cmd: "chatgpt-bridge doctor" }],
		},
		{
			name: "serve",
			summary: "Start the OpenAI-compatible HTTP server on localhost.",
			args: {
				port: { type: "number", default: 10531 },
				host: { type: "string", default: "127.0.0.1" },
			},
			returns: { listening: "string", endpoints: "string[]" },
			side_effects: "Binds to host:port. Foreground process. Shut down with SIGINT/SIGTERM.",
			idempotent: false,
			rate_limited: true,
			examples: [{ cmd: "chatgpt-bridge serve" }, { cmd: "chatgpt-bridge serve --port 11000" }],
		},
		{
			name: "mcp",
			summary: "Run as a Model Context Protocol server over stdio.",
			args: {},
			returns: "speaks MCP on stdin/stdout",
			side_effects:
				"Stdin/stdout reserved for MCP protocol. Errors go to stderr. Auto-registered when you run `install --for <ide>`.",
			idempotent: false,
			rate_limited: true,
			examples: [{ cmd: "chatgpt-bridge mcp" }],
		},
	],
};

/**
 * All verb names in the catalog. Used by tests to assert CLI ↔ catalog parity.
 */
export const CAPABILITY_VERB_NAMES = CAPABILITIES.verbs.map((v) => v.name);
