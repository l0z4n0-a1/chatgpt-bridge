# chatgpt-bridge

> Localhost OpenAI-compatible HTTP proxy that uses your **ChatGPT subscription** (via OAuth) instead of an API key. Including **image generation** through `gpt-image-2`.

[![npm](https://img.shields.io/npm/v/chatgpt-bridge.svg)](https://www.npmjs.com/package/chatgpt-bridge)
[![license](https://img.shields.io/npm/l/chatgpt-bridge.svg)](./LICENSE)
[![ci](https://img.shields.io/github/actions/workflow/status/lozanojoaog/chatgpt-bridge/ci.yml?branch=main)](https://github.com/lozanojoaog/chatgpt-bridge/actions)

```bash
npx chatgpt-bridge serve
# → listening on http://127.0.0.1:10531/v1
```

```python
from openai import OpenAI
c = OpenAI(base_url="http://127.0.0.1:10531/v1", api_key="unused")
img = c.images.generate(model="gpt-image-2", prompt="a fox in the woods")
```

That's it. Same SDK you'd use against `api.openai.com` — but the bytes go through your existing ChatGPT Plus subscription.

---

## What this is

A local HTTP server that speaks the OpenAI API dialect. When a client calls `POST /v1/images/generations` (or `/v1/chat/completions`, `/v1/responses`, …), the bridge:

1. Reads the OAuth tokens already stored at `~/.codex/auth.json` (created by the official `codex` CLI).
2. Forwards the request to `chatgpt.com/backend-api/codex/responses` with the right OAuth headers.
3. Translates ChatGPT's stream back to the shape the OpenAI SDK expects.

So any tool that talks the OpenAI API — Python SDK, Node SDK, n8n, ComfyUI, LangChain, your own scripts — can use your ChatGPT subscription as the backend.

## What this is **not**

- Not a way to bypass billing. You still need an active **ChatGPT Plus** (or Pro/Team/Enterprise) subscription.
- Not a public API. Listens on `127.0.0.1` only. Single-user, single-machine by design.
- Not officially endorsed by OpenAI. See [Responsible use](#responsible-use).

---

## Install

### Option A — `npx` (no install)

```bash
npx chatgpt-bridge serve
```

### Option B — global CLI

```bash
npm i -g chatgpt-bridge
chatgpt-bridge serve
```

### Option C — as a library

```bash
npm i chatgpt-bridge
```

```ts
import { generateImage, Auth, Upstream, loadConfig } from "chatgpt-bridge";

const cfg = loadConfig();
const upstream = new Upstream(cfg, new Auth(cfg));
const img = await generateImage(cfg, upstream, { prompt: "a serene mountain" });
require("fs").writeFileSync("out.png", Buffer.from(img.b64, "base64"));
```

### Option D — single binary

Download from [Releases](https://github.com/lozanojoaog/chatgpt-bridge/releases): `chatgpt-bridge-linux`, `chatgpt-bridge-macos`, `chatgpt-bridge.exe`.

---

## First-time setup (once)

You need a valid `auth.json`. The simplest way is the official Codex CLI:

```bash
npx @openai/codex login
```

This opens a browser, you sign in to ChatGPT, the CLI writes `~/.codex/auth.json`. The bridge automatically reads from there.

Verify everything works:

```bash
chatgpt-bridge doctor
```

---

## CLI

```
chatgpt-bridge serve              Start the local proxy server
chatgpt-bridge gen <prompt>       Generate one image to a file (one-shot)
chatgpt-bridge doctor             Health checks; exit 0 if healthy
chatgpt-bridge login              Run `npx @openai/codex login`
chatgpt-bridge version            Print version + runtime info
```

### Examples

```bash
# Start the server
chatgpt-bridge serve --port 10531

# Generate an image directly (no server needed)
chatgpt-bridge gen "a small red fox under an oak tree, watercolor" --out fox.png

# Check health
chatgpt-bridge doctor
# → {"status":"healthy","checks":[...]}
```

---

## HTTP API

All endpoints are OpenAI-compatible. Point any OpenAI SDK at `http://127.0.0.1:10531/v1` with any string as `apiKey` (it's ignored — auth comes from `auth.json`).

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Bridge state (auth, rate, version) |
| `GET` | `/v1/models` | Lists models from upstream + image-gen aliases |
| `POST` | `/v1/responses` | Pass-through to ChatGPT's Responses API |
| `POST` | `/v1/chat/completions` | Translated to `/v1/responses` upstream |
| `POST` | `/v1/images/generations` | Generates a base64 PNG via the `image_generation` tool |
| `*` | `/v1/*` | Catch-all pass-through (forward-compat) |

### Image generation

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

Response shape (OpenAI Images API exact match):

```json
{
  "created": 1714680000,
  "data": [
    { "b64_json": "iVBORw0KGgo...", "revised_prompt": "..." }
  ],
  "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 }
}
```

---

## Use it in your tools

### Python

```python
from openai import OpenAI
import base64

c = OpenAI(base_url="http://127.0.0.1:10531/v1", api_key="unused")
img = c.images.generate(model="gpt-image-2", prompt="a fox")
open("fox.png", "wb").write(base64.b64decode(img.data[0].b64_json))
```

### Node / TypeScript

```ts
import OpenAI from "openai";
import { writeFileSync } from "node:fs";

const c = new OpenAI({ baseURL: "http://127.0.0.1:10531/v1", apiKey: "unused" });
const img = await c.images.generate({ model: "gpt-image-2", prompt: "a fox" });
writeFileSync("fox.png", Buffer.from(img.data[0].b64_json, "base64"));
```

### Claude Code (as a Skill)

Copy `examples/claude-code-skill/` into `~/.claude/skills/` and Claude Code can call image generation directly. See [examples/claude-code-skill/SKILL.md](./examples/claude-code-skill/SKILL.md).

### n8n / Make / Zapier

Add an HTTP Request node pointing at `http://127.0.0.1:10531/v1/images/generations` with the same JSON body as above. See [examples/n8n.json](./examples/n8n.json) for an importable workflow.

### ComfyUI

Use any "OpenAI Image" custom node and set the API base to `http://127.0.0.1:10531/v1`.

---

## Configuration

Defaults are sensible. Override via environment variables:

| Env var | Default | What |
|---|---|---|
| `CHATGPT_BRIDGE_HOST` | `127.0.0.1` | Bind host |
| `CHATGPT_BRIDGE_PORT` | `10531` | Bind port |
| `CHATGPT_BRIDGE_AUTH_FILE` | (auto-detect) | Override path to `auth.json` |
| `CHATGPT_BRIDGE_IMAGE_MODEL` | `gpt-5.4-mini` | Text model that invokes the image tool |
| `CHATGPT_BRIDGE_CLIENT_ID` | `app_EMoamEEZ73f0CkXaXp7hrann` | OAuth client_id (matches Codex CLI) |

`auth.json` lookup order (first match wins):

1. `$CHATGPT_BRIDGE_AUTH_FILE`
2. `$CHATGPT_LOCAL_HOME/auth.json`
3. `$CODEX_HOME/auth.json`
4. `~/.chatgpt-local/auth.json`
5. `~/.codex/auth.json`
6. `~/.chatgpt-bridge/auth.json`

---

## Responsible use

- **Personal use, single user.** This isn't a SaaS or a way to share one subscription across people.
- **OpenAI's Terms of Use** prohibit automated access to consumer surfaces. Use the bridge for personal scripts and integrations on your own machine.
- **No telemetry, no phoning home.** Everything stays on `localhost`. Read the source — there are ~900 lines of it.
- **Conservative rate limits** are enforced by default (`rateHourlyHard = 200`).

---

## How it works (one paragraph)

OpenAI's Responses API exposes `image_generation` as a built-in tool. When you POST to `/v1/responses` with `tools: [{type: "image_generation"}]`, the upstream model invokes it and the SSE stream contains an `image_generation_call` event whose `result` field is the base64 PNG. The bridge takes a regular OpenAI Images request, wraps it in the right Responses payload, parses the stream, and returns the OpenAI Images response shape. The OAuth headers (`Authorization: Bearer …`, `chatgpt-account-id: …`, `OpenAI-Beta: responses=experimental`) come from the `auth.json` that the official `codex` CLI maintains.

---

## Development

```bash
git clone https://github.com/lozanojoaog/chatgpt-bridge.git
cd chatgpt-bridge
bun install
bun run dev          # serve in watch mode
bun run typecheck    # tsc --noEmit
bun test             # run tests
bun run build        # produce dist/
```

The codebase is intentionally small. Read `src/` start to finish in 30 minutes.

---

## License

MIT © [João Gabriel Lozano](https://github.com/lozanojoaog)
