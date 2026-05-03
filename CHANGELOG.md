# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — MCP mirror

- **MCP `chat` tool** — gains `attachments?: string[]` argument. Local paths or URLs auto-detect image vs. text and become vision input or contextual `input_file` parts. Same 25 MiB / 100 MiB caps as the HTTP and CLI surfaces.
- **MCP `generate_image` tool** — gains `references?: string[]` argument. Up to 8 reference images shape style/composition. Identical wire to CLI `--ref` and HTTP `reference_images[]`.
- Tool descriptions updated to surface the new capabilities so MCP-aware agents (Claude Desktop, Cursor, Zed, Cline, Continue) see them at tool-discovery time.

### Added — CLI verbs (chat, image, models)

- **`chatgpt-bridge chat <prompt|@file|->`** — send a text or multimodal message; print reply (streamed to tty by default, JSON when piped). `--attach <path|url>` (repeatable) for files/images. `--system <text|@file>` reads system prompt from string or file. `--model`, `--stream`/`--no-stream`, `--json`, `--dry-run`. Stdin `-` accepts a single prompt or JSONL batch (one job per line).
- **`chatgpt-bridge image <prompt|@file|->`** — replaces `gen` (which is kept as a deprecated alias that warns and forwards). New `--ref <path|url>` (repeatable, max 8) for reference images. Same JSONL batch via stdin. Always emits JSON `{ok, file, bytes, latency_ms, revised_prompt}`.
- **`chatgpt-bridge models`** — list available models (sorted, deduped, includes synthetic image aliases). Returns `{models: string[]}`.
- **`@file` syntax** — any string flag accepting `--system @path.md`, `--prompt @brief.md`, etc., reads the file contents in place of the literal string.
- **Stdin JSONL batch** — `chat -` and `image -` accept JSONL on stdin: one job object per line (e.g. `{"prompt":"a","ref":["mood.png"],"out":"a.png"}`). Each result is a JSON line on stdout. Exit code 0 if any job succeeded, 1 if none.
- **Global `--dry-run`** on `chat`, `image`, `install` — validates inputs and prints what would be sent without calling upstream or writing files.
- **Documented exit codes**: 0 ok, 1 user-error, 2 auth, 3 upstream, 4 rate-limited.

### Internal

- New module `src/io.ts` (~110 LOC) — single-responsibility I/O helpers: `resolveAtFile`, `parseStdin`, `readStdin`, `writeJson`, `writeError`, `classifyExitCode`, `isTty`. Keeps `cli.ts` focused on Commander wiring.
- 10 new tests in `test/io.test.ts` covering `@file` resolution and JSONL detection (plain text vs. JSONL, blank-line tolerance, malformed-line line-number reporting).

### Added — multimodal input

- **Vision input** in `/v1/chat/completions` — OpenAI vision shape (`{type:"image_url", image_url:{url}}` or string URL/data-URL) is translated to Responses `input_image` content parts. URLs pass through to upstream; the bridge does not fetch them.
- **File-as-context** in `/v1/chat/completions` — bridge extension content part `{type:"input_file", file:{path|url|data,mime,filename}}`. Local paths are read, base64-encoded, sent as `input_file`. Path-traversal guard blocks attempts to read `~/.codex/auth.json` or any auth-file candidate directory. 25 MiB per attachment, 100 MiB aggregate cap.
- **Reference images** in `/v1/images/generations` — new optional `reference_images[]` field accepts paths, URLs, data-URLs, or `{path|url|data}` objects (max 8). Drives style/composition. When present, `tool_choice` flips from `required` to `auto` so the model can inspect references before generating.
- **`AttachmentSpec`, `resolveAttachment`, `resolveAttachments`, `toContentPart`, `AttachmentError`** exported from the library entry point.
- **`translateChatMessages`** exported for direct use by integrations that build their own Responses-API bodies.

### Internal

- New module `src/attachments.ts` (~290 LOC) — single-responsibility resolver. Handles MIME detection (extension + magic bytes), path safety (allowedRoot + forbiddenPaths derived from `authFileCandidates`), size caps, and produces ready-to-splice content parts.
- `src/server.ts` chat translator (`translateChatMessages`) — maps OpenAI Chat parts to Responses parts, resolves bridge-extension `input_file` parts inline. Forward-compatible: unknown part types pass through verbatim.
- `src/images.ts` — `ImageRequest` schema gains `reference_images?: AttachmentSpec[]` (max 8). `buildBody` is now async; injects `input_image` parts into the user turn when refs are provided.
- 35 new tests across `attachments.test.ts` and `server.test.ts`: schema shapes, MIME detection, path traversal, size caps, vision translation, file-as-context, URL pass-through, schema cap of 8 refs.

