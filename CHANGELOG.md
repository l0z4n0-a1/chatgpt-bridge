# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-05-03

The agent-native release. Two-line setup, three killer capabilities, one machine-readable catalog. Everything from 0.2.0 keeps working.

### Headlines

- **One-shot install for 10 IDEs / agent runtimes.** `chatgpt-bridge install --for <target>` writes the right MCP/config block to the right path on the right OS. Idempotent, supports `--dry-run` and `--uninstall`. Refuses to overwrite a non-JSON config file.
  Targets: `claude-code`, `claude-desktop`, `codex`, `cursor`, `zed`, `cline`, `continue`, `gemini-cli`, `aider` (snippet), `openai-sdk` (snippet), `all` (auto-detects what's installed).
- **Multimodal input.** Vision (`image_url` content parts) and file context (`{type:"input_file", file:{path|url|data,mime}}` — bridge extension) work first-class on `/v1/chat/completions`. Reference images (`reference_images[]` — bridge extension) drive style/composition on `/v1/images/generations`. 25 MiB per attachment, 100 MiB aggregate. Path-traversal guard blocks attempts to read `~/.codex/auth.json`.
- **Machine-readable catalog.** `chatgpt-bridge capabilities` returns one JSON document describing every verb, arg, return shape, idempotency, side effects, typical latency, and error-code → structured `remedy` mapping. Agents read once, know everything.

### Added — CLI verbs

- `chatgpt-bridge chat <prompt|@file|->` — text or multimodal message. `--attach <path|url>` repeatable; auto-detects image vs. text. `--system <text|@file>`. Streams to tty; JSON to pipe.
- `chatgpt-bridge image <prompt|@file|->` — generate one PNG. `--ref <path|url>` repeatable (max 8) for style transfer. JSON output with absolute path, byte count, latency, and `revised_prompt` from the model.
- `chatgpt-bridge models` — list available chat + image models (deduped, sorted, includes synthetic image aliases).
- `chatgpt-bridge install --for <target>` and `chatgpt-bridge capabilities` — see Headlines.
- **Stdin JSONL batch** for `chat` and `image` — pipe one job per line, get one result line per job. Exit 0 if any job succeeds, 1 if none.
- **`@file` syntax** in any string flag — `--system @persona.md`, prompt arg as `@brief.md`, etc.
- **Universal `--dry-run`** on `chat`, `image`, `install` — validates inputs, never calls upstream or writes files.
- **Documented exit codes** — `0` ok, `1` user error, `2` auth, `3` upstream, `4` rate-limited, `5` quota exhausted.

### Added — HTTP

- `/v1/chat/completions` now translates OpenAI vision parts (`image_url`) → Responses `input_image`, and the bridge-extension `input_file` part (with `file:{path|url|data,mime,filename}`) → resolved Responses `input_file`. Unknown part types pass through verbatim (forward-compat).
- `/v1/images/generations` accepts an optional `reference_images: AttachmentSpec[]` field (max 8). When refs are present, `tool_choice` flips from `required` to `auto` so the model can inspect references before invoking the image-generation tool.
- `/health`, `/v1/responses`, `/v1/models`, `/v1/*` catch-all unchanged.

### Added — MCP

- `chat` tool gains `attachments?: string[]`. `generate_image` tool gains `references?: string[]`. Same caps and semantics as the HTTP and CLI surfaces. Existing 3 tools, no new ones.

### Added — library

```ts
import {
  CAPABILITIES, CAPABILITY_VERB_NAMES,
  runInstall, type InstallTarget, type InstallResult,
  resolveAttachment, resolveAttachments, toContentPart, AttachmentError,
  type AttachmentKind, type ResolvedAttachment,
  translateChatMessages,
  DEFAULT_CHAT_MODEL,
} from "chatgpt-bridge";
```

### Changed

- `gen` is now a deprecated alias for `image` (warns to stderr, then forwards). Will be removed in 0.5.
- `doctor` returns a `remedy[]` array when any check fails (`{check, cmd, interactive?, why?}`). Agents can read it and act without involving the user.
- `gpt-5.2` is no longer hardcoded across nine source locations — `DEFAULT_CHAT_MODEL` in `config.ts` is the single source of truth (also exported).

### Fixed

- **Empty-prompt guard** on `chat` and `image`. An empty prompt (missing arg, empty stdin, or empty `prompt` field in a JSONL line) now exits with code 1 and a structured `remedy`. Previously the bridge sent a placeholder request to the upstream and wasted quota.
- **`install` refuses to overwrite garbage.** When the target config file exists but isn't valid JSON (e.g. corrupted/null-byte `~/.cursor/mcp.json` files inherited from prior tools), `install` returns `{ok:false, error, remedy:{action,path}}` and leaves the file untouched. Empty/whitespace-only files are still safe to overwrite.
- **`doctor` exit code on Windows + Node 24.** Worked around a libuv `UV_HANDLE_CLOSING` assertion that fired during synchronous teardown after the global fetch's keep-alive socket. Bun was already unaffected.
- **MCP `health` `remedy` field** is now a structured `{cmd, interactive, why}` object, matching every other surface (was a plain string).

### Internal

- New modules: `src/install.ts` (10 adaptors), `src/capabilities.ts` (catalog), `src/attachments.ts` (resolver), `src/io.ts` (CLI I/O helpers).
- Code grew from ~900 LOC across 7 source files to ~1.7k LOC across 11. Reads end-to-end in under an hour.
- Test count: 17 → 90. Coverage spans schema validation, path safety, MIME detection, install round-trips, dry-run, JSONL parsing, error-catalog parity, compiled-CLI smoke.
- `Target` switch in `installSingle` is exhaustive — TypeScript's `never` assertion catches new-target omissions at compile time.
- Zero new runtime dependencies (re-uses `zod`).

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

[0.3.0]: https://github.com/l0z4n0-a1/chatgpt-bridge/releases/tag/v0.3.0
[0.2.0]: https://github.com/l0z4n0-a1/chatgpt-bridge/releases/tag/v0.2.0
[0.1.1]: https://github.com/l0z4n0-a1/chatgpt-bridge/releases/tag/v0.1.1
[0.1.0]: https://github.com/l0z4n0-a1/chatgpt-bridge/releases/tag/v0.1.0
