#!/usr/bin/env npx tsx
/**
 * Paired variant-matrix over grep-e2e (internal) and external-grep reports.
 *
 * Deterministic offline reader: no engine IO, no reruns. Input is a JSON
 * spec file:
 *
 *   { baseline: string,
 *     variants: { name: { internalOff?: path, internalT040?: path,
 *                          external?: path, knobs?: string[] } },
 *     replicates?: { name: { internalOff?, internalT040?, external? } },
 *     singles?: { knob: variantName },
 *     bootstrap?: { seed, iterations } }
 *
 * Each named path is a report JSON: internal grep-e2e reports (per-query
 * `fileHit` / `readReady` fields the harness already computes — never
 * re-derived here) and external reports (per-instance `successAt5` split
 * by `formulation` into title / body cohorts).
 *
 * Cohorts per variant-vs-baseline: internal off file-hit, off read-ready,
 * t040 file-hit, t040 read-ready, external title success@5, external body
 * success@5. Wins/losses pair on matched ids; net = wins - losses; the
 * 95% interval comes from ir-metrics pairedBootstrapDiff over the
 * per-pair (variant - baseline) differences (query-level for internal,
 * repo-clustered for external with repo = instanceId prefix before `__`).
 *
 * Leave-one-out classification rule (per cohort; contribution = bundle net
 * minus (bundle-minus-X) net, single = singles[knob] variant net):
 * - additive: same sign (both zero counts) and |contribution - single| <= 1
 * - antagonistic: opposite nonzero signs, or contribution < single by >= 2
 * - synergistic: contribution > single by >= 2 (same sign or from zero)
 * Checks run in order: opposite-sign -> antagonistic; |diff| <= 1 ->
 * additive; diff >= 2 -> synergistic; otherwise antagonistic.
 *
 * Usage:
 *   npx tsx scripts/eval/judge/variant-matrix.ts --spec spec.json [--format json|md] [--out path]
 *
 * Exit 2 when an internal pair fails the pairReports contract; exit 1 on
 * missing files or malformed spec.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pairReports, type PairedReport } from "./grep-e2e-contract.js";
import { pairedBootstrapDiff } from "./ir-metrics.js";

export interface VariantPaths {
    internalOff?: string;
    internalT040?: string;
    external?: string;
    knobs?: string[];
}

export interface MatrixSpec {
    baseline: string;
    variants: Record<string, VariantPaths>;
    replicates?: Record<string, VariantPaths>;
    singles?: Record<string, string>;
    bootstrap?: { seed?: number; iterations?: number };
}

export interface ValidityEntry {
    variant: string;
    kind: "internalOff" | "internalT040" | "external";
    path: string;
    rankingKnobs: Record<string, unknown>;
    engineSourceHash: string | null;
}

export interface CohortComparison {
    cohort: string;
    baseline: string;
    variant: string;
    queryCount: number;
    unavailable: number;
    wins: string[];
    losses: string[];
    net: number;
    ci95: { estimate: number; lower: number; upper: number };
    annotatedWins: Array<{ id: string; stability: "stable" | "noise-prone" }>;
    annotatedLosses: Array<{ id: string; stability: "stable" | "noise-prone" }>;
}

export interface ReplicationEntry {
    variant: string;
    cohort: string;
    differingIds: string[];
}

export interface LeaveOneOutEntry {
    knob: string;
    cohort: string;
    differingIds: string[];
    bundleNet: number;
    minusNet: number;
    contribution: number;
    singleNet: number | null;
    classification: "additive" | "synergistic" | "antagonistic" | "unknown-single";
}

export interface MatrixResult {
    baseline: string;
    validity: ValidityEntry[];
    comparisons: CohortComparison[];
    noiseProneByCohort: Record<string, string[]>;
    replication: ReplicationEntry[];
    leaveOneOut: LeaveOneOutEntry[];
}

const RANK_KEYS = ["rankTestDemote", "rankFilename", "rankBm25k1", "rankBm25b", "rankCoverage", "rankStopwords"];

function readJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(resolve(path), "utf8"));
    } catch (err) {
        throw new Error(`missing-or-unreadable: ${path} (${err instanceof Error ? err.message : String(err)})`);
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    return (value ?? {}) as Record<string, unknown>;
}

/** Internal per-query boolean outcome map for one metric key. */
export function internalOutcomeMap(report: unknown, key: "fileHit" | "readReady"): Map<string, boolean> {
    const queries = asRecord(report).queries;
    if (!Array.isArray(queries)) throw new Error("malformed-report: missing queries array");
    const out = new Map<string, boolean>();
    for (const q of queries) {
        const row = asRecord(q);
        const qid = String(row.qid);
        const v = row[key];
        if (v === undefined) continue;
        out.set(qid, v === true);
    }
    return out;
}

