# Examples

Pick the one that matches your tool. Every example expects `chatgpt-bridge serve` to be running on `:10531` (or you've authenticated and the example uses the library directly).

| File | Tool |
|---|---|
| [python.py](./python.py) | OpenAI Python SDK |
| [node.ts](./node.ts) | OpenAI Node SDK |
| [curl.sh](./curl.sh) | curl + jq + base64 |
| [library.ts](./library.ts) | direct library use, no HTTP |
| [n8n.json](./n8n.json) | importable n8n workflow |
| [claude-code-skill/](./claude-code-skill/) | Claude Code Skill |

## Setup once

```bash
npm i -g chatgpt-bridge          # or use npx
npx @openai/codex login          # mints auth.json
chatgpt-bridge doctor            # confirm everything's green
chatgpt-bridge serve             # starts the proxy
```

## Add your own

PRs welcome. Keep examples short — one file, one job. See [CONTRIBUTING.md](../CONTRIBUTING.md).
