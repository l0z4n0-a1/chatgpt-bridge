# Claude Code Skill — chatgpt-bridge

A Claude Code [Skill](https://docs.anthropic.com/en/docs/claude-code/skills) that lets Claude reach the user's ChatGPT subscription for chat (with optional image/file context) and image generation (with optional reference images).

## Install

Copy this directory into your Claude Code skills folder:

```bash
mkdir -p ~/.claude/skills
cp -r ./examples/claude-code-skill ~/.claude/skills/chatgpt-bridge
```

Or symlink to track upstream:

```bash
ln -s "$(pwd)/examples/claude-code-skill" ~/.claude/skills/chatgpt-bridge
```

Then restart Claude Code.

## Prereqs

```bash
# Install the CLI (or use `npx chatgpt-bridge` ad-hoc)
npm i -g chatgpt-bridge

# One-time auth
npx @openai/codex login
```

## Use

Just ask Claude:

> *"What font does this screenshot use?"* (drop a PNG)
>
> *"Audit this OpenAPI spec for breaking changes."* (drop a `.md`)
>
> *"Generate a hero shot in this style."* (drop a moodboard, ask for variations)
>
> *"Make 5 social-card variations from this brand kit."*

Claude will:

1. Run `chatgpt-bridge doctor` — surface auth fixes if needed.
2. Read `chatgpt-bridge capabilities` — discover the exact surface.
3. Call `chatgpt-bridge chat …` or `chatgpt-bridge image …` with the right `--attach` / `--ref` flags.
4. Surface the result (text reply, or absolute path of the saved PNG).

## Alternative: native MCP

If you'd rather skip the skill and let Claude Code use the bridge as an MCP server (`chat`, `generate_image`, `health` tools become callable directly):

```bash
chatgpt-bridge install --for claude-code
```

That writes the MCP entry to `~/.claude.json` (idempotent, preserves all your other settings). Restart Claude Code. The skill and the MCP path coexist — pick whichever you prefer per session.

## License

MIT, same as the parent project.
