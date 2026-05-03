# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
