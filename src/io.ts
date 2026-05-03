/**
 * CLI I/O helpers — agent-native conventions.
 *
 *   - `@path` syntax in any string flag reads the file contents.
 *   - Stdin '-' for prompt args accepts a single prompt OR JSONL (one job per line).
 *   - JSON output is forced on non-tty, always when --json is set.
 *
 * One file, one responsibility: turning external strings into in-memory values.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Resolve a `@path` shorthand. If the value starts with `@`, read the file
 * (resolved relative to cwd) and return its contents. Otherwise return the
 * value verbatim.
 */
export async function resolveAtFile(value: string): Promise<string> {
	if (!value.startsWith("@")) return value;
	const p = path.resolve(value.slice(1));
	return fs.readFile(p, "utf-8");
}

/** Whether stdout is currently a TTY (used to decide JSON-by-default). */
export function isTty(): boolean {
	return Boolean(process.stdout.isTTY);
}

/** Read all of stdin as a single UTF-8 string. */
export async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Parse a stdin payload as either a single prompt (one non-JSON line) or
 * JSONL batch (each line is a job object). Returns `{ batch: false, prompt }`
 * for plain text, or `{ batch: true, jobs }` for JSONL.
 *
 * Detection rule: if the first non-empty line starts with `{` and parses as
 * JSON, the whole input is treated as JSONL. Otherwise, it's a single
 * prompt (the entire input, trimmed).
 */
export type StdinPayload<Job extends Record<string, unknown>> =
	| { batch: false; prompt: string }
	| { batch: true; jobs: Job[] };

export function parseStdin<Job extends Record<string, unknown>>(raw: string): StdinPayload<Job> {
	const trimmed = raw.trimEnd();
	if (trimmed.length === 0) return { batch: false, prompt: "" };
	const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
	if (!firstLine.startsWith("{")) {
		return { batch: false, prompt: trimmed };
	}
	const jobs: Job[] = [];
	const lines = trimmed.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim();
		if (!line) continue;
		try {
			const job = JSON.parse(line) as Job;
			jobs.push(job);
		} catch (e) {
			throw new Error(`Invalid JSONL on line ${i + 1}: ${(e as Error).message}`);
		}
	}
	return { batch: true, jobs };
}

/**
 * Write a single JSON object to stdout (pretty-printed when on a tty,
 * compact one-liner otherwise). Always ends with a newline.
 */
export function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, isTty() ? 2 : 0)}\n`);
}

/**
 * Write a structured error to stderr with `remedy` field, then return the
 * exit code. Convention:
 *   1 = user_error, 2 = auth_error, 3 = upstream_error, 4 = rate_limited.
 */
export function writeError(
	error: string,
	options: { remedy?: Record<string, unknown>; exitCode?: number } = {},
): number {
	const out: Record<string, unknown> = { ok: false, error };
	if (options.remedy) out.remedy = options.remedy;
	process.stderr.write(`${JSON.stringify(out)}\n`);
	return options.exitCode ?? 1;
}

/**
 * Map an arbitrary error to an exit code based on its message + type.
 * Heuristic only — agents should rely on the `remedy.cmd` rather than the
 * exact code, but we expose stable codes for shell-script usage.
 */
export function classifyExitCode(err: Error): number {
	const m = (err.message ?? "").toLowerCase();
	if (m.includes("auth") || m.includes("access_token") || m.includes("refresh")) return 2;
	if (m.includes("rate")) return 4;
	if (m.includes("upstream") || m.includes("502") || m.includes("503")) return 3;
	if (m.includes("attach") || m.includes("path") || m.includes("invalid")) return 1;
	return 1;
}
