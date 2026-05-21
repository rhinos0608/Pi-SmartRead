// deep-search-lsp.ts
// LSP workspace symbols, document symbols, hover type

import { resolve, relative } from "node:path";
import { getLSPBridge } from "./lsp-bridge.js";

import type { DeepSearchCandidate, DeepSearchDepth } from "./deep-search.js";

// ── LSP channel constants ────────────────────────────────────────────────────

export const LSP_SCORE_BOOST = 0.15;
export const MAX_LSP_RESULTS = 30;
export const MAX_HOVER_RESULTS = 3;

// ── Helpers ─────────────────────────────────────────────────────────────────

export const LSP_SYMBOL_KINDS: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enumMember",
  23: "struct",
  24: "event",
  25: "operator",
  26: "typeParameter",
};

export function lspKindToString(kind: number): string {
  return LSP_SYMBOL_KINDS[kind] ?? "symbol";
}

/** Convert a file:// URI to an absolute filesystem path. */
export function uriToPath(uri: string): string {
  const decoded = decodeURIComponent(uri);
  if (decoded.startsWith("file://")) {
    let path = decoded.slice(7); // strip "file://" prefix
    // On Windows, file:///C:/path becomes /C:/path — remove the leading slash
    if (/^\/[A-Za-z]:/.test(path)) {
      path = path.slice(1);
    }
    return path;
  }
  return decoded;
}

// ── LSP channel ─────────────────────────────────────────────────────────────

/**
 * Run the LSP workspace/symbol retrieval channel.
 * Best-effort: returns empty array on any failure.
 */
export async function runLSPChannel(
  query: string,
  cwd: string,
  depth: DeepSearchDepth,
  maxResults: number,
  signal: AbortSignal | undefined,
): Promise<DeepSearchCandidate[]> {
  if (signal?.aborted) return [];
  if (query.length <= 2) return [];

  const bridge = await getLSPBridge();
  if (signal?.aborted) return [];
  if (!bridge?.isAvailable()) return [];

  let symbols: import("./lsp-bridge.js").LSPWorkspaceSymbol[];
  try {
    symbols = await bridge.workspaceSymbol(query, cwd);
  } catch {
    return [];
  }

  if (signal?.aborted || !Array.isArray(symbols) || symbols.length === 0) return [];

  const limit = depth === "thorough" ? Math.min(maxResults * 2, MAX_LSP_RESULTS) : maxResults;
  const candidates: DeepSearchCandidate[] = [];

  for (let i = 0; i < Math.min(symbols.length, limit); i++) {
    const sym = symbols[i]!;
    if (!sym?.name || !sym?.location?.uri) continue;

    const filePath = uriToPath(sym.location.uri);
    const rel = toRelativePath(cwd, filePath);
    if (!rel) continue;

    const range = sym.location.range;
    if (!range || typeof range.start?.line !== "number" || typeof range.end?.line !== "number") continue;

    candidates.push({
      file: rel,
      line: range.start.line + 1,
      endLine: range.end.line + 1,
      name: sym.name,
      kind: lspKindToString(sym.kind),
      rawScore: 1 + LSP_SCORE_BOOST,
      rank: candidates.length + 1,
      snippet: "",
      channel: "lsp",
    });
  }

  // For thorough depth, fetch hover info for the first few results
  if (depth === "thorough" && candidates.length > 0) {
    const hoverLimit = Math.min(MAX_HOVER_RESULTS, candidates.length);
    for (let i = 0; i < hoverLimit; i++) {
      if (signal?.aborted) break;
      const candidate = candidates[i];
      if (!candidate || candidate.line === undefined) continue;
      try {
        const absPath = resolve(cwd, candidate.file);
        const hoverResult = await bridge.hover(absPath, candidate.line - 1, 0, cwd);
        if (hoverResult) {
          const hoverText = extractHoverText(hoverResult.contents);
          if (hoverText) {
            candidate.snippet = hoverText.slice(0, 200);
          }
        }
      } catch { /* best effort */ }
    }
  }

  return candidates;
}

/** Extract hover text from an LSP hover result contents (string, array, or MarkupContent). */
function extractHoverText(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((c) => extractHoverText(c))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof contents === "object" && contents !== null && "value" in contents) {
    return String((contents as { value: unknown }).value);
  }
  return "";
}

function toRelativePath(cwd: string, path: string): string {
  const rel = relative(cwd, resolve(cwd, path));
  return rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : path.replace(/\\/g, "/");
}