/** External per-instance success map for one formulation. */
export function externalOutcomeMap(report: unknown, formulation: string): Map<string, boolean> {
    const outcomes = asRecord(report).outcomes;
    if (!Array.isArray(outcomes)) throw new Error("malformed-report: missing outcomes array");
    const out = new Map<string, boolean>();
    for (const o of outcomes) {
        const row = asRecord(o);
        if (row.formulation !== formulation) continue;
        out.set(String(row.instanceId), row.successAt5 === true);
    }
    return out;
}

function repoOf(instanceId: string): string {
    const idx = instanceId.indexOf("__");
    return idx === -1 ? instanceId : instanceId.slice(0, idx);
}

function mean(values: number[]): number {
    return values.reduce((a, b) => a + b, 0) / values.length;
}

export function compareCohort(args: {
    cohort: string;
    baseline: string;
    variant: string;
    baseMap: Map<string, boolean>;
    varMap: Map<string, boolean>;
    seed: number;
    iterations: number;
    clusters?: Map<string, string>;
    noiseProne?: Set<string>;
}): CohortComparison {
    const { baseMap, varMap } = args;
    const ids = [...baseMap.keys()].filter((id) => varMap.has(id)).sort();
    const wins: string[] = [];
    const losses: string[] = [];
    const pairs: Array<{ id: string; baseline: number; variant: number }> = [];
    let unavailable = 0;
    for (const [id, v] of varMap) {
        if (!baseMap.has(id)) unavailable++;
        void v;
    }
    for (const [id, v] of baseMap) {
        if (!varMap.has(id)) unavailable++;
        void v;
    }
    for (const id of ids) {
        const b = baseMap.get(id)!;
        const v = varMap.get(id)!;
        pairs.push({ id, baseline: b ? 1 : 0, variant: v ? 1 : 0 });
        if (v && !b) wins.push(id);
        else if (!v && b) losses.push(id);
    }
    const opts = {
        seed: args.seed,
        iterations: args.iterations,
        alpha: 0.05,
        clusters: args.clusters ? pairs.map((p) => args.clusters!.get(p.id) ?? p.id) : undefined,
    };
    const ci = pairs.length > 0
        ? pairedBootstrapDiff(pairs, mean, opts)
        : { estimate: 0, lower: 0, upper: 0, iterations: args.iterations, alpha: 0.05 };
    const noise = args.noiseProne ?? new Set<string>();
    const tag = (id: string): "stable" | "noise-prone" => (noise.has(id) ? "noise-prone" : "stable");
    return {
        cohort: args.cohort,
        baseline: args.baseline,
        variant: args.variant,
        queryCount: ids.length,
        unavailable,
        wins: [...wins].sort(),
        losses: [...losses].sort(),
        net: wins.length - losses.length,
        ci95: { estimate: ci.estimate, lower: ci.lower, upper: ci.upper },
        annotatedWins: [...wins].sort().map((id) => ({ id, stability: tag(id) })),
        annotatedLosses: [...losses].sort().map((id) => ({ id, stability: tag(id) })),
    };
}

