# AGENTS.md

> Instructions for AI coding agents (Claude Code, Cursor, Cline, Aider, etc.) working *inside this repository*. If you are an agent **using** the bridge from another project, see [llms.txt](./llms.txt) instead.

## What this repo is

A small TypeScript package (~900 LOC) that exposes a localhost OpenAI-compatible HTTP proxy. It reads OAuth tokens from `~/.codex/auth.json` and forwards requests to `chatgpt.com/backend-api/codex/responses`. See [docs/architecture.md](./docs/architecture.md) for the deep-dive.

## Project layout

```
src/
  cli.ts          # commander entry — 6 commands
  server.ts       # Hono routes (all 6 endpoints inline)
  auth.ts         # OAuth token load / decode / refresh
  upstream.ts     # single fetch wrapper + SSE parser
  images.ts       # /v1/images/generations translator
  mcp.ts          # MCP server (chatgpt-bridge mcp)
  config.ts       # defaults + env var overrides
  index.ts        # public library API exports
test/             # unit tests (bun test)
examples/         # one-file integrations (Python, Node, curl, n8n, Claude Code skill)
docs/             # deep dives
scripts/build.ts  # bun build + tsc declarations
```

## Conventions

- **Tabs for indentation** (Biome enforces).
- **LF line endings** (enforced by `.gitattributes` — Windows-safe).
- **No emoji in source code or comments.**
- **No telemetry** of any kind. PRs adding "phone home" code are rejected.
- **No new dependencies** without justification. Total runtime deps must stay ≤ 5.
- **One file = one responsibility.** Don't add `utils.ts` or `helpers.ts`.

## Commands an agent will need

```bash
bun install         # one-time
bun run typecheck   # tsc --noEmit (must pass)
bun test            # unit tests (must pass)
bun run lint        # biome check (must pass)
bun run build       # produce dist/ for npm publish
bun run dev         # run from source: chatgpt-bridge serve
```

## Tasks an agent might be asked to do

### "Add a new endpoint"

1. Define a Zod schema in the relevant file (or `src/types.ts` if shared).
2. Add the route to `src/server.ts`. **Inline, do not split into route files.**
3. If it's a new translation pattern, add a function next to `generateImage` style.
4. Add a unit test in `test/`.
5. Update `README.md` HTTP API table.
6. Update `docs/architecture.md` source map.

### "Add a new MCP tool"

1. Add the tool definition to the `TOOL_DEFINITIONS` array in `src/mcp.ts`.
2. Add a handler function (e.g. `handleNewTool`).
3. Wire it into the `CallToolRequestSchema` switch.
4. Update `llms.txt` MCP tools list.
5. Update `README.md` MCP section.

### "Add a new `install --for <target>` adaptor"

1. Add the target name to the `Target` union in `src/install.ts`.
2. Add a `pathXxx()` helper next to the others, returning the absolute config-file path. Cover mac/linux/windows via `appDataDir()` if the target is a GUI app.
3. Wire the new path into the `installSingle()` switch (uses `applyMcpJson()` for JSON-MCP targets; write a dedicated function only if the target's config format is exotic, like `applyCodexToml()`).
4. Add the target to the `candidates` array in `runInstall()` so `--for all` picks it up; or skip it if the target is snippet-only (like `openai-sdk`).
5. Add the target to `CAPABILITIES.verbs[install].args.for.values` in `src/capabilities.ts` and to the `--for` description in `src/cli.ts`.
6. Add an entry to the `install` test suite in `test/install.test.ts` (round-trip: install → idempotent re-install → uninstall preserves other keys).
7. Document the target in `llms.txt` install table and `README.md`.

Adaptor budget: ~30 LOC each. If you need more, the target's config format is wrong for our model — file an issue first.

### "Bump the version"

See [docs/releasing.md](./docs/releasing.md) — three places need updating: `package.json`, `src/server.ts` `VERSION` constant, `CHANGELOG.md`.

### "Fix a bug"

1. Reproduce locally with a failing test in `test/`.
2. Fix.
3. Test passes.
4. Add a CHANGELOG entry under `[Unreleased]`.

## Things to NEVER do in this repo

- **Never log token contents.** `pino` is not currently used; if you add any logger, configure redaction first. Currently we just `console.error` text — never include the access_token.
- **Never write to `auth.json` outside the `Auth` class.** That file is the user's credential vault.
- **Never expand the network surface.** Outbound traffic stays restricted to `chatgpt.com` and `auth.openai.com`.
- **Never add `console.log` to source.** Use `console.error` for any human-facing output (stdout is reserved for protocol traffic in `mcp` mode).
- **Never commit the contents of `dist/`** to git — `.gitignore` blocks it. Distributed via `bun run build` + `npm publish`.
- **Never add CRLF line endings.** `.gitattributes` enforces LF; biome formatter rejects CRLF.

## Verifying your changes

Before opening a PR:

```bash
bun run typecheck && bun test && bun run lint && bun run build
```

All four must pass. CI runs the same checks across Linux, macOS, and Windows.

If you changed user-facing behavior, also do a smoke test against a fresh install:

```bash
npm pack
cd /tmp && mkdir test && cd test && npm init -y >/dev/null
npm install /path/to/chatgpt-bridge-x.y.z.tgz
./node_modules/.bin/chatgpt-bridge doctor
```

## Pull request etiquette

- One change per PR. No "while I was in there" sweeps.
- Update `CHANGELOG.md` under `[Unreleased]`.
- Match the existing tone in docs: terse, professional, no emoji, no hype.
- Don't introduce new directories without asking. Current tree is intentional.

## Where to ask

- Bugs: GitHub Issues (use the bug template).
- Features: GitHub Issues (use the feature template — but read [docs/architecture.md](./docs/architecture.md) first to confirm it fits the design).
- Security: do **not** open an issue. See [SECURITY.md](./SECURITY.md).

## License

MIT. By contributing, you agree to license your contribution under MIT.
