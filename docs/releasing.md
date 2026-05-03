# Releasing

This is for maintainers. Skip unless you're cutting a new version.

## Pre-flight

```bash
bun run typecheck
bun test
bun run lint
bun run build
npm publish --dry-run
```

All must pass with zero warnings.

## Version bump

Follow [SemVer](https://semver.org/):

- **patch** (0.1.0 → 0.1.1): bug fixes, no API change.
- **minor** (0.1.0 → 0.2.0): new features, backward-compatible API additions.
- **major** (0.1.0 → 1.0.0): breaking API changes.

```bash
# Edit:
#   package.json   → "version"
#   src/server.ts  → VERSION constant
#   CHANGELOG.md   → add new section, move "Unreleased" entries

git add package.json src/server.ts CHANGELOG.md
git commit -m "chore: release v0.2.0"
git tag v0.2.0
git push && git push --tags
```

The `release.yml` GitHub Action then:
1. Builds and publishes to npm with provenance.
2. Compiles standalone binaries (Linux, macOS, Windows) and attaches them to the GitHub Release.

## Manual publish (if Action is broken)

```bash
# Make sure NPM_TOKEN is in env (NOT logged anywhere).
NPM_TOKEN=npm_xxx npm publish
```

Requires a token with **R+W permission** and **Bypass 2FA on publish** enabled, OR providing `--otp=<code>` interactively.

## Rolling back

You have **24 hours** after publish to `npm unpublish chatgpt-bridge@x.y.z`. After that, the version is permanent — but you can `npm deprecate chatgpt-bridge@x.y.z "use a.b.c instead"` to nudge users.

Never re-publish the same version with different content. Bump the patch instead.
