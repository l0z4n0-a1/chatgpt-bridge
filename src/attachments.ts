/**
 * Attachment resolver.
 *
 * Turns a path / URL / inline-data spec into a Responses-API content part
 * (`input_image` or `input_file`). One module, one responsibility.
 *
 * Safety invariants:
 *
 *   1. The bridge never fetches URLs itself. URL refs are passed through to
 *      the upstream as strings — the upstream resolves them. This preserves
 *      `docs/security.md` "zero outbound traffic except chatgpt.com +
 *      auth.openai.com" guarantee. Verifiable with tcpdump.
 *
 *   2. Path-based attachments are absolute-resolved and rejected if they
 *      escape `allowedRoot` (default: process.cwd()) or land inside any
 *      auth-file candidate directory. An LLM that "just" asks the bridge
 *      to read ~/.codex/auth.json gets ATTACH_FORBIDDEN, never the file.
 *
 *   3. Hard byte cap per attachment (default 25 MiB) plus aggregate cap
 *      (100 MiB) enforced by callers before building the upstream body.
 *
 *   4. MIME is detected by extension first, then magic bytes for common
 *      image types. We never shell out to `file(1)`.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { type Config, authFileCandidates } from "./config.ts";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_AGGREGATE_BYTES = 100 * 1024 * 1024;

/* ----------------------------- Schema (zod) ------------------------------- */

const SpecObject = z.union([
	z.object({ path: z.string().min(1) }),
	z.object({ url: z.string().url() }),
	z.object({
		data: z.string().min(1),
		mime: z.string().min(1),
		filename: z.string().optional(),
	}),
]);

/** A single attachment specifier. Strings are shorthand for `{path}` or `{url}`. */
export const AttachmentSpec = z.union([z.string().min(1), SpecObject]);
export type AttachmentSpec = z.infer<typeof AttachmentSpec>;

/* --------------------------------- Types --------------------------------- */

export type AttachmentKind = "image" | "file";

export interface ResolvedAttachment {
	kind: AttachmentKind;
	mime: string;
	filename: string;
	source: "path" | "url" | "data";
	bytes: number;
	/** For images: a value usable as `input_image.image_url`. */
	imageUrl?: string;
	/** For files: a `data:` URL usable as `input_file.file_data`. */
	fileData?: string;
}

export interface AttachmentLimits {
	maxBytes?: number;
	allowedRoot?: string;
	/** Auth-file paths to forbid (defaults are derived from Config). */
	forbiddenPaths?: string[];
}

export class AttachmentError extends Error {
	constructor(
		message: string,
		readonly code:
			| "ATTACH_NOT_FOUND"
			| "ATTACH_TOO_LARGE"
			| "ATTACH_FORBIDDEN"
			| "ATTACH_BAD_SHAPE"
			| "ATTACH_UNSUPPORTED_MIME",
	) {
		super(message);
		this.name = "AttachmentError";
	}
}

/* ----------------------------- MIME detection ----------------------------- */

const EXT_MIME: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
	".heic": "image/heic",
	".svg": "image/svg+xml",
	".txt": "text/plain",
	".md": "text/markdown",
	".markdown": "text/markdown",
	".csv": "text/csv",
	".tsv": "text/tab-separated-values",
	".json": "application/json",
	".jsonl": "application/x-ndjson",
	".ndjson": "application/x-ndjson",
	".xml": "application/xml",
	".html": "text/html",
	".htm": "text/html",
	".yaml": "text/x-yaml",
	".yml": "text/x-yaml",
	".toml": "application/toml",
	".log": "text/plain",
};

function mimeFromExt(p: string): string | undefined {
	return EXT_MIME[path.extname(p).toLowerCase()];
}

