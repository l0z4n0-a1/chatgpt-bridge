/**
 * OAuth token manager — clean-room implementation.
 *
 * References used (public specs only):
 *   - RFC 6749 §6 (refresh token grant)
 *   - RFC 7519 (JWT decoding — header + payload + sig parts)
 *
 * The auth file is a JSON document storing the OAuth tokens. Its format is
 * compatible with the file written by other ChatGPT OAuth helpers, so users
 * who already authenticated via another tool keep working transparently.
 *
 * Schema (verified by reading the file written by `npx @openai/codex login`):
 *   {
 *     "auth_mode": "chatgpt",
 *     "OPENAI_API_KEY": null | string,
 *     "tokens": {
 *       "id_token": "<JWT>",
 *       "access_token": "<JWT>",
 *       "refresh_token": "<opaque>",
 *       "account_id": "<UUID>"
 *     },
 *     "last_refresh": "<ISO-8601>"
 *   }
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { type Config, authFileCandidates } from "./config.ts";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REFRESH_INTERVAL_MS = 55 * 60 * 1000;

export interface AuthFile {
	auth_mode?: string;
	OPENAI_API_KEY?: string | null;
	tokens?: {
		id_token?: string;
		access_token?: string;
		refresh_token?: string;
		account_id?: string;
	};
	last_refresh?: string;
}

export interface Tokens {
	accessToken: string;
	idToken?: string;
	refreshToken?: string;
	accountId: string;
	sourcePath: string;
	lastRefresh?: string;
}

/* --------------------------- JWT decoder (clean) -------------------------- */

function fromBase64Url(s: string): string {
	const padded = s + "=".repeat(((-s.length % 4) + 4) % 4);
	return Buffer.from(padded, "base64url").toString("utf-8");
}

