# Integrations

Working snippets for popular tools.

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