/** Magic-byte sniff for the few image formats we cannot infer otherwise. */
function mimeFromMagic(buf: Buffer): string | undefined {
	if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
		return "image/png";
	}
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
		return "image/jpeg";
	}
	if (
		buf.length >= 12 &&
		buf.toString("ascii", 0, 4) === "RIFF" &&
		buf.toString("ascii", 8, 12) === "WEBP"
	) {
		return "image/webp";
	}
	if (
		buf.length >= 6 &&
		(buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a")
	) {
		return "image/gif";
	}
	return undefined;
}

function kindFromMime(mime: string): AttachmentKind {
	return mime.startsWith("image/") ? "image" : "file";
}

/* ------------------------------ Path safety ------------------------------- */

function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function defaultForbiddenPaths(cfg?: Config): string[] {
	if (!cfg) return [];
	// Forbid the directories of every auth-file candidate so a path that
	// resolves into ~/.codex/auth.json (or nearby) is rejected.
	return authFileCandidates(cfg).map((p) => path.dirname(p));
}

function ensurePathAllowed(resolved: string, allowedRoot: string, forbidden: string[]): void {
	if (!isInside(resolved, allowedRoot)) {
		throw new AttachmentError(
			`Attachment path is outside allowed root (${allowedRoot}): ${resolved}`,
			"ATTACH_FORBIDDEN",
		);
	}
	for (const f of forbidden) {
		if (isInside(resolved, f) || resolved === f) {
			throw new AttachmentError(
				`Attachment path is in a forbidden location (auth-file area): ${resolved}`,
				"ATTACH_FORBIDDEN",
			);
		}
	}
}

/* ---------------------------- Spec normalization -------------------------- */

interface NormalizedSpec {
	source: "path" | "url" | "data";
	path?: string;
	url?: string;
	data?: string;
	mime?: string;
	filename?: string;
}

