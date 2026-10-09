/**
 * TEB (Tool Ergonomics Bench) task schema: types + runtime validation.
 *
 * Task JSONL lives outside the repo
 * (`~/.cache/pi-smartread-bench/teb/{pilot,dev,holdout}.jsonl`, mode 0600);
 * only this schema/validator lives in-repo (mirrors the D46
 * schema/validator pattern). No dependencies beyond node builtins.
 *
 * Binding inputs: E6/E7/E10 in
 * `docs/plans/2026-10-07-tool-ergonomics-decision-log.md`; the protocol
 * §3 task JSONL layout in `docs/plans/2026-10-07-teb-protocol.md` as
 * amended by E10 (oracle R4 recheck): `useSite` is optional and absent
 * for non-semantic families, semantic tasks carry
 * `anchorKind: "use" | "definition"` (required when `useSite` is present;
 * `callers` tasks anchor at the definition site), `package-exports`
 * grades files only, and grader/audit-only fields
 * (`extensionForgiveness`, `caseSensitive`, `dtsTarget`, `derivation`,
 * `agreement`, `labelers`, `adjudication`) live at task top level — the
 * runner can never see them because it builds its prompt from the
 * RunnerTaskView projection only.
 */

export type TebSplit = "pilot" | "dev" | "holdout";

export type TebFamily =
    | "definition"
    | "all-references"
    | "implementations"
    | "callers"
    | "type-of-symbol"
    | "direct-importers"
    | "package-exports"
    | "http-routes"
    | "literal-location"
    | "file-by-name"
    | "config-value";

export type TebAnswerType =
    | "single-location"
    | "location-set"
    | "caller-set"
    | "file-set"
    | "file"
    | "scalar"
    | "type-string"
    | "route-set";

export type TebAnchorKind = "use" | "definition";

export type TebAgreement = "agree" | "server-only" | "compiler-only" | "adjudicated";

export const TEB_SPLITS: readonly TebSplit[] = ["pilot", "dev", "holdout"] as const;

export const TEB_FAMILIES: readonly TebFamily[] = [
    "definition",
    "all-references",
    "implementations",
    "callers",
    "type-of-symbol",
    "direct-importers",
    "package-exports",
    "http-routes",
    "literal-location",
    "file-by-name",
    "config-value",
] as const;

export const TEB_ANSWER_TYPES: readonly TebAnswerType[] = [
    "single-location",
    "location-set",
    "caller-set",
    "file-set",
    "file",
    "scalar",
    "type-string",
    "route-set",
] as const;

/** Families whose gold derives from pinned language-server semantics. */
export const TEB_SEMANTIC_FAMILIES: readonly TebFamily[] = [
    "definition",
    "all-references",
    "implementations",
    "callers",
    "type-of-symbol",
] as const;

/** Families where the correct behavior is NOT to use a specialist tool. */
export const TEB_NEGATIVE_FAMILIES: readonly TebFamily[] = [
    "literal-location",
    "file-by-name",
    "config-value",
] as const;

/** 1-based point location, repo-relative to the task subpath. */
export interface TebLocation {
    path: string;
    line: number;
    character: number;
}

export interface TebCaller {
    name: string;
    path: string;
    line: number;
}

export interface TebRoute {
    method: string;
    path: string;
    file: string;
    line: number;
}

export type TebGoldAnswer =
    | { kind: "single-location"; location: TebLocation }
    | { kind: "location-set"; locations: TebLocation[]; minRecall: number; minPrecision: number }
    | { kind: "caller-set"; callers: TebCaller[]; minRecall: number; minPrecision: number }
    | { kind: "file-set"; files: string[]; minRecall: number; minPrecision: number }
    | { kind: "route-set"; routes: TebRoute[]; minRecall: number; minPrecision: number }
    | { kind: "file"; path: string }
    | { kind: "scalar"; value: string }
    | {
          kind: "type-string";
          normalized: string;
          normalization: { arrayRewrite: boolean; dropUndefined: boolean };
      };

