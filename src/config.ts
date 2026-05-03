/**
 * Config: types + defaults inline. KISS.
 *
 * No TOML file, no nested structures. ENV vars override defaults.
 * Want to tweak? Set the env var. Done.
 */

import os from "node:os";
import path from "node:path";

export const DEFAULTS = {
	host: "127.0.0.1",
	port: 10531,
	upstreamBase: "https://chatgpt.com/backend-api/codex",
	oauthIssuer: "https://auth.openai.com",
	// Codex-CLI's published client_id (RFC 6749 §2.2 — public clients).
	// We piggyback it because the user's auth.json was minted under it.
	oauthClientId: "app_EMoamEEZ73f0CkXaXp7hrann",
	clientVersion: "0.111.0",
	timeoutMs: 400_000,
	rateHourlyHard: 200,
	imageModel: "gpt-5.4-mini",
} as const;

export interface Config {
	host: string;
	port: number;
	upstreamBase: string;
	oauthIssuer: string;
	oauthClientId: string;
	clientVersion: string;
	timeoutMs: number;
	rateHourlyHard: number;
	imageModel: string;
	authFilePath: string | undefined;
	dataHome: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
	const env = process.env;
	const cfg: Config = {
		host: overrides.host ?? env.CHATGPT_BRIDGE_HOST ?? DEFAULTS.host,
		port:
			overrides.port ??
			(env.CHATGPT_BRIDGE_PORT ? Number.parseInt(env.CHATGPT_BRIDGE_PORT, 10) : DEFAULTS.port),
		upstreamBase: overrides.upstreamBase ?? DEFAULTS.upstreamBase,
		oauthIssuer: overrides.oauthIssuer ?? DEFAULTS.oauthIssuer,
		oauthClientId:
			overrides.oauthClientId ?? env.CHATGPT_BRIDGE_CLIENT_ID ?? DEFAULTS.oauthClientId,
		clientVersion: overrides.clientVersion ?? DEFAULTS.clientVersion,
		timeoutMs: overrides.timeoutMs ?? DEFAULTS.timeoutMs,
		rateHourlyHard: overrides.rateHourlyHard ?? DEFAULTS.rateHourlyHard,
		imageModel: overrides.imageModel ?? env.CHATGPT_BRIDGE_IMAGE_MODEL ?? DEFAULTS.imageModel,
		authFilePath: overrides.authFilePath ?? env.CHATGPT_BRIDGE_AUTH_FILE,
		dataHome: overrides.dataHome ?? path.join(os.homedir(), ".chatgpt-bridge"),
	};
	return cfg;
}

/** Resolve auth file lookup order. First match wins. */
export function authFileCandidates(cfg: Config): string[] {
	const home = os.homedir();
	const list = [
		cfg.authFilePath,
		process.env.CHATGPT_LOCAL_HOME
			? path.join(process.env.CHATGPT_LOCAL_HOME, "auth.json")
			: undefined,
		process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "auth.json") : undefined,
		path.join(home, ".chatgpt-local", "auth.json"),
		path.join(home, ".codex", "auth.json"),
		path.join(cfg.dataHome, "auth.json"),
	];
	return list.filter((v): v is string => typeof v === "string" && v.length > 0);
}
