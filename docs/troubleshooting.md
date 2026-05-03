# Troubleshooting

If something breaks, run `chatgpt-bridge doctor` first. It's the fastest signal.

---

## Common failures

### `auth.json not found`

```
Error: auth.json not found. Looked in: …/.codex/auth.json, … . Run `npx @openai/codex login` once to mint it.
```

You haven't authenticated. One-time fix:

```bash
npx @openai/codex login
```

A browser opens. Sign in with the account that has your ChatGPT subscription. The CLI writes `~/.codex/auth.json`. Re-run `chatgpt-bridge doctor` to confirm.

### `Token refresh failed (HTTP 401)`

The refresh token in `auth.json` is no longer valid. This happens if:
- You manually revoked sessions in your OpenAI account settings.
- OpenAI rotated your account's refresh tokens (rare).
- The `auth.json` file got partially overwritten.

Fix:

```bash
npx @openai/codex login   # mints fresh tokens
chatgpt-bridge doctor     # confirm green
```

### `HTTP 403` from upstream on every request

Almost always means: the OAuth token is valid, but your account doesn't have the entitlement the request expects. Most common cause is using the bridge during a temporary OpenAI rollout or A/B test.

Diagnostic:

```bash
chatgpt-bridge doctor
# auth: ok
# upstream: HTTP 403   ← here
```

What to try:
1. Wait an hour and retry — these are sometimes transient.
2. Confirm your subscription is active at https://chatgpt.com (sign in normally).
3. Re-run `npx @openai/codex login` to refresh tokens.
4. Open a GitHub issue with the full doctor output (no tokens leaked — they're never logged).

### `EMPTY_RESPONSE` after image generation

The upstream stream completed but didn't include an `image_generation_call` event with a `result` field. Causes:

- The model decided not to invoke the tool. Rare, but possible with very abstract prompts.
- Stream interrupted mid-flight (network blip).
- Upstream changed the event shape (a tracking issue would be filed).

Retry once. If it's reproducible with a specific prompt, file an issue with that prompt.

### `HTTP 429: Hourly limit reached`

Default cap is **200 requests/hour**, regardless of upstream. This is a self-imposed safety to keep your account out of trouble.

Override at startup:

```bash
CHATGPT_BRIDGE_RATE_HOURLY_HARD=500 chatgpt-bridge serve
```

Or remove the cap entirely by setting it to a very large number. **Don't.** ChatGPT's actual web rate limit is around 80–160 messages per 3 hours for Plus accounts; pushing past it triggers account-level enforcement.

### Bridge starts, but every request hangs

Likely a stale process from a previous run holding the port.

```bash
# macOS / Linux
lsof -ti :10531 | xargs kill -9

# Windows (PowerShell)
Get-NetTCPConnection -LocalPort 10531 | Stop-Process -Force
```

Or just pick another port: `chatgpt-bridge serve --port 10532`.

### `npx chatgpt-bridge serve` says "command not found"

You're on a platform where `npx` doesn't auto-install. Two fixes:

```bash
npm i -g chatgpt-bridge
chatgpt-bridge serve
```

Or download the standalone binary from [Releases](https://github.com/l0z4n0-a1/chatgpt-bridge/releases).

### `Cannot find module 'chatgpt-bridge'` in your code

If you imported it as a library:

```ts
import { generateImage } from "chatgpt-bridge";
```

Make sure it's installed locally, not just globally:

```bash
npm i chatgpt-bridge   # in your project's directory
```

---

## When to file an issue

Open one at https://github.com/l0z4n0-a1/chatgpt-bridge/issues with:

1. Full output of `chatgpt-bridge doctor`.
2. The exact request body (redact prompts if private).
3. The full error message.
4. Your runtime: `node --version` or `bun --version`, OS.
5. Your bridge version: `chatgpt-bridge version`.

**Never paste the contents of `auth.json`.** Tokens in there are sensitive.

---

## Things that look like bugs but aren't

| Symptom | Reality |
|---|---|
| Image generation takes 30+ seconds | Normal upstream latency for high-quality images. The bridge adds < 15 ms. |
| `revised_prompt` differs from your prompt | The upstream model rewrites prompts when it deems them underspecified. The bridge surfaces the rewritten version unchanged. |
| Models list includes models you can't use | Synthetic aliases (`gpt-image-2`, `dall-e-3`) are listed for SDK compatibility but route to `gpt-5.4-mini` internally for image gen. |
| `chat-completions` streaming feels slower than `responses` streaming | The Chat translator decodes upstream SSE and re-encodes it as Chat-shaped chunks. Pass-through `/v1/responses` is faster. Use that if your client supports it. |
