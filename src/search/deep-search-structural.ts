// deep-search-structural.ts
// Tree-sitter AST parsing, code structure analysis

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { handleGrep, handleCode } from "./search-tool.js";
import {
  type RelevanceClass,
  relevanceClassWeight,
} from "./classifiers.js";

import { RRF_K } from "./deep-search-constants.js";
import type { DeepSearchCandidate } from "./deep-search.js";

// ── Structural channel ───────────────────────────────────────────────────────

import { extractTextFromToolResult } from "./deep-search-symbol.js";

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

function parseGrepCandidates(result: unknown, channel: "structural"): DeepSearchCandidate[] {
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];

  const matches = (details as { matches?: unknown }).matches;
  if (!Array.isArray(matches)) return [];

  const candidates: DeepSearchCandidate[] = [];
  for (const rawMatch of matches) {
    if (!rawMatch || typeof rawMatch !== "object") continue;
    const match = rawMatch as Record<string, unknown>;
    if (typeof match.file !== "string" || typeof match.line !== "number") continue;

    const kind = typeof match.kind === "string" ? match.kind : "text";
    const name = typeof match.name === "string" ? match.name : kind;
    const rank = candidates.length + 1;
    const group = match.group === "definition" ? "definition" : "text";

    candidates.push({
      file: match.file,
      line: match.line,
      endLine: typeof match.endLine === "number" ? match.endLine : match.line,
      kind,
      name,
      rawScore: group === "definition" ? 1.0 : 0.8,
      rank,
      snippet: typeof match.snippet === "string" ? match.snippet : name,
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
  _ctx: ExtensionContext,
): Promise<DeepSearchCandidate[]> {
  const toolCallId = `deep-search:${mode}`;
  const params = { query, maxResults, directory: cwd };
  let result;
  if (mode === "grep") {
    result = await handleGrep(toolCallId, params, cwd, signal);
    return parseGrepCandidates(result, "structural");
  }
  const { loadSearchConfig } = await import("./config.js");
  const config = loadSearchConfig(cwd);
  const enrich =
    config.enrich?.code?.symbols !== false || config.enrich?.code?.callers !== false;
  result = await handleCode(toolCallId, params, cwd, signal, enrich);
  const text = extractTextFromToolResult(result);
  return parseCodeCandidates(text, "structural");
}
