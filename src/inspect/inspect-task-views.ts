import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, resolve, relative, join } from "node:path";
import { extractStructuralFacts } from "../structural/structural-facts.js";
import { DEFAULT_SCOPE_LIMITS, enumerateBoundedScope } from "./inspect-bounded-scope.js";
import { buildBoundariesSection } from "./inspect-directory.js";
import { runGitDiff, renderDiffSection } from "./inspect-diff.js";
import { extractRoutesFromSource, type RouteInfo } from "./route-extraction.js";
import {
    DEFAULT_INSPECT_BUDGET,
    admitInspectWork,
    validateInspectTaskCompatibility,
    type InspectBudget,
    type InspectCoverage,
    type InspectSectionRecord,
    type InspectTaskStatus,
    type InspectTaskView,
} from "./inspect-task-contract.js";
import type { DiffTarget } from "./inspect-types.js";

export interface TaskViewInput {
    view: InspectTaskView;
    mode: "file" | "directory";
    path: string;
    cwd: string;
    diff?: DiffTarget;
    budget?: InspectBudget;
    signal?: AbortSignal;
}

export interface TaskViewResult {
    view: InspectTaskView;
    mode: TaskViewInput["mode"];
    canonicalScope: string;
    status: InspectTaskStatus;
    coverage: InspectCoverage;
    sections: InspectSectionRecord[];
    text: string;
}

export interface TaskViewDeps {
    readFile?: (path: string, encoding: "utf8") => Promise<string>;
    runGitDiff?: typeof runGitDiff;
    enumerateScope?: typeof enumerateBoundedScope;
}

const ROUTE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"]);
const ROUTE_SKIPPED_DIRS = new Set(["node_modules", ".git", ".next", ".nuxt", "dist", "build", ".pi-smartread", ".pi", "__pycache__", ".turbo", "coverage"]);
function routeText(routes: RouteInfo[]): string {
    if (routes.length === 0) return "## HTTP Routes\n\n(no routes found)";
    const lines = [`## HTTP Routes (${routes.length} routes)`, ""];
    for (const route of routes) {
        lines.push(`${route.file}:`, `  ${route.method.padEnd(7)} ${route.path.padEnd(30)} → ${route.handler ?? "(handler)"}  L${route.line}`);
    }
    return lines.join("\n");
}

