# chatgpt-bridge

> A localhost OpenAI-compatible HTTP proxy that uses your **ChatGPT subscription** (via OAuth) instead of a paid API key — including **image generation** with `gpt-image-2`.

[![npm version](https://img.shields.io/npm/v/chatgpt-bridge.svg?color=cb3837&logo=npm)](https://www.npmjs.com/package/chatgpt-bridge)
[![license: MIT](https://img.shields.io/npm/l/chatgpt-bridge.svg?color=blue)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/l0z4n0-a1/chatgpt-bridge/ci.yml?branch=main&label=ci)](https://github.com/l0z4n0-a1/chatgpt-bridge/actions)
[![bundle size](https://img.shields.io/badge/published%20size-15.7%20KB-success)](https://www.npmjs.com/package/chatgpt-bridge)
[![source size](https://img.shields.io/badge/source-~900%20LOC-informational)](./src)

```bash
npx chatgpt-bridge serve
```

```python
from openai import OpenAI
c = OpenAI(base_url="http://127.0.0.1:10531/v1", api_key="unused")
img = c.images.generate(model="gpt-image-2", prompt="a fox in the woods")
```

That's the whole demo. The OpenAI SDK calls go through the bridge, the bridge talks to ChatGPT using your existing OAuth tokens, and you get back a base64 PNG. No API key, no per-image charge — just your existing subscription.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [How it works](#how-it-works)
- [Install](#install)
- [First-time setup](#first-time-setup)
- [Usage](#usage)
  - [HTTP API](#http-api)
  - [As a library](#as-a-library)
  - [CLI](#cli)
- [Integrations](#integrations)
- [Configuration](#configuration)
- [Comparison](#comparison)
- [Responsible use](#responsible-use)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

---

## Why this exists

You already pay for a ChatGPT subscription. It generates images, runs the latest models, and you use it daily. But when you want to call the same models from a script, the official path is to **pay again** through `api.openai.com` — separate billing, separate quota, often more expensive per image than your monthly subscription cost.

The official `codex` CLI from OpenAI authenticates you over OAuth and lets you talk to the same models programmatically — but only as a CLI, only for code generation, and not as an HTTP server you can plug into other tools.

This package fills that gap: it's the smallest possible HTTP proxy that **speaks the OpenAI API dialect**, terminating those calls into the OAuth-authenticated upstream that the Codex CLI already uses. Your existing OpenAI SDKs, n8n workflows, ComfyUI nodes, Claude Code skills — anything that talks `localhost:port/v1/...` — just works.

## How it works

```
your code  ─►  localhost:10531/v1/...  ─►  chatgpt.com/backend-api/codex/responses
                  (this package)            (OAuth tokens from ~/.codex/auth.json)
```

OpenAI's Responses API has a built-in `image_generation` tool. The bridge wraps your OpenAI Images request as a Responses tool call, parses the SSE stream, and returns the base64 PNG in the exact shape the OpenAI Images API uses. Your client doesn't know the difference.

Read the deep dive: [docs/architecture.md](./docs/architecture.md).

---

## Install

### Option A — `npx` (zero install)

```bash
npx chatgpt-bridge serve
```

### Option B — Global CLI

```bash
npm i -g chatgpt-bridge
chatgpt-bridge serve
```

### Option C — As a library

```bash
npm i chatgpt-bridge
```

```ts
import { Auth, Upstream, generateImage, loadConfig } from "chatgpt-bridge";

const cfg = loadConfig();
const upstream = new Upstream(cfg, new Auth(cfg));
const img = await generateImage(cfg, upstream, { prompt: "a fox" });
require("fs").writeFileSync("fox.png", Buffer.from(img.b64, "base64"));
```

### Option D — Single binary

Download from [Releases](https://github.com/l0z4n0-a1/chatgpt-bridge/releases): `chatgpt-bridge-linux`, `chatgpt-bridge-macos`, `chatgpt-bridge.exe`.

---

## First-time setup

You need a valid `auth.json`. The simplest way is the official Codex CLI:

```bash
npx @openai/codex login
```

This opens a browser, you sign in to ChatGPT, the CLI writes `~/.codex/auth.json`. The bridge automatically reads from there.

Verify everything works:

```bash
chatgpt-bridge doctor
```

Expected output:

```json
{
  "status": "healthy",
  "checks": [
    { "name": "auth",     "ok": true, "detail": "loaded from …/.codex/auth.json · expires in …s" },
    { "name": "upstream", "ok": true, "detail": "HTTP 200" }
  ]
}
```

---

## Usage

### HTTP API

All endpoints are OpenAI-compatible. Point any OpenAI SDK at `http://127.0.0.1:10531/v1` with **any string** as `apiKey` — it's ignored; auth comes from `auth.json`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Bridge state (auth, rate, version) |
| `GET` | `/v1/models` | List models from upstream + image-gen aliases |
| `POST` | `/v1/responses` | Pass-through to ChatGPT's Responses API |
| `POST` | `/v1/chat/completions` | Translated to `/v1/responses` upstream |
| `POST` | `/v1/images/generations` | Generates a base64 PNG via the `image_generation` tool |
| `*` | `/v1/*` | Catch-all pass-through (forward-compat) |

#### Image generation

```bash
curl http://127.0.0.1:10531/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "a tiny dragon perched on a stack of books",
    "size": "1024x1024",
    "quality": "high"
  }' | jq -r '.data[0].b64_json' | base64 --decode > out.png
```

Response shape (matches OpenAI Images API exactly):

```json
{
  "created": 1714680000,
  "data": [{ "b64_json": "iVBORw0KGgo...", "revised_prompt": "..." }],
  "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 }
}
```

### As a library

```ts
import { generateImage, Auth, Upstream, loadConfig } from "chatgpt-bridge";

const cfg = loadConfig();
const upstream = new Upstream(cfg, new Auth(cfg));
const img = await generateImage(cfg, upstream, {
  prompt: "a serene mountain landscape at dawn",
  size: "1024x1024",
  quality: "high",
});
// img.b64        → base64 PNG string
// img.revisedPrompt → optional, may differ from input prompt
// img.usage      → token usage from upstream
```

### CLI

```
chatgpt-bridge serve              Start the local proxy server
chatgpt-bridge gen <prompt>       Generate one image to a file (one-shot)
chatgpt-bridge mcp                Run as an MCP server (Claude Desktop / Cursor / Zed)
chatgpt-bridge doctor             Health checks; exit 0 if healthy
chatgpt-bridge login              Run `npx @openai/codex login`
chatgpt-bridge version            Print version + runtime info
```

#### Examples

```bash
# Start the server (default :10531)
chatgpt-bridge serve

# One-shot image to a file
chatgpt-bridge gen "a small red fox under an oak tree, watercolor" --out fox.png

# Use a different port
chatgpt-bridge serve --port 11000

# Check health
chatgpt-bridge doctor
```

---

## Integrations

Working snippets for the most common tools:

| Tool | Snippet |
|---|---|
| **OpenAI Python SDK** | [docs/integrations.md#openai-python-sdk](./docs/integrations.md#openai-python-sdk) |
| **OpenAI Node SDK** | [docs/integrations.md#openai-node-sdk](./docs/integrations.md#openai-node-sdk) |
| **Vercel AI SDK** | [docs/integrations.md#vercel-ai-sdk](./docs/integrations.md#vercel-ai-sdk) |
| **LangChain** | [docs/integrations.md#langchain](./docs/integrations.md#langchain) |
| **n8n** | [examples/n8n.json](./examples/n8n.json) |
| **ComfyUI** | [docs/integrations.md#comfyui](./docs/integrations.md#comfyui) |
| **Claude Code Skill** | [examples/claude-code-skill/](./examples/claude-code-skill/) |
| **Claude Desktop / Cursor / Zed (MCP)** | [#use-with-claude-desktop-cursor-zed-mcp](#use-with-claude-desktop-cursor-zed-mcp) |
| **curl + jq** | [examples/curl.sh](./examples/curl.sh) |

### Use with Claude Desktop / Cursor / Zed (MCP)

The bridge ships a [Model Context Protocol](https://modelcontextprotocol.io) server. Add it to your client config:

```json
{
  "mcpServers": {
    "chatgpt-bridge": {
      "command": "npx",
      "args": ["-y", "chatgpt-bridge", "mcp"]
    }
  }
}
```

Restart your MCP client. Three tools become available:

- `generate_image(prompt, out?, size?, quality?)` — saves a PNG, returns the path.
- `chat(prompt, system?, model?)` — assistant reply as plain text.
- `health()` — bridge state snapshot.

That's it. No HTTP, no port, no API key — Claude Desktop can now generate images using the user's ChatGPT subscription.

Full integrations guide: [docs/integrations.md](./docs/integrations.md).

---

## Configuration

Defaults are sensible. Override via environment variables:

| Env var | Default | What |
|---|---|---|
| `CHATGPT_BRIDGE_HOST` | `127.0.0.1` | Bind host |
| `CHATGPT_BRIDGE_PORT` | `10531` | Bind port |
| `CHATGPT_BRIDGE_AUTH_FILE` | (auto) | Override path to `auth.json` |
| `CHATGPT_BRIDGE_IMAGE_MODEL` | `gpt-5.4-mini` | Text model that invokes the image tool |
| `CHATGPT_BRIDGE_CLIENT_ID` | (Codex CLI's client_id) | OAuth client_id |

`auth.json` lookup order (first match wins):

1. `$CHATGPT_BRIDGE_AUTH_FILE`
2. `$CHATGPT_LOCAL_HOME/auth.json`
3. `$CODEX_HOME/auth.json`
4. `~/.chatgpt-local/auth.json`
5. `~/.codex/auth.json`
6. `~/.chatgpt-bridge/auth.json`

---

## Comparison

| | OpenAI API | `chatgpt-bridge` | Reverse-eng (`acheong08/ChatGPT`, etc.) |
|---|---|---|---|
| Auth | API key | OAuth (Codex flow) | Cookie / session token |
| Cost per image | $0.02–$0.21 | $0 (subscription) | $0 (subscription) |
| Stability | Highest | High (uses developer endpoint) | Low (consumer endpoint hardened) |
| Setup | `OPENAI_API_KEY=...` | `npx @openai/codex login` | Browser cookie extraction |
| ToS posture | Sanctioned | Gray-area but uses official auth | Generally violates ToS |
| Maintenance | None on your side | Occasional patches | Constant cat-and-mouse |
| Best for | Production | Personal scripts, integrations, Claude Code | Hacking, learning |

If you need production reliability and can spend per image, use the OpenAI API. If you have a subscription and want your scripts to use it, this. If you want to learn how the consumer endpoints work, the reverse-eng projects are educational.

---

## Responsible use

- **Personal use, single user.** Not a SaaS, not a way to share one subscription across users.
- **OpenAI's Terms of Use** generally discourage automated access to consumer surfaces. The bridge ships with conservative rate limits and human-like jitter on purpose.
- **No telemetry.** Zero outbound traffic except to `chatgpt.com` and `auth.openai.com`. Read the source.
- **Tokens stay local.** `auth.json` is read, refreshed, and written back to the same file. Never copied elsewhere.

Full security model: [docs/security.md](./docs/security.md).

---

## Documentation

- [Architecture](./docs/architecture.md) — how the bridge works, end to end.
- [Integrations](./docs/integrations.md) — drop-in snippets for popular tools.
- [Troubleshooting](./docs/troubleshooting.md) — common errors, common fixes.
- [Security model](./docs/security.md) — threat model, supply-chain notes.
- [FAQ](./docs/faq.md) — questions people actually ask.
- [Releasing](./docs/releasing.md) — for maintainers.

---

## Contributing

The codebase is intentionally small (~900 LOC across 7 files). Read it end to end before opening a PR.

```bash
git clone https://github.com/l0z4n0-a1/chatgpt-bridge.git
cd chatgpt-bridge
bun install
bun run typecheck
bun test
bun run lint
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

For security issues: [SECURITY.md](./SECURITY.md). Do not file public issues.

---

## License

MIT © [João Gabriel Lozano](https://github.com/l0z4n0-a1) — 2026

This project is **clean-room implemented**. It contains no code copied from `openai-oauth`, `ima2-gen`, or any other source under non-MIT-compatible licenses. The OAuth flow follows RFC 6749 and the upstream contract is observed from public OpenAI documentation.
