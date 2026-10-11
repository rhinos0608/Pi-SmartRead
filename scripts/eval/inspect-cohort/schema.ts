/**
 * Inspect-opportunity cohort task schema: types + runtime validation.
 *
 * Binding inputs: `docs/plans/2026-10-08-inspect-opportunity-protocol.md`
 * (§1 corpus/eligibility, §2 families, §4 task/final-answer shape, §6 gold
 * derivation, §7 grading predicates, §8 inherited gates, §10 sealing) and
 * oracle `6654f438-1436-4802-ab64-05ed70df3b3f_oracle_output.md` §152
 * (Lane-P targets carried as targets: success +5pp with positive paired
 * CI, recall +15pp, precision ≥80%, ≤5% baseline-success losses, paired
 * negative-deterioration veto). Frozen TEB
 * (`docs/plans/2026-10-07-teb-protocol.md` §11 + §12 gates, E10 table R9)
 * is UNCHANGED and not owned here.
 *
 * Scope of this file: shape contracts only. No grader, runner, stats,
 * enumeration, labels, or product-source changes live here. Every
 * mandatory advertised field below names its future grader predicate in a
 * `Grader:` comment so a later worker can implement grading without
 * reinterpreting the contract.
 *
 * Conventions (frozen by the protocol):
 * - All `path`/`file`/`from` strings are subpath-relative, never absolute,
 *   never `./`-prefixed, never containing a `..` segment. Normalised form
 *   is the exact match identity (no case folding, no trailing-slash
 *   tolerance).
 * - All `line` values (and range `start`/`end`) are 1-based inclusive
 *   integers. Character offsets are not graded anywhere in this cohort.
 * - `patch.sha` is grader-only frozen metadata identifying the sealed
 *   diff. It is never shown to the model and no model hash is required.
 * - `conclusion` tri-state: `supported-true` / `supported-false` carry a
 *   mandatory `claim: boolean` that must agree with the verdict;
 *   `cannot-establish` OMITS `claim` (discriminated union) and is graded
 *   as unknown, NEVER coerced to false. There is currently no published
 *   consumer of `claim` outside the future grader; the omission is
 *   intentional so "unknown" cannot be misread as `claim: false`.
 * - Negative-control shapes (`location-set`, `file`, `scalar`) mirror the
 *   TEB primitive shapes field-for-field; they are redeclared here (not
 *   imported) so this seam stays dependency-free and no TEB file is
 *   touched.
 */

export type InspectSplit = "pilot" | "dev" | "holdout";

export type InspectFamily =
    | "P1"
    | "P2"
    | "P3"
    | "P4"
    | "P5"
    | "N1"
    | "N2"
    | "N3"
    | "N4"
    | "N5";

export type InspectAnswerType =
    | "route-set"
    | "relation-set"
    | "conclusion"
    | "evidence-chain"
    | "location-set"
    | "file"
    | "scalar";

export type InspectCoverageClaim = "exhaustive" | "partial";

export type InspectUnresolvedReason =
    | "dynamic-specifier"
    | "re-export-ambiguous"
    | "generated"
    | "out-of-scope";

export type InspectAgreement = "agree" | "adjudicated";

export const INSPECT_SPLITS: readonly InspectSplit[] = ["pilot", "dev", "holdout"] as const;

export const INSPECT_FAMILIES: readonly InspectFamily[] = [
    "P1",
    "P2",
    "P3",
    "P4",
    "P5",
    "N1",
    "N2",
    "N3",
    "N4",
    "N5",
] as const;

export const INSPECT_ANSWER_TYPES: readonly InspectAnswerType[] = [
    "route-set",
    "relation-set",
    "conclusion",
    "evidence-chain",
    "location-set",
    "file",
    "scalar",
] as const;

export const INSPECT_UNRESOLVED_REASONS: readonly InspectUnresolvedReason[] = [
    "dynamic-specifier",
    "re-export-ambiguous",
    "generated",
    "out-of-scope",
] as const;

/** Positive families and their answer types (protocol §2/§4). */
export const INSPECT_FAMILY_TABLE: Record<InspectFamily, { answerType: InspectAnswerType; negativeControl: boolean }> = {
    P1: { answerType: "route-set", negativeControl: false },
    P2: { answerType: "relation-set", negativeControl: false },
    P3: { answerType: "relation-set", negativeControl: false },
    P4: { answerType: "conclusion", negativeControl: false },
    P5: { answerType: "evidence-chain", negativeControl: false },
    N1: { answerType: "location-set", negativeControl: true },
    N2: { answerType: "scalar", negativeControl: true },
    N3: { answerType: "location-set", negativeControl: true },
    N4: { answerType: "location-set", negativeControl: true },
    N5: { answerType: "file", negativeControl: true },
} as const;

/** 1-based inclusive range over a normalised scope-relative path (P5). */
export interface InspectRange {
    path: string;
    start: number;
    end: number;
}

/** Source citation establishing one relation or path edge. */
export interface InspectWitness {
    path: string;
    line: number;
}

export interface InspectRoute {
    method: string;
    path: string;
    file: string;
    line: number;
}

export type InspectRelation =
    | {
          from: string;
          specifier: string;
          kind: string;
          line: number;
          witness: InspectWitness;
          resolved: string;
          unresolvedReason?: never;
      }
    | {
          from: string;
          specifier: string;
          kind: string;
          line: number;
          witness: InspectWitness;
          resolved: null;
          unresolvedReason: InspectUnresolvedReason;
      };

export interface InspectPathEdge {
    from: string;
    to: string;
    kind: string;
    witness: InspectWitness;
}

/** Coverage block shared by every positive final answer (protocol §4). */
export interface InspectCoverage {
    claim: InspectCoverageClaim;
    scope: string;
    enumeratedFiles: string[];
}

