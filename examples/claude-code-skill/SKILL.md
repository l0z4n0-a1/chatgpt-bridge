---
name: chatgpt-bridge-image
description: Generate an image using the user's ChatGPT subscription via chatgpt-bridge. Use when the user asks to create, render, draw, or generate any kind of image inside Claude Code. Requires the `chatgpt-bridge` CLI to be installed and the user authenticated (run `npx @openai/codex login` once).
---

# chatgpt-bridge image generation skill

This skill lets Claude Code generate real PNG images by calling the user's local `chatgpt-bridge` server. The image is created by the user's ChatGPT subscription (no API costs).

## When to invoke

- "Generate an image of …"
- "Create a picture of …"
- "Render / draw / make a thumbnail / generate a hero image …"
- Any task where the deliverable is a PNG.

Do **not** invoke for image *editing*, image analysis, or non-visual outputs.

## How to use

The bridge exposes `POST http://127.0.0.1:10531/v1/images/generations` with the standard OpenAI Images request body.

### Step 1 — make sure the bridge is running

Check `curl -s http://127.0.0.1:10531/health`. If it errors, start the server in a background bash:

```bash
npx chatgpt-bridge serve > /tmp/chatgpt-bridge.log 2>&1 &
sleep 2
```

If it still fails, the user has not authenticated. Tell them:
> Run `npx @openai/codex login` once, then retry.

### Step 2 — generate

Use a single bash call. Decode the base64 to a file the user can open:

```bash
curl -sS http://127.0.0.1:10531/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"<USER PROMPT HERE>","size":"1024x1024","quality":"high"}' \
  | jq -r '.data[0].b64_json' \
  | base64 --decode > <OUTPUT_PATH>.png
```

Replace `<USER PROMPT HERE>` with the user's request, escaped for JSON. Replace `<OUTPUT_PATH>` with a sensible relative path (e.g. `assets/hero.png`).

### Step 3 — confirm

After the file is written, tell the user the absolute path and the size in bytes. Open it in the IDE if appropriate.

## Tips

- Default to `quality: "high"` unless the user wants speed (then `low`).
- For wide formats use `1536x1024`, for portrait `1024x1536`.
- If the response includes `revised_prompt`, surface it to the user — sometimes the model rewrites for clarity.
- If you get HTTP 429, the user hit the bridge's hourly cap. Wait or tell them.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `curl: (7) Failed to connect` | bridge not running | start it as shown in Step 1 |
| HTTP 503 with `auth.json not found` | user never logged in | `npx @openai/codex login` |
| HTTP 401 | token expired and refresh failed | `npx @openai/codex login` again |
| HTTP 429 | rate limit | wait, or set `CHATGPT_BRIDGE_RATE_HOURLY_HARD` higher and restart |
| HTTP 502 with `EMPTY_RESPONSE` | upstream stream had no image (rare) | retry once |

## Why this exists

The user already pays for a ChatGPT subscription that generates images. Running them through `api.openai.com` would charge a second time. `chatgpt-bridge` makes the SDK talk to ChatGPT's OAuth surface instead, so the per-image cost is zero on top of the existing subscription.
