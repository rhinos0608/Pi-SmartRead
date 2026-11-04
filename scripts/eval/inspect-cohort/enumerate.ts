#!/usr/bin/env node
/** Frozen, engine-independent source enumerator for the inspect cohort. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import type * as TypeScript from "typescript";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof TypeScript;
const ENUMERATOR_TYPESCRIPT_VERSION = "5.9.3";
if (ts.version !== ENUMERATOR_TYPESCRIPT_VERSION) {
    throw new Error(`enumerator expects TypeScript ${ENUMERATOR_TYPESCRIPT_VERSION}, loaded ${ts.version}`);
}
export const ENUMERATOR_VERSION = `1-typescript-${ENUMERATOR_TYPESCRIPT_VERSION}`;
export type UnresolvedReason = "dynamic-specifier" | "re-export-ambiguous" | "generated" | "out-of-scope";
export interface Candidate {
    id: string;
    kind: "import" | "re-export" | "require" | "package" | "route" | "next-route" | "trpc";
    file: string;
    line: number;
    specifier?: string;
    resolved?: string | null;
    unresolvedReason?: UnresolvedReason;
    method?: string;
    path?: string;
    manifestKey?: string;
}
export interface Enumeration {
    version: string;
    repo: string;
    candidates: Candidate[];
    universe: { id: string; sha256: string; count: number };
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".d.ts"] as const;
const SUPPORTED = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const ROUTERS = new Set(["app", "fastify", "router", "server", "api"]);
const METHODS = new Set(["get", "post", "put", "delete", "patch", "options", "head", "all"]);

function walk(root: string): string[] {
    const out: string[] = [];
    const visit = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name === "node_modules" || entry.name === ".git") continue;
            const file = join(dir, entry.name);
            if (entry.isDirectory()) visit(file);
            else if (entry.isFile()) out.push(file);
        }
    };
    visit(root);
    return out;
}

function lineAt(source: string, offset: number): number { return source.slice(0, offset).split("\n").length; }
function sourceScriptKind(file: string): TypeScript.ScriptKind {
    switch (extname(file).toLowerCase()) {
        case ".tsx": return ts.ScriptKind.TSX;
        case ".jsx": return ts.ScriptKind.JSX;
        case ".js": case ".mjs": case ".cjs": return ts.ScriptKind.JS;
        default: return ts.ScriptKind.TS;
    }
}
function sourceFile(file: string, source: string): TypeScript.SourceFile {
    return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, sourceScriptKind(file));
}
function isStringModule(value: TypeScript.Expression): value is TypeScript.StringLiteral {
    return ts.isStringLiteral(value);
}
function expressionText(value: TypeScript.Expression): string | null {
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
    return null;
}
function isRouterExpression(expression: TypeScript.Expression): expression is TypeScript.PropertyAccessExpression {
    return ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) &&
        ROUTERS.has(expression.expression.text) && METHODS.has(expression.name.text);
}
function isTrpcRouter(expression: TypeScript.Expression): boolean {
    return (ts.isIdentifier(expression) && expression.text === "router") ||
        (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === "t" && expression.name.text === "router");
}
function propertyKeyName(name: TypeScript.PropertyName | undefined): string | null {
    if (!name) return null;
    if (!ts.isComputedPropertyName(name) && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))) return name.text;
    return null;
}
function portable(path: string): string { return path.split(sep).join("/"); }

function fileFor(base: string): string | null {
    const stem = base.replace(/\.(?:ts|tsx|js|d\.ts)$/i, "");
    const candidates = [base, ...SOURCE_EXTENSIONS.map((ext) => `${stem}${ext}`), ...SOURCE_EXTENSIONS.map((ext) => join(stem, `index${ext}`))];
    for (const candidate of candidates) {
        try { if (statSync(candidate).isFile()) return candidate; } catch { /* try next correspondence */ }
    }
    return null;
}

function resolveImport(fromFile: string, specifier: string, root: string, aliases: Record<string, string>): { path: string | null; reason?: UnresolvedReason } {
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
        const target = fileFor(resolve(dirname(fromFile), specifier));
        return target ? { path: target } : { path: null, reason: "out-of-scope" };
    }
    const alias = Object.entries(aliases).sort(([a], [b]) => b.length - a.length).find(([key]) => specifier === key || specifier.startsWith(key.replace(/\*$/, "")));
    if (!alias) return { path: null, reason: "out-of-scope" };
    const [key, value] = alias;
    const suffix = key.endsWith("*") ? specifier.slice(key.length - 1) : specifier.slice(key.length);
    const target = fileFor(resolve(root, value.replace(/\*$/, "") + suffix));
    return target ? { path: target } : { path: null, reason: "out-of-scope" };
}

