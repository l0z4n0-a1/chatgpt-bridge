# Contributing

Thanks for your interest. The codebase is intentionally small (~900 LOC). Read it end to end before opening a PR.

## Getting started

```bash
bun install
bun run typecheck
bun test
```

## Pull requests

- One change per PR. Keep diffs tight.
- Update `CHANGELOG.md` under `[Unreleased]`.
- Match the existing tone: terse, no emoji, no hype.
- Add a test if you fix a bug.

## What we'll accept

- Bug fixes with reproductions.
- Adapters for new ChatGPT upstream events.
- Better error messages.
- Examples for new tools (LangChain, Vercel AI SDK provider, etc.).

## What we won't accept

- Telemetry, analytics, "phone home" of any kind.
- Multi-user / SaaS scaffolding.
- Bundled dashboards or web UIs.
- Anything that materially increases bundle size for the CLI.

## License

By contributing you agree to license your contribution under MIT.
