/**
 * Canonical LSP executor — Wave 4 core.
 *
 * Single semantic seam: validate → route → gate → prepare → issue →
 * normalize → envelope. No model-facing tool registration here.
 * Read-only use of manager/normalizer/broker/tracker/contract/registry.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateStrictRequest,
  classifyStatus,
  type StrictEnvelope,
  type StrictOperation,
  type StrictRequest,
  type StrictServerInfo,
  type StrictMeta,
} from "./lsp-strict-contract.js";
import { getOperationDef } from "./lsp-operation-registry.js";
import { LspAffinity } from "./lsp-affinity.js";
import { LspCursorStore } from "./lsp-cursor-store.js";
import { AmbiguousServerError, detectLanguageFromExtension } from "./lsp-types.js";
import { evaluateRawMethodPolicy } from "./lsp-raw-method-policy.js";
import { sha256OfText } from "./lsp-document-store.js";
import {
  normalizeLocations,
  normalizeDocumentSymbols,
  normalizeHover,
  normalizeCompletions,
  normalizeCodeActions,
  normalizeWorkspaceEdit,
  normalizeTextEdits,
  normalizePrepareRename,
  normalizeSemanticTokens,
  normalizeHierarchyItems,
  normalizeIncomingCalls,
  normalizeOutgoingCalls,
} from "./lsp-response-normalizer.js";

/** Minimal session/connection surface the executor consumes. Real LSPConnection satisfies this. */
export interface ExecutorConnection {
  request(method: string, params: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>;
  prepareDocument?(filePath: string): Promise<void>;
  getCapabilityRegistry?(): { can(feature: string): boolean } | null;
  isSupported?(feature: string, staticKey: string): boolean;
  getNegotiatedEncoding?(): string;
  getDocumentStore?(): {
    get(filePath: string): { version: number; lastHash: string | null } | null;
  };
  getDiagnosticsBroker?(): unknown;
  readiness?(token?: string): { state: string; basis: string };
  getDiagnostics?(filePath: string): Array<{ message: string }>;
  descriptorId?: string;
  name?: string;
  languageId?: string;
  /** Production shape: real LSPConnection exposes plural languageIds. */
  languageIds?: string[];
  projectRoot?: string;
}

export interface ExecutorManager {
  getServer(languageId: string, opts?: Record<string, unknown>): Promise<ExecutorConnection | null>;
  /** Manager-level fanout across live connections (LSPManager.workspaceSymbol queries all). */
  workspaceSymbol?: (query: string) => Promise<unknown>;
}

export interface ExecutorDeps {
  getManager?: (root: string) => ExecutorManager;
  acquire?: (root: string, languageId: string | null, opts: Record<string, unknown>) => Promise<{ conn: ExecutorConnection; key: string | null } | null>;
  release?: (key: string | null) => void;
  affinity?: LspAffinity;
  cursors?: LspCursorStore;
  defaultTimeoutMs?: number;
  now?: () => number;
  cwd?: string;
  signal?: AbortSignal;
}

const sharedCursors = new LspCursorStore();
const sharedAffinity = new LspAffinity();

const FEATURE_TO_STATIC_KEY: Record<string, string> = {
  definition: "definitionProvider",
  references: "referencesProvider",
  documentSymbol: "documentSymbolProvider",
  implementation: "implementationProvider",
  hover: "hoverProvider",
  callHierarchy: "callHierarchyProvider",
  rename: "renameProvider",
  prepareRename: "renameProvider",
  codeAction: "codeActionProvider",
  formatting: "documentFormattingProvider",
  workspaceSymbol: "workspaceSymbolProvider",
  declaration: "declarationProvider",
  typeDefinition: "typeDefinitionProvider",
  diagnostics: "diagnosticProvider",
  workspaceDiagnostics: "diagnosticProvider",
};

const PATH_OPS: ReadonlySet<string> = new Set([
  "goToDefinition", "goToDeclaration", "goToTypeDefinition", "goToImplementation",
  "findReferences", "hover", "documentHighlights", "documentSymbols",
  "prepareCallHierarchy", "prepareTypeHierarchy", "diagnostics", "publishedDiagnostics",
  "prepareRename", "rename", "codeActions", "formatDocument", "formatRange",
  "formatOnType", "completion", "signatureHelp", "inlayHints", "semanticTokens",
  "foldingRanges", "selectionRanges",
]);


const LIST_OPS: ReadonlySet<string> = new Set([
  "goToDefinition", "goToDeclaration", "goToTypeDefinition", "goToImplementation",
  "findReferences", "documentHighlights", "documentSymbols", "workspaceSymbols",
  "prepareCallHierarchy", "prepareTypeHierarchy", "incomingCalls", "outgoingCalls",
  "supertypes", "subtypes", "diagnostics", "workspaceDiagnostics", "publishedDiagnostics",
  "codeActions", "completion",
]);

function connLanguages(c: ExecutorConnection): string[] {
  if (Array.isArray(c.languageIds) && c.languageIds.length > 0) return c.languageIds;
  if (c.languageId) return [c.languageId];
  return [];
}

function provenanceLanguage(conn: ExecutorConnection, languageId: string | null, itemHint?: string | null): string {
  const langs = connLanguages(conn);
  if (itemHint && langs.includes(itemHint)) return itemHint;
  return conn.languageId ?? conn.languageIds?.[0] ?? languageId ?? "unknown";
}

function serverInfo(conn: ExecutorConnection, root: string, languageId: string | null, req: StrictRequest, itemHint?: string | null): StrictServerInfo {
  const enc = (() => {
    try {
      const e = conn.getNegotiatedEncoding?.();
      if (e === "utf-8" || e === "utf-16" || e === "utf-32") return e;
    } catch { /* fall through */ }
    return "utf-16" as const;
  })();
  return {
    descriptorId: conn.descriptorId ?? req.server ?? "unknown",
    name: conn.name ?? conn.descriptorId ?? req.server ?? "unknown",
    languageId: provenanceLanguage(conn, languageId, itemHint),
    projectRoot: conn.projectRoot ?? root,
    positionEncoding: enc,
  };
}

function toUri(path: string): string {
  try {
    if (path.startsWith("file:")) return path;
    return pathToFileURL(path).href;
  } catch {
    return path;
  }
}

function resultMetaForPath(
  conn: ExecutorConnection,
  req: StrictRequest,
  truncated: boolean,
  nextCursor?: string,
): StrictMeta {
  const base: StrictMeta = {
    truncated,
    ...(nextCursor ? { nextCursor } : {}),
  };
  if (!req.path) return base;

  try {
    const state = conn.getDocumentStore?.()?.get(req.path);
    if (!state) return base;
    let freshness: "fresh" | "stale" | "unknown" = "unknown";
    if (state.lastHash) {
      try {
        const current = readFileSync(req.path, "utf-8");
        freshness = sha256OfText(current) === state.lastHash ? "fresh" : "stale";
      } catch {
        freshness = "unknown";
      }
    }
    return {
      ...base,
      documentVersion: state.version,
      freshness: { state: freshness, documentVersion: state.version },
    };
  } catch {
    return base;
  }
}

function isDeadConnection(err: unknown): boolean {
  const e = err as { name?: string; code?: string; message?: string } | null;
  if (!e || typeof e !== "object") return false;
  if (e.name === "LspServerExitError") return true;
  if (e.code === "DEAD_CONNECTION" || e.code === "SERVER_EXIT") return true;
  const msg = String(e.message ?? "");
  return /server exited|dead-connection|process exited/i.test(msg);
}

function isTimeoutError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  if (!e || typeof e !== "object") return false;
  if (e.name === "LspRequestTimeoutError") return true;
  return /timed out after/i.test(String(e.message ?? ""));
}

