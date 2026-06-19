// deep-search-symbol.ts
// Symbol resolution, caller graph, declaration finding

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { handleGrep } from "./search-tool.js";
import { findCallers } from "./callgraph.js";

import type { DeepSearchCandidate } from "./deep-search.js";

// ── Symbol channel ───────────────────────────────────────────────────────────

export function extractTextFromToolResult(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text") {
        return String((item as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Parse grep search results into candidates.
 * Format: "  file.ts:line-endline [kind] name"
 */
function parseGrepCandidates(result: unknown): DeepSearchCandidate[] {
  const details = (result as { details?: unknown }).details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const matches = (details as { matches?: unknown }).matches;
    if (Array.isArray(matches)) {
      const candidates: DeepSearchCandidate[] = [];
      for (const rawMatch of matches) {
        if (!rawMatch || typeof rawMatch !== "object") continue;
        const match = rawMatch as Record<string, unknown>;
        if (match.group !== "definition") continue;
        if (typeof match.file !== "string" || typeof match.line !== "number") continue;

        candidates.push({
          file: match.file,
          line: match.line,
          endLine: typeof match.endLine === "number" ? match.endLine : match.line,
          kind: typeof match.kind === "string" ? match.kind : "symbol",
          name: typeof match.name === "string" ? match.name : "symbol",
          channel: "symbol",
          snippet: typeof match.snippet === "string" ? match.snippet : String(match.name ?? "symbol"),
          rawScore: 1.0,
          rank: candidates.length + 1,
        });
      }
      return candidates;
    }
  }

  const candidates: DeepSearchCandidate[] = [];
  const text = extractTextFromToolResult(result);
  const lines = text.split('\n');
  for (const line of lines) {
    const match = line.match(/^\s{2}(.+?):(\d+)-(\d+)\s+\[(\w+)\]\s+(\S+)/);
    if (match) {
      candidates.push({
        file: match[1]!,
        line: Number(match[2]),
        endLine: Number(match[3]),
        kind: match[4]!,
        name: match[5]!,
        channel: 'symbol',
        snippet: line.trim(),
        rawScore: 1.0,
        rank: candidates.length + 1,
      });
    }
  }
  if (text.length > 0 && candidates.length === 0) {
    // Skip fallback if the output is a clear "no results" message
    const noResultPattern = /no (?:definitions?|matches?|results?|symbols?)/i;
    if (!noResultPattern.test(text)) {
      // Fallback: try to extract path:line from each line before treating as plain text.
      // The grep output format is "  file:line-endline  [kind]  name", so candidates built
      // here with proper file/line pass through candidatePathFilter in deep-search.ts.
      const pathLineRe = /^\s*([^\s:]+?):(\d+)/;
      for (let i = 0; i < Math.min(lines.length, 5); i++) {
        const trimmed = lines[i]!.trim();
        if (trimmed) {
          const plMatch = pathLineRe.exec(trimmed);
          candidates.push({
            file: plMatch?.[1] ?? "unknown",
            line: plMatch ? Number(plMatch[2]) : 1,
            name: trimmed.slice(0, 80),
            kind: "symbol",
            channel: "symbol",
            snippet: trimmed.slice(0, 400),
            rawScore: 1.0,
            rank: candidates.length + 1,
          });
        }
      }
    }
  }
  return candidates;
}

/**
 * Run the symbol search channel using grep-based search.
 */
export async function runSymbolChannel(
  query: string,
  cwd: string,
  maxResults: number,
  signal: AbortSignal | undefined,
  _ctx: ExtensionContext,
): Promise<DeepSearchCandidate[]> {
  const result = await handleGrep(
    "deep-search:grep",
    { query, maxResults, directory: cwd },
    cwd,
    signal,
  );
  return parseGrepCandidates(result);
}

/**
 * Enrich matches with caller information.
 */
export async function enrichRelationships(
  matches: Array<{
    name: string;
    callers?: Array<{ file: string; name: string }>;
  }>,
  signal: AbortSignal | undefined,
  discoveredFiles: string[],
): Promise<void> {
  const eligible = matches.filter((m) => /^[A-Za-z_$][\w$]*$/.test(m.name)).slice(0, 3);

  for (const match of eligible) {
    if (signal?.aborted) throw new Error("Operation aborted");
    try {
      const callers = await findCallers(discoveredFiles, match.name, signal);
      match.callers = callers.map(c => ({ file: c.file, name: c.callerFunction }));
    } catch {
      match.callers = [];
    }
  }
}
