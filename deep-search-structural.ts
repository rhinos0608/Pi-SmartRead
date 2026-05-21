// deep-search-structural.ts
// Tree-sitter AST parsing, code structure analysis

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import createSearchTool from "./search-tool.js";
import {
  type RelevanceClass,
  relevanceClassWeight,
} from "./classifiers.js";

import { RRF_K } from "./deep-search-constants.js";
import type { DeepSearchCandidate } from "./deep-search.js";

// ── Structural channel ───────────────────────────────────────────────────────

function extractText(result: unknown): string {
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
 * Parse code search results (mode=code) into candidates.
 * Format: "  file.ts:line-endline [kind] name relevance=X rank=N"
 */
function parseCodeCandidates(text: string, channel: "structural"): DeepSearchCandidate[] {
  const lines = text.split("\n");
  const candidates: DeepSearchCandidate[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = /^\s{2}(.+?):(\d+)-(\d+)\s+\[([^\]]+)]\s+(.+?)\s+relevance=(exact|strong|related|weak|none)\s+rank=(\d+)/.exec(line);
    if (!match) continue;

    const snippetLines: string[] = [];
    for (let j = i + 2; j < lines.length && snippetLines.length < 6; j++) {
      const snippetLine = lines[j] ?? "";
      if (!snippetLine.trim()) break;
      snippetLines.push(snippetLine.replace(/^\s{4}/, ""));
    }

    const rank = Number(match[7]) || candidates.length + 1;
    candidates.push({
      file: match[1]!,
      line: Number(match[2]),
      endLine: Number(match[3]),
      kind: match[4]!,
      name: match[5]!.trim(),
      rawScore: relevanceClassWeight(match[6] as RelevanceClass) + 1 / (RRF_K + rank),
      rank,
      snippet: snippetLines.join("\n"),
      channel,
    });
  }

  return candidates;
}


/**
 * Run the structural code search channel using tree-sitter-based search.
 */
export async function runSearchChannel(
  query: string,
  cwd: string,
  mode: "code" | "grep",
  maxResults: number,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<DeepSearchCandidate[]> {
  const searchTool = createSearchTool();
  const result = await searchTool.execute(
    `deep-search:${mode}`,
    { mode, query, maxResults, directory: cwd },
    signal,
    undefined,
    ctx,
  );
  const text = extractText(result);
  return mode === "code" ? parseCodeCandidates(text, "structural") : [];
}