export type InspectGold =
    | { kind: "route-set"; routes: InspectRoute[]; minRecall: number; minPrecision: number }
    | { kind: "relation-set"; relations: InspectRelation[]; minRecall: number; minPrecision: number }
    | {
          kind: "conclusion";
          verdict: "supported-true" | "supported-false" | "cannot-establish";
          /** Omitted exactly when verdict is "cannot-establish" (unknown, not false). */
          claim?: boolean;
          reason: string;
          scope: string;
          path: InspectPathEdge[];
          enumeratedFiles?: string[];
      }
    | {
          kind: "evidence-chain";
          patch: { sha: string; ranges: InspectRange[] };
          relations: InspectRelation[];
          minRecall: number;
          minPrecision: number;
      }
    | { kind: "location-set"; locations: InspectLocation[] }
    | { kind: "file"; path: string }
    | { kind: "scalar"; value: string };

/** 1-based point location, scope-relative (negative controls only). */
export interface InspectLocation {
    path: string;
    line: number;
    character: number;
}

export interface InspectCandidateUniverse {
    id: string;
    sha256: string;
    count: number;
}

export interface InspectSnapshot {
    head: string;
    clean: boolean;
}

export interface InspectTask {
    /** "insp-<split>-<family>-<nnn>", unique per file. */
    id: string;
    split: InspectSplit;
    /** "<owner>__<name>" from teb/repos.json v1. */
    repo: string;
    /** Pinned full sha, must match repos.json. */
    commit: string;
    /** Task root inside the checkout, e.g. "packages/astro". */
    subpath: string;
    family: InspectFamily;
    /** Verbatim agent prompt (frozen per split). */
    prompt: string;
    /** Subpath-relative scope filter, "" = whole subpath. */
    scope: string;
    answerType: InspectAnswerType;
    /** Canonical normalized gold; kind must match answerType. */
    gold: InspectGold;
    /** Labeler-enumerated candidate universe id + hash at seal. Grader metadata only. */
    candidateUniverse: InspectCandidateUniverse;
    /** Decoy ids in scope (≥1 decoy file/match per P1–P4 task). */
    decoys: string[];
    /** True iff the family is a matched negative (N1–N5). */
    negativeControl: boolean;
    /** Exact script+version+commands. */
    derivation: string;
    agreement: InspectAgreement;
    /** Two independent source-first, engine-blind labelers. */
    labelers: [string, string];
    /** "agree" | "adjudicated:<note>"; non-empty note on disagreement. */
    adjudication: string;
    snapshot: InspectSnapshot;
    /** Never shown to the agent. */
    note?: string;
}

/**
 * Runner-visible projection: id, prompt, and answer-shape text ONLY.
 * Gold, candidateUniverse (id/hash), thresholds, adjudication,
 * derivation, snapshot, and agreement never enter the prompt builder.
 */
export interface RunnerTaskView {
    id: string;
    prompt: string;
    answerShape: string;
}

/** Frozen answer-shape text per answerType (protocol §4 final-answer block). */
export const INSPECT_ANSWER_SHAPES: Record<InspectAnswerType, string> = {
    "route-set":
        '{"answer":[{"method":"...","path":"...","file":"...","line":N}],"coverage":{"claim":"exhaustive|partial","scope":"...","enumeratedFiles":[...]}}',
    "relation-set":
        '{"answer":[{"from":"...","specifier":"...","resolved":"...|null","unresolvedReason?":"...","kind":"...","line":N,"witness":{"path":"...","line":N}}],"coverage":{"claim":"exhaustive|partial","scope":"...","enumeratedFiles":[...]}}',
    conclusion:
        '{"verdict":"supported-true|supported-false|cannot-establish","claim":true,"reason":"...","scope":"...","path":[{"from":"...","to":"...","kind":"...","witness":{"path":"...","line":N}}]}',
    "evidence-chain":
        '{"answer":{"ranges":[{"path":"...","start":N,"end":M}],"relations":[...]},"coverage":{"claim":"exhaustive|partial","scope":"...","enumeratedFiles":[...]}}',
    "location-set": '{"answer": [{"path": "...", "line": N, "character": M}, ...]}',
    file: '{"answer": {"path": "..."}}',
    scalar: '{"answer": {"value": "..."}}',
};

export function inspectAnswerShapeFor(answerType: InspectAnswerType): string {
    return INSPECT_ANSWER_SHAPES[answerType];
}

/** Projects a task to the runner-visible view; drops gold/universe/thresholds/audit fields. */
export function toInspectRunnerView(task: InspectTask): RunnerTaskView {
    return {
        id: task.id,
        prompt: task.prompt,
        answerShape: inspectAnswerShapeFor(task.answerType),
    };
}

