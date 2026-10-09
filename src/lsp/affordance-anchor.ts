/**
 * Declaration-anchor resolver — Lane P WP-A foundation.
 *
 * Stateless `{ symbol, path? }` → position resolution over strict LSP
 * envelopes only. Mechanism borrows B7/B8 are mechanism-only.
 *
 * Fail-closed rules (reviewer-confirmed):
 * - Dispatch positions come ONLY from a genuine `DocumentSymbol`
 *   `selectionRange` (`selectionProvenance === "explicit"`). Collapsed
 *   `SymbolInformation` ranges and provenance-less legacy shapes are
 *   unusable and yield `anchor_search_incomplete`, never a dispatch.
 * - Pathless `workspaceSymbols` results are discovery, never enumeration:
 *   even zero or one candidate returns `not_ready` /
 *   `anchor_search_incomplete` with a path-qualified retry — never a
 *   workspace-wide `anchor_not_found`, never auto-dispatch.
 * - Explicit paths are validated (existing regular file, canonicalized
 *   via realpath) BEFORE any server request; violations yield
 *   `anchor_invalid_path`, distinct from file-scoped `anchor_not_found`.
 * - Name matching is declaration-only exact (case-sensitive) on the name
 *   or `/`-separated hierarchy with JSON Pointer segment escapes
 *   (`~1` → `/`, `~0` → `~`). No fuzzy or prefix matching.
 * - Staleness is within-request only: a `stale` freshness on the lookup
 *   envelope yields `stale_anchor`. The carried envelope proves freshness
 *   at resolution time; the dispatching recipe (WP-A2) must re-check
 *   before dispatch.
 */
import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import {
  AFFORDANCE_BOUNDS,
  type AffordanceExecContext,
  type AffordanceSymbolTarget,
  type AnchorCandidate,
  type AnchorResolution,
} from "./affordance-contract.js";
import { executeLspOperation, type ExecutorDeps } from "./lsp-executor.js";
import type { NormalizedDocumentSymbol } from "./lsp-response-normalizer.js";
import type { StrictEnvelope } from "./lsp-strict-contract.js";

type ProvenanceSymbol = NormalizedDocumentSymbol & {
  selectionProvenance?: "explicit" | "collapsed";
};

function execOf(ctx: AffordanceExecContext): (req: unknown, deps?: ExecutorDeps) => Promise<StrictEnvelope> {
  return ctx.exec ?? ((req, deps) => executeLspOperation(req, deps));
}

interface UnresolvedParams {
  status: "ok" | "empty" | "unsupported" | "unavailable" | "not_ready" | "timeout" | "cancelled" | "error" | "ambiguous";
  code: string;
  message: string;
  candidates?: AnchorCandidate[];
  envelopes?: StrictEnvelope[];
  retry?: string;
}

function unresolved(p: UnresolvedParams): AnchorResolution {
  return {
    kind: "unresolved",
    status: p.status,
    code: p.code,
    message: p.message,
    candidates: p.candidates ?? [],
    envelopes: p.envelopes ?? [],
    ...(p.retry ? { retry: p.retry } : {}),
  };
}

/** Split a `/`-separated hierarchy, unescaping JSON Pointer escapes per segment. */
function splitSymbolPath(symbol: string): string[] | null {
  if (symbol.length === 0) return null;
  const segments = symbol.split("/").map((segment) => {
    if (segment.length === 0 || !/^(?:[^~]|~[01])*$/.test(segment)) return null;
    return segment.replace(/~1/g, "/").replace(/~0/g, "~");
  });
  if (segments.some((s) => s === null || (s as string).length === 0)) return null;
  return segments as string[];
}

interface Match {
  symbol: ProvenanceSymbol;
  namePath: string;
}

function collectMatches(symbols: ProvenanceSymbol[], segments: string[]): { matches: Match[]; hasUnusable: boolean } {
  const matches: Match[] = [];
  let hasUnusable = false;
  const last = segments[segments.length - 1]!;
  const visit = (entries: ProvenanceSymbol[], ancestors: string[]): void => {
    for (const entry of entries) {
      const usable = entry.selectionProvenance === "explicit";
      if (entry.name === last && ancestors.join("/") === segments.slice(0, -1).join("/")) {
        if (usable) matches.push({ symbol: entry, namePath: [...ancestors, entry.name].join("/") });
        else hasUnusable = true;
      }
      if (Array.isArray(entry.children)) {
        visit(entry.children as ProvenanceSymbol[], [...ancestors, entry.name]);
      }
    }
  };
  // Single-segment symbols match at any depth; multi-segment hierarchies
  // match the full ancestor chain exactly.
  if (segments.length === 1) {
    const visitAny = (entries: ProvenanceSymbol[]): void => {
      for (const entry of entries) {
        if (entry.name === last) {
          if (entry.selectionProvenance === "explicit") matches.push({ symbol: entry, namePath: entry.name });
          else hasUnusable = true;
        }
        if (Array.isArray(entry.children)) visitAny(entry.children as ProvenanceSymbol[]);
      }
    };
    visitAny(symbols);
  } else {
    visit(symbols, []);
  }
  return { matches, hasUnusable };
}

