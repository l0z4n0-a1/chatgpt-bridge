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
│  chatgpt-bridge (this package, ~900 LOC)       │
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
| `src/cli.ts` | ~120 | Commander entry: `serve / gen / doctor / login / version` |
| `src/server.ts` | ~270 | Hono app with all routes inline |
| `src/auth.ts` | ~210 | Token load / decode / refresh / persist |
| `src/upstream.ts` | ~120 | Single fetch wrapper + SSE parser + body normalizer |
| `src/images.ts` | ~110 | Translate Images request → Responses tool call → extract b64 |
| `src/config.ts` | ~70 | Defaults + env var overrides + auth-file lookup order |
| `src/index.ts` | ~20 | Public library API |

Read top to bottom in 30 minutes. No magic, no clever abstractions, no DI containers. Each file does one thing.

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