export interface InspectValidationResult {
    tasks: InspectTask[];
    errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function isOneBasedInt(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function checkRepoPath(path: unknown, where: string): string[] {
    if (typeof path !== "string" || path.length === 0) return [`${where}: missing path`];
    if (path.startsWith("/") || path.startsWith("./")) {
        return [`${where}: path must be scope-relative: ${path}`];
    }
    if (path.split("/").some((segment) => segment === "..")) {
        return [`${where}: \`..\` segment escapes the corpus: ${path}`];
    }
    return [];
}

function checkThreshold(value: unknown, where: string): string[] {
    if (typeof value !== "number" || !(value > 0) || value > 1) {
        return [`${where}: must be a number in (0, 1]`];
    }
    return [];
}

/**
 * Scope containment on normalised scope-relative paths: "" and "." mean
 * the whole subpath (include everything); otherwise exact-or-descendant by
 * slash boundary, so scope "src" never matches "src2/x.ts". File-vs-
 * directory ambiguity is NOT resolved here (no FS lookups): a scope naming
 * a file matches exactly that file, a scope naming a directory matches the
 * directory and its descendants.
 */
function isInScope(file: string, scope: string): boolean {
    if (scope === "" || scope === ".") return true;
    const normalized = scope.endsWith("/") ? scope.slice(0, -1) : scope;
    if (normalized === "" || normalized === ".") return true;
    return file === normalized || file.startsWith(`${normalized}/`);
}

/**
 * Shared enumerated-files contract: scope-relative shape, containment in
 * the task scope, uniqueness, and sort order. Used by coverage blocks and
 * by supported-false conclusion enumeratedFiles (gold + final).
 */
function checkEnumeratedFiles(value: unknown, where: string, scope: string | undefined): string[] {
    if (!Array.isArray(value)) {
        return [`${where}: must be an array of scope-relative paths`];
    }
    const errors: string[] = [];
    const seen = new Set<string>();
    value.forEach((file: unknown, i: number) => {
        errors.push(...checkRepoPath(file, `${where}[${i}]`));
        if (typeof file === "string") {
            if (scope !== undefined && !isInScope(file, scope)) {
                errors.push(`${where}[${i}]: file ${JSON.stringify(file)} is outside the task scope ${JSON.stringify(scope)}`);
            }
            if (seen.has(file)) errors.push(`${where}[${i}]: duplicate file ${JSON.stringify(file)}`);
            seen.add(file);
        }
    });
    const sorted = [...seen].sort();
    if (JSON.stringify([...seen]) !== JSON.stringify(sorted)) {
        errors.push(`${where}: must be sorted scope-relative`);
    }
    return errors;
}

function checkWitness(value: unknown, where: string): string[] {
    if (!isRecord(value)) return [`${where}: not an object`];
    const errors: string[] = [...checkNoExtraKeys(value, ["path", "line"], where)];
    errors.push(...checkRepoPath(value["path"], `${where}.path`));
    if (!isOneBasedInt(value["line"])) errors.push(`${where}.line: must be a 1-based integer`);
    return errors;
}

function checkRange(value: unknown, where: string): string[] {
    if (!isRecord(value)) return [`${where}: not an object`];
    const errors: string[] = [...checkNoExtraKeys(value, ["path", "start", "end"], where)];
    errors.push(...checkRepoPath(value["path"], `${where}.path`));
    if (!isOneBasedInt(value["start"])) errors.push(`${where}.start: must be a 1-based integer`);
    if (!isOneBasedInt(value["end"])) errors.push(`${where}.end: must be a 1-based integer`);
    if (isOneBasedInt(value["start"]) && isOneBasedInt(value["end"]) && (value["end"] as number) < (value["start"] as number)) {
        errors.push(`${where}: end must be >= start (1-based inclusive)`);
    }
    return errors;
}

function relationIdentity(relation: InspectRelation): string {
    const resolved = relation.resolved === null ? `UNRESOLVED:${relation.unresolvedReason}` : relation.resolved;
    return `${relation.from}\n${relation.specifier}\n${resolved}\n${relation.kind}\n${relation.line}`;
}

function checkRelation(value: unknown, where: string): string[] {
    if (!isRecord(value)) return [`${where}: not an object`];
    const errors: string[] = [
        ...checkNoExtraKeys(
            value,
            ["from", "specifier", "kind", "line", "witness", "resolved", "unresolvedReason"],
            where,
        ),
    ];
    errors.push(...checkRepoPath(value["from"], `${where}.from`));
    if (!isNonEmptyString(value["specifier"])) errors.push(`${where}.specifier: missing specifier`);
    if (!isNonEmptyString(value["kind"])) errors.push(`${where}.kind: missing kind`);
    if (!isOneBasedInt(value["line"])) errors.push(`${where}.line: must be a 1-based integer`);
    errors.push(...checkWitness(value["witness"], `${where}.witness`));
    // Shared relation witness contract (protocol §4): the witness is the
    // source citation establishing THIS relation, so witness.path MUST
    // equal from and witness.line MUST equal line. Source-line validity
    // (does the cited line exist / support the claim) stays grader-only.
    if (isRecord(value["witness"])) {
        const witness = value["witness"] as Record<string, unknown>;
        if (typeof value["from"] === "string" && typeof witness["path"] === "string" && witness["path"] !== value["from"]) {
            errors.push(`${where}.witness: path must equal the relation from ${JSON.stringify(value["from"])}`);
        }
        if (isOneBasedInt(value["line"]) && witness["line"] !== value["line"]) {
            errors.push(`${where}.witness: line must equal the relation line ${JSON.stringify(value["line"])}`);
        }
    }
    const resolved = value["resolved"];
    const reason = value["unresolvedReason"];
    if (resolved === null) {
        // Grader: item fails when the required reason is missing or off-enum.
        if (!(INSPECT_UNRESOLVED_REASONS as readonly string[]).includes(reason as string)) {
            errors.push(`${where}.unresolvedReason: REQUIRED iff resolved is null (dynamic-specifier|re-export-ambiguous|generated|out-of-scope)`);
        }
    } else if (typeof resolved === "string" && resolved.length > 0) {
        // Grader: item fails when a reason is present although resolved is a string.
        if (reason !== undefined) {
            errors.push(`${where}.unresolvedReason: MUST be absent when resolved is a string`);
        }
        errors.push(...checkRepoPath(resolved, `${where}.resolved`));
    } else {
        errors.push(`${where}.resolved: must be a scope-relative path string or null`);
        if (reason !== undefined) {
            errors.push(`${where}.unresolvedReason: MUST be absent when resolved is a string`);
        }
    }
    return errors;
}

function checkDuplicateRelations(relations: InspectRelation[], where: string): string[] {
    const seen = new Set<string>();
    const errors: string[] = [];
    for (const relation of relations) {
        const id = relationIdentity(relation);
        if (seen.has(id)) errors.push(`${where}: duplicate relation identity ${JSON.stringify(id)}`);
        seen.add(id);
    }
    return errors;
}

/** Exact path+start+end range identity (gold patch ranges and final answers). */
function checkDuplicateRanges(ranges: unknown[], where: string): string[] {
    const seen = new Set<string>();
    const errors: string[] = [];
    for (const range of ranges) {
        if (isRecord(range)) {
            const id = `${range["path"]}\n${range["start"]}\n${range["end"]}`;
            if (seen.has(id)) errors.push(`${where}: duplicate range ${JSON.stringify(id)}`);
            seen.add(id);
        }
    }
    return errors;
}

function checkRoute(value: unknown, where: string): string[] {
    if (!isRecord(value)) return [`${where}: not an object`];
    const errors: string[] = [...checkNoExtraKeys(value, ["method", "path", "file", "line"], where)];
    if (!isNonEmptyString(value["method"])) errors.push(`${where}.method: missing method`);
    if (!isNonEmptyString(value["path"])) errors.push(`${where}.path: missing route path`);
    errors.push(...checkRepoPath(value["file"], `${where}.file`));
    if (!isOneBasedInt(value["line"])) errors.push(`${where}.line: must be a 1-based integer`);
    return errors;
}

function checkPathEdge(value: unknown, where: string): string[] {
    if (!isRecord(value)) return [`${where}: not an object`];
    const errors: string[] = [...checkNoExtraKeys(value, ["from", "to", "kind", "witness"], where)];
    errors.push(...checkRepoPath(value["from"], `${where}.from`));
    errors.push(...checkRepoPath(value["to"], `${where}.to`));
    if (!isNonEmptyString(value["kind"])) errors.push(`${where}.kind: missing kind`);
    errors.push(...checkWitness(value["witness"], `${where}.witness`));
    return errors;
}

function checkLocation(value: unknown, where: string): string[] {
    if (!isRecord(value)) return [`${where}: not an object`];
    const errors: string[] = [...checkNoExtraKeys(value, ["path", "line", "character"], where)];
    errors.push(...checkRepoPath(value["path"], `${where}.path`));
    if (!isOneBasedInt(value["line"])) errors.push(`${where}.line: must be a 1-based integer`);
    if (!isOneBasedInt(value["character"])) errors.push(`${where}.character: must be a 1-based integer`);
    return errors;
}

/**
 * Grader: coverage.claim "exhaustive" is checked offline against the sealed
 * scope universe; the false-completeness boolean is gated separately (§8a),
 * never merged into recall. Grader: coverage.scope must equal the task
 * scope; a non-matching scope fails the answer as malformed.
 */
function checkCoverage(value: unknown, where: string, taskScope: string | undefined): string[] {
    if (!isRecord(value)) return [`${where}: not an object`];
    const errors: string[] = [...checkNoExtraKeys(value, ["claim", "scope", "enumeratedFiles"], where)];
    if (value["claim"] !== "exhaustive" && value["claim"] !== "partial") {
        errors.push(`${where}.claim: must be "exhaustive" | "partial"`);
    }
    if (typeof value["scope"] !== "string") {
        errors.push(`${where}.scope: must be a string`);
    } else if (taskScope !== undefined && value["scope"] !== taskScope) {
        errors.push(`${where}.scope: must match the task scope ${JSON.stringify(taskScope)}`);
    }
    const files = value["enumeratedFiles"];
    errors.push(...checkEnumeratedFiles(files, `${where}.enumeratedFiles`, taskScope));
    return errors;
}

const INSPECT_TASK_KEYS: readonly string[] = [
    "id",
    "split",
    "repo",
    "commit",
    "subpath",
    "family",
    "prompt",
    "scope",
    "answerType",
    "gold",
    "candidateUniverse",
    "decoys",
    "negativeControl",
    "derivation",
    "agreement",
    "labelers",
    "adjudication",
    "snapshot",
    "note",
] as const;

function checkGold(gold: unknown, answerType: InspectAnswerType, prefix: string, taskScope: string | undefined): string[] {
    if (!isRecord(gold)) return [`${prefix}.gold: not an object`];
    if (gold["kind"] !== answerType) {
        return [`${prefix}.gold: kind ${JSON.stringify(gold["kind"])} does not match answerType ${answerType}`];
    }
    switch (gold["kind"]) {
        case "route-set": {
            const errors: string[] = [...checkNoExtraKeys(gold, ["kind", "routes", "minRecall", "minPrecision"], `${prefix}.gold`)];
            const routes = gold["routes"];
            if (!Array.isArray(routes) || routes.length === 0) {
                errors.push(`${prefix}.gold.routes: must be a non-empty array`);
            } else {
                routes.forEach((route: unknown, i: number) => {
                    errors.push(...checkRoute(route, `${prefix}.gold.routes[${i}]`));
                });
                const ids = (routes as InspectRoute[]).map((r) =>
                    isRecord(r) ? `${r["method"]}\n${r["path"]}\n${r["file"]}\n${r["line"]}` : "",
                );
                const seen = new Set<string>();
                ids.forEach((id) => {
                    if (seen.has(id)) errors.push(`${prefix}.gold.routes: duplicate route identity ${JSON.stringify(id)}`);
                    seen.add(id);
                });
            }
            // Grader: pass iff recall ≥ minRecall AND precision ≥ minPrecision.
            errors.push(...checkThreshold(gold["minRecall"], `${prefix}.gold.minRecall`));
            errors.push(...checkThreshold(gold["minPrecision"], `${prefix}.gold.minPrecision`));
            return errors;
        }
        case "relation-set": {
            const errors: string[] = [...checkNoExtraKeys(gold, ["kind", "relations", "minRecall", "minPrecision"], `${prefix}.gold`)];
            const relations = gold["relations"];
            if (!Array.isArray(relations) || relations.length === 0) {
                errors.push(`${prefix}.gold.relations: must be a non-empty array`);
            } else {
                relations.forEach((relation: unknown, i: number) => {
                    errors.push(...checkRelation(relation, `${prefix}.gold.relations[${i}]`));
                });
                if (errors.length === 0) {
                    errors.push(...checkDuplicateRelations(relations as InspectRelation[], `${prefix}.gold.relations`));
                }
            }
            // Grader: pass iff recall ≥ minRecall AND precision ≥ minPrecision.
            errors.push(...checkThreshold(gold["minRecall"], `${prefix}.gold.minRecall`));
            errors.push(...checkThreshold(gold["minPrecision"], `${prefix}.gold.minPrecision`));
            return errors;
        }
        case "conclusion": {
            const errors: string[] = [
                ...checkNoExtraKeys(
                    gold,
                    ["kind", "verdict", "claim", "reason", "scope", "path", "enumeratedFiles"],
                    `${prefix}.gold`,
                ),
            ];
            const verdict = gold["verdict"];
            if (verdict !== "supported-true" && verdict !== "supported-false" && verdict !== "cannot-establish") {
                return [`${prefix}.gold.verdict: must be supported-true | supported-false | cannot-establish`];
            }
            const claim = gold["claim"];
            const path = gold["path"];
            // Grader: supported-true requires claim true AND every path edge
            // matches a gold edge with a valid source witness; supported-false
            // requires claim false + path [] + non-empty reason citing the
            // checked boundary + sorted enumeratedFiles covering the scope
            // plus independent reference-enumeration confirmation of no path;
            // cannot-establish requires path [] + non-empty reason and is
            // graded as unknown, never false.
            if (verdict === "cannot-establish") {
                if (claim !== undefined) {
                    errors.push(`${prefix}.gold.claim: MUST be omitted when verdict is cannot-establish (unknown, not false)`);
                }
            } else if (claim !== (verdict === "supported-true")) {
                errors.push(
                    `${prefix}.gold.claim: must be ${verdict === "supported-true" ? "true" : "false"} when verdict is ${verdict}`,
                );
            }
            if (!isNonEmptyString(gold["reason"])) errors.push(`${prefix}.gold.reason: missing reason`);
            if (typeof gold["scope"] !== "string") errors.push(`${prefix}.gold.scope: must be a string`);
            if (!Array.isArray(path)) {
                errors.push(`${prefix}.gold.path: must be an array`);
            } else {
                path.forEach((edge: unknown, i: number) => {
                    errors.push(...checkPathEdge(edge, `${prefix}.gold.path[${i}]`));
                });
                if (verdict !== "supported-true" && path.length !== 0) {
                    errors.push(`${prefix}.gold.path: must be [] when verdict is ${verdict}`);
                }
                if (verdict === "supported-true" && path.length === 0) {
                    errors.push(`${prefix}.gold.path: must be non-empty when verdict is supported-true`);
                }
            }
            const enumeratedFiles = gold["enumeratedFiles"];
            if (enumeratedFiles !== undefined) {
                errors.push(...checkEnumeratedFiles(enumeratedFiles, `${prefix}.gold.enumeratedFiles`, taskScope));
            }
            // Grader: supported-false additionally requires enumeratedFiles.
            if (verdict === "supported-false" && !Array.isArray(enumeratedFiles)) {
                errors.push(`${prefix}.gold.enumeratedFiles: required when verdict is supported-false`);
            }
            return errors;
        }
        case "evidence-chain": {
            const errors: string[] = [
                ...checkNoExtraKeys(gold, ["kind", "patch", "relations", "minRecall", "minPrecision"], `${prefix}.gold`),
            ];
            const patch = gold["patch"];
            if (!isRecord(patch)) {
                errors.push(`${prefix}.gold.patch: not an object`);
            } else {
                errors.push(...checkNoExtraKeys(patch, ["sha", "ranges"], `${prefix}.gold.patch`));
                if (typeof patch["sha"] !== "string" || !/^[0-9a-f]{40}$/.test(patch["sha"])) {
                    errors.push(`${prefix}.gold.patch.sha: must be a full 40-hex sha (grader-only frozen metadata)`);
                }
                const ranges = patch["ranges"];
                if (!Array.isArray(ranges) || ranges.length === 0) {
                    errors.push(`${prefix}.gold.patch.ranges: must be a non-empty array`);
                } else {
                    ranges.forEach((range: unknown, i: number) => {
                        errors.push(...checkRange(range, `${prefix}.gold.patch.ranges[${i}]`));
                    });
                    // Grader: frozen-range recall requires every gold range
                    // matched exactly (path + start + end identity); extra,
                    // outside-scope, or unwitnessed claimed ranges penalise
                    // precision / support and are never ignored.
                    const seen = new Set<string>();
                    (ranges as InspectRange[]).forEach((range) => {
                        if (isRecord(range)) {
                            const id = `${range["path"]}\n${range["start"]}\n${range["end"]}`;
                            if (seen.has(id)) {
                                errors.push(`${prefix}.gold.patch.ranges: duplicate range ${JSON.stringify(id)}`);
                            }
                            seen.add(id);
                        }
                    });
                }
            }
            const relations = gold["relations"];
            if (!Array.isArray(relations) || relations.length === 0) {
                errors.push(`${prefix}.gold.relations: must be a non-empty array`);
            } else {
                relations.forEach((relation: unknown, i: number) => {
                    errors.push(...checkRelation(relation, `${prefix}.gold.relations[${i}]`));
                });
                if (errors.length === 0) {
                    errors.push(...checkDuplicateRelations(relations as InspectRelation[], `${prefix}.gold.relations`));
                }
            }
            // Grader: patch-range recall ≥ 1.0 on frozen ranges AND relation
            // recall/precision vs thresholds.
            errors.push(...checkThreshold(gold["minRecall"], `${prefix}.gold.minRecall`));
            errors.push(...checkThreshold(gold["minPrecision"], `${prefix}.gold.minPrecision`));
            return errors;
        }
        case "location-set": {
            const errors: string[] = [...checkNoExtraKeys(gold, ["kind", "locations"], `${prefix}.gold`)];
            const locations = gold["locations"];
            if (!Array.isArray(locations) || locations.length === 0) {
                errors.push(`${prefix}.gold.locations: must be a non-empty array`);
            } else {
                locations.forEach((location: unknown, i: number) => {
                    errors.push(...checkLocation(location, `${prefix}.gold.locations[${i}]`));
                });
            }
            return errors;
        }
        case "file": {
            const errors: string[] = [...checkNoExtraKeys(gold, ["kind", "path"], `${prefix}.gold`)];
            errors.push(...checkRepoPath(gold["path"], `${prefix}.gold.path`));
            return errors;
        }
        case "scalar": {
            const errors: string[] = [...checkNoExtraKeys(gold, ["kind", "value"], `${prefix}.gold`)];
            if (typeof gold["value"] !== "string" || gold["value"].length === 0) {
                errors.push(`${prefix}.gold.value: must be a non-empty string`);
            }
            return errors;
        }
        default:
            return [`${prefix}.gold: unknown kind ${JSON.stringify(gold["kind"])}`];
    }
}

/**
 * Gold-bearing strings that must never appear in a task prompt.
 * Anchor fields needed to pose the task (file paths, symbol names in the
 * prompt scope) are NOT leaks; answer-specific hidden content (gold
 * routes/relations/paths/reasons/enumerated universes/hashes) is.
 */
export function inspectGoldLeakStringsFor(task: InspectTask): string[] {
    const leaks: string[] = [];
    const gold = task.gold;
    switch (gold.kind) {
        case "route-set":
            for (const route of gold.routes) {
                leaks.push(route.path, route.file, `${route.file}:${route.line}`);
            }
            break;
        case "relation-set":
            for (const relation of gold.relations) {
                leaks.push(relation.specifier, relation.from);
                if (relation.resolved !== null) leaks.push(relation.resolved);
            }
            break;
        case "conclusion":
            for (const edge of gold.path) {
                leaks.push(edge.from, edge.to, `${edge.witness.path}:${edge.witness.line}`);
            }
            leaks.push(gold.reason);
            break;
        case "evidence-chain":
            for (const range of gold.patch.ranges) {
                leaks.push(range.path, `${range.path}:${range.start}`);
            }
            leaks.push(gold.patch.sha);
            for (const relation of gold.relations) {
                leaks.push(relation.specifier, relation.from);
            }
            break;
        case "location-set":
            for (const location of gold.locations) {
                leaks.push(location.path, `${location.path}:${location.line}`);
            }
            break;
        case "file":
            leaks.push(gold.path);
            break;
        case "scalar":
            leaks.push(gold.value);
            break;
    }
    leaks.push(task.candidateUniverse.sha256, task.candidateUniverse.id);
    return leaks.filter((s) => s.length >= 2);
}

/** Fail-closed prompt check: the prompt must not contain gold or sealed-universe strings. */
export function checkInspectPromptForGoldLeak(task: InspectTask, prefix: string): string[] {
    if (typeof task.prompt !== "string" || task.prompt.length === 0) return [];
    const lowered = task.prompt.toLowerCase();
    const hits = inspectGoldLeakStringsFor(task).filter((leak) => lowered.includes(leak.toLowerCase()));
    if (hits.length === 0) return [];
    return [
        `${prefix}.prompt: leaks gold into the agent prompt (fail closed): ${hits.slice(0, 5).map((h) => JSON.stringify(h)).join(", ")} — reword the prompt so the answer is not embedded`,
    ];
}

function checkCandidateUniverse(value: unknown, where: string): string[] {
    if (!isRecord(value)) return [`${where}: not an object`];
    const errors: string[] = [...checkNoExtraKeys(value, ["id", "sha256", "count"], where)];
    if (!isNonEmptyString(value["id"])) errors.push(`${where}.id: missing universe id`);
    if (typeof value["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(value["sha256"])) {
        errors.push(`${where}.sha256: must be a 64-hex sha256`);
    }
    if (typeof value["count"] !== "number" || !Number.isInteger(value["count"]) || value["count"] < 0) {
        errors.push(`${where}.count: must be a non-negative integer`);
    }
    return errors;
}

export function validateInspectTask(task: unknown, prefix = "task"): string[] {
    if (!isRecord(task)) return [`${prefix}: not an object`];
    const errors: string[] = [];
    for (const key of Object.keys(task)) {
        if (!(INSPECT_TASK_KEYS as readonly string[]).includes(key)) {
            errors.push(`${prefix}: unknown field ${JSON.stringify(key)}`);
        }
    }
    if (!isNonEmptyString(task["id"])) errors.push(`${prefix}.id: missing id`);
    const split = task["split"];
    if (!(INSPECT_SPLITS as readonly string[]).includes(split as string)) {
        errors.push(`${prefix}.split: unknown split ${JSON.stringify(split)}`);
    }
    if (!isNonEmptyString(task["repo"])) errors.push(`${prefix}.repo: missing repo`);
    const commit = task["commit"];
    if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
        errors.push(`${prefix}.commit: must be a full 40-hex sha`);
    }
    if (!isNonEmptyString(task["subpath"])) errors.push(`${prefix}.subpath: missing subpath`);
    const family = task["family"];
    if (!(INSPECT_FAMILIES as readonly string[]).includes(family as string)) {
        errors.push(`${prefix}.family: unknown family ${JSON.stringify(family)}`);
        return errors;
    }
    const entry = INSPECT_FAMILY_TABLE[family as InspectFamily];
    if (!isNonEmptyString(task["prompt"])) errors.push(`${prefix}.prompt: missing prompt`);
    else if (isRecord(task["gold"]) && isRecord(task["candidateUniverse"])) {
        errors.push(...checkInspectPromptForGoldLeak(task as unknown as InspectTask, prefix));
    }
    if (typeof task["scope"] !== "string") errors.push(`${prefix}.scope: must be a string`);
    if (task["answerType"] !== entry.answerType) {
        errors.push(
            `${prefix}.answerType: ${JSON.stringify(task["answerType"])} does not match family ${family} (${entry.answerType})`,
        );
    }
    if (task["answerType"] !== undefined) {
        const taskScope = typeof task["scope"] === "string" ? (task["scope"] as string) : undefined;
        errors.push(...checkGold(task["gold"], task["answerType"] as InspectAnswerType, prefix, taskScope));
    }
    errors.push(...checkCandidateUniverse(task["candidateUniverse"], `${prefix}.candidateUniverse`));
    const decoys = task["decoys"];
    if (!Array.isArray(decoys)) {
        errors.push(`${prefix}.decoys: must be an array of decoy ids`);
    } else {
        decoys.forEach((decoy: unknown, i: number) => {
            if (!isNonEmptyString(decoy)) errors.push(`${prefix}.decoys[${i}]: must be a non-empty string`);
        });
        if (!entry.negativeControl && decoys.length === 0) {
            errors.push(`${prefix}.decoys: positive tasks require ≥1 decoy in scope`);
        }
    }
    if (task["negativeControl"] !== entry.negativeControl) {
        errors.push(`${prefix}.negativeControl: must be ${entry.negativeControl} for family ${family}`);
    }
    if (!isNonEmptyString(task["derivation"])) {
        errors.push(`${prefix}.derivation: missing gold provenance`);
    }
    const agreement = task["agreement"];
    if (agreement !== "agree" && agreement !== "adjudicated") {
        errors.push(`${prefix}.agreement: must be "agree" | "adjudicated"`);
    }
    const labelers = task["labelers"];
    if (
        !Array.isArray(labelers) ||
        labelers.length !== 2 ||
        !isNonEmptyString(labelers[0]) ||
        !isNonEmptyString(labelers[1]) ||
        labelers[0] === labelers[1]
    ) {
        errors.push(`${prefix}.labelers: must be two distinct non-empty names`);
    }
    const adjudication = task["adjudication"];
    if (typeof adjudication !== "string") {
        errors.push(`${prefix}.adjudication: must be a string`);
    } else if (agreement !== "agree" && adjudication.length === 0) {
        errors.push(`${prefix}.adjudication: non-empty note required on disagreement`);
    } else if (agreement === "agree" && adjudication !== "agree") {
        errors.push(`${prefix}.adjudication: must be "agree" when agreement is "agree"`);
    }
    const snapshot = task["snapshot"];
    if (!isRecord(snapshot)) {
        errors.push(`${prefix}.snapshot: not an object`);
    } else {
        errors.push(...checkNoExtraKeys(snapshot, ["head", "clean"], `${prefix}.snapshot`));
        if (typeof snapshot["head"] !== "string" || !/^[0-9a-f]{40}$/.test(snapshot["head"])) {
            errors.push(`${prefix}.snapshot.head: must be a full 40-hex sha`);
        }
        if (snapshot["clean"] !== true) {
            errors.push(`${prefix}.snapshot.clean: must be true (clean tree at seal)`);
        }
    }
    const note = task["note"];
    if (note !== undefined && typeof note !== "string") {
        errors.push(`${prefix}.note: must be a string when present`);
    }
    return errors;
}

export function validateInspectDoc(doc: unknown): InspectValidationResult {
    if (!Array.isArray(doc)) return { tasks: [], errors: ["doc: must be an array of tasks"] };
    const errors: string[] = [];
    const seen = new Set<string>();
    doc.forEach((entry: unknown, index: number) => {
        const prefix = `tasks[${index}]`;
        errors.push(...validateInspectTask(entry, prefix));
        if (isRecord(entry) && typeof entry["id"] === "string") {
            if (seen.has(entry["id"])) errors.push(`${prefix}.id: duplicate id ${entry["id"]}`);
            seen.add(entry["id"]);
        }
    });
    return { tasks: errors.length === 0 ? (doc as InspectTask[]) : [], errors };
}

/**
 * Parses JSONL text (one task per line, UTF-8 LF) into a validated doc.
 * Blank lines are skipped; each line must parse as a JSON object.
 */
export function parseInspectJsonl(text: string): InspectValidationResult {
    const errors: string[] = [];
    const doc: unknown[] = [];
    text.split("\n").forEach((line, index) => {
        if (line.trim().length === 0) return;
        try {
            doc.push(JSON.parse(line) as unknown);
        } catch {
            errors.push(`line ${index + 1}: invalid JSON`);
        }
    });
    if (errors.length > 0) return { tasks: [], errors };
    return validateInspectDoc(doc);
}

/** Final answers are fail-closed: unknown keys are rejected per the §4 contract. */
function checkNoExtraKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): string[] {
    const extras = Object.keys(value).filter((key) => !allowed.includes(key));
    return extras.map((key) => `${where}: unknown key ${JSON.stringify(key)}`);
}

export interface InspectAnswerOptions {
    /** Task scope the answer coverage must match (fail-closed on mismatch). */
    taskScope?: string;
}

/** Validates a parsed final answer (last fenced json block) for an answerType. */
export function validateInspectFinalAnswer(
    answerType: InspectAnswerType,
    parsed: unknown,
    options: InspectAnswerOptions = {},
): string[] {
    if (!isRecord(parsed)) return ["answer: not an object"];
    switch (answerType) {
        case "route-set": {
            const errors: string[] = [
                ...checkNoExtraKeys(parsed, ["answer", "coverage"], "answer"),
            ];
            if (!Array.isArray(parsed["answer"])) errors.push("answer.answer: must be an array of routes");
            else {
                (parsed["answer"] as unknown[]).forEach((entry: unknown, i: number) => {
                    errors.push(...checkRoute(entry, `answer.answer[${i}]`));
                });
            }
            errors.push(...checkCoverage(parsed["coverage"], "answer.coverage", options.taskScope));
            return errors;
        }
        case "relation-set": {
            const errors: string[] = [
                ...checkNoExtraKeys(parsed, ["answer", "coverage"], "answer"),
            ];
            if (!Array.isArray(parsed["answer"])) errors.push("answer.answer: must be an array of relations");
            else {
                (parsed["answer"] as unknown[]).forEach((entry: unknown, i: number) => {
                    errors.push(...checkRelation(entry, `answer.answer[${i}]`));
                });
                if (errors.length === 0) {
                    errors.push(
                        ...checkDuplicateRelations(parsed["answer"] as InspectRelation[], "answer.answer"),
                    );
                }
            }
            errors.push(...checkCoverage(parsed["coverage"], "answer.coverage", options.taskScope));
            return errors;
        }
        case "conclusion": {
            if (!isRecord(parsed)) return ["answer: not an object"];
            const errors: string[] = [
                ...checkNoExtraKeys(
                    parsed,
                    ["verdict", "claim", "reason", "scope", "path", "enumeratedFiles"],
                    "answer",
                ),
            ];
            const verdict = parsed["verdict"];
            if (verdict !== "supported-true" && verdict !== "supported-false" && verdict !== "cannot-establish") {
                errors.push("answer.verdict: must be supported-true | supported-false | cannot-establish");
                return errors;
            }
            if (verdict === "cannot-establish") {
                if (parsed["claim"] !== undefined) {
                    errors.push("answer.claim: MUST be omitted when verdict is cannot-establish (unknown, not false)");
                }
            } else if (parsed["claim"] !== (verdict === "supported-true")) {
                errors.push(`answer.claim: must be ${verdict === "supported-true" ? "true" : "false"} when verdict is ${verdict}`);
            }
            if (!isNonEmptyString(parsed["reason"])) errors.push("answer.reason: missing reason");
            if (typeof parsed["scope"] !== "string") errors.push("answer.scope: must be a string");
            else if (options.taskScope !== undefined && parsed["scope"] !== options.taskScope) {
                errors.push("answer.scope: must match the task scope");
            }
            if (!Array.isArray(parsed["path"])) errors.push("answer.path: must be an array");
            else {
                (parsed["path"] as unknown[]).forEach((edge: unknown, i: number) => {
                    errors.push(...checkPathEdge(edge, `answer.path[${i}]`));
                });
                if (verdict !== "supported-true" && (parsed["path"] as unknown[]).length !== 0) {
                    errors.push(`answer.path: must be [] when verdict is ${verdict}`);
                }
                if (verdict === "supported-true" && (parsed["path"] as unknown[]).length === 0) {
                    errors.push("answer.path: must be non-empty when verdict is supported-true");
                }
            }
            if (parsed["enumeratedFiles"] !== undefined) {
                errors.push(
                    ...checkEnumeratedFiles(parsed["enumeratedFiles"], "answer.enumeratedFiles", options.taskScope),
                );
            }
            if (verdict === "supported-false" && !Array.isArray(parsed["enumeratedFiles"])) {
                errors.push("answer.enumeratedFiles: required when verdict is supported-false");
            }
            return errors;
        }
        case "evidence-chain": {
            const errors: string[] = [
                ...checkNoExtraKeys(parsed, ["answer", "coverage"], "answer"),
            ];
            const inner = parsed["answer"];
            if (!isRecord(inner)) {
                errors.push("answer.answer: must be {ranges, relations}");
            } else {
                errors.push(...checkNoExtraKeys(inner, ["ranges", "relations"], "answer.answer"));
                if (!Array.isArray(inner["ranges"]) || (inner["ranges"] as unknown[]).length === 0) {
                    errors.push("answer.answer.ranges: must be a non-empty array");
                } else {
                    (inner["ranges"] as unknown[]).forEach((range: unknown, i: number) => {
                        errors.push(...checkRange(range, `answer.answer.ranges[${i}]`));
                    });
                    errors.push(
                        ...checkDuplicateRanges(inner["ranges"] as unknown[], "answer.answer.ranges"),
                    );
                }
                if (!Array.isArray(inner["relations"])) {
                    errors.push("answer.answer.relations: must be an array of relations");
                } else {
                    (inner["relations"] as unknown[]).forEach((relation: unknown, i: number) => {
                        errors.push(...checkRelation(relation, `answer.answer.relations[${i}]`));
                    });
                }
            }
            errors.push(...checkCoverage(parsed["coverage"], "answer.coverage", options.taskScope));
            return errors;
        }
        case "location-set": {
            if (!isRecord(parsed)) return ["answer: not an object"];
            const keys = Object.keys(parsed);
            if (keys.length !== 1 || keys[0] !== "answer") {
                return ['answer: object must carry exactly the key "answer"'];
            }
            // Grader: negative controls carry NO coverage field.
            if (!Array.isArray(parsed["answer"])) return ["answer: must be an array of locations"];
            return (parsed["answer"] as unknown[]).flatMap((entry: unknown, i: number) =>
                checkLocation(entry, `answer[${i}]`),
            );
        }
        case "file": {
            if (!isRecord(parsed)) return ["answer: not an object"];
            const keys = Object.keys(parsed);
            if (keys.length !== 1 || keys[0] !== "answer") {
                return ['answer: object must carry exactly the key "answer"'];
            }
            const inner = parsed["answer"];
            if (!isRecord(inner)) return ["answer.answer: must be {path: string}"];
            const innerErrors = checkNoExtraKeys(inner, ["path"], "answer.answer");
            innerErrors.push(...checkRepoPath(inner["path"], "answer.answer.path"));
            return innerErrors;
        }
        case "scalar": {
            if (!isRecord(parsed)) return ["answer: not an object"];
            const keys = Object.keys(parsed);
            if (keys.length !== 1 || keys[0] !== "answer") {
                return ['answer: object must carry exactly the key "answer"'];
            }
            const answer = parsed["answer"];
            if (!isRecord(answer)) return ["answer: must be {value: string}"];
            if (Object.keys(answer).length !== 1 || typeof answer["value"] !== "string") {
                return ["answer: must be {value: string}"];
            }
            return [];
        }
    }
}

export interface CoverageSignal {
    /** Declared claim, or null when the answer has no well-formed coverage block. */
    claim: InspectCoverageClaim | null;
    /** Enumerated-file count, or null when not a well-formed array. */
    enumeratedCount: number | null;
    /**
     * Structural direction tag only (NOT a semantic grade):
     * - coverageRatio HIGH is GOOD (descriptive enumeration breadth);
     * - falseCompleteFlag HIGH/true is BAD (exhaustive claim over an
     *   incompletely enumerated scope).
     * The future grader computes the boolean against the sealed universe;
     * this helper only tags what the answer structurally declares.
     */
    coverageRatio: number | null;
    falseCompleteFlag: boolean;
}

/**
 * Structurally tags an answer's completeness posture. `universeTotal` is
 * the sealed scope-universe size (grader metadata, never model-visible);
 * `independentlyConfirmedComplete` records whether independent enumeration
 * affirmatively confirmed a complete scope (required before an empty
 * universe may yield coverage 1 — otherwise completeness is unknown).
 * Pure: no grading, no I/O.
 */
export function tagCoverageSignal(
    coverage: unknown,
    universeTotal: number | null,
    independentlyConfirmedComplete: boolean,
): CoverageSignal {
    if (!isRecord(coverage) || !Array.isArray(coverage["enumeratedFiles"])) {
        return { claim: null, enumeratedCount: null, coverageRatio: null, falseCompleteFlag: false };
    }
    const claim = coverage["claim"];
    const enumeratedCount = (coverage["enumeratedFiles"] as unknown[]).length;
    const validClaim = claim === "exhaustive" || claim === "partial" ? claim : null;
    if (validClaim === null) {
        return { claim: null, enumeratedCount, coverageRatio: null, falseCompleteFlag: false };
    }
    if (universeTotal === null || universeTotal < 0) {
        return { claim: validClaim, enumeratedCount, coverageRatio: null, falseCompleteFlag: false };
    }
    if (universeTotal === 0) {
        return {
            claim: validClaim,
            enumeratedCount,
            coverageRatio: independentlyConfirmedComplete ? 1 : null,
            falseCompleteFlag: validClaim === "exhaustive" && !independentlyConfirmedComplete,
        };
    }
    return {
        claim: validClaim,
        enumeratedCount,
        coverageRatio: enumeratedCount / universeTotal,
        falseCompleteFlag: validClaim === "exhaustive" && enumeratedCount < universeTotal,
    };
}