/** Classify a leave-one-out contribution against the single-knob net. */
export function classifyContribution(contribution: number, single: number | null): LeaveOneOutEntry["classification"] {
    if (single === null) return "unknown-single";
    const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);
    if (sign(contribution) !== 0 && sign(single) !== 0 && sign(contribution) !== sign(single)) {
        return "antagonistic";
    }
    const diff = contribution - single;
    if (Math.abs(diff) <= 1) return "additive";
    if (diff >= 2) return "synergistic";
    return "antagonistic";
}

function validityFor(kind: ValidityEntry["kind"], variant: string, path: string, report: unknown): ValidityEntry {
    const root = asRecord(report);
    if (kind === "external") {
        const knobs = asRecord(root.rankingKnobs);
        const picked: Record<string, unknown> = {};
        for (const k of RANK_KEYS) if (k in knobs) picked[k] = knobs[k];
        const hash = root.engineSourceHash;
        return { variant, kind, path, rankingKnobs: picked, engineSourceHash: typeof hash === "string" ? hash : null };
    }
    const manifest = asRecord(root.manifest);
    const retrieval = asRecord(manifest.retrievalConditions ?? manifest.params);
    const picked: Record<string, unknown> = {};
    for (const k of RANK_KEYS) if (k in retrieval) picked[k] = retrieval[k];
    const hash = manifest.engineSourceHash;
    return { variant, kind, path, rankingKnobs: picked, engineSourceHash: typeof hash === "string" ? hash : null };
}

/** Refuse (throw) unless an internal pair satisfies the pairReports contract. */
export function enforceInternalPair(baseline: PairedReport, variant: PairedReport, names: { baseline: string; variant: string }): void {
    pairReports(baseline, variant, names);
}

