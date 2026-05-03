import { describe, expect, test } from "bun:test";
import { accountIdFromIdToken, jwtClaims, tokenExpiryMs } from "../src/auth.ts";
import { authFileCandidates, loadConfig } from "../src/config.ts";

/** Build a fake JWT (alg=none, signature ignored). */
function makeJwt(payload: Record<string, unknown>): string {
	const enc = (o: unknown) =>
		Buffer.from(JSON.stringify(o)).toString("base64url").replace(/=+$/, "");
	return `${enc({ alg: "none", typ: "JWT" })}.${enc(payload)}.sig`;
}

describe("jwtClaims", () => {
	test("decodes payload", () => {
		const t = makeJwt({ sub: "abc", exp: 1234567890 });
		expect(jwtClaims(t)).toMatchObject({ sub: "abc", exp: 1234567890 });
	});

	test("returns undefined for invalid tokens", () => {
		expect(jwtClaims(undefined)).toBeUndefined();
		expect(jwtClaims("")).toBeUndefined();
		expect(jwtClaims("not.a.jwt")).toBeUndefined();
		expect(jwtClaims("only.two")).toBeUndefined();
	});
});

describe("tokenExpiryMs", () => {
	test("returns ms from exp claim", () => {
		const t = makeJwt({ exp: 1700000000 });
		expect(tokenExpiryMs(t)).toBe(1700000000 * 1000);
	});
	test("returns undefined when exp missing", () => {
		const t = makeJwt({ sub: "x" });
		expect(tokenExpiryMs(t)).toBeUndefined();
	});
});

describe("accountIdFromIdToken", () => {
	test("extracts from custom claim namespace", () => {
		const t = makeJwt({
			"https://api.openai.com/auth": { chatgpt_account_id: "acc-123" },
		});
		expect(accountIdFromIdToken(t)).toBe("acc-123");
	});
	test("returns undefined when claim absent", () => {
		expect(accountIdFromIdToken(makeJwt({ sub: "x" }))).toBeUndefined();
	});
});

describe("authFileCandidates", () => {
	test("includes default home paths", () => {
		const cfg = loadConfig();
		const list = authFileCandidates(cfg);
		expect(list.length).toBeGreaterThan(0);
		expect(
			list.some((p) => p.endsWith(".codex/auth.json") || p.endsWith(".codex\\auth.json")),
		).toBe(true);
	});

	test("explicit override wins", () => {
		const cfg = loadConfig({ authFilePath: "/tmp/explicit.json" });
		const list = authFileCandidates(cfg);
		expect(list[0]).toBe("/tmp/explicit.json");
	});
});
