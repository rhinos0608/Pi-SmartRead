import { createHash } from "node:crypto";
import { createLspTool } from "../../../src/lsp/lsp-tool.js";
import { resolve } from "node:path";
import { AFFORDANCE_ANCHOR_OPS, AFFORDANCE_BOUNDS, type AffordanceExecContext, type InvestigateTask } from "../../../src/lsp/affordance-contract.js";
import { investigateAffordanceTarget, renderBounded, resolveInvestigateScope } from "../../../src/lsp/affordance-investigate.js";
import { executeLspOperation, type ExecutorDeps } from "../../../src/lsp/lsp-executor.js";
import { convertOffset, type PositionEncoding } from "../../../src/lsp/lsp-position-codec.js";
import { validateStrictRequest, type StrictEnvelope } from "../../../src/lsp/lsp-strict-contract.js";
import { locateSourceIdentifier, readSource } from "./source-locator.js";


export type OriginalLspExecute = ReturnType<typeof createLspTool>["execute"];
type SourceTarget = { path: string; line: number; identifier: string; occurrence?: number };
const recipes = new Set<InvestigateTask>(["definition", "type", "references", "implementations", "callers"]);
const sharedFields = new Set(["operation", "workspace", "server", "timeoutMs", "limit", "cursor"]);

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
class SourceRouteFailure extends Error { constructor(readonly kind: "cancelled" | "timeout" | "stale" | "budget" | "routing") { super(`source-route:${kind}`); } }
async function checkedSnapshot(path: string, expectedPath: string, expectedHash: string, signal: AbortSignal | undefined, deadline: number) {
  const snapshot = await readSource(path, { signal, maxFileBytes: 1024 * 1024 }, deadline);
  if (signal?.aborted) throw new SourceRouteFailure("cancelled");
  if (Date.now() >= deadline) throw new SourceRouteFailure("timeout");
  if (!snapshot.ok || snapshot.canonicalPath !== expectedPath || createHash("sha256").update(snapshot.bytes).digest("hex") !== expectedHash) {
    throw new SourceRouteFailure("stale");
  }
  return snapshot;
}
function targetOf(value: unknown): SourceTarget {
  if (!record(value) || Object.keys(value).some((key) => !["path", "line", "identifier", "occurrence"].includes(key)) ||
    typeof value.path !== "string" || !value.path || !Number.isInteger(value.line) || (value.line as number) < 1 ||
    typeof value.identifier !== "string" || !value.identifier ||
    (value.occurrence !== undefined && (!Number.isInteger(value.occurrence) || (value.occurrence as number) < 1)) ) {
    throw new Error("source: malformed source target");
  }
  return value as SourceTarget;
}
function supportedEncoding(value: unknown): value is PositionEncoding {
  return value === "utf-8" || value === "utf-16" || value === "utf-32";
}
function sourceFailure(status: "empty" | "ambiguous" | "unsupported" | "not_ready" | "cancelled" | "timeout" | "error", operation: string, reason: string, details: Record<string, unknown> = {}, result: unknown = null) {
  const failure = { status, operation, result, ...(status !== "empty" ? { error: { code: status === "not_ready" ? "source-stale" : `source-${status}`, message: reason } } : {}), meta: { truncated: false } };
  const bounded = renderBounded([failure]);
  const projection = bounded.projection[0] ?? { status: "error", operation, result: null, error: { code: "output-limit", message: "source response exceeds output limit" }, meta: { truncated: true } };
  return { content: [{ type: "text" as const, text: JSON.stringify(projection) }], details };
}

function bootstrapFailure(bootstrap: unknown, operation: string, cause: string) {
  const envelope = record(bootstrap) ? bootstrap : {};
  const status = envelope.status;
  const failure = {
    status: typeof status === "string" && ["error", "unavailable", "unsupported", "not_ready", "ambiguous", "timeout", "cancelled"].includes(status) ? status : "error",
    operation,
    result: null,
    error: record(envelope.error) ? envelope.error : { code: "source-bootstrap", message: cause },
    meta: { truncated: false },
  };
  const bounded = renderBounded([failure]);
  const projection = bounded.truncated || !bounded.projection[0] ? {
    status: "error", operation, result: null,
    error: { code: "output-limit", message: "source bootstrap failure exceeds output limit" },
    meta: { truncated: true },
  } : bounded.projection[0];
  return {
    content: [{ type: "text" as const, text: JSON.stringify(projection) }],
    details: { envelope: bootstrap, steps: [{ id: "source.bootstrap", args: { operation: "documentSymbols" }, envelope: bootstrap }] },
  };
}