export interface TebOpportunity {
    /** Specialist tool(s) expected to improve evidence quality or cost. */
    tools: string[];
    /** One sentence saying how. */
    rationale: string;
    /** Example concrete calls naming real tool contracts (E10.3). */
    calls?: string[];
}


export interface TebTask {
    /** "teb-<split>-<family>-<nnn>", unique per file. */
    id: string;
    split: TebSplit;
    /** "<owner>__<name>" from repos.json. */
    repo: string;
    /** Pinned full sha, must match repos.json. */
    commit: string;
    /** Task root inside the checkout, e.g. "packages/astro". */
    subpath: string;
    family: TebFamily;
    /** Verbatim agent prompt (frozen per split). */
    prompt: string;
    /** Exact anchor named in the prompt; absent for non-semantic families. */
    useSite?: TebLocation;
    /** Required when useSite is present, forbidden otherwise. */
    anchorKind?: TebAnchorKind;
    /** Subpath-relative scope filter, "" = whole subpath. */
    scope: string;
    answerType: TebAnswerType;
    /** Normalized canonical gold; kind must match answerType. */
    gold: TebGoldAnswer;
    opportunity: TebOpportunity;
    /** True iff the family is a (−) negative-control family. */
    negativeControl: boolean;
    // Grader/audit-only fields (protocol §3 top-level layout). Never shown
    // to the agent; the runner builds its prompt from the RunnerTaskView
    // projection only.
    /** ".js→.ts forgiveness": true ONLY on prettier discovery tasks. Default false. */
    extensionForgiveness?: boolean;
    /** Scalar answers only; default false (trim + case-insensitive). */
    caseSensitive?: boolean;
    /** True iff a gold target is a .d.ts (never on prettier tasks). Default false. */
    dtsTarget?: boolean;
    /** Optional free-text note, e.g. threshold justification (E13.1). Never graded. */
    note?: string;
    /** Exact gold-derivation commands/script+version. */
    derivation: string;
    agreement: TebAgreement;
    /** Two independent source-first, tool-output-blind labelers. */
    labelers: [string, string];
    /** "agree" | "adjudicated:<note>"; non-empty note on disagreement. */
    adjudication: string;
}

/**
 * Runner-visible projection: id, prompt, and answer-shape text ONLY.
 * Gold, opportunity, thresholds, adjudication, derivation, and agreement
 * never enter the prompt builder.
 */
export interface RunnerTaskView {
    id: string;
    prompt: string;
    answerShape: string;
}

/** Frozen answer-shape text per answerType (the §4 final-answer block). */
export const TEB_ANSWER_SHAPES: Record<TebAnswerType, string> = {
    "single-location": '{"answer": {"path": "...", "line": N, "character": M}}',
    "location-set": '{"answer": [{"path": "...", "line": N, "character": M}, ...]}',
    "caller-set": '{"answer": [{"name": "...", "path": "...", "line": N}, ...]}',
    "file-set": '{"answer": {"files": ["...", ...]}}',
    "route-set": '{"answer": [{"method": "...", "path": "...", "file": "...", "line": N}, ...]}',
    file: '{"answer": {"path": "..."}}',
    scalar: '{"answer": {"value": "..."}}',
    "type-string": '{"answer": {"type": "..."}}',
};

export function answerShapeFor(answerType: TebAnswerType): string {
    return TEB_ANSWER_SHAPES[answerType];
}

/** Projects a task to the runner-visible view; drops gold/opportunity/thresholds/audit fields. */
export function toRunnerView(task: TebTask): RunnerTaskView {
    return {
        id: task.id,
        prompt: task.prompt,
        answerShape: answerShapeFor(task.answerType),
    };
}

export interface TebFamilyEntry {
    answerType: TebAnswerType;
    /** Specialist tools counting as specialist use for opportunity recall. */
    specialistTools: readonly string[];
    negativeControl: boolean;
    /** Frozen example concrete calls for the opportunity label (E10.3). */
    exampleCalls: readonly string[];
}

/**
 * Frozen family→answerType→specialist-tools table. `package-exports`
 * grades files only (E10.2); `callers` and `implementations` anchor at
 * the definition/interface site because prepareCallHierarchy is empty
 * at use sites (E10.1, E13.2). `direct-importers` is a grep/LSP
 * opportunity: no exhaustive inspect importer view exists (E13.5).
 */