### Added — agent-native core

- **`chatgpt-bridge install --for <target>`** — one-shot, idempotent registration with 10 IDE/agent runtimes: `claude-code`, `claude-desktop`, `codex`, `cursor`, `zed`, `cline`, `continue`, `aider`, `gemini-cli`, `openai-sdk`, plus `all` (auto-detects installed runtimes, skips absent ones). Supports `--dry-run` and `--uninstall`. Agents never have to hand-edit MCP/config files again.
- **`chatgpt-bridge capabilities`** — machine-readable capability catalog. Returns a single JSON document describing every verb, args, returns, idempotency, side effects, typical latency, errors with structured `remedy`. Agents read once, know everything.
- **`doctor` remedies** — when checks fail, output now includes a `remedy[]` array with executable next steps (`{check, cmd, interactive?, why?}`). Replaces the need for separate `auth`/`login` verbs in agent flows.
- **Library exports** — `runInstall`, `CAPABILITIES`, `CAPABILITY_VERB_NAMES`, plus `InstallTarget`, `InstallResult`, `InstallOptions` types.

### Internal

- New module `src/capabilities.ts` (~280 LOC) — single source of truth for the agent-facing surface. A test (`test/capabilities.test.ts`) asserts catalog ↔ implementation parity.
- New module `src/install.ts` (~290 LOC) — 10 adaptor implementations behind a uniform `runInstall(target, options)` entry point. Cross-platform path resolution (mac / linux / windows) for every target's config file.
- 15 new tests covering install round-trips (write → re-install idempotent → uninstall preserves other keys), `--dry-run`, `--for all` skip behavior on bare environments, and full catalog coverage.

## [0.2.0] — 2026-05-03

### Added

- **`chatgpt-bridge mcp`** — Model Context Protocol server over stdio. One-line install in Claude Desktop / Cursor / Zed / Cline. Exposes 3 tools: `generate_image`, `chat`, `health`.
- **`llms.txt`** — agent-readable documentation entry point following the [llmstxt.org](https://llmstxt.org) convention.
- **`AGENTS.md`** — instructions for AI coding agents working *in this repo* (project layout, conventions, never-do list).
- **Structured CLI errors** — top-level errors now emit JSON to stderr with `ok`, `error`, `remedy` fields. Agents can parse and act on them.

### Dependencies

- `@modelcontextprotocol/sdk` (new, runtime).

## [0.1.1] — 2026-05-03

### Changed

- Documentation pass: README rewritten with TOC + comparison + clearer "why".
- Added `docs/`: architecture, security, troubleshooting, FAQ, integrations, releasing.
- Repo hygiene: `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue templates, PR template.
- All repository URLs point to `l0z4n0-a1/chatgpt-bridge` (correct GitHub handle).

### Fixed

- Build script now emits `.d.ts` declarations correctly via `tsconfig.build.json`.
- `/v1/chat/completions` non-streaming requests no longer return HTTP 400. The
  bridge always streams from upstream (Codex `/responses` requires it) and
  aggregates the response when the caller asked for non-streaming.

## [0.1.0] — 2026-05-03

### Added

- Initial public release.
- Localhost OpenAI-compatible HTTP server (`/v1/models`, `/v1/responses`, `/v1/chat/completions`, `/v1/images/generations`, catch-all pass-through, `/health`).
- OAuth token reader / refresher compatible with `~/.codex/auth.json` written by the official `codex` CLI.
- CLI: `serve`, `gen`, `doctor`, `login`, `version`.
- Library API: `generateImage`, `Auth`, `Upstream`, `createApp`, `loadConfig`.
- Examples: Python, Node, curl, n8n, Claude Code skill.

[0.2.0]: https://github.com/l0z4n0-a1/chatgpt-bridge/releases/tag/v0.2.0
[0.1.1]: https://github.com/l0z4n0-a1/chatgpt-bridge/releases/tag/v0.1.1
[0.1.0]: https://github.com/l0z4n0-a1/chatgpt-bridge/releases/tag/v0.1.0
