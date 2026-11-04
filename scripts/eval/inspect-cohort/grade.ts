/**
 * Inspect-opportunity cohort grader: pure deterministic grading over a
 * parsed final payload plus a frozen grader context.
 *
 * Binding inputs: `docs/plans/2026-10-08-inspect-opportunity-protocol.md`
 * §7 grading predicates, §8 inherited gates, and the oracle handoff
 * `de9d0961-b0af-4b9a-a961-71b94cdfe875_oracle_output.md`.
 *
 * Boundary: this module is pure (no I/O, no model, no graph, no source
 * parsing, no labeler/runner/stats). The certification LOADER (outside
 * this module) verifies actual source digests and manifest provenance;
 * this module validates binding/fact consistency of the supplied context:
 * task/context/snapshot/hash/count/source/witness/certification problems
 * are `goldInvalid` (pass null, abort the batch), never model zeros.
 * Malformed model payloads are `modelFail` (pass false); semantically
 * wrong well-formed outputs are graded failures. Unknown (`cannot-
 * establish`) is its own outcome, never false. `verified:true` model
 * claims are never trusted — only independently certified context facts.
 *
 * Path handling: every path is normalised exactly ONCE with the anchored
 * single-strip normaliser below (repo/subpath prefixes stripped at most
 * once each). Repeated prefixes (`sub/sub/x.ts`), extra `repo/` prefixes,
 * and phantom files never collapse into aliases — they simply fail to
 * match certified identities.
 */

import {
    INSPECT_UNRESOLVED_REASONS,
    validateInspectFinalAnswer,
    validateInspectTask,
} from "./schema.js";
import type {
    InspectFamily,
    InspectPathEdge,
    InspectRelation,
    InspectRoute,
    InspectTask,
    InspectWitness,
} from "./schema.js";

export type InspectGradeStatus = "graded" | "modelFail" | "goldInvalid";

export type InspectPredicted = "true" | "false" | "unknown" | "set" | "value" | null;

export interface GradeInspectResult {
    status: InspectGradeStatus;
    /** Null exactly when status is goldInvalid. */
    pass: boolean | null;
    detail: string;
    predicted: InspectPredicted;
    recall: number | null;
    precision: number | null;
    rangeRecall: number | null;
    rangePrecision: number | null;
    /** Declared ∩ sealed membership over |sealed|; null when undetermined. */
    coverageRatio: number | null;
    /** True = bad (false exhaustiveness); null when undetermined. */
    falseCompleteness: boolean | null;
}

/** Sealed candidate universe as certified by the loader. */
export interface SealedUniverse {
    id: string;
    sha256: string;
    count: number;
    files: string[];
}

export interface TaskBinding {
    repo: string;
    commit: string;
    subpath: string;
    scope: string;
    snapshotHead: string;
    snapshotClean: boolean;
}

export interface NegativeSetPolicy {
    minRecall: number;
    minPrecision: number;
}

export interface ScalarPolicy {
    /** Default false (trim + case-insensitive, TEB protocol §5). */
    caseSensitive: boolean;
}

/** Per-task frozen context. Every field is certified BEFORE labels. */
export interface TaskGraderContext {
    binding: TaskBinding;
    universe: SealedUniverse;
    /** File -> tracked line count (source-snapshot bindings). */
    sourceLines: Record<string, number>;
    trackedFiles: string[];
    certifiedRoutes: InspectRoute[];
    certifiedRelations: InspectRelation[];
    /** Independent complete edge set for P4 traversal (never the prod graph). */
    certifiedEdges: InspectPathEdge[];
    /** P4 private: requested endpoints, bound BEFORE labels. */
    requestedEndpoints?: { from: string; to: string };
    /** P5 private: frozen patch identity. */
    patchSha?: string;
    /** N1/N3/N4 private: explicit REQUIRED thresholds (never defaulted). */
    negativePolicy?: NegativeSetPolicy;
    /** N2 private: scalar matching policy. */
    scalarPolicy?: ScalarPolicy;
    /** Independent completeness certification for the sealed scope. */
    completeness?: { complete: boolean; truncated?: boolean };
    /** Sealed manifest provenance reference (opaque to the grader). */
    manifestRef?: string;
}

