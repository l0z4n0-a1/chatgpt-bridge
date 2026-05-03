#!/usr/bin/env bun
/**
 * Build distributable JS for npm publish.
 * Outputs:
 *   dist/cli.js    — CLI entry (with shebang)
 *   dist/index.js  — Library entry
 *   dist/*.d.ts    — Type declarations
 */

import { mkdir, rm } from "node:fs/promises";

const outDir = "dist";

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const r = await Bun.build({
	entrypoints: ["src/cli.ts", "src/index.ts"],
	outdir: outDir,
	target: "node",
	format: "esm",
	splitting: false,
	sourcemap: "linked",
	external: ["@hono/node-server", "hono", "commander", "zod"],
	naming: { entry: "[dir]/[name].js" },
});

if (!r.success) {
	console.error(r.logs);
	process.exit(1);
}

// Generate declarations via tsc emit.
const tsc = Bun.spawn(["bunx", "tsc", "--emitDeclarationOnly", "--outDir", outDir, "--declaration"], {
	stdout: "inherit",
	stderr: "inherit",
});
const code = await tsc.exited;
if (code !== 0) process.exit(code);

console.log("✔ build done →", outDir);