export const FAMILY_TABLE: Record<TebFamily, TebFamilyEntry> = {
    definition: {
        answerType: "single-location",
        specialistTools: ["LSP"],
        negativeControl: false,
        exampleCalls: ["LSP {operation: goToDefinition, path, position}"],
    },
    "all-references": {
        answerType: "location-set",
        specialistTools: ["LSP"],
        negativeControl: false,
        exampleCalls: ["LSP {operation: findReferences, path, position}"],
    },
    implementations: {
        answerType: "location-set",
        specialistTools: ["LSP"],
        negativeControl: false,
        exampleCalls: ["LSP {operation: goToImplementation, path, position}"],
    },
    callers: {
        answerType: "caller-set",
        specialistTools: ["LSP"],
        negativeControl: false,
        exampleCalls: ["LSP {operation: prepareCallHierarchy + incomingCalls at the definition site}"],
    },
    "type-of-symbol": {
        answerType: "type-string",
        specialistTools: ["LSP"],
        negativeControl: false,
        exampleCalls: ["LSP {operation: hover, path, position}"],
    },
    "direct-importers": {
        answerType: "file-set",
        specialistTools: ["grep", "LSP"],
        negativeControl: false,
        exampleCalls: [
            'grep {pattern: "./module", structural: {language: "typescript"}}',
            "LSP {operation: findReferences, path, position}",
        ],
    },
    "package-exports": {
        answerType: "file-set",
        specialistTools: ["inspect", "read"],
        negativeControl: false,
        exampleCalls: [
            'inspect {mode: "directory", path, analysis: {boundaries: true}}',
            "read {path: package.json} + read {path: index barrel}",
        ],
    },
    "http-routes": {
        answerType: "route-set",
        specialistTools: ["inspect", "grep"],
        negativeControl: false,
        exampleCalls: [
            'inspect {mode: "file", path, analysis: {routes: true}}',
            "grep {pattern: route-registration (app.get/post, router.*)}",
        ],
    },
    "literal-location": {
        answerType: "location-set",
        specialistTools: [],
        negativeControl: true,
        exampleCalls: [],
    },
    "file-by-name": {
        answerType: "file",
        specialistTools: [],
        negativeControl: true,
        exampleCalls: [],
    },
    "config-value": {
        answerType: "scalar",
        specialistTools: [],
        negativeControl: true,
        exampleCalls: [],
    },
} as const;

/** Final-answer payloads per answerType (extract §2; no extra keys). */
export type TebFinalAnswer =
    | { answer: TebLocation }
    | { answer: TebLocation[] }
    | { answer: TebCaller[] }
    | { answer: { files: string[] } }
    | { answer: TebRoute[] }
    | { answer: { path: string } }
    | { answer: { value: string } }
    | { answer: { type: string } };

export interface TebValidationResult {
    tasks: TebTask[];
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
        return [`${where}: path must be subpath-relative: ${path}`];
    }
    if (path.split("/").some((segment) => segment === "..")) {
        return [`${where}: \`..\` segment escapes the corpus: ${path}`];
    }
    return [];
}

function checkLocation(value: unknown, where: string): string[] {
    if (!isRecord(value)) return [`${where}: not an object`];
    const errors: string[] = [];
    errors.push(...checkRepoPath(value["path"], `${where}.path`));
    if (!isOneBasedInt(value["line"])) errors.push(`${where}.line: must be a 1-based integer`);
    if (!isOneBasedInt(value["character"])) errors.push(`${where}.character: must be a 1-based integer`);
    return errors;
}

function checkThreshold(value: unknown, where: string): string[] {
    if (typeof value !== "number" || !(value > 0) || value > 1) {
        return [`${where}: must be a number in (0, 1]`];
    }
    return [];
}

