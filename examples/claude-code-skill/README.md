# Claude Code Skill — chatgpt-bridge

This is a Claude Code [Skill](https://docs.anthropic.com/en/docs/claude-code/skills) that lets Claude generate images for you, in any project, using your own ChatGPT subscription.

## Install

Copy this directory into your Claude Code skills folder:

```bash
mkdir -p ~/.claude/skills
cp -r ./examples/claude-code-skill ~/.claude/skills/chatgpt-bridge-image
```

(Or symlink it if you want to track upstream updates.)

Then restart Claude Code.

## Use

Just ask Claude:

> "Generate an image of a tiny dragon perched on a stack of books and save it as `dragon.png`."

Claude will:

1. Verify `chatgpt-bridge` is running (start it if not).
2. POST your prompt to `http://127.0.0.1:10531/v1/images/generations`.
3. Decode the base64 PNG and save it.
4. Tell you where the file is.

## Prereqs

- [chatgpt-bridge](https://github.com/lozanojoaog/chatgpt-bridge) installed (`npm i -g chatgpt-bridge` or use `npx`).
- One-time auth: `npx @openai/codex login`.

That's it.