export function buildMatrix(spec: MatrixSpec, load: (path: string) => unknown = readJson): MatrixResult {
    if (!spec.baseline || !spec.variants?.[spec.baseline]) {
        throw new Error("malformed-spec: baseline must name a variant");
    }
    const seed = spec.bootstrap?.seed ?? 42;
    const iterations = spec.bootstrap?.iterations ?? 1000;
    const validity: ValidityEntry[] = [];
    const loaded = new Map<string, unknown>();
    const get = (path: string): unknown => {
        let report = loaded.get(path);
        if (report === undefined) {
            report = load(path);
            loaded.set(path, report);
        }
        return report;
    };
    const base = spec.variants[spec.baseline]!;
    // Validity + contract enforcement for every internal pair.
    for (const [name, paths] of Object.entries(spec.variants)) {
        for (const kind of ["internalOff", "internalT040"] as const) {
            const p = paths[kind];
            if (!p) continue;
            const report = get(p);
            validity.push(validityFor(kind, name, p, report));
            if (name !== spec.baseline) {
                const basePath = base[kind];
                if (!basePath) continue;
                try {
                    enforceInternalPair(get(basePath) as PairedReport, report as PairedReport, {
                        baseline: `${spec.baseline}:${kind}`,
                        variant: `${name}:${kind}`,
                    });
                } catch (err) {
                    throw new Error(`refuses-pair: ${spec.baseline} vs ${name} (${kind}): ${err instanceof Error ? err.message : String(err)}`, { cause: err });
                }
            }
        }
        if (paths.external) {
            validity.push(validityFor("external", name, paths.external, get(paths.external)));
        }
    }

    const cohortDefs: Array<{ cohort: string; kind: "internalOff" | "internalT040" | "external"; metric: string }> = [
        { cohort: "internal-off-file-hit", kind: "internalOff", metric: "fileHit" },
        { cohort: "internal-off-read-ready", kind: "internalOff", metric: "readReady" },
        { cohort: "internal-t040-file-hit", kind: "internalT040", metric: "fileHit" },
        { cohort: "internal-t040-read-ready", kind: "internalT040", metric: "readReady" },
        { cohort: "external-title-success@5", kind: "external", metric: "title" },
        { cohort: "external-body-success@5", kind: "external", metric: "body" },
    ];
    const resolveMap = (variantName: string, def: { kind: string; metric: string }): Map<string, boolean> | null => {
        const paths = (spec.variants[variantName] ?? spec.replicates?.[variantName]) as VariantPaths | undefined;
        if (!paths) return null;
        if (def.kind === "external") {
            if (!paths.external) return null;
            return externalOutcomeMap(get(paths.external), def.metric);
        }
        const p = paths[def.kind as "internalOff" | "internalT040"];
        if (!p) return null;
        return internalOutcomeMap(get(p), def.metric as "fileHit" | "readReady");
    };

    // Replication first: noise-prone ids per cohort.
    const noiseProneByCohort = new Map<string, Set<string>>();
    const replication: ReplicationEntry[] = [];
    for (const [repName, repPaths] of Object.entries(spec.replicates ?? {})) {
        void repPaths;
        for (const def of cohortDefs) {
            const varMap = resolveMap(repName.replace(/-rep\d+$/, "").replace(/-replicate\d*$/, ""), def)
                ?? resolveMap(repName, def);
            const repMap = resolveMap(repName, def);
            const anchorName = spec.variants[repName] ? repName : repName.replace(/-rep\d+$/, "");
            void varMap;
            const anchor = resolveMap(anchorName, def);
            if (!anchor || !repMap) continue;
            const ids = new Set([...anchor.keys(), ...repMap.keys()]);
            const differing = [...ids].filter((id) => anchor.get(id) !== repMap.get(id)).sort();
            if (differing.length > 0) {
                replication.push({ variant: anchorName, cohort: def.cohort, differingIds: differing });
                let set = noiseProneByCohort.get(def.cohort);
                if (!set) {
                    set = new Set<string>();
                    noiseProneByCohort.set(def.cohort, set);
                }
                for (const id of differing) set.add(id);
            }
        }
    }

    const comparisons: CohortComparison[] = [];
    const netOf = new Map<string, number>();
    for (const [name, paths] of Object.entries(spec.variants)) {
        void paths;
        if (name === spec.baseline) continue;
        for (const def of cohortDefs) {
            const baseMap = resolveMap(spec.baseline, def);
            const varMap = resolveMap(name, def);
            if (!baseMap || !varMap) continue;
            const clusters = def.kind === "external"
                ? new Map<string, string>([...varMap.keys()].map((id) => [id, repoOf(id)]))
                : undefined;
            const comp = compareCohort({
                cohort: def.cohort,
                baseline: spec.baseline,
                variant: name,
                baseMap,
                varMap,
                seed,
                iterations,
                clusters,
                noiseProne: noiseProneByCohort.get(def.cohort),
            });
            comparisons.push(comp);
            netOf.set(`${name}\0${def.cohort}`, comp.net);
        }
    }
    const leaveOneOut: LeaveOneOutEntry[] = [];
    const bundleName = "bundle";
    if (spec.variants[bundleName]) {
        const minusNames = Object.keys(spec.variants).filter((n) => n.startsWith("bundle-minus-"));
        for (const minus of minusNames) {
            const knob = minus.slice("bundle-minus-".length);
            const singleName = spec.singles?.[knob] ?? null;
            for (const def of cohortDefs) {
                const bundleMap = resolveMap(bundleName, def);
                const minusMap = resolveMap(minus, def);
                if (!bundleMap || !minusMap) continue;
                const ids = new Set([...bundleMap.keys()].filter((id) => minusMap.has(id)));
                const differing = [...ids].filter((id) => bundleMap.get(id) !== minusMap.get(id)).sort();
                const bundleNet = netOf.get(`${bundleName}\0${def.cohort}`) ?? 0;
                const minusNet = netOf.get(`${minus}\0${def.cohort}`) ?? 0;
                const contribution = bundleNet - minusNet;
                const singleNet = singleName ? (netOf.get(`${singleName}\0${def.cohort}`) ?? null) : null;
                leaveOneOut.push({
                    knob,
                    cohort: def.cohort,
                    differingIds: differing,
                    bundleNet,
                    minusNet,
                    contribution,
                    singleNet,
                    classification: classifyContribution(contribution, singleNet),
                });
            }
        }
    }

    return {
        baseline: spec.baseline,
        validity,
        comparisons,
        noiseProneByCohort: Object.fromEntries([...noiseProneByCohort].map(([k, v]) => [k, [...v].sort()])),
        replication,
        leaveOneOut,
    };
}