const TEB_TASK_KEYS: readonly string[] = [
    "id",
    "split",
    "repo",
    "commit",
    "subpath",
    "family",
    "prompt",
    "useSite",
    "anchorKind",
    "scope",
    "answerType",
    "gold",
    "opportunity",
    "negativeControl",
    "extensionForgiveness",
    "caseSensitive",
    "dtsTarget",
    "derivation",
    "agreement",
    "labelers",
    "adjudication",
    "note",
] as const;

function checkGold(gold: unknown, answerType: TebAnswerType, prefix: string): string[] {
    if (!isRecord(gold)) return [`${prefix}.gold: not an object`];
    const kind = gold["kind"];
    const expectedKind = answerType;
    if (kind !== expectedKind) {
        return [`${prefix}.gold: kind ${JSON.stringify(kind)} does not match answerType ${answerType}`];
    }
    switch (gold["kind"]) {
        case "single-location": {
            if (!isRecord(gold["location"])) return [`${prefix}.gold.location: not an object`];
            return checkLocation(gold["location"], `${prefix}.gold.location`);
        }
        case "location-set": {
            const errors: string[] = [];
            const locations = gold["locations"];
            if (!Array.isArray(locations) || locations.length === 0) {
                errors.push(`${prefix}.gold.locations: must be a non-empty array`);
            } else {
                // §1.1.4: set-valued semantic tasks are admitted ONLY for
                // symbols with ≤ 40 in-scope references.
                if (locations.length > 40) {
                    errors.push(`${prefix}.gold.locations: ${locations.length} exceeds the 40-reference bound`);
                }
                locations.forEach((location: unknown, i: number) => {
                    errors.push(...checkLocation(location, `${prefix}.gold.locations[${i}]`));
                });
            }
            errors.push(...checkThreshold(gold["minRecall"], `${prefix}.gold.minRecall`));
            errors.push(...checkThreshold(gold["minPrecision"], `${prefix}.gold.minPrecision`));
            return errors;
        }
        case "caller-set": {
            const errors: string[] = [];
            const callers = gold["callers"];
            if (!Array.isArray(callers) || callers.length === 0) {
                errors.push(`${prefix}.gold.callers: must be a non-empty array`);
            } else {
                callers.forEach((caller: unknown, i: number) => {
                    if (!isRecord(caller)) {
                        errors.push(`${prefix}.gold.callers[${i}]: not an object`);
                        return;
                    }
                    if (!isNonEmptyString(caller["name"])) {
                        errors.push(`${prefix}.gold.callers[${i}].name: missing name`);
                    }
                    errors.push(...checkRepoPath(caller["path"], `${prefix}.gold.callers[${i}].path`));
                    if (!isOneBasedInt(caller["line"])) {
                        errors.push(`${prefix}.gold.callers[${i}].line: must be a 1-based integer`);
                    }
                });
            }
            errors.push(...checkThreshold(gold["minRecall"], `${prefix}.gold.minRecall`));
            errors.push(...checkThreshold(gold["minPrecision"], `${prefix}.gold.minPrecision`));
            return errors;
        }
        case "file-set": {
            const errors: string[] = [];
            const files = gold["files"];
            if (!Array.isArray(files) || files.length === 0) {
                errors.push(`${prefix}.gold.files: must be a non-empty array`);
            } else {
                files.forEach((file: unknown, i: number) => {
                    errors.push(...checkRepoPath(file, `${prefix}.gold.files[${i}]`));
                });
            }
            errors.push(...checkThreshold(gold["minRecall"], `${prefix}.gold.minRecall`));
            errors.push(...checkThreshold(gold["minPrecision"], `${prefix}.gold.minPrecision`));
            return errors;
        }
        case "route-set": {
            const errors: string[] = [];
            const routes = gold["routes"];
            if (!Array.isArray(routes) || routes.length === 0) {
                errors.push(`${prefix}.gold.routes: must be a non-empty array`);
            } else {
                routes.forEach((route: unknown, i: number) => {
                    if (!isRecord(route)) {
                        errors.push(`${prefix}.gold.routes[${i}]: not an object`);
                        return;
                    }
                    if (!isNonEmptyString(route["method"])) {
                        errors.push(`${prefix}.gold.routes[${i}].method: missing method`);
                    }
                    if (!isNonEmptyString(route["path"])) {
                        errors.push(`${prefix}.gold.routes[${i}].path: missing route path`);
                    }
                    errors.push(...checkRepoPath(route["file"], `${prefix}.gold.routes[${i}].file`));
                    if (!isOneBasedInt(route["line"])) {
                        errors.push(`${prefix}.gold.routes[${i}].line: must be a 1-based integer`);
                    }
                });
            }
            errors.push(...checkThreshold(gold["minRecall"], `${prefix}.gold.minRecall`));
            errors.push(...checkThreshold(gold["minPrecision"], `${prefix}.gold.minPrecision`));
            return errors;
        }
        case "file": {
            return checkRepoPath(gold["path"], `${prefix}.gold.path`);
        }
        case "scalar": {
            // Absence-style negatives are NOT used in TEB (protocol §6.4),
            // so an empty gold value can only be an echo/empty-answer trap.
            if (typeof gold["value"] !== "string" || gold["value"].length === 0) {
                return [`${prefix}.gold.value: must be a non-empty string`];
            }
            return [];
        }
        case "type-string": {
            const errors: string[] = [];
            if (!isNonEmptyString(gold["normalized"])) {
                errors.push(`${prefix}.gold.normalized: missing normalized type`);
            }
            const normalization = gold["normalization"];
            if (!isRecord(normalization)) {
                errors.push(`${prefix}.gold.normalization: not an object`);
            } else {
                if (typeof normalization["arrayRewrite"] !== "boolean") {
                    errors.push(`${prefix}.gold.normalization.arrayRewrite: must be boolean`);
                }
                if (typeof normalization["dropUndefined"] !== "boolean") {
                    errors.push(`${prefix}.gold.normalization.dropUndefined: must be boolean`);
                }
            }
            return errors;
        }
        default:
            return [`${prefix}.gold: unknown kind ${JSON.stringify(kind)}`];
    }
}

