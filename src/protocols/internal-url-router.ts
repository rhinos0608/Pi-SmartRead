/**
 * Internal URL scheme router for Pi-SmartRead.
 *
 * Allows the read tool to transparently resolve URLs like:
 *   skill://<skill-name>/<file>       → ~/.pi/agent/skills/<name>/<file>
 *   memory://<query>                  → agentmemory search
 *   graph://<node-type>/<name>        → context graph query
 */

export interface UrlSourceInfo {
	scheme: string;
	path: string;
}

export interface UrlHandlerResult {
	text: string;
	sourceInfo: UrlSourceInfo;
}

export interface UrlHandler {
	scheme: string;
	resolve(url: string, cwd?: string): Promise<UrlHandlerResult>;
}

/** URL pattern: scheme://host/path → ["skill", "semantic-compression", "SKILL.md"] */
const URL_RE = /^([a-zA-Z][a-zA-Z\d+\-.]*):\/\/([^/]+)(\/.*)?$/;

export function parseInternalUrl(raw: string): { scheme: string; host: string; path: string } | null {
	const match = URL_RE.exec(raw);
	if (!match) return null;
	return {
		scheme: match[1]!,
		host: match[2]!,
		path: (match[3] ?? "").replace(/^\/+/, ""),
	};
}

export function isInternalUrl(rawPath: string): boolean {
	return parseInternalUrl(rawPath) !== null;
}

// ── Router ─────────────────────────────────────────────────────────────────

const _handlers = new Map<string, UrlHandler>();

export function registerHandler(handler: UrlHandler): void {
	_handlers.set(handler.scheme, handler);
}

export function getHandler(scheme: string): UrlHandler | undefined {
	return _handlers.get(scheme);
}

export async function resolveUrl(rawUrl: string): Promise<UrlHandlerResult> {
	const parsed = parseInternalUrl(rawUrl);
	if (!parsed) {
		throw new Error(`Cannot parse as internal URL: ${rawUrl}`);
	}
	const handler = _handlers.get(parsed.scheme);
	if (!handler) {
		throw new Error(`No handler registered for scheme: ${parsed.scheme}`);
	}
	return handler.resolve(rawUrl);
}

// ── Re-export helpers from protocol files ───────────────────────────────────

export { resolveSkillUrl } from "./skill-protocol.js";
export { resolveMemoryUrl } from "./memory-protocol.js";
export { resolveGraphUrl } from "./graph-protocol.js";