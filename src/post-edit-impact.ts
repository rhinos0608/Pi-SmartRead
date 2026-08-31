/**
 * Post-edit impact summary (advisory, additive UX only).
 *
 * Appended to successful write/edit tool_results when context-graph data
 * exists. Never blocks or gates mutations. Bounded, best-effort, never throws.
 */

import { resolve, relative } from "node:path";
import { computeImpact } from "./impact-analysis.js";
import { getSharedContextGraphIfBuilt } from "./mcp-registry.js";

export interface PostEditImpactEvent {
  toolName: string;
  isError?: boolean;
  input?: { path?: unknown; [key: string]: unknown };
  details?: { changedResources?: unknown; [key: string]: unknown };
  content?: unknown[];
  cwd?: string;
}

export interface PostEditImpactResult {
  content: unknown[];
}

export interface PostEditImpactOptions {
  /** Max time for graph lookup + impact computation, ms. Default 800. */
  timeoutMs?: number;
  /** Max related files to list explicitly. Default 5. */
  maxFiles?: number;
  /** Override for computeImpact (tests). */
  computeImpactFn?: typeof computeImpact;
  /** Override for graph lookup (tests). */
  getGraph?: (cwd: string) => unknown;
}

const DEFAULT_TIMEOUT_MS = 800;
const DEFAULT_MAX_FILES = 5;

export function formatImpactBlock(files: string[], totalCount: number, cwd: string, maxFiles: number = DEFAULT_MAX_FILES): string | undefined {
  if (files.length === 0 && totalCount === 0) return undefined;
  // Display relative to cwd when possible, else basename-ish absolute.
  const display = files.map((f) => {
    try {
      const rel = relative(cwd, f);
      if (rel && !rel.startsWith("..")) return rel;
      // Also try resolving relative if already absolute mismatch
      return rel || f;
    } catch {
      return f;
    }
  });
  const shown = display.slice(0, maxFiles);
  const remaining = totalCount - shown.length;
  const list = shown.join(", ");
  const more = remaining > 0 ? ` (+${remaining} more)` : "";
  return `[Possibly affected: ${list}${more} — advisory, based on prior graph data]`;
}

function changedPathsFromDetails(details: unknown): string[] {
  if (!details || typeof details !== "object") return [];
  const changedResources = (details as Record<string, unknown>).changedResources;
  if (!Array.isArray(changedResources)) return [];
  const paths: string[] = [];
  for (const res of changedResources) {
    if (!res || typeof res !== "object") continue;
    const cp = (res as Record<string, unknown>).canonicalPath;
    if (typeof cp === "string" && cp.length > 0) paths.push(cp);
  }
  return paths;
}

export async function runPostEditImpactSummary(
  event: PostEditImpactEvent,
  opts: PostEditImpactOptions = {},
): Promise<PostEditImpactResult | undefined> {
  try {
    if (event.isError) return undefined;
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

    // Resolve target paths: changedResources canonicalPath is authoritative for edit; fallback to input.path for write/single-file edit.
    const changedPaths = changedPathsFromDetails(event.details);
    let rawPaths: string[] = [];
    if (event.toolName === "edit") {
      if (changedPaths.length > 0) rawPaths = changedPaths.slice(0, 2);
      else {
        const rawPath = event.input?.path;
        if (typeof rawPath === "string" && rawPath) rawPaths = [rawPath];
        else return undefined;
      }
    } else {
      // write: check changedResources first for consistency, then input.path
      if (changedPaths.length > 0) rawPaths = changedPaths.slice(0, 2);
      else {
        const rawPath = event.input?.path;
        if (typeof rawPath === "string" && rawPath) rawPaths = [rawPath];
        else return undefined;
      }
    }

    const cwd = event.cwd ?? process.cwd();
    const resolvedPaths = rawPaths.map((p) => resolve(cwd, p));

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;

    const getGraph = opts.getGraph ?? ((root: string) => getSharedContextGraphIfBuilt(root) as unknown);
    const graph = getGraph(cwd) as any;
    if (!graph) return undefined;

    const impactFn = opts.computeImpactFn ?? computeImpact;

    // Run computeImpact for each target concurrently sharing a single total budget (don't multiply per file).
    const allImpactsPromise = Promise.all(
      resolvedPaths.map((targetFile) =>
        impactFn({ targetFile, contextGraph: graph, workspaceRoot: cwd, maxDepth: 3 }).catch(() => undefined),
      ),
    );

    let results: (Awaited<ReturnType<typeof computeImpact>> | undefined)[] | undefined;
    try {
      results = (await Promise.race([
        allImpactsPromise,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
      ])) as any;
    } catch {
      return undefined;
    }

    if (!results) return undefined;
    // Merge/dedupe affectedFiles across targets, preserving order.
    const seen = new Set<string>();
    const mergedPaths: string[] = [];
    for (const r of results) {
      if (!r) continue;
      const affected = r.affectedFiles ?? [];
      for (const f of affected) {
        if (!seen.has(f.path)) {
          seen.add(f.path);
          mergedPaths.push(f.path);
        }
      }
    }
    if (mergedPaths.length === 0) return undefined;

    const sortedPaths = mergedPaths;
    const totalCount = sortedPaths.length;

    const block = formatImpactBlock(sortedPaths, totalCount, cwd, maxFiles);
    if (!block) return undefined;

    const originalContent = Array.isArray(event.content) ? event.content : [];
    return { content: [...originalContent, { type: "text", text: block }] };
  } catch {
    return undefined;
  }
}
