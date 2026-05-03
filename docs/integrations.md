# Integrations

Working snippets for popular tools. The HTTP API is OpenAI-compatible; bridge-specific extensions are flagged inline.

## Multimodal (vision + file context + reference images)

These work both via the OpenAI HTTP API and via the CLI / MCP.

### Vision (image as context)

```python
# Python — standard OpenAI vision shape
import base64
from openai import OpenAI

c = OpenAI(base_url="http://127.0.0.1:10531/v1", api_key="unused")

with open("screenshot.png", "rb") as f:
    b64 = base64.b64encode(f.read()).decode()

resp = c.chat.completions.create(
    model="gpt-5.2",
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "What font is this?"},
            {"type": "image_url",
             "image_url": {"url": f"data:image/png;base64,{b64}"}},
        ],
    }],
)
print(resp.choices[0].message.content)
```

```bash
# CLI — same thing
chatgpt-bridge chat "What font is this?" --attach screenshot.png
```

### File as context (bridge extension)

```python
# Python — bridge-extension content part: {type:"input_file", file:{path|url|data,mime,filename}}
resp = c.chat.completions.create(
    model="gpt-5.2",
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "Audit this spec against OpenAPI 3.1."},
            {"type": "input_file", "file": {"path": "./spec.md"}},
        ],
    }],
    extra_body={},  # bridge accepts the unknown content type natively
)
```

```bash
# CLI — same thing
chatgpt-bridge chat "Audit this spec against OpenAPI 3.1" --attach spec.md
```

> **Bridge extension note:** the `input_file` content part is not portable to `api.openai.com`. Code that uses it speaks to the bridge specifically. Vision (`image_url`) is standard OpenAI and works against either endpoint.

### Reference images for generation (bridge extension)

```python
# Python — bridge-extension `reference_images[]` field
img = c.images.generate(
    model="gpt-image-2",
    prompt="hero shot, brand-consistent, premium aesthetic",
    size="1536x1024",
    quality="high",
    extra_body={"reference_images": ["./moodboard.png", "./logo.svg"]},
)
```

```bash
# CLI — same thing
chatgpt-bridge image "hero shot, brand-consistent, premium aesthetic" \
  --ref moodboard.png --ref logo.svg \
  --size 1536x1024 --out hero.png
```

> **Bridge extension note:** `reference_images[]` is not a standard OpenAI Images field. Use the standard prompt-only call if you also need to target `api.openai.com`.

### Batch via stdin (CLI / shell)

```bash
# 5 ad creative variations from a single moodboard
for i in 1 2 3 4 5; do
  chatgpt-bridge image "creative variation $i, premium aesthetic" \
    --ref moodboard.png --quality high --out "out/v$i.png" --json &
done | jq -s

# Or JSONL: one job per line
chatgpt-bridge image - <<'EOF'
{"prompt":"hero v1","ref":["mood.png"],"out":"v1.png"}
{"prompt":"hero v2","ref":["mood.png"],"out":"v2.png","quality":"medium"}
{"prompt":"hero v3","ref":["mood.png","logo.svg"],"out":"v3.png"}
EOF
```

---

## OpenAI Python SDK

```python
from openai import OpenAI
import base64

c = OpenAI(base_url="http://127.0.0.1:10531/v1", api_key="unused")

img = c.images.generate(
    model="gpt-image-2",
    prompt="a small red fox under an oak tree, watercolor",
    size="1024x1024",
    quality="high",
)

with open("fox.png", "wb") as f:
    f.write(base64.b64decode(img.data[0].b64_json))
```

## OpenAI Node SDK

```ts
import OpenAI from "openai";
import { writeFileSync } from "node:fs";

const c = new OpenAI({
  baseURL: "http://127.0.0.1:10531/v1",
  apiKey: "unused",
});

const img = await c.images.generate({
  model: "gpt-image-2",
  prompt: "a small red fox under an oak tree, watercolor",
  size: "1024x1024",
  quality: "high",
});

writeFileSync("fox.png", Buffer.from(img.data[0].b64_json, "base64"));
```

## Vercel AI SDK

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const openai = createOpenAI({
  baseURL: "http://127.0.0.1:10531/v1",
  apiKey: "unused",
});

const { text } = await generateText({
  model: openai("gpt-5.2"),
  prompt: "Why is the sky blue?",
});

console.log(text);
```

## LangChain

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    base_url="http://127.0.0.1:10531/v1",
    api_key="unused",
    model="gpt-5.2",
)

print(llm.invoke("Hello").content)
```

## curl + jq

```bash
curl -sS http://127.0.0.1:10531/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "a tiny dragon perched on a stack of books",
    "size": "1024x1024",
    "quality": "high"
  }' \
  | jq -r '.data[0].b64_json' \
  | base64 --decode > dragon.png
```

## n8n

Import [`examples/n8n.json`](../examples/n8n.json). It's an HTTP Request node pointing at the local bridge with a sample body. Customize the prompt and connect the binary output to whatever downstream node consumes images (Cloud Storage, Slack, etc.).

## Make.com / Zapier

Add an HTTP Request module:

- **Method**: POST
- **URL**: `http://127.0.0.1:10531/v1/images/generations`
- **Headers**: `Content-Type: application/json`
- **Body** (JSON):
  ```json
  {
    "model": "gpt-image-2",
    "prompt": "{{your_input}}",
    "size": "1024x1024",
    "quality": "high"
  }
  ```

Note: Make/Zapier run in the cloud and won't reach your `localhost`. You'd need to expose the bridge through ngrok / Tailscale / Cloudflare Tunnel — and at that point you're *probably* better off using OpenAI's paid Images API.

## ComfyUI

Any "OpenAI Image Generation" custom node that lets you set a base URL works. Point it at `http://127.0.0.1:10531/v1` and use any string as the API key.

## Claude Code

Copy the skill into your skills directory:

```bash
mkdir -p ~/.claude/skills
cp -r examples/claude-code-skill ~/.claude/skills/chatgpt-bridge-image
```

Then ask Claude:

> Generate an image of a tiny dragon perched on a stack of books and save it as dragon.png.

The skill auto-starts the bridge if needed and writes the file. See [`examples/claude-code-skill/SKILL.md`](../examples/claude-code-skill/SKILL.md) for the full spec.

## As a library (programmatic, no HTTP)

```ts
import { writeFileSync } from "node:fs";
import { Auth, Upstream, generateImage, loadConfig } from "chatgpt-bridge";

const cfg = loadConfig();
const upstream = new Upstream(cfg, new Auth(cfg));

const img = await generateImage(cfg, upstream, {
  prompt: "a serene mountain landscape at dawn",
  quality: "high",
  size: "1024x1024",
});

writeFileSync("mountain.png", Buffer.from(img.b64, "base64"));
```

This skips the HTTP layer entirely — useful if you're embedding the bridge inside a larger Node/Bun process.