function isCancelledError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  if (!e || typeof e !== "object") return false;
  return e.name === "AbortError" || e.name === "LspRequestCancelledError" || /cancelled/i.test(String(e.message ?? ""));
}

function isNotReadyError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e || typeof e !== "object") return false;
  if (e.code === "NOT_READY") return true;
  return /not[ _-]?ready|document .* not (open|synced|prepared)/i.test(String(e.message ?? ""));
}

function buildParams(req: StrictRequest): Record<string, unknown> {
  const uri = req.path ? toUri(req.path) : undefined;
  switch (req.operation) {
    case "goToDefinition": case "goToDeclaration": case "goToTypeDefinition":
    case "goToImplementation": case "hover": case "prepareCallHierarchy":
    case "prepareTypeHierarchy": case "prepareRename": case "selectionRanges":
      return { textDocument: { uri }, position: req.position };
    case "findReferences":
      return { textDocument: { uri }, position: req.position, context: { includeDeclaration: req.includeDeclaration ?? false } };
    case "documentHighlights":
      return { textDocument: { uri }, position: req.position };
    case "documentSymbols":
      return { textDocument: { uri } };
    case "workspaceSymbols":
      return { query: req.query };
    case "incomingCalls": case "outgoingCalls": case "supertypes": case "subtypes":
    case "resolveCompletion": case "resolveInlayHint":
      return { item: req.item };
    case "resolveCodeAction":
      return { codeAction: req.codeAction };
    case "rename":
      return { textDocument: { uri }, position: req.position, newName: req.newName };
    case "codeActions":
      return {
        textDocument: { uri },
        range: req.range,
        context: { diagnostics: [], ...(req.context ?? {}) },
      };
    case "formatDocument":
      return { textDocument: { uri }, options: req.formatting ?? { tabSize: 2, insertSpaces: true } };
    case "formatRange":
      return { textDocument: { uri }, range: req.range, options: req.formatting ?? { tabSize: 2, insertSpaces: true } };
    case "formatOnType":
      return { textDocument: { uri }, position: req.position, options: req.formatting ?? { tabSize: 2, insertSpaces: true } };
    case "completion": case "signatureHelp":
      return { textDocument: { uri }, position: req.position, context: req.context };
    case "inlayHints":
      return { textDocument: { uri }, range: req.range };
    case "semanticTokens":
      return req.range ? { textDocument: { uri }, range: req.range } : { textDocument: { uri } };
    case "foldingRanges":
      return { textDocument: { uri } };
    case "diagnostics":
      return { textDocument: { uri } };
    case "workspaceDiagnostics":
      return req.identifier ? { identifier: req.identifier } : {};
    case "request":
      return { ...(req.params ?? {}) };
    default:
      return {};
  }
}

function normalizeByOp(op: StrictOperation, raw: unknown): { value: unknown; malformed: boolean } {
  switch (op) {
    case "goToDefinition": case "goToDeclaration": case "goToTypeDefinition":
    case "goToImplementation": case "findReferences": case "documentHighlights": {
      const v = normalizeLocations(raw);
      return v === null ? { value: null, malformed: true } : { value: v, malformed: false };
    }
    case "hover": {
      if (raw === null || raw === undefined) return { value: null, malformed: false };
      const v = normalizeHover(raw);
      return v === null ? { value: null, malformed: true } : { value: v, malformed: false };
    }
    case "documentSymbols": case "workspaceSymbols": {
      const v = normalizeDocumentSymbols(raw);
      return v === null ? { value: null, malformed: true } : { value: v, malformed: false };
    }
    case "prepareCallHierarchy": case "prepareTypeHierarchy": {
      const v = normalizeHierarchyItems(raw);
      return v === null ? { value: null, malformed: true } : { value: v, malformed: false };
    }
    case "incomingCalls": {
      const v = normalizeIncomingCalls(raw);
      return v === null ? { value: null, malformed: true } : { value: v, malformed: false };
    }
    case "outgoingCalls": {
      const v = normalizeOutgoingCalls(raw);
      return v === null ? { value: null, malformed: true } : { value: v, malformed: false };
    }
    case "supertypes": case "subtypes": {
      // Type-hierarchy continuations share the call-hierarchy item wire shape.
      const v = normalizeHierarchyItems(raw);
      return v === null ? { value: null, malformed: true } : { value: v, malformed: false };
    }
    case "codeActions": {
      const v = normalizeCodeActions(raw);
      return v === null ? { value: null, malformed: true } : { value: v, malformed: false };
    }
    case "rename": {
      if (raw === null || raw === undefined) return { value: null, malformed: false };
      const v = normalizeWorkspaceEdit(raw);
      return v === null ? { value: null, malformed: true } : { value: v, malformed: false };
    }
    case "formatDocument": case "formatRange": case "formatOnType": {
      if (raw === null || raw === undefined) return { value: null, malformed: false };
      const v = normalizeTextEdits(raw);
      return v === null ? { value: null, malformed: true } : { value: v, malformed: false };
    }
    case "prepareRename": {
      if (raw === null || raw === undefined) return { value: null, malformed: false };
      const v = normalizePrepareRename(raw);
      return v === null ? { value: null, malformed: true } : { value: v, malformed: false };
    }
    case "completion": {
      if (raw === null || raw === undefined) return { value: null, malformed: false };
      const v = normalizeCompletions(raw);
      return v === null ? { value: null, malformed: true } : { value: v, malformed: false };
    }
    case "semanticTokens": {
      if (raw === null || raw === undefined) return { value: null, malformed: false };
      const v = normalizeSemanticTokens(raw);
      return v === null ? { value: null, malformed: true } : { value: v, malformed: false };
    }
    case "request":
      return { value: raw ?? null, malformed: false };
    default:
      return { value: raw ?? null, malformed: false };
  }
}