function candidateName(m: Match): string {
  return m.namePath;
}

function uriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/**
 * Resolve a declaration-name anchor to a dispatch position.
 *
 * Only `{ symbol, path? }` targets are accepted: `{ path, position }`
 * targets need no resolution and dispatch directly via
 * `executeLspOperation` (caller error here). Malformed targets throw —
 * the strict tool-error path, never a status.
 */
export async function resolveAffordanceAnchor(
  target: AffordanceSymbolTarget,
  ctx: AffordanceExecContext,
): Promise<AnchorResolution> {
  if (!target || typeof target !== "object") throw new Error("anchor target must be an object");
  if ("position" in target) {
    throw new Error("position targets need no anchor resolution; dispatch directly via executeLspOperation");
  }
  const symbol = (target as { symbol?: unknown }).symbol;
  if (typeof symbol !== "string" || symbol.length === 0) throw new Error("anchor target requires a non-empty symbol");
  const segments = splitSymbolPath(symbol);
  if (!segments) throw new Error("anchor symbol must be a non-empty name or /-separated hierarchy");

  const budget = {
    maxCandidates: ctx.budget?.maxCandidates ?? AFFORDANCE_BOUNDS.discoveryCandidates,
    maxRequests: ctx.budget?.maxRequests ?? AFFORDANCE_BOUNDS.underlyingRequests,
    deadlineMs: ctx.budget?.deadlineMs ?? AFFORDANCE_BOUNDS.aggregateDeadlineMs,
    signal: ctx.budget?.signal,
  };
  const now = ctx.now ?? Date.now;
  const started = now();
  let requests = 0;
  const exec = execOf(ctx);

  const admitted = (): AnchorResolution | null => {
    if (budget.signal?.aborted) {
      return unresolved({ status: "cancelled", code: "cancelled", message: "anchor resolution cancelled" });
    }
    if (now() - started >= budget.deadlineMs) {
      return unresolved({ status: "timeout", code: "timeout", message: "anchor resolution deadline exceeded" });
    }
    if (requests >= budget.maxRequests) {
      return unresolved({
        status: "error",
        code: "anchor_budget_exceeded",
        message: `anchor request budget exhausted (${budget.maxRequests})`,
      });
    }
    return null;
  };

  const dispatch = async (req: unknown): Promise<StrictEnvelope | AnchorResolution> => {
    const gate = admitted();
    if (gate) return gate;
    requests += 1;
    try {
      return await exec(req, { cwd: ctx.root, signal: budget.signal, includeSymbolProvenance: true });
    } catch (err) {
      // Injected-executor transport failure: truthful error, no envelope to carry.
      return unresolved({
        status: "error",
        code: (err as { code?: string })?.code ?? "error",
        message: `anchor lookup transport failure: ${String((err as Error)?.message ?? err)}`,
      });
    }
  };

  const rawPath = (target as { path?: unknown }).path;
  if (rawPath !== undefined) {
    if (typeof rawPath !== "string" || rawPath.length === 0) throw new Error("anchor path must be a non-empty string");
    // Explicit target validation BEFORE any server request: the path must
    // exist and be a regular file, canonicalized via realpath, and the
    // canonical path is what gets dispatched — so validation and the server
    // request share one identity and a symlink alias cannot retarget between
    // them. realpath failure is fail-closed (`anchor_invalid_path`), never a
    // fallback to the unvalidated path.
    //
    // Scope note: explicit files follow strict executor semantics
    // (`lsp-executor.ts` `resolve(workspace ?? cwd, path)`): the path is
    // resolved against the effective workspace (`ctx.workspace` when supplied,
    // else `ctx.root`), and absolute or `../` targets outside that root remain
    // valid when the exact server can serve them — there is no root jail here.
    // Pathless `workspaceSymbols` discovery stays workspace-bounded, and the
    // future `investigate` `scope` filter remains root-scoped (WP-A2).
    const effectiveRoot = ctx.workspace ? resolvePath(ctx.workspace) : ctx.root;
    const abs = resolvePath(effectiveRoot, rawPath);
    let canonical: string;
    try {
      const st = statSync(abs);
      if (!st.isFile()) {
        return unresolved({
          status: "error",
          code: "anchor_invalid_path",
          message: `anchor path is not a regular file: ${rawPath}`,
        });
      }
      canonical = realpathSync(abs);
      // Re-validate the canonical target: the alias may resolve to a
      // non-file, or realpath may have failed (throws below → invalid path).
      if (!statSync(canonical).isFile()) {
        return unresolved({
          status: "error",
          code: "anchor_invalid_path",
          message: `anchor path canonical target is not a regular file: ${rawPath}`,
        });
      }
    } catch {
      return unresolved({
        status: "error",
        code: "anchor_invalid_path",
        message: `anchor path does not exist or is inaccessible: ${rawPath}`,
      });
    }

    const outcome = await dispatch({
      operation: "documentSymbols",
      ...(ctx.workspace ? { workspace: ctx.workspace } : {}),
      ...(ctx.server ? { server: ctx.server } : {}),
      path: canonical,
    });
    if ((outcome as AnchorResolution).kind === "unresolved") return outcome as AnchorResolution;
    const envelope = outcome as StrictEnvelope;
    if (envelope.status !== "ok" && envelope.status !== "empty") {
      return unresolved({
        status: envelope.status,
        code: envelope.error?.code ?? envelope.status,
        message: envelope.error?.message ?? `anchor lookup ${envelope.status}`,
        envelopes: [envelope],
      });
    }
    if (envelope.meta?.freshness?.state === "stale") {
      return unresolved({
        status: "error",
        code: "stale_anchor",
        message: "anchor source changed during resolution; re-read and retry",
        envelopes: [envelope],
      });
    }
    if (!Array.isArray(envelope.result)) {
      return unresolved({
        status: "not_ready",
        code: "anchor_search_incomplete",
        message: "anchor lookup returned an unusable outline; retry with a refreshed document",
        envelopes: [envelope],
      });
    }
    const { matches, hasUnusable } = collectMatches(envelope.result as ProvenanceSymbol[], segments);
    if (matches.length === 0) {
      if (hasUnusable) {
        return unresolved({
          status: "not_ready",
          code: "anchor_search_incomplete",
          message: "matching declarations lack genuine identifier selection provenance; cannot anchor",
          envelopes: [envelope],
          retry: `re-issue with an explicit path whose outline carries DocumentSymbol selectionRange`,
        });
      }
      return unresolved({
        status: "error",
        code: "anchor_not_found",
        message: `no declaration named "${symbol}" in ${rawPath}`,
        envelopes: [envelope],
      });
    }
    if (matches.length > 1) {
      const candidates: AnchorCandidate[] = matches
        .slice(0, AFFORDANCE_BOUNDS.ambiguityCandidates)
        .map((m) => ({ path: canonical, name: candidateName(m) }));
      return unresolved({
        status: "ambiguous",
        code: "ambiguous_anchor",
        message: `${matches.length} declarations named "${symbol}" in ${rawPath}; qualify with a hierarchy path`,
        candidates,
        envelopes: [envelope],
        retry: `re-issue with symbol "<Parent>/${symbol}" and path "${rawPath}"`,
      });
    }
    const match = matches[0]!;
    return {
      kind: "resolved",
      path: canonical,
      position: {
        line: match.symbol.selectionRange.start.line,
        character: match.symbol.selectionRange.start.character,
      },
      server: envelope.server,
      resolutionEnvelope: envelope,
    };
  }

  // Pathless: discovery only. The query is the final hierarchy segment;
  // completeness is unprovable (no enumeration signal in workspace/symbol,
  // single-server fanout envelope), so this branch never resolves.
  const query = segments[segments.length - 1]!;
  const outcome = await dispatch({
    operation: "workspaceSymbols",
    ...(ctx.workspace ? { workspace: ctx.workspace } : {}),
    ...(ctx.server ? { server: ctx.server } : {}),
    query,
  });
  if ((outcome as AnchorResolution).kind === "unresolved") return outcome as AnchorResolution;
  const envelope = outcome as StrictEnvelope;
  if (envelope.status !== "ok" && envelope.status !== "empty") {
    return unresolved({
      status: envelope.status,
      code: envelope.error?.code ?? envelope.status,
      message: envelope.error?.message ?? `anchor discovery ${envelope.status}`,
      envelopes: [envelope],
    });
  }
  const raw = Array.isArray(envelope.result) ? (envelope.result as ProvenanceSymbol[]) : null;
  if (!raw) {
    return unresolved({
      status: "not_ready",
      code: "anchor_search_incomplete",
      message: "anchor discovery returned an unusable result; retry with an explicit path",
      envelopes: [envelope],
      retry: "re-issue with symbol and path from a known candidate",
    });
  }
  const candidates: AnchorCandidate[] = [];
  for (const entry of raw) {
    if (candidates.length >= Math.min(budget.maxCandidates, AFFORDANCE_BOUNDS.discoveryCandidates)) break;
    if (typeof entry?.name !== "string") continue;
    const uri = (entry as { uri?: unknown }).uri;
    const p = typeof uri === "string" ? uriToPath(uri) : null;
    if (!p) continue;
    candidates.push({ path: p, name: entry.name });
  }
  return unresolved({
    status: "not_ready",
    code: "anchor_search_incomplete",
    message:
      raw.length === 0
        ? `anchor discovery found no candidates for "${symbol}"; absence is unproven — retry with an explicit path`
        : `anchor discovery for "${symbol}" is incomplete by construction; re-issue with an explicit path`,
    candidates,
    envelopes: [envelope],
    retry: candidates.length > 0
      ? `re-issue with symbol "${symbol}" and path "${candidates[0]!.path}"`
      : "re-issue with symbol and path from a known candidate",
  });
}