/** Wrap the registered five-argument LSP execute; existing requests keep their original path unchanged. */
export function createSourceRoutingExecutor(
  original: OriginalLspExecute,
  options: { executeOperation?: typeof executeLspOperation } = {},
): OriginalLspExecute {
  return async (...args) => {
    const [toolCallId, params, signal, onUpdate, ctx] = args;
    if (!record(params) || params.source === undefined) return original(toolCallId, params, signal, onUpdate, ctx);
    const operation = params.operation;
    const isRecipe = operation === "investigate";
    if (!(typeof operation === "string" && (AFFORDANCE_ANCHOR_OPS as readonly string[]).includes(operation)) && !isRecipe) {
      throw new Error("source: unsupported operation");
    }
    const allowed = new Set([...sharedFields, "source", ...(isRecipe ? ["task", "scope"] : operation === "findReferences" ? ["includeDeclaration"] : [])]);
    if (Object.keys(params).some((key) => !allowed.has(key))) throw new Error("source: foreign or conflicting field");
    if (isRecipe && (typeof params.task !== "string" || !recipes.has(params.task as InvestigateTask))) throw new Error("source: unsupported investigate task");
    if (!isRecipe && operation !== "findReferences" && (params.limit !== undefined || params.cursor !== undefined)) throw new Error("source: operation-inappropriate limit or cursor");
    if (isRecipe && (params.limit !== undefined || params.cursor !== undefined)) throw new Error("source: investigate does not accept limit or cursor");
    if (params.includeDeclaration !== undefined && typeof params.includeDeclaration !== "boolean") throw new Error("source: includeDeclaration must be boolean");
    const source = targetOf(params.source);
    for (const key of ["workspace", "server", "cursor"] as const) if (params[key] !== undefined && (typeof params[key] !== "string" || !params[key])) throw new Error(`source: invalid ${key}`);
    for (const key of ["timeoutMs", "limit"] as const) if (params[key] !== undefined && (!Number.isInteger(params[key]) || (params[key] as number) < 1)) throw new Error(`source: invalid ${key}`);
    const cwd = ctx.cwd;
    if (typeof cwd !== "string" || !cwd) throw new Error("source: invocation cwd unavailable");
    if (isRecipe) resolveInvestigateScope(params.scope, typeof params.workspace === "string" ? params.workspace : cwd);
    const abs = resolve(cwd, source.path);
    const started = Date.now();
    const deadline = started + Math.min(AFFORDANCE_BOUNDS.aggregateDeadlineMs, typeof params.timeoutMs === "number" ? params.timeoutMs : AFFORDANCE_BOUNDS.aggregateDeadlineMs);
    const remaining = () => deadline - Date.now();
    const completedSteps: Array<{ id: string; args: unknown; envelope: StrictEnvelope }> = [];
    let expectedServer: StrictEnvelope["server"] | undefined = undefined;
    let routingFailure: SourceRouteFailure | undefined;
    let executorFailure: { error: unknown } | undefined;
    const checkBudget = () => {
      if (signal?.aborted) throw new SourceRouteFailure("cancelled");
      if (remaining() <= 0) throw new SourceRouteFailure("timeout");
    };
    const outcome = (error: unknown, details: Record<string, unknown> = {}) => {
      if (!(error instanceof SourceRouteFailure)) return undefined;
      details = { ...details, steps: completedSteps.slice() };
      if (error.kind === "routing") return sourceFailure("not_ready", operation, "Server metadata changed after bootstrap", details);
      if (error.kind === "cancelled") return sourceFailure("cancelled", operation, "Source routing cancelled", details);
      if (error.kind === "timeout") return sourceFailure("timeout", operation, "Source routing deadline exceeded", details);
      if (error.kind === "stale") return sourceFailure("not_ready", operation, "Source snapshot is stale or unreadable", details);
      return sourceFailure("not_ready", operation, "Source routing request budget exhausted", details);
    };
    if (signal?.aborted) return sourceFailure("cancelled", operation, "Source routing cancelled");
    if (remaining() <= 0) return sourceFailure("timeout", operation, "Source routing deadline exceeded");
    let located: Awaited<ReturnType<typeof locateSourceIdentifier>>;
    try { located = await locateSourceIdentifier({ ...source, path: abs }, { signal, deadlineMs: remaining() }); }
    catch (error) { const failure = outcome(error); if (failure) return failure; throw error; }
    const locatorDetails = { locator: located };
    if (signal?.aborted) return sourceFailure("cancelled", operation, "Source routing cancelled", locatorDetails);
    if (remaining() <= 0) return sourceFailure("timeout", operation, "Source routing deadline exceeded", locatorDetails);
    if (located.status === "notfound") return sourceFailure("empty", operation, "No AST identifier matched the requested source location", locatorDetails);
    if (located.status === "ambiguous") return sourceFailure("ambiguous", operation, `Multiple AST identifiers matched; provide occurrence (1-${located.totalMatches})`, locatorDetails, { displayedMatches: located.displayedMatches, totalMatches: located.totalMatches });
    if (located.status === "unsupported") return sourceFailure("unsupported", operation, located.reason, locatorDetails);
    if (located.status === "incomplete") return sourceFailure("not_ready", operation, located.reason, locatorDetails);
    if (located.status === "invalid") throw new Error(`source: invalid locator result: ${located.reason}`);
    checkBudget();
    const initialHash = located.sourceSha256;
    let requests = 0;
    const admit = () => {
      if (signal?.aborted) throw new SourceRouteFailure("cancelled");
      if (remaining() <= 0) throw new SourceRouteFailure("timeout");
      if (requests >= AFFORDANCE_BOUNDS.underlyingRequests) throw new SourceRouteFailure("budget");
      requests += 1;
    };
    const run = async (request: unknown, deps?: ExecutorDeps) => {
      if (routingFailure) throw routingFailure;
      if (executorFailure) throw executorFailure.error;
      const validated = validateStrictRequest(request);
      if (!validated.ok) throw new Error(validated.error);
      admit();
      let envelope: StrictEnvelope;
      try {
        envelope = await (options.executeOperation ?? executeLspOperation)(validated.value, { cwd, signal, ...deps });
      } catch (error) {
        executorFailure = { error };
        throw error;
      }
      completedSteps.push({ id: completedSteps.length === 0 ? "source.bootstrap" : `source.${validated.value.operation}.${completedSteps.length}`, args: validated.value, envelope });
      const comparableServer = typeof envelope.server?.descriptorId === "string" && envelope.server.descriptorId.length > 0 &&
        envelope.server.descriptorId !== "unknown" && supportedEncoding(envelope.server.positionEncoding);
      if (expectedServer && (envelope.status === "ok" || envelope.status === "empty" || comparableServer) &&
        (envelope.server?.descriptorId !== expectedServer.descriptorId || envelope.server?.positionEncoding !== expectedServer.positionEncoding)) {
        routingFailure = new SourceRouteFailure("routing");
        throw routingFailure;
      }
      return envelope;
    };
    let bootstrap: unknown;
    try { bootstrap = await run({ operation: "documentSymbols", path: located.canonicalPath, ...(params.workspace ? { workspace: params.workspace } : {}), ...(params.server ? { server: params.server } : {}), timeoutMs: remaining() }); }
    catch (error) { const failure = outcome(error, { locator: located }); if (failure) return failure; throw error; }
    if (signal?.aborted) return sourceFailure("cancelled", operation, "Source routing cancelled", { locator: located, bootstrap });
    if (remaining() <= 0) return sourceFailure("timeout", operation, "Source routing deadline exceeded", { locator: located, bootstrap });
    const metadata = bootstrap as StrictEnvelope;
    const server = metadata?.server;
    const invalidBootstrap = metadata?.status !== "ok" && metadata?.status !== "empty"
      ? `bootstrap status ${String(metadata?.status ?? "unknown")}`
      : metadata?.operation !== "documentSymbols" || metadata?.method !== "textDocument/documentSymbol"
        ? "bootstrap operation or method mismatch"
        : !server || typeof server.descriptorId !== "string" || !server.descriptorId || server.descriptorId === "unknown"
          ? "initialized server descriptor unavailable"
          : !supportedEncoding(server.positionEncoding)
            ? "initialized server encoding unavailable"
            : metadata.meta?.freshness?.state === "stale"
              ? "bootstrap document is stale"
              : params.server !== undefined && params.server !== server.descriptorId
                ? "requested server conflicts with initialized server"
                : undefined;
    if (metadata?.meta?.freshness?.state === "stale") return sourceFailure("not_ready", operation, "Bootstrap document is stale", { locator: located, bootstrap });
    if (invalidBootstrap) return bootstrapFailure(bootstrap, operation, invalidBootstrap);
    if (!server || !supportedEncoding(server.positionEncoding)) return bootstrapFailure(bootstrap, operation, "initialized server metadata unavailable");
    expectedServer = server;
    let snapshot: Awaited<ReturnType<typeof checkedSnapshot>>;
    try { snapshot = await checkedSnapshot(abs, located.canonicalPath, initialHash, signal, Date.now() + remaining()); }
    catch (error) { const failure = outcome(error, { locator: located, bootstrap }); if (failure) return failure; throw error; }
    const row = located.sourcePositionUtf16.line;
    const lineText = snapshot.source.split(/\r\n|\n|\r/)[row];
    const { start, end } = located.tokenSpan;
    const token = snapshot.source.slice(start, end);
    if (lineText === undefined || start < 0 || end <= start || end > snapshot.source.length ||
      token !== source.identifier || snapshot.source.slice(0, start).split(/\r\n|\n|\r/).length - 1 !== row ||
      lineText.slice(located.sourcePositionUtf16.character, located.sourcePositionUtf16.character + token.length) !== token) {
      throw new Error("source: located token does not match checked snapshot");
    }
    const position = { line: row, character: convertOffset(lineText, located.sourcePositionUtf16.character, "utf-16", server.positionEncoding) };
    let output: Awaited<ReturnType<OriginalLspExecute>>;
    if (isRecipe) {
      const base: AffordanceExecContext = {
        root: cwd, ...(typeof params.workspace === "string" ? { workspace: params.workspace } : {}), server: server.descriptorId,
        budget: { maxCandidates: AFFORDANCE_BOUNDS.discoveryCandidates, maxRequests: AFFORDANCE_BOUNDS.underlyingRequests - requests, deadlineMs: remaining(), signal },
        exec: run,
      };
      let investigation: Awaited<ReturnType<typeof investigateAffordanceTarget>>;
      try { investigation = await investigateAffordanceTarget({ operation: "investigate", task: params.task as InvestigateTask, path: located.canonicalPath, position, ...(typeof params.scope === "string" ? { scope: params.scope } : {}), ...(typeof params.workspace === "string" ? { workspace: params.workspace } : {}), server: server.descriptorId, ...(typeof params.timeoutMs === "number" ? { timeoutMs: remaining() } : {}) }, base); }
      catch (error) { const failure = outcome(error, { locator: located, bootstrap }); if (failure) return failure; throw error; }
      if (executorFailure) throw executorFailure.error;
      if (routingFailure) return sourceFailure("not_ready", operation, "Server metadata changed after bootstrap", { locator: located, bootstrap, steps: completedSteps.slice() });
      const investigationTrace = { locator: located, bootstrap, steps: [{ id: "source.bootstrap", args: { operation: "documentSymbols", path: located.canonicalPath }, envelope: bootstrap }, ...investigation.steps] };
      if (signal?.aborted) return sourceFailure("cancelled", operation, "Source routing cancelled", investigationTrace);
      if (remaining() <= 0) return sourceFailure("timeout", operation, "Source routing deadline exceeded", investigationTrace);
      const changedStep = investigation.steps.find((step) => record(step.envelope) && (step.envelope.server?.descriptorId !== server.descriptorId || step.envelope.server?.positionEncoding !== server.positionEncoding));
      if (changedStep) return sourceFailure("not_ready", operation, "Investigation server metadata changed after bootstrap", investigationTrace);
      const env = { status: investigation.status, operation: "investigate", result: investigation.result, meta: { truncated: Boolean(record(investigation.result) && investigation.result.truncated) || investigation.steps.some((step) => step.envelope.meta.truncated) } };
      const bounded = renderBounded([env]);
      const projection = bounded.projection[0];
      const projected = bounded.truncated || !record(projection) ? { status: "error", operation: "investigate", result: null, error: { code: "output-limit", message: "source response exceeds output limit" }, meta: { truncated: true } } : { ...projection, meta: { ...(record(projection.meta) ? projection.meta : {}), truncated: Boolean(record(projection.meta) && projection.meta.truncated) } };
      output = { content: [{ type: "text", text: JSON.stringify(projected) }], details: { envelope: env, investigation: { steps: [{ id: "source.bootstrap", args: { operation: "documentSymbols", path: located.canonicalPath }, envelope: bootstrap }, ...investigation.steps] } } };
    } else {
      let envelope: Awaited<ReturnType<typeof executeLspOperation>>;
      try { envelope = await run({ ...Object.fromEntries(Object.entries(params).filter(([key]) => sharedFields.has(key) || key === "includeDeclaration")), operation, path: located.canonicalPath, position, server: server.descriptorId, timeoutMs: Math.min(typeof params.timeoutMs === "number" ? params.timeoutMs : AFFORDANCE_BOUNDS.aggregateDeadlineMs, remaining()) }); }
      catch (error) { const failure = outcome(error, { locator: located, bootstrap }); if (failure) return failure; throw error; }
      const semanticTrace = { locator: located, bootstrap, steps: [{ id: "source.bootstrap", args: { operation: "documentSymbols", path: located.canonicalPath }, envelope: bootstrap }, { id: `source.${operation}`, args: { operation, path: located.canonicalPath, position, server: server.descriptorId }, envelope }] };
      if (signal?.aborted) return sourceFailure("cancelled", operation, "Source routing cancelled", semanticTrace);
      if (remaining() <= 0) return sourceFailure("timeout", operation, "Source routing deadline exceeded", semanticTrace);
      if (!record(envelope) || envelope.server?.descriptorId !== server.descriptorId || envelope.server?.positionEncoding !== server.positionEncoding) return sourceFailure("not_ready", operation, "Semantic server metadata changed after bootstrap", semanticTrace);
      const rendered = renderBounded([envelope]);
      const projection = rendered.projection[0];
      const projected = rendered.truncated || !record(projection) ? { status: "error", operation, result: null, error: { code: "output-limit", message: "source response exceeds output limit" }, meta: { truncated: true } } : { ...projection, meta: { ...(record(projection.meta) ? projection.meta : {}), truncated: Boolean(rendered.truncated || (record(envelope) && record(envelope.meta) && envelope.meta.truncated)) } };
      output = { content: [{ type: "text", text: JSON.stringify(projected) }], details: { envelope, steps: [{ id: "source.bootstrap", args: { operation: "documentSymbols", path: located.canonicalPath }, envelope: bootstrap }, { id: `source.${operation}`, args: { operation, path: located.canonicalPath, position, server: server.descriptorId }, envelope }] } };
    }
    try { await checkedSnapshot(abs, located.canonicalPath, initialHash, signal, Date.now() + remaining()); }
    catch (error) { const failure = outcome(error, { locator: located, bootstrap, output }); if (failure) return failure; throw error; }
    if (signal?.aborted) return sourceFailure("cancelled", operation, "Source routing cancelled", { locator: located, bootstrap, output });
    if (remaining() <= 0) return sourceFailure("timeout", operation, "Source routing deadline exceeded", { locator: located, bootstrap, output });
    return output;
  };
}
