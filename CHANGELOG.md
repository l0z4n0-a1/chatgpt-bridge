# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

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
