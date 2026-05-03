# FAQ

### Is this allowed by OpenAI?

The OAuth flow this bridge uses is the same flow `npx @openai/codex login` performs, against the same upstream endpoint the official `codex` CLI hits. So **the authentication path is sanctioned**.

What's grayer is *programmatic* use: OpenAI's Terms of Use generally discourage automation against consumer surfaces. That's why the bridge ships with conservative defaults (200 req/h cap, jitter between requests, localhost-only).

Use it for personal projects and integrations. Don't run a SaaS off it.

### Does this bypass billing?

No. You need an active **ChatGPT subscription** (Plus, Pro, Team, Enterprise — any of those). The bridge uses the entitlements that subscription already grants to the `codex` CLI. There is no free lunch here.

### How is this different from `acheong08/ChatGPT` / `gin337/ChatGPTReversed`?

Those projects target `chatgpt.com/backend-api/conversation` — the consumer web endpoint, hardened with proof-of-work + Cloudflare Turnstile + Sentinel tokens. Maintaining a client against that is a constant battle.

This bridge targets `chatgpt.com/backend-api/codex/responses` — the developer endpoint that the official OpenAI Codex CLI uses. It accepts plain OAuth Bearer auth, no PoW, no captcha. Much simpler, much more stable.

### Why does it depend on `npx @openai/codex login`?

Because reimplementing OAuth + PKCE + browser dance properly is its own project, and the official CLI already does it well. The bridge reads the `auth.json` that CLI writes. We don't reinvent auth.

We may add a self-contained `chatgpt-bridge login` in a future version, but the dependency on the Codex CLI for *initial* auth keeps the trust chain short.

### Will my account get banned?

Probably not for personal use within the bridge's default rate limits. The defaults — 200 req/h hard cap, 200–800 ms jitter between requests — keep traffic well within human bounds.

You're more likely to get banned for:
- Sharing tokens across users.
- Hitting the bridge with thousands of concurrent requests.
- Generating prohibited content (the upstream model still enforces its own moderation).

### What happens when OpenAI changes the upstream?

This is the real risk, not bans. When `chatgpt.com/backend-api/codex/responses` changes shape, the bridge breaks. Two outcomes:

1. **Field renames / new fields**: usually transparent — `passthrough` route forwards them.
2. **Major API changes**: the bridge will need a patch. File an issue with the failing request and the symptoms; fixes are typically same-day.

You can also pin a specific version (`npm i chatgpt-bridge@0.1.0`) to insulate yourself from upstream changes that might require a bridge update.

### Why these specific dependencies?

| Package | Why |
|---|---|
| `hono` | Fastest, smallest web framework that speaks Web Standards. ~3 KB. |
| `@hono/node-server` | Adapter for Node. The bridge runs on Bun or Node interchangeably. |
| `commander` | Boring, battle-tested CLI framework. Stable for years. |
| `zod` | Runtime + compile-time schema validation in one. |

Total ≈ 5 packages installed.

### Why TypeScript and not Go / Rust / Python?

Optimization for ergonomics, not raw speed:
- The OpenAI SDK ecosystem is TS-first.
- Bun + TS lets you ship a single self-executing binary if you want.
- The whole codebase is ~900 LOC; raw speed isn't where time is spent (network is).

Python equivalents exist but require pip + venv + interpreter, which is friction. `npx chatgpt-bridge serve` runs everywhere Node runs, no setup.

### Can I use this with image editing? Vision? Embeddings?

Right now the bridge implements `/v1/images/generations` (with `image_generation` tool). Other endpoints work via passthrough at `/v1/*` — including `/v1/responses` directly, which supports vision input. Image **edits** (`/v1/images/edits`) is planned for `0.2.0`.

### Can I use this in n8n / Make / Zapier?

Yes — they all support custom HTTP nodes. See [`examples/n8n.json`](../examples/n8n.json).

### Does it work on Windows?

Yes. CI runs on Linux, macOS, and Windows. Tested manually on Windows 10/11 with Node 22+ and Bun 1.3+.

### How do I update?

```bash
npm i -g chatgpt-bridge@latest
# or for projects:
npm update chatgpt-bridge
```

Watch the [CHANGELOG](../CHANGELOG.md) — semver is followed strictly.

### Can I monitor / log requests?

Currently: `chatgpt-bridge doctor` for snapshot, server logs to stderr for live events. Structured audit logging is on the roadmap.

### What about OpenAI's official Image API?

If you want production stability and don't mind paying per image, use `api.openai.com/v1/images/generations` directly with an API key. That's what it's for.

This bridge is for the case where you're already paying for a subscription and want your scripts to use the same compute.
