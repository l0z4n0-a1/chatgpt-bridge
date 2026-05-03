/**
 * MCP server: exposes the bridge as a Model Context Protocol server over stdio.
 *
 * Plug into Claude Desktop / Cursor / Zed / Cline / any MCP client with:
 *
 *   {
 *     "mcpServers": {
 *       "chatgpt-bridge": {
 *         "command": "npx",
 *         "args": ["-y", "chatgpt-bridge", "mcp"]
 *       }
 *     }
 *   }
 *
 * `chatgpt-bridge install --for <ide>` writes that block automatically.
 *
 * Tools exposed (mirror the CLI surface):
 *   - generate_image(prompt, out?, size?, quality?, references?)
 *       → writes PNG to disk, returns absolute path. `references` are
 *         optional reference images that drive style/composition.
 *   - chat(prompt, system?, model?, attachments?)
 *       → assistant reply as plain text. `attachments` accept paths or URLs;
 *         images become vision input, text files become contextual file_data.
 *   - health()
 *       → bridge state snapshot (auth, version, upstream).
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolveAttachments } from "./attachments.ts";
import { Auth, tokenExpiryMs } from "./auth.ts";
import { type Config, DEFAULT_CHAT_MODEL } from "./config.ts";
import { generateImage } from "./images.ts";
import { VERSION } from "./server.ts";
import { Upstream } from "./upstream.ts";

const TOOL_DEFINITIONS = [
	{
		name: "generate_image",
		description:
			"Generate an image using the user's ChatGPT subscription via OAuth (no API key, no per-image cost). Optional `references` array shapes style/composition. Returns the absolute path to a PNG file written to disk.",
		inputSchema: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description: "What to draw. Be visually specific.",
				},
				out: {
					type: "string",
					description:
						"Output PNG path. Defaults to ./chatgpt-bridge-<timestamp>.png in the current working directory.",
				},
				size: {
					type: "string",
					enum: ["1024x1024", "1024x1536", "1536x1024", "auto"],
					description: "Image dimensions. Default 1024x1024.",
				},
				quality: {
					type: "string",
					enum: ["low", "medium", "high", "auto"],
					description: "Generation quality. Higher = slower + more detailed. Default high.",
				},
				references: {
					type: "array",
					items: { type: "string" },
					description:
						"Optional reference images (paths, URLs, or data-URLs). Up to 8. Drives the style/composition of the generated image.",
				},
			},
			required: ["prompt"],
		},
	},
	{
		name: "chat",
		description:
			"Send a chat message through the user's ChatGPT subscription and get the assistant reply as plain text. Supports text plus optional attachments (images for vision, .md/.txt/.json for context).",
		inputSchema: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description: "User message.",
				},
				system: {
					type: "string",
					description: "Optional system / developer prompt.",
				},
				model: {
					type: "string",
					description: "Upstream model id (e.g. gpt-5.2). Defaults to gpt-5.2.",
				},
				attachments: {
					type: "array",
					items: { type: "string" },
					description:
						"Optional attachment paths or URLs. Auto-detects image vs. text. Images become vision input; text files become contextual file_data. Max 25 MiB each, 100 MiB aggregate.",
				},
			},
			required: ["prompt"],
		},
	},
	{
		name: "health",
		description:
			"Return a snapshot of the bridge's auth and upstream state. Useful for confirming the user is authenticated.",
		inputSchema: { type: "object", properties: {} },
	},
];

interface GenerateImageArgs {
	prompt: string;
	out?: string;
	size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
	quality?: "low" | "medium" | "high" | "auto";
	references?: string[];
}

interface ChatArgs {
	prompt: string;
	system?: string;
	model?: string;
	attachments?: string[];
}

async function handleGenerateImage(
	cfg: Config,
	upstream: Upstream,
	args: GenerateImageArgs,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
	const t0 = Date.now();
	const img = await generateImage(cfg, upstream, {
		prompt: args.prompt,
		size: args.size ?? "1024x1024",
		quality: args.quality ?? "high",
		n: 1,
		response_format: "b64_json",
		moderation: "low",
		...(args.references && args.references.length > 0 ? { reference_images: args.references } : {}),
	});
	const outPath = path.resolve(args.out ?? `chatgpt-bridge-${Date.now()}.png`);
	await fs.mkdir(path.dirname(outPath), { recursive: true }).catch(() => {});
	await fs.writeFile(outPath, Buffer.from(img.b64, "base64"));
	const summary = {
		ok: true,
		file: outPath,
		latency_ms: Date.now() - t0,
		bytes: Buffer.byteLength(img.b64, "base64"),
		revised_prompt: img.revisedPrompt ?? null,
	};
	return {
		content: [
			{
				type: "text",
				text: `Image saved to ${outPath}\n\n${JSON.stringify(summary, null, 2)}`,
			},
		],
	};
}

async function handleChat(
	cfg: Config,
	upstream: Upstream,
	args: ChatArgs,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
	const input: Array<Record<string, unknown>> = [];
	if (args.system) input.push({ role: "developer", content: args.system });

	const userContent: Array<Record<string, unknown>> = [{ type: "input_text", text: args.prompt }];
	if (args.attachments && args.attachments.length > 0) {
		const { parts } = await resolveAttachments(args.attachments, {}, cfg);
		for (const p of parts) userContent.push(p);
	}
	input.push({ role: "user", content: userContent });

	const res = await upstream.call({
		path: "/responses",
		method: "POST",
		body: {
			model: args.model ?? DEFAULT_CHAT_MODEL,
			input,
			stream: true,
			store: false,
			instructions: "",
		},
		stream: true,
	});
	if (!res.ok) await upstream.raiseForStatus(res);

	let text = "";
	const { parseSSE } = await import("./upstream.ts");
	for await (const ev of parseSSE(res)) {
		if (ev.type === "response.output_text.delta") {
			const delta = (ev.data as any).delta;
			if (typeof delta === "string") text += delta;
		}
	}
	return { content: [{ type: "text", text: text || "(empty response)" }] };
}

async function handleHealth(
	cfg: Config,
	auth: Auth,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
	let status: Record<string, unknown>;
	try {
		const t = await auth.ensure();
		const exp = tokenExpiryMs(t.accessToken);
		status = {
			ok: true,
			version: VERSION,
			auth: {
				source_path: t.sourcePath,
				expires_in_seconds:
					typeof exp === "number" ? Math.max(0, Math.floor((exp - Date.now()) / 1000)) : null,
			},
			upstream: cfg.upstreamBase,
		};
	} catch (e) {
		status = {
			ok: false,
			version: VERSION,
			error: (e as Error).message,
			remedy: {
				cmd: "npx @openai/codex login",
				interactive: true,
				why: "OAuth flow opens browser; user signs in to ChatGPT once",
			},
		};
	}
	return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
}

export async function startMcpServer(cfg: Config): Promise<void> {
	const auth = new Auth(cfg);
	const upstream = new Upstream(cfg, auth);

	const server = new Server(
		{ name: "chatgpt-bridge", version: VERSION },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: TOOL_DEFINITIONS,
	}));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const name = req.params.name;
		const args = (req.params.arguments ?? {}) as Record<string, unknown>;
		try {
			if (name === "generate_image") {
				return await handleGenerateImage(cfg, upstream, args as unknown as GenerateImageArgs);
			}
			if (name === "chat") {
				return await handleChat(cfg, upstream, args as unknown as ChatArgs);
			}
			if (name === "health") {
				return await handleHealth(cfg, auth);
			}
			return {
				isError: true,
				content: [{ type: "text", text: `Unknown tool: ${name}` }],
			};
		} catch (e) {
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: `${(e as Error).message}\n\nRun \`chatgpt-bridge doctor\` to diagnose.`,
					},
				],
			};
		}
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
	// Process stays alive on stdio. No console.log here — stdout is the protocol channel.
	void os; // silence unused if stripped
}
