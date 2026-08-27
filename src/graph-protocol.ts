/**
 * graph:// protocol handler.
 *
 * Resolves graph://<node-type>/<name> by querying the context graph
 * using its public API (findSymbolFiles, getFileNeighbours).
 *
 * Import-cycle safety: this module MUST NOT static-import mcp-registry.ts
 * -- doing so creates a circular ES module dependency:
 *   mcp-registry.ts -> grep-tool.ts -> search-tool.ts -> hook.ts ->
 *   read-many.ts -> graph-protocol.ts -> mcp-registry.ts
 * which breaks runtime loading with a temporal-dead-zone ReferenceError.
 * mcp-registry is instead imported lazily via dynamic `await import()`
 * inside the function that needs it, after the module graph has
 * finished resolving.
 */

import type { UrlHandler, UrlSourceInfo } from "./internal-url-router.js";

/** Query the context graph for a node of the given type and name. */
export async function resolveGraphUrl(
	url: string,
	cwd?: string,
): Promise<{ text: string; sourceInfo: UrlSourceInfo }> {
	// graph://file/utils.ts → file, utils.ts
	const match = /^graph:\/\/([^/]+)\/(.+)$/.exec(url);
	if (!match) {
		throw new Error(`Invalid graph URL: ${url}`);
	}
	const nodeType = match[1] ?? "";
	const name = match[2] ?? "";
	const workspace = cwd ?? process.cwd();

	let text = "";
	try {
		const { getSharedContextGraphAsync } = await import("./mcp-registry.js");
		const graph = await getSharedContextGraphAsync(workspace);

		if (nodeType === "file") {
			// Look up file neighbours (imports / imported-by)
			const neighbours = await graph.getFileNeighbours(name, { includeSymbols: false, includeCalls: false }).catch(() => []);
			if (neighbours.length === 0) {
				text = `[No graph edges found for file: ${name}]`;
			} else {
				text = neighbours
					.slice(0, 20)
					.map((n) => `  ${n.path} (${n.provenance.type} ← ${n.provenance.from})`)
					.join("\n");
				text = `Edges for ${name}:\n${text}`;
			}
		} else {
			// Symbol / function — use findSymbolFiles
			const results = await graph.findSymbolFiles(name, { forceRefresh: false, includeSymbols: true, includeCalls: false }).catch(() => []);
			if (results.length === 0) {
				text = `[No graph node found for symbol: ${name}]`;
			} else {
				text = results
					.slice(0, 20)
					.map((n) => `  ${n.path} (${n.provenance.type} ← ${n.provenance.from})`)
					.join("\n");
				text = `Definitions/references for "${name}":\n${text}`;
			}
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`graph://${nodeType}/${name}: ${msg}`);
	}

	return {
		text,
		sourceInfo: { scheme: "graph", path: url },
	};
}

export const graphHandler: UrlHandler = {
	scheme: "graph",
	resolve: (url, cwd) => resolveGraphUrl(url, cwd),
};
