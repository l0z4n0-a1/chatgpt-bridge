/**
 * Use chatgpt-bridge as a library — no HTTP server, direct calls.
 *
 *   bun add chatgpt-bridge
 */

import { writeFileSync } from "node:fs";
import { Auth, Upstream, generateImage, loadConfig } from "chatgpt-bridge";

const cfg = loadConfig();
const upstream = new Upstream(cfg, new Auth(cfg));

const img = await generateImage(cfg, upstream, {
	prompt: "a serene mountain landscape at dawn",
	quality: "high",
	size: "1024x1024",
});

writeFileSync("mountain.png", Buffer.from(img.b64, "base64"));
console.log("saved mountain.png · revised:", img.revisedPrompt);
