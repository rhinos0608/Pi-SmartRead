import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { DEFAULT_SCOPE_LIMITS, enumerateBoundedScope, type BoundedScopeLimits, type ScopeFile } from "./inspect-bounded-scope.js";
import { admitInspectWork, DEFAULT_INSPECT_BUDGET, GATHER_RECIPE_BY_VIEW, type GatherRecipe, type InspectBudget, type InspectCitation, type InspectTaskStatus, type InspectTaskView } from "./inspect-task-contract.js";

export interface GatherRelation {
    source: string;
    target: string;
    kind: "import" | "manifest-dep" | "workspace-import";
    specifier: string;
    resolutionRule: string;
    citation: InspectCitation & { range: { start: number; end: number }; specifier: string; resolutionRule: string };
}
export interface GatherUnresolved { source: string; specifier: string; reason: string; citation: InspectCitation & { range: { start: number; end: number }; specifier: string; resolutionRule: string } }
export interface GatherStage { name: string; args: Record<string, unknown>; derivation: string; status: InspectTaskStatus | "not-run"; observed: { files: number | null; bytes: number | null; wallMs: number | null; outputBytes: number | null } }
export interface GatherSection { name: string; status: InspectTaskStatus; coverage: "complete" | "partial" | "unknown"; items: unknown[]; omissions: string[] }
export interface GatherResult {
    recipe: GatherRecipe;
    sections: GatherSection[];
    status: InspectTaskStatus;
    coverage: "complete" | "partial" | "unknown";
    relations: GatherRelation[];
    unresolved: GatherUnresolved[];
    followups: string[];
    stages: GatherStage[];
    omissions: string[];
    heuristics: string[];
}
export interface GatherInput {
    mode: "file" | "directory";
    /** Canonical requested scope; a file mode root is the target source file. */
    root: string;
    budget: InspectBudget;
    limits?: BoundedScopeLimits;
    signal?: AbortSignal;
    now?: () => number;
    sourceReader?: (relativePath: string, absolutePath: string) => Promise<string>;
    diffProvider?: () => Promise<string>;
    boundedBuilder?: (files: readonly ScopeFile[], signal?: AbortSignal) => Promise<{ bounded: boolean; cancellation: boolean; value: unknown }>;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"];
const IMPORT_PATTERN = /\b(?:import\s+(?:[^;]*?\s+from\s+)?|export\s+[^;]*?\s+from\s+|require\s*\()(["'])([^"'\n]+)\1/g;
const DYNAMIC_PATTERN = /\b(?:import|require)\s*\(\s*(?!["'])[^)]*\)|\b(?:import|require)\s*`[^`]*`/g;
const LITERAL_DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;
const SOURCE_SUFFIX = /\.(?:ts|tsx|js|jsx|mjs|cjs|d\.ts)$/;

function stage(name: string, derivation: string): GatherStage { return { name, args: {}, derivation, status: "not-run", observed: { files: null, bytes: null, wallMs: null, outputBytes: null } }; }
function aborted(signal?: AbortSignal): boolean { return signal?.aborted === true; }
function targetCandidates(path: string): string[] {
    const ext = extname(path);
    if (ext) return [path, ...SOURCE_EXTENSIONS.filter((suffix) => suffix !== ext).map((suffix) => `${path.slice(0, -ext.length)}${suffix}`)];
    return [path, ...SOURCE_EXTENSIONS.map((suffix) => `${path}${suffix}`), ...SOURCE_EXTENSIONS.map((suffix) => join(path, `index${suffix}`))];
}
function maskComments(source: string): string {
    const chars = [...source];
    let quote: "'" | '"' | "`" | undefined;
    let lineComment = false;
    let blockComment = false;
    for (let i = 0; i < chars.length; i++) {
        const char = chars[i]!;
        const next = chars[i + 1];
        if (lineComment) {
            if (char === "\n") lineComment = false;
            else chars[i] = " ";
            continue;
        }
        if (blockComment) {
            if (char === "*" && next === "/") { chars[i] = " "; chars[i + 1] = " "; i++; blockComment = false; }
            else if (char !== "\n") chars[i] = " ";
            continue;
        }
        if (quote) {
            if (char === "\\") { i++; continue; }
            if (char === quote) quote = undefined;
            continue;
        }
        if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
        if (char === "/" && next === "/") { chars[i] = " "; chars[i + 1] = " "; i++; lineComment = true; }
        else if (char === "/" && next === "*") { chars[i] = " "; chars[i + 1] = " "; i++; blockComment = true; }
    }
    return chars.join("");
}
function extractImports(source: string): Array<{ specifier: string; line: number }> {
    const code = maskComments(source);
    const found: Array<{ specifier: string; line: number }> = [];
    for (const match of code.matchAll(IMPORT_PATTERN)) {
        const offset = match.index ?? 0;
        found.push({ specifier: match[2]!, line: code.slice(0, offset).split("\n").length });
    }
    for (const match of code.matchAll(LITERAL_DYNAMIC_IMPORT_PATTERN)) {
        const offset = match.index ?? 0;
        found.push({ specifier: match[2]!, line: code.slice(0, offset).split("\n").length });
    }
    for (const match of code.matchAll(DYNAMIC_PATTERN)) {
        const offset = match.index ?? 0;
        found.push({ specifier: "<dynamic>", line: code.slice(0, offset).split("\n").length });
    }
    return found.sort((a, b) => a.line - b.line || compareText(a.specifier, b.specifier));
}
function sourceLike(path: string): boolean { return SOURCE_SUFFIX.test(path); }
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value) ?? ""); }
function isWithin(root: string, target: string): boolean {
    const rel = relative(root, target);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maxBytes) throw new Error("source exceeds the per-file bound");
        const buffer = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < buffer.length) {
            const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        const extra = Buffer.alloc(1);
        const { bytesRead } = await handle.read(extra, 0, 1, offset);
        if (bytesRead > 0) throw new Error("source grew beyond the per-file bound");
        return buffer.subarray(0, offset).toString("utf8");
    } finally { await handle.close(); }
}
function diffRanges(diff: string): Map<string, Array<{ start: number; end: number }>> {
    const ranges = new Map<string, Array<{ start: number; end: number }>>();
    let path: string | undefined;
    for (const line of diff.split("\n")) {
        const file = /^\+\+\+ b\/(.+)$/.exec(line);
        if (file) { path = file[1]; continue; }
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (!hunk || !path) continue;
        const start = Number(hunk[1]); const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
        const list = ranges.get(path) ?? []; list.push({ start, end: start + Math.max(0, count - 1) }); ranges.set(path, list);
    }
    return ranges;
}
type PackageManifest = { name?: string; main?: string; types?: string; typings?: string; module?: string; exports?: unknown; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; workspaces?: string[] | { packages?: string[] } };
function manifestEntry(manifest: PackageManifest): string {
    const exportEntry = (value: unknown): string | undefined => {
        if (typeof value === "string") return value;
        if (!value || typeof value !== "object") return undefined;
        const record = value as Record<string, unknown>;
        for (const key of ["types", "import", "require", "default"]) { const found = exportEntry(record[key]); if (found) return found; }
        for (const child of Object.values(record)) { const found = exportEntry(child); if (found) return found; }
        return undefined;
    };
    const exportsMap = manifest.exports && typeof manifest.exports === "object" ? manifest.exports as Record<string, unknown> : undefined;
    const rootExport = exportsMap && Object.prototype.hasOwnProperty.call(exportsMap, ".") ? exportEntry(exportsMap["."]) : exportEntry(manifest.exports);
    return rootExport ?? manifest.types ?? manifest.typings ?? manifest.module ?? manifest.main ?? "index.js";
}
function packageName(specifier: string): string {
    const parts = specifier.split("/");
    return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}
function workspacePatterns(manifest: PackageManifest): string[] {
    const workspaces = manifest.workspaces;
    return Array.isArray(workspaces) ? workspaces : workspaces?.packages ?? [];
}
function matchesWorkspacePattern(path: string, patterns: string[]): boolean {
    const pathParts = path.replace(/\\/g, "/").split("/");
    const matches = (patternParts: string[], pathIndex = 0, patternIndex = 0): boolean => {
        if (patternIndex === patternParts.length) return pathIndex === pathParts.length;
        const part = patternParts[patternIndex]!;
        if (part === "**") return matches(patternParts, pathIndex, patternIndex + 1) || (pathIndex < pathParts.length && matches(patternParts, pathIndex + 1, patternIndex));
        if (pathIndex >= pathParts.length || (part !== "*" && part !== pathParts[pathIndex])) return false;
        return matches(patternParts, pathIndex + 1, patternIndex + 1);
    };
    const normalized = patterns.map((pattern) => ({ exclude: pattern.startsWith("!"), parts: pattern.replace(/^!/, "").replace(/\\/g, "/").replace(/\/$/, "").split("/") }));
    const included = normalized.filter((pattern) => !pattern.exclude).some((pattern) => matches(pattern.parts));
    return included && !normalized.filter((pattern) => pattern.exclude).some((pattern) => matches(pattern.parts));
}

export async function runGatherRecipe(view: InspectTaskView, input: Omit<GatherInput, "budget"> & { budget?: InspectBudget }): Promise<GatherResult> {
    if (view !== GATHER_RECIPE_BY_VIEW[view]) throw new Error(`Unknown inspect gather view: ${view}`);
    const budget = input.budget ?? DEFAULT_INSPECT_BUDGET;
    const clock = input.now ?? (() => performance.now());
    const started = clock();
    const stages = [stage("candidates", "enumerate bounded admitted source scope"), stage("corroboration-targets", "sort admitted source paths deterministically"), stage("source-checks", "read and verify literal source specifiers"), stage("relations", "emit corroborated relations and unresolved references")];
    const result: GatherResult = { recipe: view, sections: [], status: "ok", coverage: "unknown", relations: [], unresolved: [], followups: [], stages, omissions: [], heuristics: [] };
    const outputFits = (value: unknown): boolean => jsonBytes({ ...result, projected: value }) <= budget.outputBytes;
    const emitRelation = (relation: GatherRelation): boolean => {
        if (!outputFits([...result.relations, ...result.unresolved, relation])) return outputRefusal();
        result.relations.push(relation); return true;
    };
    const emitUnresolved = (reference: GatherUnresolved): boolean => {
        if (!outputFits([...result.relations, ...result.unresolved, reference])) return outputRefusal();
        result.unresolved.push(reference); return true;
    };
    const outputRefusal = (): false => { result.status = "partial"; result.coverage = "partial"; result.followups.push("Retry with a scoped sub-path to stay within the output-byte budget."); return false; };
    const limits = input.limits ?? DEFAULT_SCOPE_LIMITS;
    const requestedRoot = await realpath(input.root).catch(() => undefined);
    if (!requestedRoot) { result.status = "unavailable"; result.omissions.push(`scope unavailable: ${input.root}`); return result; }
    const scopeRoot = input.mode === "file" ? dirname(requestedRoot) : requestedRoot;
    const fileTarget = input.mode === "file" ? basename(requestedRoot) : undefined;
    const enumerate = (root: string) => enumerateBoundedScope(root, { limits, signal: input.signal, deadlineMs: Math.max(0, budget.wallMs - (clock() - started)) });
    const readWithinScope = async (relativePath: string): Promise<string> => {
        const canonical = await realpath(resolve(scopeRoot, relativePath));
        if (!isWithin(scopeRoot, canonical)) throw new Error("source escapes the admitted scope");
        return input.sourceReader ? input.sourceReader(relativePath, canonical) : readBoundedFile(canonical, limits.maxBytesPerFile);
    };
    let universe: ScopeFile[] = [];
    let admittedFiles: ScopeFile[] = [];
    const sourceContents = new Map<string, string>();
    const manifestRecords = new Map<string, PackageManifest>();
    let reads = 0; let bytes = 0;
    const admitted = (extraFiles = 0, extraBytes = 0) => admitInspectWork({ stages: stages.filter((s) => s.status !== "not-run").length + 1, candidates: universe.length, scannedFiles: reads + extraFiles, scannedBytes: bytes + extraBytes, corroborationFiles: reads + extraFiles, wallMs: clock() - started, outputBytes: jsonBytes(result) }, budget);
    for (let i = 0; i < stages.length; i++) {
        const current = stages[i]!;
        if (aborted(input.signal)) { result.status = "partial"; result.coverage = "partial"; result.followups.push("Retry the gather with an active signal."); break; }
        const verdict = admitted();
        if (!verdict.admitted) { current.status = "partial"; result.status = "partial"; result.coverage = "partial"; result.followups.push(`Retry with a scoped sub-path: ${verdict.reasons.join("; ")}`); break; }
        const tick = clock();
        if (i === 0) {
            current.args = { mode: input.mode, root: requestedRoot };
            if (input.mode === "file") {
                const stat = await lstat(requestedRoot).catch(() => undefined);
                if (!stat?.isFile() || !sourceLike(requestedRoot)) { current.status = "failed"; result.status = "failed"; result.omissions.push("file target is not a supported source file"); break; }
                if (view === "dependencies") {
                    const scope = await enumerate(scopeRoot);
                    admittedFiles = scope.files;
                    universe = scope.files.filter((file) => sourceLike(file.path));
                    result.coverage = scope.status;
                    result.omissions.push(...scope.omitted.map((omission) => `${omission.path}: ${omission.reason}`));
                    if (scope.status !== "complete") { result.status = "partial"; result.followups.push("Retry with a smaller scoped sub-path to improve coverage."); }
                } else {
                    universe = [{ path: fileTarget!, bytes: stat.size }];
                    admittedFiles = universe;
                    result.coverage = "unknown";
                }
            } else {
                const scope = await enumerate(scopeRoot);
                admittedFiles = scope.files;
                universe = scope.files.filter((file) => sourceLike(file.path));
                result.coverage = scope.status;
                result.omissions.push(...scope.omitted.map((omission) => `${omission.path}: ${omission.reason}`));
                if (scope.status !== "complete") { result.status = "partial"; result.followups.push("Retry with a smaller scoped sub-path to improve coverage."); }
            }
            current.status = result.status === "failed" ? "failed" : result.status;
            current.observed.files = universe.length;
            current.observed.bytes = universe.reduce((sum, file) => sum + file.bytes, 0);
        } else if (i === 1) {
            universe.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
            current.status = "ok"; current.observed.files = universe.length;
        } else if (i === 2) {
            current.args = { candidates: universe.length };
            const manifests = manifestRecords;
            const packagePaths = new Map<string, string>();
            const workspaceNames = new Set<string>();
            const aliases = new Set<string>();
            const rootManifestPath = admittedFiles.find((file) => file.path === "package.json");
            let rootManifest: PackageManifest = {};
            for (const manifestFile of admittedFiles.filter((file) => file.path.endsWith("package.json"))) {
                if (aborted(input.signal)) { current.status = "partial"; result.status = "partial"; result.coverage = "partial"; break; }
                const admission = admitted(1, manifestFile.bytes);
                if (!admission.admitted) { current.status = "partial"; result.status = "partial"; result.coverage = "partial"; result.followups.push(`Retry with a scoped sub-path: ${admission.reasons.join("; ")}`); break; }
                try {
                    const text = await readWithinScope(manifestFile.path);
                    const actualBytes = Buffer.byteLength(text);
                    if (actualBytes > limits.maxBytesPerFile || bytes + actualBytes > budget.scannedBytes || bytes + actualBytes > limits.maxTotalBytes) { result.status = "partial"; result.coverage = "partial"; current.status = "partial"; result.followups.push("Retry with a scoped sub-path to stay within the scanned-byte budget."); break; }
                    reads++; bytes += actualBytes;
                    const manifest = JSON.parse(text) as PackageManifest;
                    manifests.set(manifestFile.path, manifest);
                    if (manifest.name) packagePaths.set(manifest.name, manifestFile.path);
                    if (manifestFile.path === rootManifestPath?.path) rootManifest = manifest;
                } catch {
                    result.omissions.push(`${manifestFile.path}: manifest-read-or-parse-failed`);
                    result.status = "partial"; result.coverage = "partial";
                }
            }
            for (const configFile of admittedFiles.filter((file) => file.path === "tsconfig.json" || (file.path.startsWith("tsconfig.") && file.path.endsWith(".json")))) {
                if (aborted(input.signal)) { current.status = "partial"; result.status = "partial"; result.coverage = "partial"; break; }
                const admission = admitted(1, configFile.bytes);
                if (!admission.admitted) { current.status = "partial"; result.status = "partial"; result.coverage = "partial"; result.followups.push(`Retry with a scoped sub-path: ${admission.reasons.join("; ")}`); break; }
                try {
                    const text = await readWithinScope(configFile.path);
                    const actualBytes = Buffer.byteLength(text);
                    if (actualBytes > limits.maxBytesPerFile || bytes + actualBytes > budget.scannedBytes || bytes + actualBytes > limits.maxTotalBytes) { result.status = "partial"; result.coverage = "partial"; current.status = "partial"; result.followups.push("Retry with a scoped sub-path to stay within the scanned-byte budget."); break; }
                    reads++; bytes += actualBytes;
                    const parsed = JSON.parse(text) as { compilerOptions?: { paths?: Record<string, unknown> } };
                    for (const alias of Object.keys(parsed.compilerOptions?.paths ?? {})) aliases.add(alias);
                } catch { result.omissions.push(`${configFile.path}: tsconfig-read-or-parse-failed`); result.status = "partial"; result.coverage = "partial"; }
            }
            const declaredWorkspaces = workspacePatterns(rootManifest);
            for (const [name, manifestPath] of packagePaths) {
                if (manifestPath !== rootManifestPath?.path && matchesWorkspacePattern(manifestPath.replace(/\\/g, "/").slice(0, -"/package.json".length), declaredWorkspaces)) workspaceNames.add(name);
            }
            for (const file of universe) {
                if (aborted(input.signal)) { current.status = "partial"; result.status = "partial"; result.coverage = "partial"; break; }
                const admission = admitted(1, file.bytes);
                if (!admission.admitted) { current.status = "partial"; result.status = "partial"; result.coverage = "partial"; result.followups.push(`Retry with a scoped sub-path: ${admission.reasons.join("; ")}`); break; }
                let text: string;
                try { text = await readWithinScope(file.path); }
                catch { result.omissions.push(`${file.path}: source-read-failed`); result.coverage = "partial"; result.status = "partial"; continue; }
                if (aborted(input.signal)) { current.status = "partial"; result.status = "partial"; result.coverage = "partial"; break; }
                const actualBytes = Buffer.byteLength(text);
                if (actualBytes > limits.maxBytesPerFile || bytes + actualBytes > budget.scannedBytes || bytes + actualBytes > limits.maxTotalBytes) { result.status = "partial"; result.coverage = "partial"; result.followups.push("Retry with a scoped sub-path to stay within the scanned-byte budget."); current.status = "partial"; break; }
                reads++; bytes += actualBytes;
                current.observed.files = reads; current.observed.bytes = bytes;
                sourceContents.set(file.path, text);
                const imports = extractImports(text);
                for (const ref of imports) {
                    const citation = { path: file.path, range: { start: ref.line, end: ref.line }, specifier: ref.specifier, resolutionRule: "unresolved" };
                    if (ref.specifier === "<dynamic>") { if (!emitUnresolved({ source: file.path, specifier: ref.specifier, reason: "dynamic-specifier", citation })) break; continue; }
                    if (ref.specifier.startsWith(".")) {
                        const base = resolve(dirname(resolve(scopeRoot, file.path)), ref.specifier);
                        let found: string | undefined;
                        for (const candidate of targetCandidates(base)) {
                            const path = await realpath(candidate).catch(() => undefined);
                            if (path && isWithin(scopeRoot, path) && admittedFiles.some((item) => resolve(scopeRoot, item.path) === path)) { found = path; break; }
                        }
                        if (found) {
                            const target = relative(scopeRoot, found).replace(/\\/g, "/");
                            const rule = resolve(scopeRoot, target) === base ? "relative-exact" : extname(base) ? "relative-extension" : target.includes("/index.") || target.startsWith("index.") ? "relative-index" : "relative-extension";
                            const citation = { path: file.path, range: { start: ref.line, end: ref.line }, specifier: ref.specifier, resolutionRule: rule };
                            if (!emitRelation({ source: file.path, target, kind: "import", specifier: ref.specifier, resolutionRule: rule, citation })) break;
                        } else if (!emitUnresolved({ source: file.path, specifier: ref.specifier, reason: "relative-target-not-in-admitted-universe", citation })) break;
                    } else {
                        const sourceDir = dirname(file.path).replace(/\\/g, "/");
                        const nearestManifest = [...manifests.keys()].filter((path) => path === "package.json" || sourceDir === dirname(path) || sourceDir.startsWith(`${dirname(path)}/`)).sort((a, b) => dirname(b).length - dirname(a).length)[0];
                        const localManifest = nearestManifest ? manifests.get(nearestManifest) : rootManifest;
                        const dependencies = { ...localManifest?.dependencies, ...localManifest?.devDependencies, ...localManifest?.peerDependencies };
                        const importedPackage = packageName(ref.specifier);
                        const workspaceManifest = workspaceNames.has(importedPackage) ? [...packagePaths].find(([name]) => name === importedPackage)?.[1] : undefined;
                        if (workspaceManifest) {
                            const entry = resolve(dirname(workspaceManifest), manifestEntry(manifests.get(workspaceManifest)!));
                            let target = targetCandidates(entry).map((candidate) => admittedFiles.find((file) => resolve(scopeRoot, file.path) === resolve(candidate))?.path).find((candidate) => candidate !== undefined);
                            if (target) {
                                target = target.replace(/\\/g, "/");
                                const workspaceCitation = { ...citation, resolutionRule: "workspace-manifest" };
                                if (!emitRelation({ source: file.path, target, kind: "workspace-import", specifier: ref.specifier, resolutionRule: "workspace-manifest", citation: workspaceCitation })) break;
                            } else if (!emitUnresolved({ source: file.path, specifier: ref.specifier, reason: "workspace-entry-not-in-admitted-universe", citation })) break;
                        } else if (dependencies?.[importedPackage]) {
                            const dependencyCitation = { ...citation, resolutionRule: "manifest-declared" };
                            if (!emitRelation({ source: file.path, target: importedPackage, kind: "manifest-dep", specifier: ref.specifier, resolutionRule: "manifest-declared", citation: dependencyCitation })) break;
                        } else {
                            const isAlias = ref.specifier.startsWith("@/") || ref.specifier.startsWith("~") || ref.specifier.startsWith("#") || [...aliases].some((alias) => alias.endsWith("*") ? ref.specifier.startsWith(alias.slice(0, -1)) : alias === ref.specifier);
                            if (!emitUnresolved({ source: file.path, specifier: ref.specifier, reason: isAlias ? "alias-not-supported" : "undeclared-package", citation })) break;
                        }
                    }
                }
                if (result.followups.some((followup) => followup.includes("output-byte"))) { current.status = "partial"; break; }
            }
            if (current.status === "not-run") current.status = result.status === "partial" ? "partial" : "ok";
            current.observed.outputBytes = jsonBytes({ relations: result.relations, unresolved: result.unresolved });
        } else {
            const builder = input.boundedBuilder;
            if (builder) {
                let built: Awaited<ReturnType<NonNullable<GatherInput["boundedBuilder"]>>>;
                try { built = await builder(universe, input.signal); }
                catch { current.status = "failed"; result.status = "failed"; result.omissions.push("bounded builder failed"); break; }
                if (!built.bounded || !built.cancellation) { current.status = "unsupported"; result.status = "unsupported"; result.followups.push("This builder cannot guarantee resource bounds and cooperative cancellation."); break; }
            }
            if (aborted(input.signal)) { current.status = "partial"; result.status = "partial"; result.coverage = "partial"; break; }
            result.relations.sort((a, b) => compareText(a.source, b.source) || a.citation.range.start - b.citation.range.start || compareText(a.specifier, b.specifier));
            result.unresolved.sort((a, b) => compareText(a.source, b.source) || a.citation.range.start - b.citation.range.start || compareText(a.specifier, b.specifier));
            let changedRanges = new Map<string, Array<{ start: number; end: number }>>();
            if (view === "change-review") {
                if (!input.diffProvider) { current.status = "failed"; result.status = "failed"; result.omissions.push("change-review requires a diff provider"); }
                else try { changedRanges = diffRanges(await input.diffProvider()); } catch { current.status = "partial"; result.status = "partial"; result.coverage = "partial"; result.omissions.push("diff-read-failed"); }
            }
            const routeItems: Array<{ path: string; route: string; method: string; range: { start: number; end: number } }> = [];
            for (const [path, source] of sourceContents) {
                const code = maskComments(source);
                const pattern = /\b(?:app|router|route)\.(get|post|put|patch|delete|all)\s*\(\s*(["'])([^"'\n]+)\2/g;
                for (const match of code.matchAll(pattern)) {
                    const line = code.slice(0, match.index ?? 0).split("\n").length;
                    const routeItem = { path, method: match[1]!.toUpperCase(), route: match[3]!, range: { start: line, end: line } };
                    if (!outputFits({ relations: result.relations, unresolved: result.unresolved, sections: result.sections, routes: [...routeItems, routeItem] })) { outputRefusal(); break; }
                    routeItems.push(routeItem);
                }
                const dynamicRoutePattern = /\b(?:app|router|route)\.(?:get|post|put|patch|delete|all)\s*\(\s*`[^`]*`/g;
                for (const match of code.matchAll(dynamicRoutePattern)) {
                    const line = code.slice(0, match.index ?? 0).split("\n").length;
                    result.omissions.push(`${path}:${line}: dynamic-route-registration`);
                    result.status = "partial"; result.coverage = "partial";
                }
                if (result.followups.some((followup) => followup.includes("output-byte"))) break;
            }
            routeItems.sort((a, b) => compareText(a.path, b.path) || a.range.start - b.range.start || compareText(a.route, b.route));
            const coverage = result.coverage;
            const section = (name: string, items: unknown[]): GatherSection => ({ name, status: result.status, coverage, items, omissions: [...result.omissions] });
            const addSection = (name: string, items: unknown[]): void => {
                const candidate = section(name, items);
                if (!outputFits({ relations: result.relations, unresolved: result.unresolved, sections: [...result.sections, candidate] })) { outputRefusal(); return; }
                result.sections.push(candidate);
            };
            if (view === "dependencies") {
                const target = fileTarget;
                const items = result.relations.filter((relation) => relation.source === target || relation.target === target);
                const unresolved = result.unresolved.filter((reference) => reference.source === target);
                addSection("dependencies", [...items, ...unresolved]);
            } else if (view === "architecture") {
                result.heuristics.push("Architecture groupings and layers are heuristic, not architectural facts.");
                addSection("architecture", [...result.relations.filter((relation) => relation.kind === "workspace-import"), ...manifestRecords.entries()].map((item) => item));
            } else if (view === "routes") {
                result.heuristics.push("Static registrations are source candidates; they do not establish runtime-mounted endpoints.");
                addSection("routes", routeItems);
            } else if (view === "change-review") {
                const affected = result.relations.filter((relation) => changedRanges.get(relation.source)?.some((range) => range.start <= relation.citation.range.end && range.end >= relation.citation.range.start));
                addSection("change-review", affected);
            } else {
                result.heuristics.push("Static registrations are source candidates; they do not establish runtime-mounted endpoints.");
                addSection("dependencies", [...result.relations, ...result.unresolved]);
                addSection("routes", routeItems);
            }
            if (view === "architecture") result.heuristics.push("Cross-package import groupings are heuristic, not architectural facts.");
            if (view === "overview") result.followups.push("Gathered source relations are discovery-only; inspect cited files directly for strong evidence.");
            current.status = result.status === "ok" ? "ok" : result.status;
            current.observed.outputBytes = jsonBytes(result);
            if (!outputFits({ relations: result.relations, unresolved: result.unresolved, sections: result.sections })) { result.sections = []; outputRefusal(); current.status = "partial"; result.status = "partial"; }
            if (result.status !== "ok") for (const record of result.sections) { record.status = result.status; record.coverage = result.coverage; }
        }
        current.observed.wallMs = Math.max(0, clock() - tick);
    }
    for (const unfinished of stages.filter((s) => s.status === "not-run")) unfinished.status = "not-run";
    return result;
}