export interface FrozenGraderContext {
    tasks: Record<string, TaskGraderContext>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isOneBasedInt(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function goldInvalid(detail: string): GradeInspectResult {
    return {
        status: "goldInvalid",
        pass: null,
        detail,
        predicted: null,
        recall: null,
        precision: null,
        rangeRecall: null,
        rangePrecision: null,
        coverageRatio: null,
        falseCompleteness: null,
    };
}

function modelFail(detail: string): GradeInspectResult {
    return {
        status: "modelFail",
        pass: false,
        detail,
        predicted: null,
        recall: null,
        precision: null,
        rangeRecall: null,
        rangePrecision: null,
        coverageRatio: null,
        falseCompleteness: null,
    };
}

/**
 * Strict subpath-relative normaliser: backslashes -> slashes, trim,
 * collapse redundant separators and interior `.` segments. Absolute
 * inputs, `./`-prefixed inputs, and `..` segments are preserved as-is so
 * downstream shape validators reject them — they are never stripped or
 * re-anchored into an in-scope alias. Repo/subpath prefixes are never
 * stripped: every inspect path is already subpath-relative and exact
 * identity is the only match rule. Case-sensitive throughout.
 */
export function normalizeInspectPath(
    raw: string,
    _repo: string,
    _subpath: string,
): string {
    const p = raw.replace(/\\/g, "/").trim().replace(/\/{2,}/g, "/");
    if (p.startsWith("/") || p.startsWith("./") || p === "." || p === "") return p;
    const parts: string[] = [];
    for (const segment of p.split("/")) {
        if (segment === "" || segment === ".") continue;
        parts.push(segment);
    }
    return parts.join("/");
}

/** Scope containment on normalised scope-relative paths. */
function inScope(file: string, scope: string): boolean {
    if (scope === "" || scope === ".") return true;
    const normalized = scope.endsWith("/") ? scope.slice(0, -1) : scope;
    if (normalized === "" || normalized === ".") return true;
    return file === normalized || file.startsWith(`${normalized}/`);
}

function routeIdentity(route: InspectRoute): string {
    return `${route.method.toUpperCase()}\n${route.path}\n${route.file}\n${route.line}`;
}

function relationIdentity(relation: InspectRelation): string {
    const resolved =
        relation.resolved === null ? `UNRESOLVED:${relation.unresolvedReason}` : relation.resolved;
    return `${relation.from}\n${relation.specifier}\n${resolved}\n${relation.kind}\n${relation.line}`;
}

function edgeIdentity(edge: InspectPathEdge): string {
    return `${edge.from}\n${edge.to}\n${edge.kind}\n${edge.witness.path}\n${edge.witness.line}`;
}

interface Validated {
    task: InspectTask;
    entry: TaskGraderContext;
}

/** Fail-closed task + context validation. Any failure is goldInvalid. */
function validateInputs(task: unknown, context: unknown): Validated | GradeInspectResult {
    if (!isRecord(context) || !isRecord(context["tasks"])) {
        return goldInvalid("context: missing tasks record");
    }
    const taskErrors = validateInspectTask(task, "task");
    if (taskErrors.length > 0) return goldInvalid(`invalid task: ${taskErrors.join("; ")}`);
    const t = task as InspectTask;
    const entry = (context["tasks"] as Record<string, unknown>)[t.id];
    if (!isRecord(entry)) return goldInvalid(`context: no frozen entry for task ${t.id}`);
    return validateEntry(t, entry);
}

function validateEntry(task: InspectTask, entry: unknown): Validated | GradeInspectResult {
    if (!isRecord(entry)) return goldInvalid("context: frozen entry malformed");
    const candidate = entry as unknown as TaskGraderContext;
    if (!isRecord(entry["binding"]) || !isRecord(entry["universe"])) {
        return goldInvalid("context: binding/universe must be records");
    }
    const b = candidate.binding;
    if (
        b.repo !== task.repo ||
        b.commit !== task.commit ||
        b.subpath !== task.subpath ||
        b.scope !== task.scope ||
        b.snapshotHead !== task.snapshot.head ||
        b.snapshotClean !== true ||
        task.snapshot.clean !== true
    ) {
        return goldInvalid("context: binding/snapshot mismatch with task");
    }
    const u = candidate.universe;
    if (
        u.id !== task.candidateUniverse.id ||
        u.sha256 !== task.candidateUniverse.sha256 ||
        u.count !== task.candidateUniverse.count ||
        !Array.isArray(u.files) ||
        u.files.length !== u.count
    ) {
        return goldInvalid("context: sealed universe id/hash/count mismatch");
    }
    // Empty sealed universe: coverage 1 is certified only with an
    // independent complete enumeration; otherwise completeness is
    // undetermined and the batch cannot grade (never automatic absence).
    if (u.count === 0 && candidate.completeness?.complete !== true) {
        return goldInvalid("context: empty universe without independent complete certification");
    }
    if (!isRecord(candidate.sourceLines) || !Array.isArray(candidate.trackedFiles)) {
        return goldInvalid("context: sourceLines/trackedFiles malformed");
    }
    for (const [file, lines] of Object.entries(candidate.sourceLines)) {
        if (typeof lines !== "number" || !Number.isInteger(lines) || lines < 1) {
            return goldInvalid(`context: sourceLines[${file}] must be a positive line count`);
        }
    }
    const tracked = new Set(candidate.trackedFiles);
    // Every sealed-universe file must be a tracked identity.
    for (const file of u.files) {
        if (!tracked.has(file)) return goldInvalid(`context: universe file ${file} not tracked`);
    }
    // Certified facts must be witness-consistent against the snapshot.
    const factError = checkCertifiedFacts(task, candidate, tracked);
    if (factError !== null) return goldInvalid(factError);
    // Family-private requirements bound BEFORE labels.
    const familyError = checkFamilyContext(task, candidate);
    if (familyError !== null) return goldInvalid(familyError);
    return { task, entry: candidate };
}

function witnessSupported(
    witness: { path: string; line: number },
    entry: TaskGraderContext,
    tracked: Set<string>,
): boolean {
    const max = entry.sourceLines[witness.path];
    return (
        tracked.has(witness.path) &&
        typeof max === "number" &&
        Number.isInteger(witness.line) &&
        witness.line >= 1 &&
        witness.line <= max
    );
}

/** Certified gold facts must each carry an existing source-line witness. */
function isStrictSubpathRelative(path: unknown): path is string {
    return (
        typeof path === "string" &&
        path.length > 0 &&
        !path.includes("\\") &&
        !path.startsWith("/") &&
        !path.startsWith("./") &&
        !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    );
}

const CERTIFIED_WITNESS_KEYS: readonly string[] = ["path", "line"];
const CERTIFIED_ROUTE_KEYS: readonly string[] = ["method", "path", "file", "line"];
const CERTIFIED_RELATION_KEYS: readonly string[] = [
    "from",
    "specifier",
    "kind",
    "line",
    "witness",
    "resolved",
    "unresolvedReason",
];
const CERTIFIED_EDGE_KEYS: readonly string[] = ["from", "to", "kind", "witness"];

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function isValidCertifiedWitness(value: unknown): value is InspectWitness {
    return (
        isRecord(value) &&
        hasExactKeys(value, CERTIFIED_WITNESS_KEYS) &&
        isStrictSubpathRelative(value["path"]) &&
        isOneBasedInt(value["line"])
    );
}

function isValidCertifiedRoute(value: unknown): value is InspectRoute {
    return (
        isRecord(value) &&
        hasExactKeys(value, CERTIFIED_ROUTE_KEYS) &&
        typeof value["method"] === "string" &&
        value["method"].length > 0 &&
        typeof value["path"] === "string" &&
        value["path"].length > 0 &&
        isStrictSubpathRelative(value["file"]) &&
        isOneBasedInt(value["line"])
    );
}

function isValidCertifiedRelation(value: unknown): value is InspectRelation {
    if (!isRecord(value)) return false;
    // `unresolvedReason` is optional (absent when resolved is a string);
    // only the absence of unknown keys is enforced here.
    if (!Object.keys(value).every((key) => CERTIFIED_RELATION_KEYS.includes(key))) return false;
    if (value["from"] === undefined || value["specifier"] === undefined || value["kind"] === undefined || value["line"] === undefined || value["witness"] === undefined || value["resolved"] === undefined) return false;
    if (!isStrictSubpathRelative(value["from"])) return false;
    if (typeof value["specifier"] !== "string" || value["specifier"].length === 0) return false;
    if (typeof value["kind"] !== "string" || value["kind"].length === 0) return false;
    if (!isOneBasedInt(value["line"])) return false;
    if (!isValidCertifiedWitness(value["witness"])) return false;
    const resolved = value["resolved"];
    const reason = value["unresolvedReason"];
    if (resolved === null) {
        return (
            typeof reason === "string" &&
            (INSPECT_UNRESOLVED_REASONS as readonly string[]).includes(reason)
        );
    }
    return isStrictSubpathRelative(resolved) && reason === undefined;
}

function isValidCertifiedEdge(value: unknown): value is InspectPathEdge {
    return (
        isRecord(value) &&
        hasExactKeys(value, CERTIFIED_EDGE_KEYS) &&
        isStrictSubpathRelative(value["from"]) &&
        isStrictSubpathRelative(value["to"]) &&
        typeof value["kind"] === "string" &&
        value["kind"].length > 0 &&
        isValidCertifiedWitness(value["witness"])
    );
}

function checkCertifiedFacts(
    task: InspectTask,
    entry: TaskGraderContext,
    tracked: Set<string>,
): string | null {
    const gold = task.gold;
    if (gold.kind === "route-set") {
        if (!Array.isArray(entry.certifiedRoutes)) return "context: certifiedRoutes malformed";
        for (const fact of entry.certifiedRoutes) {
            if (!isValidCertifiedRoute(fact)) return "context: certifiedRoutes malformed";
        }
        const certified = new Set(entry.certifiedRoutes.map((r) => routeIdentity(r)));
        for (const r of entry.certifiedRoutes) {
            if (!tracked.has(r.file) || !witnessSupported({ path: r.file, line: r.line }, entry, tracked)) {
                return "context: certified route without source witness";
            }
        }
        // Every gold route must be independently certified: a gold item
        // with no certified source witness invalidates the batch (gold
        // support missing), it is never merely a model miss.
        for (const route of gold.routes) {
            if (!certified.has(routeIdentity(route))) {
                return "context: gold route without independent certification";
            }
        }
    }
    if (gold.kind === "relation-set" || gold.kind === "evidence-chain") {
        if (!Array.isArray(entry.certifiedRelations)) return "context: certifiedRelations malformed";
        for (const fact of entry.certifiedRelations) {
            if (!isValidCertifiedRelation(fact)) return "context: certifiedRelations malformed";
        }
        const certified = new Set(entry.certifiedRelations.map((rel) => relationIdentity(rel)));
        for (const rel of entry.certifiedRelations) {
            if (
                rel.witness.path !== rel.from ||
                rel.witness.line !== rel.line ||
                !witnessSupported(rel.witness, entry, tracked)
            ) {
                return "context: certified relation without source witness";
            }
        }
        const goldRelations = gold.kind === "relation-set" ? gold.relations : gold.relations;
        for (const relation of goldRelations) {
            if (!certified.has(relationIdentity(relation))) {
                return "context: gold relation without independent certification";
            }
        }
    }
    if (gold.kind === "conclusion") {
        if (!Array.isArray(entry.certifiedEdges)) return "context: certifiedEdges malformed";
        for (const fact of entry.certifiedEdges) {
            if (!isValidCertifiedEdge(fact)) return "context: certifiedEdges malformed";
        }
        for (const edge of entry.certifiedEdges) {
            if (!witnessSupported(edge.witness, entry, tracked)) {
                return "context: certified edge without source witness";
            }
        }
        // Contradictory reference: a false gold with an independent
        // from->to path in the certified edge set invalidates the batch.
        if (gold.verdict === "supported-false" && entry.requestedEndpoints) {
            const reached = reachableTo(
                entry.certifiedEdges,
                entry.requestedEndpoints.from,
                entry.requestedEndpoints.to,
            );
            if (reached) return "context: contradictory reference — certified edge set reaches a false-gold endpoint pair";
        }
    }
    if (gold.kind === "evidence-chain") {
        if (entry.patchSha !== gold.patch.sha) return "context: frozen patch sha mismatch";
    }
    return null;
}

function checkFamilyContext(task: InspectTask, entry: TaskGraderContext): string | null {
    const family = task.family;
    if (family === "P4" && !isRecord(entry.requestedEndpoints)) {
        return "context: P4 requires frozen requestedEndpoints";
    }
    if (family === "P4" && entry.requestedEndpoints) {
        const { from, to } = entry.requestedEndpoints as { from: unknown; to: unknown };
        if (typeof from !== "string" || typeof to !== "string" || from.length === 0 || to.length === 0) {
            return "context: P4 requestedEndpoints malformed";
        }
    }
    if (family === "P5" && typeof entry.patchSha !== "string") {
        return "context: P5 requires frozen patchSha";
    }
    if ((family === "N1" || family === "N3" || family === "N4") && !isRecord(entry.negativePolicy)) {
        return "context: negative location task requires explicit negativePolicy";
    }
    if (isRecord(entry.negativePolicy)) {
        const p = entry.negativePolicy as Record<string, unknown>;
        if (typeof p["minRecall"] !== "number" || typeof p["minPrecision"] !== "number") {
            return "context: negativePolicy thresholds malformed";
        }
    }
    return null;
}

/**
 * Coverage membership (NOT cardinality): |declared ∩ sealed| / |sealed|.
 * Empty universe yields 1 only with independent complete certification;
 * otherwise completeness is undetermined (null).
 */
function coverageOf(
    declared: unknown,
    entry: TaskGraderContext,
): { ratio: number | null; member: boolean } {
    const sealed = entry.universe.files;
    if (!Array.isArray(declared)) return { ratio: null, member: false };
    const declaredSet = new Set(declared.filter((f): f is string => typeof f === "string"));
    const sealedSet = new Set(sealed);
    const inter = [...declaredSet].filter((f) => sealedSet.has(f)).length;
    if (sealed.length === 0) {
        const complete = entry.completeness?.complete === true;
        return { ratio: complete ? 1 : null, member: complete && declaredSet.size === 0 };
    }
    return { ratio: inter / sealed.length, member: inter === sealed.length && declaredSet.size >= sealed.length };
}

/**
 * False-completeness (HIGH is BAD): an explicit exhaustive claim over an
 * incompletely enumerated scope, certified truncation/omission, or a
 * missing gold item despite full declaration.
 */
function falseCompletenessOf(
    claim: unknown,
    coverage: { ratio: number | null; member: boolean },
    entry: TaskGraderContext,
    missingGoldItem: boolean,
): boolean | null {
    if (claim !== "exhaustive") return claim === "partial" ? false : null;
    if (coverage.ratio === null) return null;
    if (coverage.ratio < 1) return true;
    if (entry.completeness?.complete === false) return true;
    if (entry.completeness?.truncated === true) return true;
    if (missingGoldItem) return true;
    return false;
}

function normOnce(value: string, task: InspectTask): string {
    return normalizeInspectPath(value, task.repo, task.subpath);
}

function supportedRouteHit(
    predicted: InspectRoute,
    goldRoutes: InspectRoute[],
    task: InspectTask,
    entry: TaskGraderContext,
): boolean {
    const tracked = new Set(entry.trackedFiles);
    const witnessOk = witnessSupported({ path: predicted.file, line: predicted.line }, entry, tracked);
    if (!witnessOk || !inScope(predicted.file, task.scope)) return false;
    // A counted hit must ALSO be independently certified: matching the
    // gold shape alone is never sufficient. Uncertified phantoms keep
    // their precision penalty via the miss.
    const certified = new Set(entry.certifiedRoutes.map((r) => routeIdentity(r)));
    if (!certified.has(routeIdentity(predicted))) return false;
    return goldRoutes.some((g) => routeIdentity(predicted) === routeIdentity({ ...g, file: normOnce(g.file, task) }));
}

function supportedRelationHit(
    predicted: InspectRelation,
    goldRelations: InspectRelation[],
    task: InspectTask,
    entry: TaskGraderContext,
): boolean {
    const tracked = new Set(entry.trackedFiles);
    if (!witnessSupported(predicted.witness, entry, tracked)) return false;
    if (!inScope(predicted.from, task.scope)) return false;
    const normResolved =
        predicted.resolved === null ? null : normOnce(predicted.resolved, task);
    const candidate: InspectRelation =
        predicted.resolved === null
            ? { ...predicted, from: predicted.from, resolved: null }
            : { ...predicted, from: predicted.from, resolved: normResolved as string };
    const certified = new Set(entry.certifiedRelations.map((r) => relationIdentity(r)));
    if (!certified.has(relationIdentity({ ...candidate, from: normOnce(candidate.from, task) }))) return false;
    return goldRelations.some((g) => {
        const normGold: InspectRelation =
            g.resolved === null ? { ...g } : { ...g, resolved: normOnce(g.resolved, task) };
        return relationIdentity({ ...candidate, from: normOnce(candidate.from, task) }) === relationIdentity(normGold);
    });
}

function countHits<T>(predicted: T[], gold: T[], matches: (p: T, g: T, used: Set<number>) => boolean): number {
    const used = new Set<number>();
    let hits = 0;
    for (const g of gold) {
        const idx = predicted.findIndex((p, i) => !used.has(i) && matches(p, g, used));
        if (idx !== -1) {
            used.add(idx);
            hits++;
        }
    }
    return hits;
}

function setMetrics(hits: number, predictedSize: number, goldSize: number): { recall: number; precision: number } {
    return {
        recall: goldSize === 0 ? 0 : hits / goldSize,
        precision: predictedSize === 0 ? 0 : hits / predictedSize,
    };
}

/** BFS over the INDEPENDENT certified edge set (never the product graph). */
function reachableTo(edges: InspectPathEdge[], from: string, to: string): boolean {
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length > 0) {
        const current = queue.shift() as string;
        for (const edge of edges) {
            if (edge.from === current && !seen.has(edge.to)) {
                if (edge.to === to) return true;
                seen.add(edge.to);
                queue.push(edge.to);
            }
        }
    }
    return false;
}

/** Continuous directed chain from->to where every edge is certified+witnessed. */
function chainSupported(
    path: InspectPathEdge[],
    entry: TaskGraderContext,
    from: string,
    to: string,
    task: InspectTask,
): boolean {
    if (path.length === 0) return false;
    if (path[0]!.from !== from) return false;
    if (path[path.length - 1]!.to !== to) return false;
    const tracked = new Set(entry.trackedFiles);
    const certified = new Set(entry.certifiedEdges.map((e) => edgeIdentity({ ...e, from: normOnce(e.from, task), to: normOnce(e.to, task) })));
    for (let i = 0; i < path.length; i++) {
        const edge = path[i]!;
        if (i > 0 && edge.from !== path[i - 1]!.to) return false;
        if (!inScope(edge.from, task.scope) || !inScope(edge.to, task.scope)) return false;
        if (!witnessSupported(edge.witness, entry, tracked)) return false;
        const id = edgeIdentity({ ...edge, from: normOnce(edge.from, task), to: normOnce(edge.to, task) });
        if (!certified.has(id)) return false;
    }
    return true;
}

function withPathsNormalized(answerType: string, parsed: unknown, task: InspectTask): unknown {
    const clone = JSON.parse(JSON.stringify(parsed)) as unknown;
    if (!isRecord(clone)) return clone;
    const norm = (v: unknown): unknown => (typeof v === "string" ? normOnce(v, task) : v);
    const normKey = (entry: unknown, key: string): void => {
        if (isRecord(entry) && key in entry) entry[key] = norm(entry[key]);
    };
    if (answerType === "route-set" && Array.isArray(clone["answer"])) {
        for (const item of clone["answer"] as unknown[]) normKey(item, "file");
    }
    if (answerType === "relation-set" && Array.isArray(clone["answer"])) {
        for (const item of clone["answer"] as unknown[]) {
            normKey(item, "from");
            normKey(item, "resolved");
            if (isRecord(item) && isRecord(item["witness"])) normKey(item["witness"], "path");
        }
    }
    if (answerType === "conclusion") {
        normKey(clone, "from");
        if (Array.isArray(clone["path"])) {
            for (const edge of clone["path"] as unknown[]) {
                normKey(edge, "from");
                normKey(edge, "to");
                if (isRecord(edge) && isRecord(edge["witness"])) normKey(edge["witness"], "path");
            }
        }
        if (Array.isArray(clone["enumeratedFiles"])) {
            clone["enumeratedFiles"] = (clone["enumeratedFiles"] as unknown[]).map((f) => norm(f));
        }
    }
    if (answerType === "evidence-chain" && isRecord(clone["answer"])) {
        const inner = clone["answer"] as Record<string, unknown>;
        if (Array.isArray(inner["ranges"])) {
            for (const range of inner["ranges"] as unknown[]) normKey(range, "path");
        }
        if (Array.isArray(inner["relations"])) {
            for (const item of inner["relations"] as unknown[]) {
                normKey(item, "from");
                normKey(item, "resolved");
                if (isRecord(item) && isRecord(item["witness"])) normKey(item["witness"], "path");
            }
        }
    }
    if ((answerType === "location-set" || answerType === "file") && (clone["answer"] !== undefined)) {
        const inner = clone["answer"];
        if (Array.isArray(inner)) {
            for (const item of inner as unknown[]) normKey(item, "path");
        } else {
            normKey(inner, "path");
        }
    }
    if (isRecord(clone["coverage"]) && Array.isArray(clone["coverage"]["enumeratedFiles"])) {
        clone["coverage"]["enumeratedFiles"] = (clone["coverage"]["enumeratedFiles"] as unknown[]).map((f) => norm(f));
    }
    return clone;
}

function gradeRouteSet(task: InspectTask, entry: TaskGraderContext, parsed: unknown): GradeInspectResult {
    const gold = task.gold;
    if (gold.kind !== "route-set") return goldInvalid("gold kind mismatch for route-set");
    const answer = (parsed as Record<string, unknown>)["answer"] as InspectRoute[];
    const coverage = (parsed as Record<string, unknown>)["coverage"] as Record<string, unknown>;
    const hits = countHits(answer, gold.routes, (p) => supportedRouteHit(p, gold.routes, task, entry));
    const { recall, precision } = setMetrics(hits, answer.length, gold.routes.length);
    const pass = recall >= gold.minRecall && precision >= gold.minPrecision;
    const cov = coverageOf(coverage["enumeratedFiles"], entry);
    const fc = falseCompletenessOf(coverage["claim"], cov, entry, hits < gold.routes.length);
    return {
        status: "graded",
        pass,
        detail: `${hits}/${gold.routes.length} routes`,
        predicted: "set",
        recall,
        precision,
        rangeRecall: null,
        rangePrecision: null,
        coverageRatio: cov.ratio,
        falseCompleteness: fc,
    };
}

function gradeRelationSet(task: InspectTask, entry: TaskGraderContext, parsed: unknown): GradeInspectResult {
    const gold = task.gold;
    if (gold.kind !== "relation-set") return goldInvalid("gold kind mismatch for relation-set");
    const answer = (parsed as Record<string, unknown>)["answer"] as InspectRelation[];
    const coverage = (parsed as Record<string, unknown>)["coverage"] as Record<string, unknown>;
    const hits = countHits(answer, gold.relations, (p) => supportedRelationHit(p, gold.relations, task, entry));
    const { recall, precision } = setMetrics(hits, answer.length, gold.relations.length);
    const pass = recall >= gold.minRecall && precision >= gold.minPrecision;
    const cov = coverageOf(coverage["enumeratedFiles"], entry);
    const fc = falseCompletenessOf(coverage["claim"], cov, entry, hits < gold.relations.length);
    return {
        status: "graded",
        pass,
        detail: `${hits}/${gold.relations.length} relations`,
        predicted: "set",
        recall,
        precision,
        rangeRecall: null,
        rangePrecision: null,
        coverageRatio: cov.ratio,
        falseCompleteness: fc,
    };
}

function gradeConclusion(task: InspectTask, entry: TaskGraderContext, parsed: unknown): GradeInspectResult {
    const gold = task.gold;
    if (gold.kind !== "conclusion") return goldInvalid("gold kind mismatch for conclusion");
    const root = parsed as Record<string, unknown>;
    const verdict = root["verdict"] as string;
    const scope = root["scope"] as string;
    const path = root["path"] as InspectPathEdge[];
    const scopeOk = scope === task.scope;
    if (gold.verdict === "supported-true") {
        const endpoints = entry.requestedEndpoints as { from: string; to: string };
        const ok =
            verdict === "supported-true" &&
            root["claim"] === true &&
            scopeOk &&
            chainSupported(path, entry, endpoints.from, endpoints.to, task);
        return {
            status: "graded",
            pass: ok,
            detail: ok ? "supported chain from requested endpoints" : "no supported chain from requested endpoints",
            predicted: verdict === "supported-true" ? "true" : verdict === "supported-false" ? "false" : "unknown",
            recall: null,
            precision: null,
            rangeRecall: null,
            rangePrecision: null,
            coverageRatio: null,
            falseCompleteness: null,
        };
    }
    if (gold.verdict === "supported-false") {
        // Unknown is its own outcome: a false-shaped answer on a false
        // gold is graded here; an unknown-shaped answer never matches.
        if (verdict === "cannot-establish") {
            return {
                status: "graded",
                pass: false,
                detail: "unknown is never false",
                predicted: "unknown",
                recall: null,
                precision: null,
                rangeRecall: null,
                rangePrecision: null,
                coverageRatio: null,
                falseCompleteness: null,
            };
        }
        const cov = coverageOf(root["enumeratedFiles"], entry);
        const endpoints = entry.requestedEndpoints as { from: string; to: string };
        const noPath = !reachableTo(entry.certifiedEdges, endpoints.from, endpoints.to);
        const complete = entry.completeness?.complete === true;
        const ok =
            verdict === "supported-false" &&
            root["claim"] === false &&
            path.length === 0 &&
            typeof root["reason"] === "string" &&
            root["reason"].length > 0 &&
            scopeOk &&
            cov.member &&
            cov.ratio === 1 &&
            complete &&
            noPath;
        const fc =
            verdict === "supported-false" && (cov.ratio !== null && cov.ratio < 1 ? true : cov.ratio === 1 && !cov.member ? true : null);
        return {
            status: "graded",
            pass: ok,
            detail: ok ? "certified absence with complete enumeration" : "unsupported false claim",
            predicted: "false",
            recall: null,
            precision: null,
            rangeRecall: null,
            rangePrecision: null,
            coverageRatio: cov.ratio,
            falseCompleteness: fc ?? (verdict === "supported-false" && !complete ? true : null),
        };
    }
    // Gold unknown: only an omitted-claim unknown passes.
    const ok =
        verdict === "cannot-establish" &&
        root["claim"] === undefined &&
        path.length === 0 &&
        typeof root["reason"] === "string" &&
        root["reason"].length > 0 &&
        scopeOk;
    return {
        status: "graded",
        pass: ok,
        detail: ok ? "unknown correctly withheld" : "unknown gold never matches a claim",
        predicted: "unknown",
        recall: null,
        precision: null,
        rangeRecall: null,
        rangePrecision: null,
        coverageRatio: null,
        falseCompleteness: null,
    };
}

function gradeEvidenceChain(task: InspectTask, entry: TaskGraderContext, parsed: unknown): GradeInspectResult {
    const gold = task.gold;
    if (gold.kind !== "evidence-chain") return goldInvalid("gold kind mismatch for evidence-chain");
    const root = parsed as Record<string, unknown>;
    const inner = root["answer"] as Record<string, unknown>;
    const ranges = inner["ranges"] as { path: string; start: number; end: number }[];
    const relations = inner["relations"] as InspectRelation[];
    const coverage = root["coverage"] as Record<string, unknown>;
    const tracked = new Set(entry.trackedFiles);
    const goldRangeIds = new Set(gold.patch.ranges.map((r) => `${normOnce(r.path, task)}\n${r.start}\n${r.end}`));
    const validRanges = ranges.filter(
        (r) =>
            tracked.has(r.path) &&
            inScope(r.path, task.scope) &&
            witnessSupported({ path: r.path, line: r.start }, entry, tracked) &&
            witnessSupported({ path: r.path, line: r.end }, entry, tracked),
    );
    const validIds = validRanges.map((r) => `${r.path}\n${r.start}\n${r.end}`);
    const used = new Set<number>();
    let rangeHits = 0;
    for (const id of goldRangeIds) {
        const idx = validIds.findIndex((v, i) => !used.has(i) && v === id);
        if (idx !== -1) {
            used.add(idx);
            rangeHits++;
        }
    }
    const rangeRecall = gold.patch.ranges.length === 0 ? 0 : rangeHits / gold.patch.ranges.length;
    const rangePrecision = ranges.length === 0 ? 0 : rangeHits / ranges.length;
    const relHits = countHits(relations, gold.relations, (p) => supportedRelationHit(p, gold.relations, task, entry));
    const { recall, precision } = setMetrics(relHits, relations.length, gold.relations.length);
    const pass =
        rangeRecall >= 1 && rangePrecision >= 1 && recall >= gold.minRecall && precision >= gold.minPrecision;
    const cov = coverageOf(coverage["enumeratedFiles"], entry);
    const fc = falseCompletenessOf(coverage["claim"], cov, entry, rangeHits < gold.patch.ranges.length || relHits < gold.relations.length);
    return {
        status: "graded",
        pass,
        detail: `${rangeHits}/${gold.patch.ranges.length} ranges, ${relHits}/${gold.relations.length} relations`,
        predicted: "set",
        recall,
        precision,
        rangeRecall,
        rangePrecision,
        coverageRatio: cov.ratio,
        falseCompleteness: fc,
    };
}

function gradeLocationSet(task: InspectTask, entry: TaskGraderContext, parsed: unknown): GradeInspectResult {
    const gold = task.gold;
    if (gold.kind !== "location-set") return goldInvalid("gold kind mismatch for location-set");
    const policy = entry.negativePolicy as NegativeSetPolicy;
    const answer = (parsed as Record<string, unknown>)["answer"] as { path: string; line: number; character: number }[];
    const matches = (p: { path: string; line: number; character: number }, g: { path: string; line: number; character: number }): boolean =>
        p.path === g.path && p.line === g.line && Math.abs(p.character - g.character) <= 2;
    const hits = countHits(answer, gold.locations, (p) => gold.locations.some((g) => matches(p, g)));
    const { recall, precision } = setMetrics(hits, answer.length, gold.locations.length);
    const pass = recall >= policy.minRecall && precision >= policy.minPrecision;
    return {
        status: "graded",
        pass,
        detail: `${hits}/${gold.locations.length} locations`,
        predicted: "set",
        recall,
        precision,
        rangeRecall: null,
        rangePrecision: null,
        coverageRatio: null,
        falseCompleteness: null,
    };
}

function gradeFile(task: InspectTask, parsed: unknown): GradeInspectResult {
    const gold = task.gold;
    if (gold.kind !== "file") return goldInvalid("gold kind mismatch for file");
    const answer = (parsed as Record<string, unknown>)["answer"] as { path: string };
    const match = answer.path === gold.path;
    return {
        status: "graded",
        pass: match,
        detail: match ? "file match" : "file mismatch",
        predicted: "value",
        recall: null,
        precision: null,
        rangeRecall: null,
        rangePrecision: null,
        coverageRatio: null,
        falseCompleteness: null,
    };
}

function gradeScalar(task: InspectTask, entry: TaskGraderContext, parsed: unknown): GradeInspectResult {
    const gold = task.gold;
    if (gold.kind !== "scalar") return goldInvalid("gold kind mismatch for scalar");
    const answer = (parsed as Record<string, unknown>)["answer"] as { value: string };
    const caseSensitive = entry.scalarPolicy?.caseSensitive ?? false;
    const left = answer.value.trim();
    const right = gold.value.trim();
    const match = caseSensitive ? left === right : left.toLowerCase() === right.toLowerCase();
    return {
        status: "graded",
        pass: match,
        detail: match ? "scalar match" : "scalar mismatch",
        predicted: "value",
        recall: null,
        precision: null,
        rangeRecall: null,
        rangePrecision: null,
        coverageRatio: null,
        falseCompleteness: null,
    };
}

const NEGATIVE_FAMILIES: readonly InspectFamily[] = ["N1", "N2", "N3", "N4", "N5"];

/**
 * Grade one inspect task from a parsed final payload against the frozen
 * context. Invalid task/context -> goldInvalid (pass null); malformed
 * model payload -> modelFail (pass false); otherwise graded.
 */
export function gradeInspectTask(task: unknown, finalPayload: unknown, context: FrozenGraderContext): GradeInspectResult {
    const validated = validateInputs(task, context);
    if (!("task" in validated)) return validated;
    const { task: valid, entry } = validated;
    const normalized = withPathsNormalized(valid.answerType, finalPayload, valid);
    const shapeErrors = validateInspectFinalAnswer(valid.answerType, normalized, { taskScope: valid.scope });
    if (shapeErrors.length > 0) return modelFail(shapeErrors.join("; "));
    if (NEGATIVE_FAMILIES.includes(valid.family) && isRecord(normalized) && "coverage" in normalized) {
        return modelFail("negatives carry no coverage field");
    }
    switch (valid.answerType) {
        case "route-set":
            return gradeRouteSet(valid, entry, normalized);
        case "relation-set":
            return gradeRelationSet(valid, entry, normalized);
        case "conclusion":
            return gradeConclusion(valid, entry, normalized);
        case "evidence-chain":
            return gradeEvidenceChain(valid, entry, normalized);
        case "location-set":
            return gradeLocationSet(valid, entry, normalized);
        case "file":
            return gradeFile(valid, normalized);
        case "scalar":
            return gradeScalar(valid, entry, normalized);
    }
}
