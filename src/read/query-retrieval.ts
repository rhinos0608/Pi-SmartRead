import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { canonicalPath, canonicalRelative } from "../workspace/workspace-boundary.js";
import { handleCode, handleGrep } from "../search/search-tool.js";
import { pathPrefixForDirectory } from "../indexing/semantic-index.js";
import { getSemanticIndex } from "../indexing/semantic-index-registry.js";
import { persistentIndexChannel, runQueryChannels } from "../retrieval/runner.js";
import type { ChannelContext } from "../retrieval/types.js";

export interface QueryRetrievalHit {
  absolutePath: string;
  relativePath: string;
  lineStart: number;
  lineEnd: number;
  name: string;
  kind: string;
  snippet: string;
  score?: number;
}

export type QueryRetrievalResult =
  | { strategy: "hybrid"; hits: QueryRetrievalHit[] }
  | { strategy: "fallback"; reason: "unavailable" | "error"; hits: QueryRetrievalHit[] };

interface FallbackMatch {
  file?: unknown;
  relFile?: unknown;
  line?: unknown;
  endLine?: unknown;
  name?: unknown;
  kind?: unknown;
  snippet?: unknown;
  body?: unknown;
}

export interface RetrieveQueryOptions {
  query: string;
  cwd: string;
  directory?: string;
  topK?: number;
  signal?: AbortSignal;
  toolCallId?: string;
}

function canonicalFile(path: string): string | null {
  try {
    const canonical = canonicalPath(path);
    if (!canonical) return null;
    return statSync(canonical).isFile() ? canonical : null;
  } catch {
    return null;
  }
}

/**
 * Direct canonical resolver for explicit directories. No allowed-root gate:
 * external directories are allowed (permission is handled externally). Must
 * be a real directory; throws if not.
 */
function resolveExplicitDirectory(cwd: string, requested: string | undefined): string {
  const raw = requested?.trim() ? requested.trim() : ".";
  const absolute = resolve(cwd, raw);
  const stat = statSync(absolute);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${raw}`);
  }
  return canonicalPath(absolute) ?? absolute;
}

export async function retrieveQuery(options: RetrieveQueryOptions): Promise<QueryRetrievalResult> {
  const query = options.query.trim();
  if (!query) throw new Error("query must not be empty or whitespace-only");
  // Single-flavor canonicalization: the index registry keys on canonicalPath
  // (native-first), so lookup roots must use the same flavor or short/long
  // mismatches make relative() escape and force fallback.
  const cwd = canonicalPath(options.cwd) ?? resolve(options.cwd);
  const topK = Math.max(1, Math.min(100, Math.trunc(options.topK ?? 20)));

  // Resolve search directory — no allowed-root gating; external directories allowed.
  const searchDirectory = resolveExplicitDirectory(cwd, options.directory);

  // Use nearest registered semantic index containing searchDirectory.
  const semanticIndex = getSemanticIndex(searchDirectory);

  if (semanticIndex?.isAvailable()) {
    try {
      const prefix = pathPrefixForDirectory(semanticIndex.root, searchDirectory);
      // P2 kernel route: single minimal indexChannel (queries the resolved
      // index directly — no discovery, no intent_read) fanned out through the
      // generic runner. Hit mapping/filtering below is unchanged.
      const channel = persistentIndexChannel(semanticIndex, { topK, pathPrefix: prefix });
      const channelContext: ChannelContext = {
        query,
        cwd,
        signal: options.signal,
        // The index channel never touches ExtensionContext (no discovery,
        // no intent_read); the field is required by the shared kernel type.
        ctx: undefined as never,
        discoveredFiles: [],
        seedFiles: [],
        maxResults: topK,
        limit: topK,
        depth: "standard",
      };
      const { candidates, degraded } = await runQueryChannels([channel], channelContext);
      if (degraded.length > 0) {
        return runFallback(query, cwd, searchDirectory, topK, options, "error");
      }
      return {
        strategy: "hybrid",
        hits: candidates.flatMap((candidate) => {
          const absolutePath = canonicalFile(candidate.file);
          if (!absolutePath) return [];
          // Filter to searchDirectory scope
          const relToSearchDir = canonicalRelative(searchDirectory, absolutePath);
          if (relToSearchDir.startsWith("..") || isAbsolute(relToSearchDir)) return [];
          return [{
            absolutePath,
            relativePath: relative(cwd, absolutePath).replace(/\\/g, "/"),
            lineStart: candidate.line ?? 1,
            lineEnd: candidate.endLine ?? candidate.line ?? 1,
            name: candidate.name,
            kind: candidate.kind,
            snippet: candidate.snippet,
            score: candidate.rawScore,
          }];
        }),
      };
    } catch {
      return runFallback(query, cwd, searchDirectory, topK, options, "error");
    }
  }

  return runFallback(query, cwd, searchDirectory, topK, options, "unavailable");
}

async function runFallback(
  query: string,
  cwd: string,
  searchDirectory: string,
  topK: number,
  options: RetrieveQueryOptions,
  reason: "unavailable" | "error",
): Promise<QueryRetrievalResult> {
  const toolCallId = options.toolCallId ?? `query-fallback:${query}`;
  const params = { query, matchMode: "literal", maxResults: Math.max(topK * 3, topK) } as never;
  const [grepResult, codeResult] = await Promise.all([
    handleGrep(toolCallId, params, searchDirectory, options.signal),
    handleCode(toolCallId, params, searchDirectory, options.signal, false),
  ]);
  const matches: FallbackMatch[] = [
    ...((((grepResult.details as Record<string, unknown> | undefined)?.matches) as FallbackMatch[] | undefined) ?? []),
    ...((((codeResult.details as Record<string, unknown> | undefined)?.matches) as FallbackMatch[] | undefined) ?? []),
  ];

  const seen = new Set<string>();
  const hits: QueryRetrievalHit[] = [];
  for (const match of matches) {
    if (typeof match.file !== "string") continue;
    const candidate = isAbsolute(match.file) ? match.file : resolve(searchDirectory, match.file);
    const absolutePath = canonicalFile(candidate);
    if (!absolutePath || seen.has(absolutePath)) continue;
    // Filter fallback hits to those actually under the requested searchDirectory
    // (the underlying tools can return matches from registered/ancestor roots).
    const relToSearchDir = canonicalRelative(searchDirectory, absolutePath);
    if (relToSearchDir.startsWith("..") || isAbsolute(relToSearchDir)) continue;
    seen.add(absolutePath);
    const lineStart = typeof match.line === "number" ? Math.max(1, Math.trunc(match.line)) : 1;
    const lineEnd = typeof match.endLine === "number" ? Math.max(lineStart, Math.trunc(match.endLine)) : lineStart;
    hits.push({
      absolutePath,
      relativePath: relative(cwd, absolutePath).replace(/\\/g, "/"),
      lineStart,
      lineEnd,
      name: typeof match.name === "string" ? match.name : relative(cwd, absolutePath),
      kind: typeof match.kind === "string" ? match.kind : "match",
      snippet: typeof match.snippet === "string" ? match.snippet : typeof match.body === "string" ? match.body : "",
    });
    if (hits.length >= topK) break;
  }
  return { strategy: "fallback", reason, hits };
}
