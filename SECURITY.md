# Security policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports.**

Email **fluxmind.ia@gmail.com** with subject `chatgpt-bridge security`. Include:

- A clear description of the vulnerability.
- Steps to reproduce.
- Affected versions (output of `chatgpt-bridge version` if applicable).
- Your assessment of impact.
- Whether you've disclosed elsewhere or to whom.

You should expect:

- An acknowledgement within **72 hours**.
- A first assessment within **7 days**.
- Coordinated disclosure timeline agreed before any patch goes public.

## Scope

In scope:

- Token leakage to disk, logs, network, or unintended files.
- Authentication bypass in the local server.
- Code execution via crafted upstream responses.
- Privilege escalation through file modes / paths.
- Supply-chain risks specific to this package.

Out of scope:

- Issues with `chatgpt.com` itself (report to OpenAI).
- Issues with `npx @openai/codex` (report to OpenAI's Codex repo).
- Generic Node / Bun / Hono / Zod CVEs (handled by their maintainers).
- Social engineering against the maintainer.

## Supported versions

Only the latest minor version receives security fixes. Always upgrade to the most recent release.

| Version | Supported |
|---|---|
| 0.1.x | ✅ |
| < 0.1.0 | ❌ (none exist) |

## What's in this package on disk

The published tarball contains:

- `dist/` — compiled JS + TypeScript declarations.
- `LICENSE`, `README.md`, `CHANGELOG.md`, `package.json`.

It does **not** contain:

- Sourcemaps (intentionally).
- Source TypeScript files.
- Tests, scripts, examples.
- Any tokens, keys, or environment-specific paths.

Verify with:

```bash
npm view chatgpt-bridge dist.tarball
curl -sLO <tarball-url>
tar tzf chatgpt-bridge-*.tgz
```

## Acknowledgements

Disclosure credit goes to reporters who follow this process. List maintained in [CHANGELOG.md](./CHANGELOG.md) under each release.