/**
 * Grader/audit-only fields live at task top level (protocol §3 layout).
 * The validator rejects misplaced combinations per the protocol.
 */
function checkGrading(task: Record<string, unknown>, prefix: string): string[] {
    const errors: string[] = [];
    const answerType = task["answerType"];
    const repo = task["repo"];
    const family = task["family"];
    const extensionForgiveness = task["extensionForgiveness"] ?? false;
    const caseSensitive = task["caseSensitive"] ?? false;
    const dtsTarget = task["dtsTarget"] ?? false;
    for (const [key, value] of [
        ["extensionForgiveness", extensionForgiveness],
        ["caseSensitive", caseSensitive],
        ["dtsTarget", dtsTarget],
    ] as const) {
        if (typeof value !== "boolean") errors.push(`${prefix}.${key}: must be boolean`);
    }
    if (caseSensitive === true && answerType !== "scalar") {
        errors.push(`${prefix}.caseSensitive: allowed on scalar answers only`);
    }
    if (extensionForgiveness === true && !(typeof repo === "string" && repo.includes("prettier"))) {
        errors.push(`${prefix}.extensionForgiveness: allowed on prettier tasks only`);
    }
    if (dtsTarget === true && typeof repo === "string" && repo.includes("prettier")) {
        errors.push(`${prefix}.dtsTarget: never on prettier tasks`);
    }
    if (
        dtsTarget === true &&
        typeof family === "string" &&
        !(TEB_SEMANTIC_FAMILIES as readonly string[]).includes(family)
    ) {
        errors.push(`${prefix}.dtsTarget: semantic families only`);
    }
    if (!isNonEmptyString(task["derivation"])) {
        errors.push(`${prefix}.derivation: missing gold provenance`);
    }
    const agreement = task["agreement"];
    if (
        agreement !== "agree" &&
        agreement !== "server-only" &&
        agreement !== "compiler-only" &&
        agreement !== "adjudicated"
    ) {
        errors.push(`${prefix}.agreement: unknown agreement ${JSON.stringify(agreement)}`);
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
    }
    return errors;
}

