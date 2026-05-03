import { describe, expect, test } from "bun:test";
import { ImageRequest } from "../src/images.ts";

describe("ImageRequest schema", () => {
	test("accepts minimal valid request", () => {
		const r = ImageRequest.parse({ prompt: "a fox" });
		expect(r.prompt).toBe("a fox");
		expect(r.size).toBe("1024x1024");
		expect(r.quality).toBe("high");
	});

	test("rejects empty prompt", () => {
		expect(() => ImageRequest.parse({ prompt: "" })).toThrow();
	});

	test("rejects n > 1", () => {
		expect(() => ImageRequest.parse({ prompt: "x", n: 2 })).toThrow();
	});

	test("rejects invalid size", () => {
		expect(() => ImageRequest.parse({ prompt: "x", size: "999x999" })).toThrow();
	});

	test("passes through unknown fields", () => {
		const r = ImageRequest.parse({ prompt: "x", custom_extra: "value" });
		expect((r as any).custom_extra).toBe("value");
	});
});