export async function executeTaskView(input: TaskViewInput, deps: TaskViewDeps = {}): Promise<TaskViewResult> {
    validateInspectTaskCompatibility({
        view: input.view,
        mode: input.mode,
        hasAnalysis: Object.hasOwn(input, "analysis"),
        diff: input.diff,
        targetIsDirectory: input.mode === "directory",
    });
    const canonicalCwd = await realpath(input.cwd);
    const requestedPath = resolve(canonicalCwd, input.path);
    const targetStat = await lstat(requestedPath);
    const isDirectory = targetStat.isDirectory();
    validateInspectTaskCompatibility({
        view: input.view,
        mode: input.mode,
        hasAnalysis: Object.hasOwn(input, "analysis"),
        diff: input.diff,
        targetIsDirectory: isDirectory,
    });
    const canonicalScope = await realpath(requestedPath);
    const budget = input.budget ?? DEFAULT_INSPECT_BUDGET;
    const admission = admitInspectWork({ ...budget, stages: 1, candidates: 0, scannedFiles: 0, scannedBytes: 0, corroborationFiles: 0, wallMs: 0, outputBytes: 0 }, budget);
    if (!admission.admitted) throw new Error(`Error: inspect task budget exceeded: ${admission.reasons.join("; ")}`);

    const record = (relationKind: string, coverage: InspectCoverage, details: Partial<InspectSectionRecord> = {}): InspectSectionRecord => ({
        scope: canonicalScope,
        relationKind,
        inspectedCount: null,
        displayedCount: null,
        omissions: [],
        unresolved: [],
        failures: [],
        coverage,
        citations: [],
        ...details,
    });

    let text: string;
    let section: InspectSectionRecord;
    let status: InspectTaskStatus = "ok";

    if (input.view === "change-review") {
        const diffRunner = deps.runGitDiff ?? runGitDiff;
        const changes = await diffRunner(input.diff!, canonicalScope);
        const rendered = await renderDiffSection(input.diff!, canonicalScope);
        const count = changes?.length ?? null;
        section = record("diff", changes === null ? "unknown" : "complete", {
            inspectedCount: count,
            displayedCount: count,
            failures: changes === null ? ["git diff unavailable"] : [],
        });
        text = rendered.text;
        if (changes === null) status = "unavailable";
    } else if (input.view === "routes") {
        if (input.mode === "file") {
            let source: string;
            try {
                source = await (deps.readFile ?? ((path, encoding) => readFile(path, encoding)))(canonicalScope, "utf8");
                const routes = extractRoutesFromSource(source, canonicalScope);
                text = routeText(routes);
                section = record("routes", "complete", { inspectedCount: 1, displayedCount: routes.length });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                text = "## HTTP Routes\n\n(route extraction failed)";
                section = record("routes", "partial", { inspectedCount: 1, displayedCount: 0, failures: [message] });
                status = "partial";
            }
        } else {
            const enumerate = deps.enumerateScope ?? enumerateBoundedScope;
            const scope = await enumerate(canonicalScope, { limits: DEFAULT_SCOPE_LIMITS, signal: input.signal });
            const omitted = scope.omitted.map((item) => `${item.path}: ${item.reason}${item.detail ? ` (${item.detail})` : ""}; count: 1`);
            const failures: string[] = [];
            let skippedFiles = 0;
            const routes: RouteInfo[] = [];
            const read = deps.readFile ?? ((path, encoding) => readFile(path, encoding));
            for (const file of scope.files) {
                const components = file.path.split("/");
                const skippedDirectory = components.slice(0, -1).find((part) => ROUTE_SKIPPED_DIRS.has(part) || part.startsWith("."));
                if (skippedDirectory) {
                    omitted.push(`${file.path}: skipped-listed-directory (${skippedDirectory}); count: 1`);
                    skippedFiles++;
                    continue;
                }
                if (!ROUTE_EXTENSIONS.has(extname(file.path).toLowerCase())) continue;
                try {
                    const source = await read(join(canonicalScope, file.path), "utf8");
                    routes.push(...extractRoutesFromSource(source, file.path));
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    failures.push(`${file.path}: ${message}`);
                    omitted.push(`${file.path}: read-failed (${message}); count: 1`);
                }
            }
            text = routeText(routes);
            if (skippedFiles > 0) omitted.push(`listed-directory skipped files: ${skippedFiles}`);
            if (scope.status !== "complete" && scope.stopReason) omitted.push(`enumeration incomplete: ${scope.stopReason}`);
            const coverage: InspectCoverage = scope.status === "unknown" && scope.emittedFiles === 0 ? "unknown" : scope.status === "complete" && failures.length === 0 && omitted.length === 0 ? "complete" : "partial";
            section = record("routes", coverage, {
                inspectedCount: scope.emittedFiles,
                displayedCount: routes.length,
                omissions: omitted,
                failures,
                truncationReason: scope.stopReason,
            });
            if (coverage !== "complete") status = "partial";
        }
    } else if (input.view === "architecture") {
        text = buildBoundariesSection(canonicalScope);
        section = record("service-boundaries", "complete", { inspectedCount: null, displayedCount: null });
    } else if (input.view === "overview" && input.mode === "directory") {
        const enumerate = deps.enumerateScope ?? enumerateBoundedScope;
        const scope = await enumerate(canonicalScope, { limits: DEFAULT_SCOPE_LIMITS, signal: input.signal });
        const omitted = scope.omitted.map((item) => `${item.path}: ${item.reason}${item.detail ? ` (${item.detail})` : ""}; count: 1`);
        if (scope.status !== "complete" && scope.stopReason) omitted.push(`enumeration incomplete: ${scope.stopReason}`);
        const coverage: InspectCoverage = scope.status === "complete" && omitted.length === 0 ? "complete" : scope.status === "unknown" ? "unknown" : "partial";
        text = `## Structural Overview: ${canonicalScope}\n\nSource files inspected: ${scope.emittedFiles}\nCoverage: ${coverage}`;
        section = record("structural-overview", coverage, { inspectedCount: scope.emittedFiles, displayedCount: scope.emittedFiles, omissions: omitted, truncationReason: scope.stopReason });
        if (coverage !== "complete") status = "partial";
    } else {
        const facts = await extractStructuralFacts(canonicalScope, canonicalCwd, input.signal);
        if (input.view === "dependencies") {
            const lines = [`## Dependencies (${facts.dependencies.length})`, ""];
            for (const dependency of facts.dependencies) lines.push(`  ${dependency.specifier} L${dependency.line}${dependency.resolvedPath ? ` → ${relative(canonicalCwd, dependency.resolvedPath)}` : ""}`);
            text = lines.join("\n");
            section = record("dependencies", "complete", { inspectedCount: facts.dependencies.length, displayedCount: facts.dependencies.length });
        } else {
            const lines = [`## Structural Overview: ${relative(canonicalCwd, canonicalScope)}`, "", `External dependents: ${facts.externalDependents?.length ?? 0}`, `Dependencies: ${facts.dependencies.length}`, `Internal call sites: ${facts.internalCallSites.length}`, `Children: ${facts.children.length}`, `Base classes / interfaces: ${facts.baseClasses.length}`];
            text = lines.join("\n");
            section = record("structural-overview", "complete", { inspectedCount: 1, displayedCount: 1 });
        }
    }

    return { view: input.view, mode: input.mode, canonicalScope, status, coverage: section.coverage, sections: [section], text };
}