/**
 * Gold-bearing strings that must never appear in a task prompt (E13
 * prompt-leakage guard). Paths are the full subpath-relative gold
 * strings; `path:line` covers the `path:line:character` echo form by
 * prefix. Caller/route names and scalar/type values are matched
 * case-insensitively by the caller. Strings shorter than 2
 * characters are dropped: a single character (e.g. a one-letter
 * caller name) occurs in ordinary prose and cannot discriminate a
 * leak. Empty strings are dropped so no vacuous leak is reported.
 */
export function goldLeakStringsFor(task: TebTask): string[] {
    const leaks: string[] = [];
    const gold = task.gold;
    switch (gold.kind) {
        case "single-location":
            leaks.push(gold.location.path, `${gold.location.path}:${gold.location.line}`);
            break;
        case "location-set":
            for (const location of gold.locations) {
                leaks.push(location.path, `${location.path}:${location.line}`);
            }
            break;
        case "caller-set":
            for (const caller of gold.callers) {
                leaks.push(caller.name, caller.path, `${caller.path}:${caller.line}`);
            }
            break;
        case "file-set":
            leaks.push(...gold.files);
            break;
        case "route-set":
            for (const route of gold.routes) {
                leaks.push(route.path, route.file, `${route.file}:${route.line}`);
            }
            break;
        case "file":
            leaks.push(gold.path);
            break;
        case "scalar":
            leaks.push(gold.value);
            break;
        case "type-string":
            leaks.push(gold.normalized);
            break;
    }
    return leaks.filter((s) => s.length >= 2);
}

/**
 * Fail-closed prompt check: the prompt must not contain any gold
 * string. The exact `useSite` anchor path named in the prompt is
 * stripped first — a semantic prompt legitimately names where the
 * symbol is *used*, which may share the gold file.
 */
export function checkPromptForGoldLeak(task: TebTask, prefix: string): string[] {
    if (typeof task.prompt !== "string" || task.prompt.length === 0) return [];
    let visible = task.prompt;
    if (typeof task.useSite?.path === "string" && task.useSite.path.length > 0) {
        visible = visible.split(task.useSite.path).join("");
    }
    const lowered = visible.toLowerCase();
    const hits = goldLeakStringsFor(task).filter((leak) => lowered.includes(leak.toLowerCase()));
    if (hits.length === 0) return [];
    return [
        `${prefix}.prompt: leaks gold into the agent prompt (fail closed): ${hits.slice(0, 5).map((h) => JSON.stringify(h)).join(", ")} — reword the prompt so the answer is not embedded`,
    ];
}