export function jwtClaims(token: string | undefined): Record<string, unknown> | undefined {
	if (!token || !token.includes(".")) return undefined;
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) return undefined;
	try {
		const json = JSON.parse(fromBase64Url(parts[1]));
		return typeof json === "object" && json !== null && !Array.isArray(json)
			? (json as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

export function tokenExpiryMs(token: string | undefined): number | undefined {
	const c = jwtClaims(token);
	const exp = c?.exp;
	return typeof exp === "number" ? exp * 1000 : undefined;
}

/**
 * Extract chatgpt account id from id_token. The custom claim path is the
 * documented OpenAI auth namespace.
 */
export function accountIdFromIdToken(idToken: string | undefined): string | undefined {
	const c = jwtClaims(idToken);
	if (!c) return undefined;
	const ns = c["https://api.openai.com/auth"];
	if (typeof ns === "object" && ns !== null && !Array.isArray(ns)) {
		const v = (ns as Record<string, unknown>).chatgpt_account_id;
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

/* ------------------------------ File I/O --------------------------------- */

async function readFirstAuthFile(
	candidates: string[],
): Promise<{ path: string; data: AuthFile } | undefined> {
	for (const p of candidates) {
		try {
			const text = await fs.readFile(p, "utf-8");
			const json = JSON.parse(text);
			if (json && typeof json === "object") return { path: p, data: json as AuthFile };
		} catch {
			/* try next */
		}
	}
	return undefined;
}

async function writeAuthFile(p: string, data: AuthFile): Promise<void> {
	await fs.mkdir(path.dirname(p), { recursive: true });
	await fs.writeFile(p, `${JSON.stringify(data, null, 2)}\n`, {
		encoding: "utf-8",
		mode: 0o600,
	});
}

/* ---------------------------- Refresh (RFC 6749) -------------------------- */

async function refresh(
	cfg: Config,
	refreshToken: string,
): Promise<{ accessToken: string; idToken?: string; refreshToken?: string }> {
	const url = `${cfg.oauthIssuer.replace(/\/$/, "")}/oauth/token`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: cfg.oauthClientId,
			scope: "openid profile email offline_access",
		}),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Token refresh failed (HTTP ${res.status}). ${body.slice(0, 200)}`);
	}
	const j = (await res.json()) as Record<string, unknown>;
	const accessToken = typeof j.access_token === "string" ? j.access_token : undefined;
	if (!accessToken) throw new Error("Token refresh response missing access_token");
	return {
		accessToken,
		idToken: typeof j.id_token === "string" ? j.id_token : undefined,
		refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : refreshToken,
	};
}

/* ------------------------------ Public API ------------------------------- */

export class Auth {
	private current?: Tokens;
	private inflight?: Promise<Tokens>;

	constructor(private readonly cfg: Config) {}

	async ensure(): Promise<Tokens> {
		if (this.inflight) return this.inflight;
		if (this.current && !this.needsRefresh(this.current)) return this.current;
		this.inflight = this.load().finally(() => {
			this.inflight = undefined;
		});
		return this.inflight;
	}

	async headers(): Promise<Record<string, string>> {
		const t = await this.ensure();
		return {
			Authorization: `Bearer ${t.accessToken}`,
			"chatgpt-account-id": t.accountId,
			"OpenAI-Beta": "responses=experimental",
		};
	}

	private needsRefresh(t: Tokens): boolean {
		const exp = tokenExpiryMs(t.accessToken);
		if (typeof exp === "number" && exp <= Date.now() + REFRESH_MARGIN_MS) return true;
		if (t.lastRefresh) {
			const last = Date.parse(t.lastRefresh);
			if (!Number.isNaN(last) && last <= Date.now() - REFRESH_INTERVAL_MS) return true;
		}
		return false;
	}

	private async load(): Promise<Tokens> {
		const found = await readFirstAuthFile(authFileCandidates(this.cfg));
		if (!found) {
			const tried = authFileCandidates(this.cfg).join(", ");
			throw new Error(
				`auth.json not found. Looked in: ${tried}. Run \`npx @openai/codex login\` once to mint it.`,
			);
		}
		const t = found.data.tokens ?? {};
		let accessToken = t.access_token;
		let idToken = t.id_token;
		let refreshToken = t.refresh_token;
		let accountId = t.account_id ?? accountIdFromIdToken(idToken);
		let lastRefresh = found.data.last_refresh;

		const stale = !accessToken || this.shouldRefreshFromFile(accessToken, lastRefresh);
		if (stale && refreshToken) {
			const r = await refresh(this.cfg, refreshToken);
			accessToken = r.accessToken;
			idToken = r.idToken ?? idToken;
			refreshToken = r.refreshToken ?? refreshToken;
			accountId = accountIdFromIdToken(idToken) ?? accountId;
			lastRefresh = new Date().toISOString();
			await writeAuthFile(found.path, {
				auth_mode: found.data.auth_mode ?? "chatgpt",
				OPENAI_API_KEY: found.data.OPENAI_API_KEY ?? null,
				tokens: {
					id_token: idToken,
					access_token: accessToken,
					refresh_token: refreshToken,
					account_id: accountId,
				},
				last_refresh: lastRefresh,
			});
		}

		if (!accessToken) throw new Error("Access token missing after refresh attempt");
		if (!accountId) throw new Error("account_id not found in id_token claims");

		const tokens: Tokens = {
			accessToken,
			accountId,
			sourcePath: found.path,
		};
		if (idToken) tokens.idToken = idToken;
		if (refreshToken) tokens.refreshToken = refreshToken;
		if (lastRefresh) tokens.lastRefresh = lastRefresh;
		this.current = tokens;
		return tokens;
	}

	private shouldRefreshFromFile(access: string, lastRefresh: string | undefined): boolean {
		const exp = tokenExpiryMs(access);
		if (typeof exp === "number" && exp <= Date.now() + REFRESH_MARGIN_MS) return true;
		if (lastRefresh) {
			const last = Date.parse(lastRefresh);
			if (!Number.isNaN(last) && last <= Date.now() - REFRESH_INTERVAL_MS) return true;
		}
		return false;
	}
}