const RAW_MAX_DEPTH = 20;
const RAW_MAX_BYTES = 1024 * 1024;
const RAW_TRUNCATION_MARKER = "[truncated]";

// Raw-output bounds, enforced BEFORE the envelope is built:
// - depth-prune is shape-preserving-with-markers (deeper levels become
//   "[truncated]", envelope stays success with meta.truncated=true);
// - byte-exceed is an error (returning silently truncated raw JSON would be
//   a lie about server data, so it becomes an error envelope instead).
function boundRawResult(value: unknown): { value: unknown; truncated: boolean } {
  let truncated = false;
  const seen = new Set<object>();
  const prune = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v;
    if (typeof v !== "object") return v;
    if (depth >= RAW_MAX_DEPTH) { truncated = true; return RAW_TRUNCATION_MARKER; }
    const obj = v as Record<string, unknown>;
    if (seen.has(obj)) { truncated = true; return RAW_TRUNCATION_MARKER; }
    seen.add(obj);
    try {
      if (Array.isArray(v)) return (v as unknown[]).map((item) => prune(item, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(obj)) out[k] = prune(item, depth + 1);
      return out;
    } finally {
      seen.delete(obj);
    }
  };
  return { value: prune(value, 0), truncated };
}

function rawByteSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") {
    const r = v as Record<string, unknown>;
    if (Array.isArray(r.items)) return r.items.length === 0;
    if (Array.isArray(r.contents)) return r.contents.length === 0;
    if (Array.isArray(r.changes)) return r.changes.length === 0;
  }
  return false;
}

async function defaultAcquire(
  deps: ExecutorDeps,
  root: string,
  languageId: string | null,
  opts: Record<string, unknown>,
): Promise<{ conn: ExecutorConnection; key: string | null } | null> {
  // P1 null-language guard: unknown-extension / pathless must never reach injected acquire.
  if (!languageId) return null;
  if (deps.acquire) return deps.acquire(root, languageId, opts);
  const getManager = deps.getManager;
  if (getManager) {
    const mgr = getManager(root);
    const conn = await mgr.getServer(languageId, opts);
    if (!conn) return null;
    return { conn, key: null };
  }

  // Production default: strict requests acquire a leased, fingerprinted
  // session. Callers should not need to inject the manager just to make the
  // canonical executor usable.
  const { acquireSession } = await import("./lsp-manager.js");
  const acquired = await acquireSession(root, languageId, opts);
  return acquired ? { conn: acquired.conn, key: acquired.key } : null;
}

/**
 * Server-direct lookup for pathless ops with an explicit `server`: scans the
 * root's live sessions (sessionStore) by descriptorId-or-name across languages.
 * Skips closed connections (a closed match is unusable → unavailable, never a
 * transport-error). Returns the session KEY with an acquired lease — the
 * caller must release it in a finally, like the normal path, so the reaper
 * cannot kill the selection mid-request. Else null (→ unavailable). Never
 * spawns: with no language there is no session identity to construct, so none
 * is invented.
 */
