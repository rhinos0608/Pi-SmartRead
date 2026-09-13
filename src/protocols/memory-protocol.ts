/**
 * memory:// protocol handler.
 *
 * Resolves memory://<query> by searching agentmemory via the MCP gateway.
 * The MCP gateway must be connected (mcp-server running). Falls back to a
 * descriptive placeholder when the gateway is unavailable.
 *
 * AgentMemory integration is optional — reads never fail due to it.
 */

import type { UrlHandler, UrlSourceInfo } from "./internal-url-router.js";

interface MemorySearchResult {
	text: string;
	sourceInfo: UrlSourceInfo;
}

type McpGateway = {
	call?: (server: string, tool: string, args: Record<string, unknown>) => Promise<unknown>;
};

function isTextChunk(x: unknown): x is { type: string; text: string } {
	return typeof x === "object" && x !== null
		&& (x as { type?: unknown }).type === "text"
		&& typeof (x as { text?: unknown }).text === "string";
}

/** Attempt to call agentmemory/memory_search via the MCP gateway. */
async function callAgentMemorySearch(query: string): Promise<string> {
	try {
		// Dynamic import avoids hard coupling. Try to get the gateway from mcp-server.
		// The gateway pattern is only available when Pi-SmartRead runs as an MCP server.
		const mcpMod = await import("./mcp-server.js").catch(() => null);
		const gateway = (mcpMod as unknown as { getMcpGateway?: () => McpGateway; defaultGateway?: McpGateway })?.getMcpGateway?.()
			?? (mcpMod as unknown as { defaultGateway?: McpGateway })?.defaultGateway
			?? null;
		if (!gateway) return "";

		const res = await gateway.call?.("agentmemory", "memory_search", { query });
		if (res && typeof res === "object" && "content" in res) {
			const c = (res as { content: unknown[] }).content;
			return Array.isArray(c)
				? c.filter(isTextChunk)
					.map((x) => x.text ?? "")
					.join("\n")
				: String(res);
		}
		return String(res ?? "");
	} catch {
		return "";
	}
}

/** Search agentmemory for the given query. Returns combined text or a helpful fallback. */
export async function resolveMemoryUrl(url: string): Promise<MemorySearchResult> {
	const match = /^memory:\/\/(.+)$/.exec(url);
	if (!match) {
		throw new Error(`Invalid memory URL: ${url}`);
	}
	const query = decodeURIComponent(match[1]!);

	const result = await callAgentMemorySearch(query);
	const text = result || `[agentmemory unavailable — query: "${query}"]`;

	return {
		text,
		sourceInfo: { scheme: "memory", path: url },
	};
}

export const memoryHandler: UrlHandler = {
	scheme: "memory",
	resolve: resolveMemoryUrl,
};