export function validateTebTask(task: unknown, prefix = "task"): string[] {
    if (!isRecord(task)) return [`${prefix}: not an object`];
    const errors: string[] = [];
    for (const key of Object.keys(task)) {
        if (!(TEB_TASK_KEYS as readonly string[]).includes(key)) {
            errors.push(`${prefix}: unknown field ${JSON.stringify(key)}`);
        }
    }
    if (!isNonEmptyString(task["id"])) errors.push(`${prefix}.id: missing id`);
    const split = task["split"];
    if (!(TEB_SPLITS as readonly string[]).includes(split as string)) {
        errors.push(`${prefix}.split: unknown split ${JSON.stringify(split)}`);
    }
    if (!isNonEmptyString(task["repo"])) errors.push(`${prefix}.repo: missing repo`);
    const commit = task["commit"];
    if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
        errors.push(`${prefix}.commit: must be a full 40-hex sha`);
    }
    if (!isNonEmptyString(task["subpath"])) errors.push(`${prefix}.subpath: missing subpath`);
    const family = task["family"];
    if (!(TEB_FAMILIES as readonly string[]).includes(family as string)) {
        errors.push(`${prefix}.family: unknown family ${JSON.stringify(family)}`);
        return errors;
    }
    const entry = FAMILY_TABLE[family as TebFamily];
    if (!isNonEmptyString(task["prompt"])) errors.push(`${prefix}.prompt: missing prompt`);
    else if (isRecord(task) && isRecord(task["gold"])) {
        errors.push(...checkPromptForGoldLeak(task as unknown as TebTask, prefix));
    }
    if (typeof task["scope"] !== "string") errors.push(`${prefix}.scope: must be a string`);
    if (task["answerType"] !== entry.answerType) {
        errors.push(
            `${prefix}.answerType: ${JSON.stringify(task["answerType"])} does not match family ${family} (${entry.answerType})`,
        );
    }
    // useSite is optional and absent for non-semantic families (E10.1).
    const isSemantic = (TEB_SEMANTIC_FAMILIES as readonly string[]).includes(family as string);
    const hasUseSite = task["useSite"] !== undefined;
    if (isSemantic && !hasUseSite) {
        errors.push(`${prefix}.useSite: required for semantic family ${family}`);
    }
    if (!isSemantic && hasUseSite) {
        errors.push(`${prefix}.useSite: must be absent for non-semantic family ${family}`);
    }
    if (hasUseSite) errors.push(...checkLocation(task["useSite"], `${prefix}.useSite`));
    const anchorKind = task["anchorKind"];
    if (hasUseSite) {
        if (anchorKind !== "use" && anchorKind !== "definition") {
            errors.push(`${prefix}.anchorKind: required "use" | "definition" when useSite is present`);
        } else if (family === "callers" && anchorKind !== "definition") {
            errors.push(`${prefix}.anchorKind: callers tasks anchor at the definition site`);
        } else if (family === "implementations" && anchorKind !== "definition") {
            errors.push(`${prefix}.anchorKind: implementations tasks anchor at the definition/interface site`);
        }
    } else if (anchorKind !== undefined) {
        errors.push(`${prefix}.anchorKind: must be absent without useSite`);
    }
    if (task["answerType"] !== undefined) {
        errors.push(...checkGold(task["gold"], task["answerType"] as TebAnswerType, prefix));
    }
    const opportunity = task["opportunity"];
    if (!isRecord(opportunity)) {
        errors.push(`${prefix}.opportunity: not an object`);
    } else {
        const tools = opportunity["tools"];
        if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")) {
            errors.push(`${prefix}.opportunity.tools: must be a string array`);
        } else if (entry.negativeControl ? tools.length !== 0 : tools.length === 0) {
            errors.push(
                entry.negativeControl
                    ? `${prefix}.opportunity.tools: negative controls must list no tools`
                    : `${prefix}.opportunity.tools: non-negative tasks must name an opportunity tool`,
            );
        }
        if (!isNonEmptyString(opportunity["rationale"])) {
            errors.push(`${prefix}.opportunity.rationale: missing rationale`);
        }
        const calls = opportunity["calls"];
        if (calls !== undefined) {
            if (!Array.isArray(calls) || !calls.every((call) => isNonEmptyString(call))) {
                errors.push(`${prefix}.opportunity.calls: must be concrete call strings`);
            }
        }
    }
    if (task["negativeControl"] !== entry.negativeControl) {
        errors.push(
            `${prefix}.negativeControl: must be ${entry.negativeControl} for family ${family}`,
        );
    }
    errors.push(...checkGrading(task, prefix));
    const note = task["note"];
    if (note !== undefined && typeof note !== "string") {
        errors.push(`${prefix}.note: must be a string when present`);
    }
    return errors;
}

export function validateTebDoc(doc: unknown): TebValidationResult {
    if (!Array.isArray(doc)) return { tasks: [], errors: ["doc: must be an array of tasks"] };
    const errors: string[] = [];
    const seen = new Set<string>();
    doc.forEach((entry: unknown, index: number) => {
        const prefix = `tasks[${index}]`;
        errors.push(...validateTebTask(entry, prefix));
        if (isRecord(entry) && typeof entry["id"] === "string") {
            if (seen.has(entry["id"])) errors.push(`${prefix}.id: duplicate id ${entry["id"]}`);
            seen.add(entry["id"]);
        }
    });
    return { tasks: errors.length === 0 ? (doc as TebTask[]) : [], errors };
}

/**
 * Parses JSONL text (one task per line, UTF-8 LF) into a validated doc.
 * Blank lines are skipped; each line must parse as a JSON object.
 */
