# Architecture

The whole thing fits on a napkin.

```
┌────────────────────────────┐
│  Your code                 │
│  (Python / Node / curl /   │
│   n8n / Claude Code / …)   │
└──────────────┬─────────────┘
               │  POST localhost:10531/v1/images/generations
               │  (OpenAI dialect)
               ▼
┌────────────────────────────────────────────────┐
│  chatgpt-bridge (this package, ~1.7k LOC)      │
│  ┌──────────────────────────────────────────┐  │
│  │ Hono router                              │  │
│  │   /v1/images/generations  ─► images.ts   │  │
│  │   /v1/responses           ─► passthrough │  │
│  │   /v1/chat/completions    ─► translate   │  │
│  │   /v1/models              ─► cache       │  │
│  │   /v1/*                   ─► passthrough │  │
│  │   /health                 ─► state       │  │
│  └──────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │ Auth (auth.ts)                           │  │
│  │   reads ~/.codex/auth.json               │  │
│  │   refreshes via auth.openai.com (RFC 6749)│ │
│  │   exposes:                                │ │
│  │     Authorization: Bearer <access_token> │  │
│  │     chatgpt-account-id: <UUID>           │  │
│  │     OpenAI-Beta: responses=experimental  │  │
│  └──────────────────────────────────────────┘  │
└──────────────────┬─────────────────────────────┘
                   │  HTTPS
                   ▼
       ┌──────────────────────────────────────┐
       │  chatgpt.com/backend-api/codex       │
       │    /responses     POST  (SSE)        │
       │    /models?...    GET                │
       └──────────────────────────────────────┘
```

## Why image generation works through `/responses`

OpenAI's Responses API (the successor to Chat Completions) exposes built-in tools, including `image_generation`. When you POST a request like:

```json
{
  "model": "gpt-5.4-mini",
  "input": [{"role": "user", "content": "Generate an image: a fox"}],
  "tools": [{"type": "image_generation", "quality": "high", "size": "1024x1024"}],
  "tool_choice": "required",
  "stream": true
}
```

the upstream model invokes `image_generation` internally, and the SSE stream contains an event:

```
event: response.output_item.done
data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"<base64-png>","revised_prompt":"...","index":0}}
```

The bridge unwraps that `item.result` and returns it shaped exactly like the OpenAI Images API:

```json
{ "created": ..., "data": [{"b64_json": "<base64-png>", "revised_prompt": "..."}], "usage": {...} }
```

So your existing OpenAI SDK code keeps working — it has no idea the bytes came through ChatGPT.

## Why the OAuth route works

The official `codex` CLI (the one OpenAI ships at `npx @openai/codex`) authenticates via OAuth Authorization Code + PKCE, stores the resulting tokens in `~/.codex/auth.json`, and uses them to call `chatgpt.com/backend-api/codex/responses` directly. This bridge does the same thing — same `client_id`, same headers, same upstream path. The user-facing surface is just relabeled to look like `api.openai.com`.

When the access token expires (~10 days), the bridge transparently calls `https://auth.openai.com/oauth/token` with the refresh_token, persists the new tokens back to `auth.json`, and continues serving requests.

## Why nothing else was needed

Earlier attempts at this kind of bridge (see `acheong08/ChatGPT`, `gin337/ChatGPTReversed`) targeted the consumer endpoint `chatgpt.com/backend-api/conversation` — the one the web app uses. That endpoint is hardened with proof-of-work, Sentinel tokens, Cloudflare Turnstile, and a constantly-changing JS VM challenge. Maintaining clients against it is a full-time job.

The Codex endpoint (`/backend-api/codex/responses`) is different: it's the same route the official `codex` CLI hits, and it accepts simple OAuth Bearer auth without the proof-of-work circus. We don't fight Cloudflare. We don't reimplement Sentinel. We just speak the API the OAuth tokens were minted for.

## Source map

| File | LOC | Purpose |
|---|---|---|
| `src/cli.ts` | ~620 | Commander entry: 8 verbs + deprecated `gen` alias. JSON output discipline, `@file` resolution, JSONL stdin batch, `--dry-run`. |
| `src/server.ts` | ~470 | Hono app with all routes inline; `translateChatMessages` for vision/file content parts. |
| `src/install.ts` | ~440 | `install --for <ide>` — 10 adaptors + cross-platform paths. Refuses to overwrite non-JSON config files. |
| `src/attachments.ts` | ~350 | Path/URL/data-URL resolver. MIME via extension + magic bytes. Path traversal + auth-file guard. 25 MiB / 100 MiB caps. |
| `src/capabilities.ts` | ~340 | Single-source-of-truth machine-readable catalog (verbs, args, returns, idempotency, side effects, errors with structured remedies). |
| `src/auth.ts` | ~250 | Token load / decode / refresh / persist (RFC 6749). |
| `src/mcp.ts` | ~270 | MCP server (stdio); 3 tools mirror the CLI surface. |
| `src/upstream.ts` | ~120 | Single fetch wrapper + SSE parser + body normalizer. |
| `src/io.ts` | ~110 | I/O helpers: `@file` resolution, JSONL stdin parser, JSON stdout, structured stderr errors, exit-code classification. |
| `src/images.ts` | ~140 | Images-API request → `/responses` `image_generation` tool call. Refs become `input_image` parts; `tool_choice` flips to `auto`. |
| `src/config.ts` | ~80 | Defaults + env var overrides + auth-file lookup order. `DEFAULT_CHAT_MODEL` lives here. |
| `src/index.ts` | ~30 | Public library API. |

Reads end-to-end in under an hour. No magic, no clever abstractions, no DI containers. Each file does one thing.

## Concurrency model

- One Node/Bun process, one Hono server, one event loop.
- `Auth.ensure()` deduplicates concurrent token-refresh attempts (single in-flight promise).
- Models list is cached in-memory for 5 minutes.
- Rate limiter is in-memory (no SQLite, no Redis): hits within the last hour kept in an array, hard cap = 200/h by default.
- No background workers, no cron, no daemon. Process exits cleanly on SIGINT/SIGTERM.

## What it doesn't do (by design)

- **No telemetry.** Zero outbound network calls except to `chatgpt.com` and `auth.openai.com`. Read the source.
- **No multi-user.** One process, one ChatGPT account. The auth file lives in your `$HOME`.
- **No background daemon.** You start it, it runs in foreground, you stop it.
- **No web UI.** This is plumbing. Use any client that speaks OpenAI HTTP.
- **No retry logic.** Upstream errors are surfaced as-is in OpenAI shape. Add retries in your client if you want.
- **No request queueing past the rate limit.** Hit 429, you get 429.

## Performance

| Operation | Typical |
|---|---|
| `serve` startup | < 200 ms |
| Routing overhead per request | < 15 ms p50 |
| `/v1/images/generations` end-to-end (low quality) | 8–30 s |
| `/v1/images/generations` end-to-end (high quality) | 30–90 s |
| Memory RSS at idle | < 80 MB |

The bridge's contribution is single-digit milliseconds per request. Everything else is upstream latency.