async function acquireByServerId(root: string, server: string): Promise<{ conn: ExecutorConnection; key: string } | null> {
  const [{ sessionStore, acquireLease }, { canonicalProjectRoot }] = await Promise.all([
    import("./lsp-manager.js"),
    import("./lsp-session-key.js"),
  ]);
  const canonical = canonicalProjectRoot(root);
  const matches: Array<{ conn: ExecutorConnection; key: string }> = [];
  for (const [key, e] of sessionStore) {
    if (e.root !== canonical) continue;
    if ((e.conn as unknown as { closed?: boolean }).closed) continue;
    const c = e.conn as unknown as ExecutorConnection;
    if (e.descriptorId === server || c.descriptorId === server) {
      matches.push({ conn: c, key });
    }
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new AmbiguousServerError(server, matches.map((m) => m.key));
  const selected = matches[0]!;
  acquireLease(selected.key);
  return selected;
}

/**
 * Advisory live-only lookup by language hint (caller-provided item.uri).
 * Reuses a live session only — never spawns. Closed sessions are skipped.
 * Returns the session KEY with an acquired lease; caller must release.
 */
async function acquireLiveByLanguage(root: string, language: string): Promise<{ conn: ExecutorConnection; key: string } | null> {
  const [{ sessionStore, acquireLease }, { canonicalProjectRoot }] = await Promise.all([
    import("./lsp-manager.js"),
    import("./lsp-session-key.js"),
  ]);
  const canonical = canonicalProjectRoot(root);
  for (const [key, e] of sessionStore) {
    if (e.root !== canonical) continue;
    if ((e.conn as unknown as { closed?: boolean }).closed) continue;
    const c = e.conn as unknown as ExecutorConnection;
    if (connLanguages(c).includes(language)) {
      acquireLease(key);
      return { conn: c, key };
    }
  }
  return null;
}

/** Best-effort release of a scan-acquired lease: notify the injected releaser
 * (tests) and decrement the real session store (production). Either may no-op. */
async function releaseScanLease(deps: ExecutorDeps, key: string | null): Promise<void> {
  if (!key) return;
  try { deps.release?.(key); } catch { /* best-effort */ }
  try {
    const { releaseLease } = await import("./lsp-manager.js");
    releaseLease(key);
  } catch { /* best-effort */ }
}

export async function executeLspOperation(req: unknown, deps: ExecutorDeps = {}): Promise<StrictEnvelope> {
  // 1. Caller mistakes throw via normal tool-error path — never a status.
  const validated = validateStrictRequest(req);
  if (!validated.ok) throw new Error(validated.error);
  const parsed = validated.value as StrictRequest;
  const root = resolve(parsed.workspace ?? deps.cwd ?? process.cwd());
  const r: StrictRequest = parsed.path
    ? { ...parsed, path: resolve(root, parsed.path) }
    : parsed;
  const def = getOperationDef(r.operation);
  if (!def) throw new Error(`unknown operation: ${String((r as { operation?: unknown }).operation)}`);

  const cursors = deps.cursors ?? sharedCursors;
  const affinity = deps.affinity ?? sharedAffinity;
  const timeoutMs = r.timeoutMs ?? deps.defaultTimeoutMs ?? 15000;
  const signal = deps.signal;
  // Routing hint: path first, then item uri (hierarchy/resolve ops carry no path).
  // No "typescript" fallback — a null languageId means unroutable except via
  // manager-level fanout (pathless workspaceSymbols) or explicit ambiguity.
  const itemUri = typeof (r as { item?: unknown }).item === "object" && (r as { item?: unknown }).item !== null
    ? ((): string | null => {
      const u = ((r as unknown as { item: Record<string, unknown> }).item.uri ?? (r as unknown as { item: Record<string, unknown> }).item.targetUri) as unknown;
      return typeof u === "string" ? u : null;
    })()
    : null;
  // Session identity comes from the path ONLY. item.uri is advisory (a hint
  // for live-only reuse); it must never feed generic acquisition, or a
  // caller-provided URI could spawn a process for a spoofed extension.
  const pathLang = r.path ? (detectLanguageFromExtension(r.path) ?? null) : null;
  const itemHint = itemUri ? (detectLanguageFromExtension(itemUri) ?? null) : null;
  const languageId = pathLang;
  const scopeKey = `${root}::${languageId ?? "workspace"}`;
  const method = def.method ?? (r.operation === "request" ? (r.method as string) : `local/${r.operation}`);

  // request escape hatch: fail-closed raw policy is a caller error (read-only boundary).
  if (r.operation === "request") {
    const rawPolicy = evaluateRawMethodPolicy(r.method, r.params ?? {});
    if (!rawPolicy.allowed) {
      throw new Error(`raw method not allowed: ${r.method} (${rawPolicy.reason})`);
    }
  }

  // 3. Routing with lease.
  let conn: ExecutorConnection | null = null;
  let leaseKey: string | null = null;
  const sessionOpts: Record<string, unknown> = {
    purpose: "request",
    allowInstall: false,
    ...(r.server ? { descriptorId: r.server } : {}),
  };
  try {
    if (signal?.aborted) {
      // Cancellation wins before any wire work. Pre-acquisition: no server was selected, so provenance is ALWAYS unknown.
      const info: StrictServerInfo = {
        descriptorId: "unknown",
        name: "unknown",
        languageId: languageId ?? "unknown",
        projectRoot: root,
        positionEncoding: "utf-16",
      };
      return {
        status: classifyStatus({ kind: "cancelled" }),
        operation: r.operation, method, server: info, result: null,
        meta: { truncated: false },
        error: { code: "cancelled", message: "Aborted" },
      };
    }
    // Pathless branch FIRST: generic acquisition (which may spawn or throw)
    // must never run before pathless routing. With no path there is no
    // session identity, so no acquire call happens on this branch at all.
    if (!r.path) {
      if (r.server) {
        // Explicit-server live scan (leased). Never spawns: miss → unavailable.
        let found: { conn: ExecutorConnection; key: string } | null = null;
        try {
          found = await acquireByServerId(root, r.server);
        } catch (err) {
          if (err instanceof AmbiguousServerError) {
            const info: StrictServerInfo = {
              descriptorId: r.server ?? "unknown",
              name: r.server ?? "unknown",
              languageId: languageId ?? itemHint ?? "unknown",
              projectRoot: root,
              positionEncoding: "utf-16",
            };
            return {
              status: classifyStatus({ kind: "ambiguous" }),
              operation: r.operation,
              method,
              server: info,
              result: null,
              meta: { truncated: false },
              error: { code: "ambiguous", message: err.message },
            };
          }
          throw err;
        }
        if (found) {
          // Explicit server/session identity wins; item.uri is advisory only.
          // On conflict → ambiguous (pick neither); on agreement → proceed.
          if (itemHint && connLanguages(found.conn).length > 0 && !connLanguages(found.conn).includes(itemHint)) {
            await releaseScanLease(deps, found.key);
            const info: StrictServerInfo = {
              descriptorId: r.server ?? "unknown",
              name: r.server ?? "unknown",
              languageId: provenanceLanguage(found.conn, languageId, itemHint),
              projectRoot: root,
              positionEncoding: "utf-16",
            };
            return {
              status: classifyStatus({ kind: "ambiguous" }),
              operation: r.operation,
              method,
              server: info,
              result: null,
              meta: { truncated: false },
              error: {
                code: "ambiguous",
                message: `explicit server ${r.server} (${provenanceLanguage(found.conn, languageId, itemHint)}) conflicts with item.uri hint (${itemHint})`,
              },
            };
          }
          conn = found.conn;
          leaseKey = found.key;
        }
        // miss → unavailable via !conn below (never spawn)
      } else if (itemHint) {
        // Advisory routing: reuse a live session only; caller-provided URIs
        // must not cause process spawning. Miss → unavailable.
        const found = await acquireLiveByLanguage(root, itemHint);
        if (found) {
          conn = found.conn;
          leaseKey = found.key;
        }
      }
    } else try {
      const acquired = await defaultAcquire(deps, root, languageId, sessionOpts);
      if (acquired) {
        conn = acquired.conn;
        leaseKey = acquired.key;
      }
    } catch (err) {
      if (err instanceof AmbiguousServerError) {
        // Affinity is advisory only: consult but never mask ambiguity.
        try {
          affinity.preferred(scopeKey, err.candidates);
        } catch { /* advisory */ }
        const info: StrictServerInfo = {
        descriptorId: "unknown",
        name: "unknown",
        languageId: languageId ?? "unknown",
          projectRoot: root,
          positionEncoding: "utf-16",
        };
        return {
          status: classifyStatus({ kind: "ambiguous" }),
          operation: r.operation,
          method,
          server: info,
          result: null,
          meta: { truncated: false },
          error: { code: "ambiguous", message: String((err as Error).message) },
        };
      }
      // Acquisition escape: any non-ambiguity acquisition failure becomes an
      // `error` envelope (with message). VALIDATION throws stay outside this
      // try and still throw (caller mistakes, not statuses).
      const info: StrictServerInfo = {
        descriptorId: "unknown",
        name: "unknown",
        languageId: languageId ?? "unknown",
        projectRoot: root,
        positionEncoding: "utf-16",
      };
      return {
        status: classifyStatus({ kind: "transport-error" }),
        operation: r.operation,
        method,
        server: info,
        result: null,
        meta: { truncated: false },
        error: { code: (err as { name?: string })?.name ?? "error", message: String((err as Error)?.message ?? err) },
      };
    }
    // Pathless routing: no "typescript" fallback (deleted). Pathless
    // workspaceSymbols fans out at manager level across live connections
    // (LSPManager.workspaceSymbol queries all); pathless workspaceDiagnostics
    // returns ambiguous — the StrictEnvelope carries a single server, so a
    // multi-server pull cannot represent per-server provenance honestly.
    // Explicit-server scan MISS → unavailable via !conn below (never fan out / never ambiguous).
    if (!conn && !languageId && !r.server && (r.operation === "workspaceSymbols" || r.operation === "workspaceDiagnostics")) {
      if (r.operation === "workspaceDiagnostics") {
        const info: StrictServerInfo = {
          descriptorId: "unknown",
          name: "unknown",
          languageId: "unknown",
          projectRoot: root,
          positionEncoding: "utf-16",
        };
        return {
          status: classifyStatus({ kind: "ambiguous" }),
          operation: r.operation,
          method,
          server: info,
          result: null,
          meta: { truncated: false },
          error: { code: "ambiguous", message: "pathless workspaceDiagnostics is ambiguous across servers; pass path or server" },
        };
      }
      try {
        const mgr = deps.getManager
          ? deps.getManager(root)
          : (await import("./lsp-manager.js")).cachedManager(root);
        const fanout = (mgr as ExecutorManager & { workspaceSymbol?: (q: string) => Promise<unknown> }).workspaceSymbol;
        if (typeof fanout === "function") {
          const raw = await fanout.call(mgr, r.query ?? "");
          const { value, malformed } = normalizeByOp(r.operation, raw);
          const info: StrictServerInfo = {
            descriptorId: "unknown",
            name: "unknown",
            languageId: "unknown",
            projectRoot: root,
            positionEncoding: "utf-16",
          };
          if (malformed) {
            return {
              status: classifyStatus({ kind: "transport-error" }),
              operation: r.operation, method, server: info, result: null,
              meta: { truncated: false },
              error: { code: "normalization", message: `malformed ${r.operation} response` },
            };
          }
          if (LIST_OPS.has(r.operation) && Array.isArray(value) && (r.limit !== undefined || r.cursor !== undefined)) {
            const page = paginate(value, r.limit, r.cursor, cursors);
            const empty = page.items.length === 0;
            return {
              status: classifyStatus({ kind: empty ? "success-empty" : "success-value" }),
              operation: r.operation, method, server: info, result: page.items,
              meta: { truncated: page.truncated, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) },
            };
          }
          const empty = isEmptyValue(value);
          return {
            status: classifyStatus({ kind: empty ? "success-empty" : "success-value" }),
            operation: r.operation, method, server: info, result: value,
            meta: { truncated: false },
          };
        }
      } catch (err) {
        const info: StrictServerInfo = {
          descriptorId: "unknown",
          name: "unknown",
          languageId: "unknown",
          projectRoot: root,
          positionEncoding: "utf-16",
        };
        return {
          status: classifyStatus({ kind: "transport-error" }),
          operation: r.operation,
          method,
          server: info,
          result: null,
          meta: { truncated: false },
          error: { code: (err as { name?: string })?.name ?? "error", message: String((err as Error)?.message ?? err) },
        };
      }
    }
    // (Explicit-server and advisory item-hint pathless routing resolved above,
    // before any generic acquisition, with leased scan results. No spawning.)
    if (!conn) {
      const info: StrictServerInfo = {
        descriptorId: "unknown",
        name: "unknown",
        languageId: languageId ?? "unknown",
        projectRoot: root,
        positionEncoding: "utf-16",
      };
      return {
        status: classifyStatus({ kind: "no-session" }),
        operation: r.operation,
        method,
        server: info,
        result: null,
        meta: { truncated: false },
      };
    }
    let info = serverInfo(conn, root, languageId, r, itemHint);

    // Local-only ops: no wire request.
    if (r.operation === "capabilities" || r.operation === "sessionStatus") {
      let payload: unknown;
      if (r.operation === "capabilities") {
        const reg = conn.getCapabilityRegistry?.() ?? null;
        payload = reg && typeof (reg as { snapshot?: unknown }).snapshot === "function"
          ? (reg as unknown as { snapshot(): unknown }).snapshot()
          : { static: [], dynamic: [] };
      } else {
        payload = { root, languageId, descriptorId: info.descriptorId };
      }
      affinity.noteSuccess(scopeKey, info.descriptorId);
      return {
        status: classifyStatus({ kind: "success-value" }),
        operation: r.operation, method, server: info, result: payload,
        meta: { truncated: false },
      };
    }

    // 4. Capability gating (re-checked after any dead-connection reacquire
    // before re-issuing; a server that lost the capability is unsupported).
    const capabilityGate = (c: ExecutorConnection): StrictEnvelope | null => {
      if (!(def.capability && def.capabilityExact)) return null;
      let supported: boolean | null = null;
      try {
        const reg = c.getCapabilityRegistry?.() ?? null;
        if (reg) supported = reg.can(def.capability);
        else if (c.isSupported) supported = c.isSupported(def.capability, FEATURE_TO_STATIC_KEY[def.capability] ?? "");
        else if ((c as unknown as { capabilities?: Record<string, boolean> }).capabilities) {
          supported = ((c as unknown as { capabilities: Record<string, boolean> }).capabilities)[def.capability] !== false;
        }
      } catch { supported = null; }
      if (supported === false) {
        return {
          status: classifyStatus({ kind: "unsupported" }),
          operation: r.operation, method, server: info, result: null,
          meta: { truncated: false },
        };
      }
      return null;
    };
    {
      const gated = capabilityGate(conn);
      if (gated) return gated;
    }

    const runOnce = async (): Promise<StrictEnvelope> => {
      // 5. Document prep for path-bearing ops.
      if (r.path && PATH_OPS.has(r.operation) && conn!.prepareDocument) {
        try {
          await conn!.prepareDocument(r.path);
        } catch (err) {
          if (isNotReadyError(err)) {
            return {
              status: classifyStatus({ kind: "state-missing" }),
              operation: r.operation, method, server: info, result: null,
              meta: { truncated: false },
            };
          }
          throw err;
        }
      }

      // 8. Diagnostics ops via broker.
      if (r.operation === "diagnostics" || r.operation === "workspaceDiagnostics" || r.operation === "publishedDiagnostics") {
        return await runDiagnostics(conn!, r, method, info, cursors, timeoutMs, signal);
      }

      // Wire issue with timeout; cancellation wins.
      const params = buildParams(r);
      const raw = await issueWithTimeout(conn!, method, params, timeoutMs, signal);
      const { value, malformed } = normalizeByOp(r.operation, raw);
      if (malformed) {
        return {
          status: classifyStatus({ kind: "transport-error" }),
          operation: r.operation, method, server: info, result: null,
          meta: { truncated: false },
          error: { code: "normalization", message: `malformed ${r.operation} response` },
        };
      }
      // Raw-output bounds (request op only): depth-prune then byte-cap.
      if (r.operation === "request") {
        const bounded = boundRawResult(value);
        if (rawByteSize(bounded.value) > RAW_MAX_BYTES) {
          return {
            status: classifyStatus({ kind: "transport-error" }),
            operation: r.operation, method, server: info, result: null,
            meta: { truncated: false },
            error: { code: "output-limit", message: "raw result exceeds output limit" },
          };
        }
        if (bounded.truncated) {
          const empty = isEmptyValue(bounded.value);
          affinity.noteSuccess(scopeKey, info.descriptorId);
          return {
            status: classifyStatus({ kind: empty ? "success-empty" : "success-value" }),
            operation: r.operation, method, server: info, result: bounded.value,
            meta: resultMetaForPath(conn!, r, true),
          };
        }
      }
      // Pagination for list results.
      if (LIST_OPS.has(r.operation) && Array.isArray(value) && (r.limit !== undefined || r.cursor !== undefined)) {
        const page = paginate(value, r.limit, r.cursor, cursors);
        const empty = page.items.length === 0;
        affinity.noteSuccess(scopeKey, info.descriptorId);
        return {
          status: classifyStatus({ kind: empty ? "success-empty" : "success-value" }),
          operation: r.operation, method, server: info, result: page.items,
          meta: resultMetaForPath(conn!, r, page.truncated, page.nextCursor),
        };
      }
      const empty = isEmptyValue(value);
      affinity.noteSuccess(scopeKey, info.descriptorId);
      return {
        status: classifyStatus({ kind: empty ? "success-empty" : "success-value" }),
        operation: r.operation, method, server: info, result: value,
        meta: resultMetaForPath(conn!, r, false),
      };
    };

    const classifyFailure = (fail: unknown) => {
      if (isCancelledError(fail) || signal?.aborted) {
        return {
          status: classifyStatus({ kind: "cancelled" as const }),
          operation: r.operation, method, server: info, result: null,
          meta: { truncated: false },
          error: { code: "cancelled", message: String((fail as Error)?.message ?? "cancelled") },
        };
      }
      if (isTimeoutError(fail)) {
        return {
          status: classifyStatus({ kind: "timeout" as const }),
          operation: r.operation, method, server: info, result: null,
          meta: { truncated: false },
          error: { code: "timeout", message: String((fail as Error)?.message ?? "timeout") },
        };
      }
      if (isNotReadyError(fail)) {
        return {
          status: classifyStatus({ kind: "state-missing" as const }),
          operation: r.operation, method, server: info, result: null,
          meta: { truncated: false },
        };
      }
      return {
        status: classifyStatus({ kind: "transport-error" as const }),
        operation: r.operation, method, server: info, result: null,
        meta: { truncated: false },
        error: { code: (fail as { name?: string })?.name ?? "error", message: String((fail as Error)?.message ?? fail) },
      };
    };
    try {
      return await runOnce();
    } catch (err) {
      // Caller mistakes (e.g. invalid cursor) throw via tool-error path, never a status.
      if ((err as Error)?.message === "invalid cursor") throw err;
      // 7. Exactly-once retry: typed dead-connection/process-exit + idempotent reads only.
      // Reacquire a FRESH session (release dead lease, acquire again) before
      // re-issuing; never re-issue on the same dead connection.
      if (def.idempotent && r.operation !== "request" && isDeadConnection(err)) {
        // Drop the dead handle FIRST: a failed reacquire must never leave conn
        // pointing at the dead connection (retries would re-issue on it).
        conn = null;
        try {
          if (leaseKey) {
            try { deps.release?.(leaseKey); } catch { /* best-effort */ }
            try {
              const { releaseLease } = await import("./lsp-manager.js");
              releaseLease(leaseKey);
            } catch { /* best-effort */ }
          }
        } catch { /* release is best-effort */ }
        leaseKey = null;
        try {
          // Pathless dead-retry reuses the resolved pathless mechanism (scan
          // identity), never the generic acquire — which must not run pathless.
          const reacquired = !r.path
            ? (r.server
              ? await acquireByServerId(root, r.server)
              : itemHint
                ? await acquireLiveByLanguage(root, itemHint)
                : null)
            : await defaultAcquire(deps, root, languageId, sessionOpts);
          if (reacquired) {
            conn = reacquired.conn;
            leaseKey = reacquired.key;
            info = serverInfo(conn, root, languageId, r, itemHint);
            // Re-gate capability on the fresh handle before re-issuing:
            // a reacquired server that no longer advertises the capability
            // is unsupported (no request issued on it).
            const gated = capabilityGate(conn);
            if (gated) return gated;
          }
          // Reacquire miss → no session: unavailable (never re-issue; conn
          // stays null so the dead handle cannot be reused below).
          if (!conn) {
            const un: StrictServerInfo = {
              descriptorId: "unknown",
              name: "unknown",
              languageId: languageId ?? "unknown",
              projectRoot: root,
              positionEncoding: "utf-16",
            };
            return {
              status: classifyStatus({ kind: "no-session" }),
              operation: r.operation,
              method,
              server: un,
              result: null,
              meta: { truncated: false },
            };
          }
        } catch (acqErr) {
          if (acqErr instanceof AmbiguousServerError) {
            const amb: StrictServerInfo = {
              descriptorId: "unknown",
              name: "unknown",
              languageId: languageId ?? "unknown",
              projectRoot: root,
              positionEncoding: "utf-16",
            };
            return {
              status: classifyStatus({ kind: "ambiguous" }),
              operation: r.operation,
              method,
              server: amb,
              result: null,
              meta: { truncated: false },
              error: { code: "ambiguous", message: String((acqErr as Error).message) },
            };
          }
          const ae: StrictServerInfo = {
            descriptorId: "unknown",
            name: "unknown",
            languageId: languageId ?? "unknown",
            projectRoot: root,
            positionEncoding: "utf-16",
          };
          return {
            status: classifyStatus({ kind: "transport-error" }),
            operation: r.operation,
            method,
            server: ae,
            result: null,
            meta: { truncated: false },
            error: { code: (acqErr as { name?: string })?.name ?? "error", message: String((acqErr as Error)?.message ?? acqErr) },
          };
        }
        // Second-attempt failure flows through the SAME classification catch
        // below → error/timeout/cancelled envelope, never a rejected promise.
        try {
          return await runOnce();
        } catch (retryErr) {
          if ((retryErr as Error)?.message === "invalid cursor") throw retryErr;
          return classifyFailure(retryErr);
        }
      }
      return classifyFailure(err);
    }
  } finally {
    // Release both channels best-effort: the injected releaser (test seam)
    // and the real session store (scan-acquired production leases). Each
    // no-ops on foreign keys, so dual release is safe.
    if (leaseKey) {
      try { deps.release?.(leaseKey); } catch { /* release is best-effort */ }
      try {
        const { releaseLease } = await import("./lsp-manager.js");
        releaseLease(leaseKey);
      } catch { /* release is best-effort */ }
    }
  }
}