function add(candidates: Candidate[], candidate: Omit<Candidate, "id">): void {
    candidates.push({ ...candidate, id: "" });
}

function scanSource(file: string, root: string, aliases: Record<string, string>, candidates: Candidate[]): void {
    const original = readFileSync(file, "utf8");
    const source = sourceFile(file, original);
    const rel = portable(relative(root, file));
    const addRelation = (node: TypeScript.Node, specifier: string, kind: Candidate["kind"], reason?: UnresolvedReason): void => {
        const resolution = reason ? { path: null, reason } : resolveImport(file, specifier, root, aliases);
        add(candidates, {
            kind,
            file: rel,
            line: lineAt(original, node.getStart(source)),
            specifier,
            resolved: resolution.path ? portable(relative(root, resolution.path)) : null,
            ...(resolution.reason ? { unresolvedReason: resolution.reason } : {}),
        });
    };
    const visit = (node: TypeScript.Node): void => {
        if (ts.isImportDeclaration(node) && isStringModule(node.moduleSpecifier)) {
            addRelation(node, node.moduleSpecifier.text, "import");
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && isStringModule(node.moduleSpecifier)) {
            const ambiguous = !node.exportClause || ts.isNamespaceExport(node.exportClause);
            addRelation(node, node.moduleSpecifier.text, "re-export", ambiguous ? "re-export-ambiguous" : undefined);
        } else if (ts.isCallExpression(node)) {
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                const specifier = node.arguments[0] ? expressionText(node.arguments[0]) : null;
                addRelation(node, specifier ?? "<dynamic>", "import", "dynamic-specifier");
            } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
                const arg = node.arguments.length === 1 ? node.arguments[0] : undefined;
                const specifier = arg ? expressionText(arg) : null;
                addRelation(node, specifier ?? "<dynamic>", "require", specifier === null ? "dynamic-specifier" : undefined);
            } else if (isRouterExpression(node.expression)) {
                const first = node.arguments[0];
                const path = first && ts.isStringLiteral(first) ? first.text : null;
                add(candidates, {
                    kind: "route", file: rel, line: lineAt(original, node.getStart(source)),
                    method: node.expression.name.text.toUpperCase(), path: path ?? "<dynamic>",
                    ...(path === null ? { unresolvedReason: "dynamic-specifier" as const } : {}),
                });
            } else if (isTrpcRouter(node.expression)) {
                const arg = node.arguments[0];
                if (arg && ts.isObjectLiteralExpression(arg)) {
                    for (const property of arg.properties) {
                        const key = propertyKeyName(property.name);
                        if (key !== null) add(candidates, { kind: "trpc", file: rel, line: lineAt(original, property.getStart(source)), specifier: key });
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
}

function walkPackagePaths(value: unknown, prefix: string, out: Array<[string, string]>): void {
    if (typeof value === "string") { out.push([prefix, value]); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) walkPackagePaths(child, prefix ? `${prefix}.${key}` : key, out);
}

function scanPackage(file: string, root: string, candidates: Candidate[]): void {
    let pkg: Record<string, unknown>;
    try { pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { return; }
    const rel = portable(relative(root, file));
    for (const key of ["exports", "main", "types", "workspaces"] as const) {
        const value = pkg[key];
        if (value === undefined) continue;
        const paths: Array<[string, string]> = [];
        walkPackagePaths(value, key, paths);
        for (const [manifestKey, path] of paths) add(candidates, { kind: "package", file: rel, line: 1, manifestKey, specifier: path });
    }
}

const NEXT_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]);
function hasExportModifier(node: TypeScript.Node): boolean {
    return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}
function isNextMethod(name: string): boolean { return NEXT_METHODS.has(name); }

export function enumerateRepository(rootPath: string, repo: string, aliases: Record<string, string> = {}): Enumeration {
    const root = realpathSync(rootPath);
    const candidates: Candidate[] = [];
    for (const file of walk(root)) {
        const rel = portable(relative(root, file));
        if (file.endsWith("package.json")) scanPackage(file, root, candidates);
        if (!SUPPORTED.has(extname(file).toLowerCase()) || file.endsWith(".d.ts")) continue;
        scanSource(file, root, aliases, candidates);
        if (/^app\/(?:.+\/)?route\.(ts|tsx)$/.test(rel)) {
            const source = sourceFile(file, readFileSync(file, "utf8"));
            const routePath = `/${rel.replace(/^app\//, "").replace(/\/route\.(ts|tsx)$/, "")}`;
            for (const statement of source.statements) {
                if (!hasExportModifier(statement)) continue;
                if (ts.isFunctionDeclaration(statement) && statement.name && isNextMethod(statement.name.text)) {
                    add(candidates, { kind: "next-route", file: rel, line: lineAt(source.text, statement.getStart(source)), method: statement.name.text, path: routePath });
                } else if (ts.isVariableStatement(statement)) {
                    for (const declaration of statement.declarationList.declarations) {
                        if (ts.isIdentifier(declaration.name) && isNextMethod(declaration.name.text)) {
                            add(candidates, { kind: "next-route", file: rel, line: lineAt(source.text, declaration.getStart(source)), method: declaration.name.text, path: routePath });
                        }
                    }
                }
            }
        }
        if (/^pages\/api\/.+\.(ts|tsx|js|mjs|cjs)$/.test(rel)) add(candidates, { kind: "next-route", file: rel, line: 1, method: "PAGES", path: `/${rel.replace(/\.(ts|tsx|js|mjs|cjs)$/, "")}` });
    }
    candidates.sort((a, b) => `${a.file}\0${a.line}\0${a.kind}\0${a.specifier ?? ""}\0${a.method ?? ""}\0${a.path ?? ""}`.localeCompare(`${b.file}\0${b.line}\0${b.kind}\0${b.specifier ?? ""}\0${b.method ?? ""}\0${b.path ?? ""}`));
    const seen = new Map<string, number>();
    for (const candidate of candidates) {
        const base = `${candidate.file}:${candidate.line}:${candidate.kind}:${candidate.specifier ?? candidate.path ?? candidate.manifestKey ?? ""}`;
        const occurrence = seen.get(base) ?? 0;
        seen.set(base, occurrence + 1);
        candidate.id = createHash("sha256").update(`${repo}\0${base}\0${occurrence}`).digest("hex");
    }
    const serialized = JSON.stringify(candidates);
    return { version: ENUMERATOR_VERSION, repo, candidates, universe: { id: `${repo}-v${ENUMERATOR_VERSION}`, sha256: createHash("sha256").update(serialized).digest("hex"), count: candidates.length } };
}

interface RepoManifest { reposDir: string; repos: Array<{ owner: string; name: string; commit: string; aliases?: Record<string, string> }> }
function loadManifest(path: string): RepoManifest {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as RepoManifest;
    if (typeof manifest.reposDir !== "string" || !Array.isArray(manifest.repos)) throw new Error("invalid repos manifest");
    return manifest;
}
function checkRepos(manifest: RepoManifest): Array<{ repo: string; expected: string; head: string | null; clean: boolean; status: string[]; error?: string }> {
    return manifest.repos.map((pin) => {
        const repo = `${pin.owner}__${pin.name}`;
        const checkout = resolve(manifest.reposDir.replace(/^~/, homedir()), repo);
        try {
            const path = realpathSync(checkout);
            const head = execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
            const status = execFileSync("git", ["-C", path, "status", "--porcelain"], { encoding: "utf8" }).split("\n").filter(Boolean);
            return { repo, expected: pin.commit, head, clean: status.length === 0, status };
        } catch (error) {
            return { repo, expected: pin.commit, head: null, clean: false, status: [], error: error instanceof Error ? error.message : String(error) };
        }
    });
}
function parseCli(argv: string[]): { check: boolean; repos: string; repo: string | null; subpath: string } {
    const value = (flag: string): string | undefined => {
        const index = argv.indexOf(flag);
        return index >= 0 ? argv[index + 1] : undefined;
    };
    return {
        check: argv.includes("--check"),
        repos: value("--repos") ?? join(homedir(), ".cache", "pi-smartread-bench", "teb", "repos.json"),
        repo: value("--repo") ?? null,
        subpath: value("--subpath") ?? "",
    };
}
function main(): void {
    const args = parseCli(process.argv.slice(2));
    if (!existsSync(args.repos)) throw new Error(`repos manifest not found: ${args.repos}`);
    const manifest = loadManifest(args.repos);
    if (args.check) {
        const results = checkRepos(manifest);
        console.log(JSON.stringify({ version: ENUMERATOR_VERSION, repos: results }, null, 2));
        if (results.some((result) => !result.clean || result.head !== result.expected)) process.exitCode = 1;
        return;
    }
    if (!args.repo) throw new Error("usage: enumerate.ts --repo <owner__name> [--subpath <path>] [--repos <manifest>");
    const pin = manifest.repos.find((entry) => `${entry.owner}__${entry.name}` === args.repo);
    if (!pin) throw new Error(`repo not in repos.json: ${args.repo}`);
    const repoRoot = realpathSync(resolve(manifest.reposDir.replace(/^~/, homedir()), args.repo));
    const root = args.subpath ? realpathSync(resolve(repoRoot, args.subpath)) : repoRoot;
    if (!root.startsWith(`${repoRoot}${sep}`) && root !== repoRoot) throw new Error("subpath escapes pinned checkout");
    console.log(JSON.stringify(enumerateRepository(root, args.repo), null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();