export function renderMarkdown(result: MatrixResult): string {
    const lines: string[] = [`# Variant matrix (baseline: ${result.baseline})`, ""];
    lines.push("## Validity", "");
    lines.push("| variant | report | ranking knobs | engineSourceHash |");
    lines.push("|---|---|---|---|");
    for (const v of result.validity) {
        const knobs = Object.keys(v.rankingKnobs).length === 0
            ? "(defaults)"
            : Object.entries(v.rankingKnobs).map(([k, val]) => `${k}=${JSON.stringify(val)}`).join(" ");
        lines.push(`| ${v.variant} | ${v.kind} ${v.path} | ${knobs} | ${v.engineSourceHash ?? "(absent)"} |`);
    }
    lines.push("", "## Paired comparisons", "");
    for (const c of result.comparisons) {
        lines.push(`### ${c.variant} — ${c.cohort}`);
        lines.push(`net ${c.net} (+${c.wins.length}/-${c.losses.length}, n=${c.queryCount}, unavailable=${c.unavailable}) 95% CI [${c.ci95.lower.toFixed(3)}, ${c.ci95.upper.toFixed(3)}]`);
        lines.push(`wins: ${c.annotatedWins.map((w) => `${w.id}(${w.stability})`).join(" ") || "(none)"}`);
        lines.push(`losses: ${c.annotatedLosses.map((w) => `${w.id}(${w.stability})`).join(" ") || "(none)"}`);
        lines.push("");
    }
    if (result.replication.length > 0) {
        lines.push("## Replication", "");
        for (const r of result.replication) {
            lines.push(`- ${r.variant} ${r.cohort}: differs on ${r.differingIds.join(" ") || "(none)"}`);
        }
        lines.push("");
    }
    if (result.leaveOneOut.length > 0) {
        lines.push("## Leave-one-out", "");
        for (const l of result.leaveOneOut) {
            lines.push(`- minus-${l.knob} ${l.cohort}: contribution=${l.contribution} (bundle ${l.bundleNet} − minus ${l.minusNet}) single=${l.singleNet ?? "?"} → ${l.classification}; differs: ${l.differingIds.join(" ") || "(none)"}`);
        }
        lines.push("");
    }
    return lines.join("\n");
}

function usage(): never {
    console.log("Usage: npx tsx scripts/eval/judge/variant-matrix.ts --spec spec.json [--format json|md] [--out path]");
    process.exit(1);
}

const entryArg = process.argv[1] ?? "";
if (entryArg.endsWith("variant-matrix.ts")) {
    const argv = process.argv.slice(2);
    let specPath: string | null = null;
    let format = "md";
    let out: string | null = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--spec") specPath = argv[++i] ?? null;
        else if (arg === "--format") format = argv[++i] ?? "md";
        else if (arg === "--out") out = argv[++i] ?? null;
        else usage();
    }
    if (!specPath) usage();
    try {
        const spec = readJson(specPath!) as MatrixSpec;
        const result = buildMatrix(spec);
        const text = format === "json" ? JSON.stringify(result, null, 2) : renderMarkdown(result);
        if (out) writeFileSync(resolve(out), text);
        else console.log(text);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        process.exit(message.startsWith("refuses-pair:") ? 2 : 1);
    }
}
