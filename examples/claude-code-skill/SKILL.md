---
name: chatgpt-bridge
description: Use the user's ChatGPT subscription for chat (with optional image/file context) and image generation (with optional reference images), via the local chatgpt-bridge CLI. Use when the user asks to create/render/draw an image, asks a question that benefits from looking at a local file or screenshot, or wants to generate creative variations from a moodboard. Requires `chatgpt-bridge` to be installed and the user authenticated (`npx @openai/codex login` once).
---

# chatgpt-bridge skill

This skill lets Claude Code reach the user's ChatGPT subscription through the local `chatgpt-bridge` CLI. Three capabilities are exposed:

1. **Chat with attachments** — answer a question while looking at one or more local files (images for vision, `.md`/`.txt`/`.json`/`.csv` for textual context).
2. **Image generation with references** — generate a PNG, optionally guided by reference images (style/composition transfer).
3. **Bridge management** — start the server when needed, surface auth-recovery steps when not.

Per-call cost is $0 on top of the subscription.

## When to invoke

- "Generate / render / draw / make an image of …" → use **image**.
- "Look at this screenshot/diagram and …" → use **chat with image attachment**.
- "Audit/summarize/translate this file …" → use **chat with file attachment**.
- "Make 5 variations of this hero shot, same vibe as the moodboard" → use **image with --ref**.

Do not invoke for image *editing* (masked inpainting); the bridge does not expose `/v1/images/edits`.

## Discovery (run once at the start of any session that uses this skill)

Read the bridge's machine-readable catalog so you know the exact verb shapes, defaults, and error remedies — without re-asking the user:

```bash
npx chatgpt-bridge capabilities
```

The JSON document lists every verb, args, return shape, idempotency, typical latency, and structured `remedy` for each documented error code. Cache the result for the session.

## Health check

Run before the first call. Exit code 0 means everything is fine; the JSON also has a `remedy[]` field when something is wrong:

```bash
npx chatgpt-bridge doctor
```

If `auth` fails, the remedy is interactive (`npx @openai/codex login`). Surface it to the user verbatim and stop — do not try to "fix" `auth.json` by editing it.

## How to call

All calls below default to JSON on stdout when piped (which they are, when invoked from Claude Code's Bash tool). Errors emit a JSON object with `ok:false` and a `remedy` field.

### Chat (text-only)

```bash
npx chatgpt-bridge chat "<the user's question>" --no-stream
```

Output:
```json
{"ok":true,"text":"…","latency_ms":1200,"model":"gpt-5.2"}
```

### Chat with attachments

Local paths or URLs. The CLI auto-detects MIME — images become vision input, text files become contextual `input_file` parts.

```bash
npx chatgpt-bridge chat "What does this screenshot show?" \
  --attach ./screenshot.png \
  --no-stream
```

```bash
npx chatgpt-bridge chat "Audit this spec against OpenAPI 3.1" \
  --attach ./openapi-spec.md \
  --no-stream
```

Multiple attachments mixed:
```bash
npx chatgpt-bridge chat "Align this copy with this brand identity" \
  --attach ./copy.md \
  --attach ./brand-guide.png \
  --no-stream
```

Limits: 25 MiB per attachment, 100 MiB aggregate per request.

### Image generation

Default output is `./chatgpt-bridge-<timestamp>.png` if `--out` is omitted.

```bash
npx chatgpt-bridge image "a small red fox under an oak tree, watercolor" \
  --out ./assets/fox.png \
  --quality high \
  --size 1024x1024
```

Output:
```json
{"ok":true,"file":"/abs/path/assets/fox.png","bytes":987654,"latency_ms":42000,"revised_prompt":"…"}
```

If `revised_prompt` is present and differs from the input, surface it to the user — the model sometimes rewrites for clarity.

### Image with reference images

Up to 8 references. Use for style/composition transfer (mood-board → variation, brand-consistent creative).

```bash
npx chatgpt-bridge image "hero shot, brand-consistent, premium aesthetic" \
  --ref ./moodboard.png \
  --ref ./logo.svg \
  --out ./assets/hero.png \
  --size 1536x1024
```

### Multiple variations (shell loop)

Don't ask the bridge to do this — compose with shell:

```bash
mkdir -p ./out
for i in 1 2 3 4 5; do
  npx chatgpt-bridge image "creative variation $i" \
    --ref ./moodboard.png \
    --out "./out/v$i.png" --quality high &
done
wait
```

### Batch via JSONL stdin

For larger batches (homogeneous structure):

```bash
npx chatgpt-bridge image - <<'EOF'
{"prompt":"hero v1","ref":["./mood.png"],"out":"./out/v1.png"}
{"prompt":"hero v2","ref":["./mood.png"],"out":"./out/v2.png","quality":"medium"}
{"prompt":"hero v3","ref":["./mood.png","./logo.svg"],"out":"./out/v3.png"}
EOF
```

One result per line on stdout. Exit code 0 if any job succeeded, 1 if none.

## Dry-run before spending quota

Image generation can take 8–90 seconds and counts against the user's hourly cap. When in doubt, validate the call shape first:

```bash
npx chatgpt-bridge image "<prompt>" --ref ./mood.png --dry-run
```

Returns `{ok:true, dry_run:true, jobs:[{…}]}` without calling upstream.

## Failure recovery

The CLI emits structured errors with a `remedy` field. Parse it and act, rather than guessing:

| `error` contains | `remedy.cmd` | What to do |
|---|---|---|
| `auth.json not found` | `npx @openai/codex login` | Surface to user; flow is interactive (browser). |
| `RATE_LIMITED` | wait | Tell the user the hourly cap was hit; suggest they retry in <1h. |
| `ATTACH_TOO_LARGE` | split or compress | Compress the image (e.g. with `sharp`/`imagemagick`) or shorten the file. |
| `ATTACH_FORBIDDEN` | path outside cwd | Use a path within the project; never reference `~/.codex/auth.json` or any auth file. |
| `ATTACH_NOT_FOUND` | verify path | The file path is wrong; double-check before retrying. |
| upstream error 5xx | retry | Transient. Wait briefly and re-issue. Don't retry more than once or twice. |

## Things to never do

- **Never read or echo `~/.codex/auth.json`** or any token contents.
- **Never** edit `auth.json` to "fix" auth issues — tell the user to run `npx @openai/codex login`.
- **Never** start the server with `--host 0.0.0.0`. Localhost only.
- **Never** disable the rate limit. It protects the user's account.
- **Never** invent a `usage` field — the `chat` verb does not return token counts.

## Why this exists

The user already pays for a ChatGPT subscription that does chat, vision, and image generation. Calling `api.openai.com` would charge again. `chatgpt-bridge` proxies the user's OAuth-authenticated session to the same models, with $0 marginal cost. The bridge is local-only, has zero outbound traffic except to `chatgpt.com` and `auth.openai.com`, and never copies tokens.
