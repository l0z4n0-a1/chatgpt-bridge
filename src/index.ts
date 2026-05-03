/**
 * Public library API. Use the bridge programmatically in any Node/Bun app.
 *
 *   import { createApp, generateImage, Auth, Upstream, loadConfig } from "chatgpt-bridge";
 *
 *   const cfg = loadConfig();
 *   const auth = new Auth(cfg);
 *   const upstream = new Upstream(cfg, auth);
 *   const img = await generateImage(cfg, upstream, { prompt: "a fox" });
 *   require("fs").writeFileSync("fox.png", Buffer.from(img.b64, "base64"));
 */

export {
	AttachmentError,
	AttachmentSpec,
	MAX_AGGREGATE_BYTES,
	MAX_ATTACHMENT_BYTES,
	resolveAttachment,
	resolveAttachments,
	toContentPart,
} from "./attachments.ts";
export type { AttachmentKind, AttachmentLimits, ResolvedAttachment } from "./attachments.ts";
export { Auth, jwtClaims, tokenExpiryMs, accountIdFromIdToken } from "./auth.ts";
export type { AuthFile, Tokens } from "./auth.ts";
export {
	type Config,
	DEFAULT_CHAT_MODEL,
	DEFAULTS,
	authFileCandidates,
	loadConfig,
} from "./config.ts";
export { generateImage, ImageRequest } from "./images.ts";
export type { ImageResult } from "./images.ts";
export { createApp, startServer, translateChatMessages, VERSION } from "./server.ts";
export { Upstream, UpstreamError, normalizeResponsesBody, parseSSE } from "./upstream.ts";
export { CAPABILITIES, CAPABILITY_VERB_NAMES } from "./capabilities.ts";
export type { Capabilities, CapabilityVerb, CapabilityArg } from "./capabilities.ts";
export { runInstall } from "./install.ts";
export type { Target as InstallTarget, InstallResult, InstallOptions } from "./install.ts";