export function parseTebJsonl(text: string): TebValidationResult {
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
    return validateTebDoc(doc);
}

/** Final answers are fail-closed: unknown keys are rejected per the §4 contract. */
function checkNoExtraKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): string[] {
    const extras = Object.keys(value).filter((key) => !allowed.includes(key));
    return extras.map((key) => `${where}: unknown key ${JSON.stringify(key)}`);
}

function checkAnswerLocation(value: unknown, where: string): string[] {
    if (!isRecord(value)) return [`${where}: not an object`];
    return [
        ...checkNoExtraKeys(value, ["path", "line", "character"], where),
        ...checkLocation(value, where),
    ];
}

/** Validates a parsed final answer (last fenced json block) for an answerType. */
export function validateFinalAnswer(answerType: TebAnswerType, parsed: unknown): string[] {
    if (!isRecord(parsed)) return ["answer: not an object"];
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== "answer") {
        return ["answer: object must carry exactly the key \"answer\""];
    }
    const answer = parsed["answer"];
    switch (answerType) {
        case "single-location":
            return checkAnswerLocation(answer, "answer");
        case "location-set": {
            if (!Array.isArray(answer)) return ["answer: must be an array of locations"];
            return answer.flatMap((entry: unknown, i: number) =>
                checkAnswerLocation(entry, `answer[${i}]`),
            );
        }
        case "caller-set": {
            if (!Array.isArray(answer)) return ["answer: must be an array of callers"];
            return answer.flatMap((entry: unknown, i: number) => {
                if (!isRecord(entry)) return [`answer[${i}]: not an object`];
                const errors: string[] = checkNoExtraKeys(entry, ["name", "path", "line"], `answer[${i}]`);
                if (!isNonEmptyString(entry["name"])) errors.push(`answer[${i}].name: missing name`);
                errors.push(...checkRepoPath(entry["path"], `answer[${i}].path`));
                if (!isOneBasedInt(entry["line"])) errors.push(`answer[${i}].line: must be a 1-based integer`);
                return errors;
            });
        }
        case "file-set": {
            if (!isRecord(answer)) return ["answer: must be {files: string[]}"];
            const keyErrors = checkNoExtraKeys(answer, ["files"], "answer");
            if (keyErrors.length > 0) return keyErrors;
            if (!Array.isArray(answer["files"])) {
                return ["answer: must be {files: string[]}"];
            }
            return (answer["files"] as unknown[]).flatMap((file: unknown, i: number) =>
                checkRepoPath(file, `answer.files[${i}]`),
            );
        }
        case "route-set": {
            if (!Array.isArray(answer)) return ["answer: must be an array of routes"];
            return answer.flatMap((entry: unknown, i: number) => {
                if (!isRecord(entry)) return [`answer[${i}]: not an object`];
                const errors: string[] = checkNoExtraKeys(
                    entry,
                    ["method", "path", "file", "line"],
                    `answer[${i}]`,
                );
                if (!isNonEmptyString(entry["method"])) errors.push(`answer[${i}].method: missing method`);
                if (!isNonEmptyString(entry["path"])) errors.push(`answer[${i}].path: missing route path`);
                errors.push(...checkRepoPath(entry["file"], `answer[${i}].file`));
                if (!isOneBasedInt(entry["line"])) errors.push(`answer[${i}].line: must be a 1-based integer`);
                return errors;
            });
        }
        case "file": {
            if (!isRecord(answer)) return ["answer: must be {path: string}"];
            if (Object.keys(answer).length !== 1) return ["answer: must be {path: string}"];
            return checkRepoPath(answer["path"], "answer.path");
        }
        case "scalar": {
            if (!isRecord(answer)) return ["answer: must be {value: string}"];
            if (Object.keys(answer).length !== 1 || typeof answer["value"] !== "string") {
                return ["answer: must be {value: string}"];
            }
            return [];
        }
        case "type-string": {
            if (!isRecord(answer)) return ["answer: must be {type: string}"];
            if (Object.keys(answer).length !== 1 || typeof answer["type"] !== "string") {
                return ["answer: must be {type: string}"];
            }
            return [];
        }
    }
}
