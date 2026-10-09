#!/usr/bin/env node
/** Frozen, engine-independent source enumerator for the inspect cohort. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

export const ENUMERATOR_VERSION = 1;
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
    version: number;
    repo: string;
    candidates: Candidate[];
    universe: { id: string; sha256: string; count: number };
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".d.ts"] as const;
const SUPPORTED = new Set([".ts", ".tsx", ".js"]);
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

// Replace comments with spaces while preserving newlines/offsets and quoted strings.
function withoutComments(source: string): string {
    return source.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
        (match, literal: string | undefined) => literal ?? match.replace(/[^\r\n]/g, " "));
}
function maskRegexLiterals(source: string): string {
    const chars = [...source];
    const regexPrefixWords = new Set(["return", "throw", "case", "delete", "void", "typeof", "instanceof", "in", "of", "yield", "await"]);
    let previous = "";
    for (let index = 0; index < source.length;) {
        const char = source[index]!;
        if (char.charCodeAt(0) === 34 || char.charCodeAt(0) === 39 || char.charCodeAt(0) === 96) {
            const quote = char;
            index += 1;
            while (index < source.length) {
                if (source.charCodeAt(index) === 92) index += 2;
                else if (source[index++] === quote) break;
                else continue;
            }
            previous = "value";
            continue;
        }
        if (char === "/" && source[index + 1] !== "/" && source[index + 1] !== "*" && canStartRegex(previous, regexPrefixWords)) {
            let cursor = index + 1;
            let inClass = false;
            let closed = false;
            while (cursor < source.length && source[cursor] !== "\n") {
                const current = source[cursor]!;
                if (current.charCodeAt(0) === 92) cursor += 2;
                else if (current === "[") { inClass = true; cursor += 1; }
                else if (current === "]") { inClass = false; cursor += 1; }
                else if (current === "/" && !inClass) { cursor += 1; closed = true; break; }
                else cursor += 1;
            }
            if (closed) {
                while (/[A-Za-z]/.test(source[cursor] ?? "")) cursor += 1;
                for (let masked = index; masked < cursor; masked += 1) if (chars[masked]?.charCodeAt(0) !== 10) chars[masked] = " ";
                index = cursor;
                previous = "value";
                continue;
            }
        }
        if (/\s/.test(char)) { index += 1; continue; }
        if (/[A-Za-z_$]/.test(char)) {
            const start = index++;
            while (/[A-Za-z0-9_$]/.test(source[index] ?? "")) index += 1;
            previous = source.slice(start, index);
        } else {
            previous = char;
            index += 1;
        }
    }
    return chars.join("");
}
function canStartRegex(previous: string, prefixWords: Set<string>): boolean {
    return previous === "" || prefixWords.has(previous) || "([{=,:;!?&|+-*%^~<>".includes(previous);
}
function lineAt(source: string, offset: number): number { return source.slice(0, offset).split("\n").length; }
function inLiteral(source: string, offset: number): boolean {
    let quote = "";
    let escaped = false;
    for (let index = 0; index < offset; index += 1) {
        const char = source[index]!;
        if (quote) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === quote) quote = "";
        } else if (char === '"' || char === "'" || char === "`") quote = char;
    }
    return quote.length > 0;
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
    const code = maskRegexLiterals(withoutComments(original));
    const rel = portable(relative(root, file));
    const addRelation = (offset: number, specifier: string, kind: Candidate["kind"], dynamic = false): void => {
        const resolved = dynamic ? { path: null, reason: "dynamic-specifier" as const } : resolveImport(file, specifier, root, aliases);
        add(candidates, { kind, file: rel, line: lineAt(original, offset), specifier, resolved: resolved.path ? portable(relative(root, resolved.path)) : null, ...(resolved.reason ? { unresolvedReason: resolved.reason } : {}) });
    };
    const importExport = /\b(import|export)\s+(?:type\s+)?(?:[^;\n]*?\s+from\s*)?(["'])([^"']+)\2/g;
    for (const match of code.matchAll(importExport)) {
        if (inLiteral(code, match.index!)) continue;
        const specifier = match[3]!;
        // `import(` is outside the closed static syntax; bare side-effect imports are accepted.
        if (match[0].includes("import(") || match[0].includes("export *")) continue;
        addRelation(match.index!, specifier, match[1] === "export" ? "re-export" : "import");
    }
    const dynamic = /\b(?:import|export)\s*(?:\([^"'`]|[^;\n]*?\s+from\s*[^"'`\s])/g;
    for (const match of code.matchAll(dynamic)) if (!inLiteral(code, match.index!)) addRelation(match.index!, "<dynamic>", "import", true);
    const requirePattern = /\brequire\s*\(\s*(["'])([^"']+)\1\s*\)/g;
    for (const match of code.matchAll(requirePattern)) if (!inLiteral(code, match.index!)) addRelation(match.index!, match[2]!, "require");
    const dynamicRequire = /\brequire\s*\(\s*(?!["'])[^)]+\)/g;
    for (const match of code.matchAll(dynamicRequire)) if (!inLiteral(code, match.index!)) addRelation(match.index!, "<dynamic>", "require", true);

    const route = /\b(app|fastify|router|server|api)\s*\.\s*(get|post|put|delete|patch|options|head|all)\s*\(\s*(["'])([^"']+)\3/g;
    for (const match of code.matchAll(route)) {
        if (inLiteral(code, match.index!)) continue;
        if (!ROUTERS.has(match[1]!) || !METHODS.has(match[2]!)) continue;
        add(candidates, { kind: "route", file: rel, line: lineAt(original, match.index!), method: match[2]!.toUpperCase(), path: match[4]! });
    }
    // Template-string and computed route paths are retained as unsupported candidates.
    const dynamicRoute = /\b(app|fastify|router|server|api)\s*\.\s*(get|post|put|delete|patch|options|head|all)\s*\(\s*(?:`|[A-Za-z_$][\w$]*)/g;
    for (const match of code.matchAll(dynamicRoute)) if (!inLiteral(code, match.index!)) add(candidates, { kind: "route", file: rel, line: lineAt(original, match.index!), method: match[2]!.toUpperCase(), path: "<dynamic>", unresolvedReason: "dynamic-specifier" });
    const trpc = /\b(?:router|t\.router)\s*\(\s*\{([^}]*)\}/g;
    for (const match of code.matchAll(trpc)) {
        if (inLiteral(code, match.index!)) continue;
        const keys = match[1]!.matchAll(/(?:^|[,\n])\s*([A-Za-z_$][\w$]*)\s*:/g);
        for (const key of keys) add(candidates, { kind: "trpc", file: rel, line: lineAt(original, match.index! + match[0].indexOf(match[1]!) + key.index!), specifier: key[1] });
    }
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

export function enumerateRepository(rootPath: string, repo: string, aliases: Record<string, string> = {}): Enumeration {
    const root = realpathSync(rootPath);
    const candidates: Candidate[] = [];
    for (const file of walk(root)) {
        const rel = portable(relative(root, file));
        if (file.endsWith("package.json")) scanPackage(file, root, candidates);
        if (!SUPPORTED.has(file.endsWith(".d.ts") ? ".d.ts" : file.slice(file.lastIndexOf(".")))) continue;
        scanSource(file, root, aliases, candidates);
        if (/^app\/(?:.+\/)?route\.(ts|tsx)$/.test(rel)) {
            const source = maskRegexLiterals(withoutComments(readFileSync(file, "utf8")));
            for (const method of source.matchAll(/\bexport\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\b/g)) {
                add(candidates, { kind: "next-route", file: rel, line: lineAt(source, method.index!), method: method[1]!, path: `/${rel.replace(/^app\//, "").replace(/\/route\.(ts|tsx)$/, "")}` });
            }
        }
        if (/^pages\/api\/.+\.(ts|tsx|js)$/.test(rel)) add(candidates, { kind: "next-route", file: rel, line: 1, method: "PAGES", path: `/${rel.replace(/\.(ts|tsx|js)$/, "")}` });
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