async function issueWithTimeout(
  conn: ExecutorConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });

  // Use one internal signal for both caller cancellation and our deadline.
  // Real LSPConnection turns an abort into $/cancelRequest and removes the
  // pending slot immediately, so executor timeouts do not leak in-flight work.
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  const timeoutError = Object.assign(
    new Error(`LSP request ${method} timed out`),
    { name: "LspRequestTimeoutError" },
  );
  const inner = conn.request(method, params, { signal: controller.signal });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      // Reject with timeout before aborting the wire request so the public
      // outcome remains timeout rather than cancelled.
      reject(timeoutError);
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([inner, timeout]);
  } catch (err) {
    if (timedOut && isCancelledError(err)) throw timeoutError;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

function paginate(
  items: unknown[],
  limit: number | undefined,
  cursor: string | undefined,
  cursors: LspCursorStore,
): { items: unknown[]; truncated: boolean; nextCursor?: string } {
  let offset = 0;
  if (cursor !== undefined) {
    const resolved = cursors.resolve(cursor);
    if (resolved === null) throw new Error(`invalid cursor`);
    offset = resolved;
  }
  const lim = limit ?? items.length - offset;
  const slice = items.slice(offset, offset + lim);
  const remaining = offset + lim;
  if (remaining < items.length) {
    return { items: slice, truncated: true, nextCursor: cursors.create(remaining) };
  }
  return { items: slice, truncated: false };
}

interface BrokerLike {
  pullDocument?(uri: string, opts?: { previousResultId?: string | null }): Promise<{ source: string; diagnostics: unknown[]; receipt: number | null; resultId: string | null; version: number | null; confirmed: boolean }>;
  pullWorkspace?(opts?: { identifier?: string; previousResultIds?: Array<{ uri: string; value: string }> }): Promise<{ source: string; diagnostics: unknown[]; receipt: number | null; resultId: string | null; version: number | null; confirmed: boolean; reports?: Array<{ uri: string | null; version?: number | null; resultId: string | null; kind: string; diagnostics: unknown[] }>; resultIds?: Array<{ uri: string | null; value: string | null }> }>;
  readPush?(filePath: string): { source: string; diagnostics: unknown[]; receipt: number | null; resultId: string | null; version: number | null; confirmed: boolean };
  getPullState?(filePath: string): { resultId: string | null } | null;
}

async function runDiagnostics(
  conn: ExecutorConnection,
  r: StrictRequest,
  method: string,
  info: StrictServerInfo,
  cursors: LspCursorStore,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<StrictEnvelope> {
  const broker = (() => {
    try { return (conn.getDiagnosticsBroker?.() ?? null) as BrokerLike | null; } catch { return null; }
  })();
  const readiness = (() => {
    try { return conn.readiness?.(); } catch { return undefined; }
  })();
  if (r.operation === "publishedDiagnostics") {
    const res = broker?.readPush?.(r.path as string) ?? { source: "push", diagnostics: [], receipt: null, resultId: null, version: null, confirmed: false };
    // Honesty: unconfirmed push state is not proof of clean — freshness
    // unknown means the operation could not complete with required evidence.
    if (!res.confirmed) {
      return {
        status: classifyStatus({ kind: "state-missing" }),
        operation: r.operation, method, server: info, result: null,
        meta: {
          truncated: false,
          source: res.source,
          freshness: { state: "unknown", ...(res.version != null ? { documentVersion: res.version } : {}), ...(res.resultId ? { resultId: res.resultId } : {}) },
          ...(readiness ? { readiness: readiness as { state: "confirmed" | "settling" | "unknown"; basis: "progress" | "diagnostic-receipt" | "request-completion" | "server-specific" | "none" } } : {}),
        },
      };
    }
    const empty = res.diagnostics.length === 0;
    return {
      status: classifyStatus({ kind: empty ? "success-empty" : "success-value" }),
      operation: r.operation, method, server: info, result: res.diagnostics,
      meta: {
        truncated: false,
        source: res.source,
        freshness: { state: "unknown", ...(res.version != null ? { documentVersion: res.version } : {}), ...(res.resultId ? { resultId: res.resultId } : {}) },
        ...(readiness ? { readiness: readiness as { state: "confirmed" | "settling" | "unknown"; basis: "progress" | "diagnostic-receipt" | "request-completion" | "server-specific" | "none" } } : {}),
      },
    };
  }
  if (r.operation === "workspaceDiagnostics") {
    if (!broker?.pullWorkspace) {
      return { status: classifyStatus({ kind: "unsupported" }), operation: r.operation, method, server: info, result: null, meta: { truncated: false } };
    }
    const res = await withOpTimeout(broker.pullWorkspace(r.identifier ? { identifier: r.identifier } : undefined), timeoutMs, signal);
    // Honesty: unconfirmed workspace pull → not_ready (freshness unknown),
    // never ok/empty. Only confirmed results map to ok/empty.
    if (!res.confirmed) {
      return {
        status: classifyStatus({ kind: "state-missing" }),
        operation: r.operation, method, server: info, result: null,
        meta: {
          truncated: false,
          source: res.source,
          freshness: { state: "unknown", ...(res.version != null ? { documentVersion: res.version } : {}), ...(res.resultId ? { resultId: res.resultId } : {}) },
          ...(readiness ? { readiness: readiness as { state: "confirmed" | "settling" | "unknown"; basis: "progress" | "diagnostic-receipt" | "request-completion" | "server-specific" | "none" } } : {}),
        },
      };
    }
    // Local result shaping only (identifier is a strict-contract field): workspace pull
    // returns per-document reports plus a flat roll-up. Carry BOTH so
    // per-doc metadata (uri/version/resultId/kind) survives the envelope:
    // result = { diagnostics: flat[], reports: [{uri, version, resultId,
    // kind, diagnostics}] }. previousResultIds replay lives in the broker,
    // which auto-builds them from its workspace pull cache.
    const reports = (res.reports ?? []).map((rep) => ({
      uri: rep.uri,
      version: rep.version ?? null,
      resultId: rep.resultId,
      kind: rep.kind,
      diagnostics: rep.diagnostics,
    }));
    const shaped = { diagnostics: res.diagnostics, reports };
    const empty = res.diagnostics.length === 0;
    return {
      status: classifyStatus({ kind: empty ? "success-empty" : "success-value" }),
      operation: r.operation, method, server: info, result: shaped,
      meta: {
        truncated: false,
        source: res.source,
        freshness: { state: "fresh", ...(res.resultId ? { resultId: res.resultId } : {}) },
        ...(readiness ? { readiness: readiness as { state: "confirmed" | "settling" | "unknown"; basis: "progress" | "diagnostic-receipt" | "request-completion" | "server-specific" | "none" } } : {}),
      },
    };
  }
  // diagnostics(path): strongest file answer — pull when available, else push cache.
  let res: { source: string; diagnostics: unknown[]; receipt: number | null; resultId: string | null; version: number | null; confirmed: boolean } | null = null;
  if (broker?.pullDocument) {
    try {
      const uri = toUri(r.path as string);
      let prev: string | null = null;
      try { prev = broker.getPullState?.(uri)?.resultId ?? null; } catch { prev = null; }
      res = await withOpTimeout(
        prev ? broker.pullDocument(uri, { previousResultId: prev }) : broker.pullDocument(uri),
        timeoutMs,
        signal,
      );
      if (!res.confirmed) {
        const push = broker.readPush?.(r.path as string);
        if (push && push.confirmed) res = push;
      }
    } catch (err) {
      // Caller cancellation is terminal for this operation; do not disguise it
      // as a push-diagnostics fallback. Other pull failures may still fall
      // back to an already-confirmed push receipt.
      if (isCancelledError(err) || signal?.aborted) throw err;
      res = broker.readPush?.(r.path as string) ?? null;
    }
  } else {
    res = broker?.readPush?.(r.path as string) ?? null;
  }
  if (!res) {
    const legacy = conn.getDiagnostics?.(r.path as string) ?? [];
    res = { source: "push", diagnostics: legacy, receipt: null, resultId: null, version: null, confirmed: false };
  }
  // Honesty: unconfirmed (pull failed + push unconfirmed, or legacy with no
  // receipt) is not proof of clean — freshness unknown, required evidence
  // missing. Only confirmed results map to ok/empty.
  if (!res.confirmed) {
    return {
      status: classifyStatus({ kind: "state-missing" }),
      operation: r.operation, method, server: info, result: null,
      meta: {
        truncated: false,
        source: res.source,
        freshness: { state: "unknown", ...(res.version != null ? { documentVersion: res.version } : {}), ...(res.resultId ? { resultId: res.resultId } : {}) },
        ...(readiness ? { readiness: readiness as { state: "confirmed" | "settling" | "unknown"; basis: "progress" | "diagnostic-receipt" | "request-completion" | "server-specific" | "none" } } : {}),
      },
    };
  }
  const empty = res.diagnostics.length === 0;
  let result: unknown[] = res.diagnostics as unknown[];
  let truncated = false;
  let nextCursor: string | undefined;
  if (r.limit !== undefined || r.cursor !== undefined) {
    const page = paginate(result, r.limit, r.cursor, cursors);
    result = page.items;
    truncated = page.truncated;
    nextCursor = page.nextCursor;
  }
  return {
    status: classifyStatus({ kind: empty ? "success-empty" : "success-value" }),
    operation: r.operation, method, server: info, result,
    meta: {
      truncated,
      ...(nextCursor ? { nextCursor } : {}),
      source: res.source,
      freshness: { state: res.confirmed ? "fresh" : "unknown", ...(res.version != null ? { documentVersion: res.version } : {}), ...(res.resultId ? { resultId: res.resultId } : {}) },
      ...(readiness ? { readiness: readiness as { state: "confirmed" | "settling" | "unknown"; basis: "progress" | "diagnostic-receipt" | "request-completion" | "server-specific" | "none" } } : {}),
    },
  };
}

async function withOpTimeout<T>(p: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error("LSP request timed out"), { name: "LspRequestTimeoutError" })),
      timeoutMs,
    );
  });
  const cancelled = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        signal.addEventListener("abort", onAbort, { once: true });
      })
    : null;
  try {
    return await Promise.race(cancelled ? [p, timeout, cancelled] : [p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
