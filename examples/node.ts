/**
 * Generate an image via your ChatGPT subscription.
 * Prereq: chatgpt-bridge serve  (running on :10531)
 */

import { writeFileSync } from "node:fs";
import OpenAI from "openai";

const c = new OpenAI({
	baseURL: "http://127.0.0.1:10531/v1",
	apiKey: "unused",
});

const img = await c.images.generate({
	model: "gpt-image-2",
	prompt: "a small red fox under an oak tree, watercolor",
	size: "1024x1024",
	quality: "high",
});

writeFileSync("fox.png", Buffer.from(img.data[0].b64_json, "base64"));
console.log("saved fox.png");