function normalize(spec: AttachmentSpec): NormalizedSpec {
	if (typeof spec === "string") {
		// Shorthand: URL if it parses as one, else treat as a local path.
		if (/^https?:\/\//i.test(spec)) return { source: "url", url: spec };
		if (/^data:/i.test(spec)) {
			// `data:<mime>;base64,<payload>`
			const m = spec.match(/^data:([^;,]+)(;base64)?,(.*)$/i);
			if (!m) throw new AttachmentError("malformed data URL", "ATTACH_BAD_SHAPE");
			return { source: "data", mime: m[1], data: m[3] ?? "" };
		}
		return { source: "path", path: spec };
	}
	if ("path" in spec) return { source: "path", path: spec.path };
	if ("url" in spec) return { source: "url", url: spec.url };
	const out: NormalizedSpec = { source: "data", data: spec.data, mime: spec.mime };
	if (spec.filename) out.filename = spec.filename;
	return out;
}

/* --------------------------------- Main ---------------------------------- */

/**
 * Resolve a single attachment spec into a content-part-ready payload.
 *
 * URL specs are returned without any fetch — bridge does NOT touch the
 * network here. Path specs are read, size-capped, MIME-sniffed. Data specs
 * are taken at face value (the caller already produced the base64).
 */
export async function resolveAttachment(
	spec: AttachmentSpec,
	limits: AttachmentLimits = {},
	cfg?: Config,
): Promise<ResolvedAttachment> {
	const parsed = AttachmentSpec.safeParse(spec);
	if (!parsed.success) {
		throw new AttachmentError(
			`Invalid attachment spec: ${parsed.error.message}`,
			"ATTACH_BAD_SHAPE",
		);
	}
	const norm = normalize(parsed.data);
	const maxBytes = limits.maxBytes ?? MAX_ATTACHMENT_BYTES;

	if (norm.source === "url") {
		const url = norm.url as string;
		const filename = path.basename(new URL(url).pathname) || "remote";
		const mime = mimeFromExt(filename) ?? "application/octet-stream";
		return {
			kind: kindFromMime(mime),
			mime,
			filename,
			source: "url",
			bytes: 0,
			imageUrl: kindFromMime(mime) === "image" ? url : undefined,
			fileData: kindFromMime(mime) === "file" ? url : undefined,
		};
	}

	if (norm.source === "data") {
		const data = norm.data as string;
		const mime = norm.mime as string;
		const filename = norm.filename ?? `inline.${mime.split("/")[1] ?? "bin"}`;
		// Approximate decoded size: ceil(len*3/4) — minus padding.
		const approxBytes = Math.ceil((data.length * 3) / 4);
		if (approxBytes > maxBytes) {
			throw new AttachmentError(
				`Attachment exceeds ${maxBytes} bytes (got ~${approxBytes})`,
				"ATTACH_TOO_LARGE",
			);
		}
		const dataUrl = `data:${mime};base64,${data}`;
		return {
			kind: kindFromMime(mime),
			mime,
			filename,
			source: "data",
			bytes: approxBytes,
			imageUrl: kindFromMime(mime) === "image" ? dataUrl : undefined,
			fileData: kindFromMime(mime) === "file" ? dataUrl : undefined,
		};
	}

	// Path source.
	const allowedRoot = path.resolve(limits.allowedRoot ?? process.cwd());
	const forbidden = limits.forbiddenPaths ?? defaultForbiddenPaths(cfg);
	const resolved = path.resolve(norm.path as string);
	ensurePathAllowed(resolved, allowedRoot, forbidden);

	let stat: { size: number };
	try {
		stat = await fs.stat(resolved);
	} catch {
		throw new AttachmentError(`Attachment not found: ${resolved}`, "ATTACH_NOT_FOUND");
	}
	if (stat.size > maxBytes) {
		throw new AttachmentError(
			`Attachment exceeds ${maxBytes} bytes (got ${stat.size}): ${resolved}`,
			"ATTACH_TOO_LARGE",
		);
	}

	const buf = await fs.readFile(resolved);
	const mime = mimeFromExt(resolved) ?? mimeFromMagic(buf) ?? "application/octet-stream";
	const filename = path.basename(resolved);
	const b64 = buf.toString("base64");
	const dataUrl = `data:${mime};base64,${b64}`;
	return {
		kind: kindFromMime(mime),
		mime,
		filename,
		source: "path",
		bytes: buf.byteLength,
		imageUrl: kindFromMime(mime) === "image" ? dataUrl : undefined,
		fileData: kindFromMime(mime) === "file" ? dataUrl : undefined,
	};
}

/**
 * Build the OpenAI Responses content part for an attachment.
 * Image → `input_image`. File → `input_file`.
 */
export function toContentPart(
	att: ResolvedAttachment,
):
	| { type: "input_image"; image_url: string }
	| { type: "input_file"; filename: string; file_data: string } {
	if (att.kind === "image") {
		if (!att.imageUrl) {
			throw new AttachmentError("image attachment missing imageUrl", "ATTACH_BAD_SHAPE");
		}
		return { type: "input_image", image_url: att.imageUrl };
	}
	if (!att.fileData) {
		throw new AttachmentError("file attachment missing fileData", "ATTACH_BAD_SHAPE");
	}
	return { type: "input_file", filename: att.filename, file_data: att.fileData };
}

/**
 * Resolve an array of specs and enforce the aggregate byte cap.
 * Returns content parts ready to splice into a Responses message.
 */
export async function resolveAttachments(
	specs: ReadonlyArray<AttachmentSpec>,
	limits: AttachmentLimits = {},
	cfg?: Config,
): Promise<{
	resolved: ResolvedAttachment[];
	parts: Array<ReturnType<typeof toContentPart>>;
}> {
	const resolved: ResolvedAttachment[] = [];
	let totalBytes = 0;
	for (const spec of specs) {
		const r = await resolveAttachment(spec, limits, cfg);
		totalBytes += r.bytes;
		if (totalBytes > MAX_AGGREGATE_BYTES) {
			throw new AttachmentError(
				`Aggregate attachment size exceeds ${MAX_AGGREGATE_BYTES} bytes`,
				"ATTACH_TOO_LARGE",
			);
		}
		resolved.push(r);
	}
	return { resolved, parts: resolved.map(toContentPart) };
}
