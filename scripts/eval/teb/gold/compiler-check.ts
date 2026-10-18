/**
 * TEB independent cross-check via the TypeScript compiler API.
 *
 * Per §6.1 this is a *mistake detector*, not an independent source: the
 * pinned server and this check share pinned-TS semantic assumptions, so
 * agreement detects adapter mistakes, not shared TypeScript-semantics
 * errors. Records the exact typescript version used.
 *
 * Covers: definition/references (ts.LanguageService
 * getDefinitionAtPosition/getReferencesAtPosition), implementations
 * (getImplementationAtPosition), and the structural families — an import
 * graph for direct-importers plus package-exports read from package.json
 * `exports`/`main`/`types`. Callers (call hierarchy) and hover have no
 * compiler-API equivalent; their independent checks are the labelers'
 * textual enumeration / source type read (§6.1), recorded by derive.ts.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { TebGoldLocation, AgreementClass } from "./normalize.js";

const PINNED_TS_LIB = join(
    homedir(),
    ".cache",
    "pi-smartread-bench",
    "tools",
    "lsp-pinned",
    "node_modules",
    "typescript",
    "lib",
    "typescript.js",
);

const localRequire = createRequire(import.meta.url);

function loadTypescript(explicitPath?: string): { ts: typeof import("typescript"); version: string; resolvedFrom: string } {
    const candidates = [
        explicitPath,
        PINNED_TS_LIB,
        localRequire.resolve("typescript"),
    ].filter((c): c is string => typeof c === "string" && c.length > 0);
    let lastError: unknown = null;
    for (const c of candidates) {
        try {
            const ts = localRequire(c) as typeof import("typescript");
            return { ts, version: String(ts.version), resolvedFrom: c };
        } catch (err) {
            lastError = err;
        }
    }
    throw new Error(`cannot load typescript compiler API (tried pinned + local): ${String(lastError)}`);
}

export interface CompilerCheckResult {
    typescriptVersion: string;
    resolvedFrom: string;
    definition: TebGoldLocation[];
    references: TebGoldLocation[];
    implementations: TebGoldLocation[];
}

/** Minimal LanguageService host over disk reads (mirrors the external-lsp harness). */
export function createCompilerService(
    ts: typeof import("typescript"),
    root: string,
    files: string[],
): import("typescript").LanguageService {
    const snapshots = new Map<string, import("typescript").IScriptSnapshot | undefined>();
    const host: import("typescript").LanguageServiceHost = {
        getCompilationSettings: () => ({
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
            strict: true,
            allowJs: true,
        }),
        getScriptFileNames: () => files,
        getScriptVersion: () => "0",
        getScriptSnapshot: (f) => {
            const cached = snapshots.get(f);
            if (cached !== undefined) return cached;
            try {
                const snap = ts.ScriptSnapshot.fromString(readFileSync(f, "utf-8"));
                snapshots.set(f, snap);
                return snap;
            } catch {
                snapshots.set(f, undefined);
                return undefined;
            }
        },
        getCurrentDirectory: () => root,
        getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        fileExists: (f) => {
            try {
                return statSync(f).isFile();
            } catch {
                return false;
            }
        },
        readFile: (f) => {
            try {
                return readFileSync(f, "utf-8");
            } catch {
                return undefined;
            }
        },
    };
    return ts.createLanguageService(host);
}

export function listProjectFiles(root: string, cap = 2000): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        if (out.length >= cap) return;
        for (const entry of readdirSync(dir)) {
            if (out.length >= cap) return;
            if (entry === "node_modules" || entry.startsWith(".")) continue;
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) walk(full);
            else if (/\.(m|c)?[jt]sx?$/.test(entry)) out.push(full);
        }
    };
    walk(root);
    return out.sort();
}

function spanToGold(
    ts: typeof import("typescript"),
    root: string,
    fileName: string,
    span: { start: number; length: number },
): TebGoldLocation | null {
    try {
        const text = readFileSync(fileName, "utf-8");
        const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true);
        const s = ts.getLineAndCharacterOfPosition(sf, span.start);
        return {
            path: relative(root, realpathSync(fileName)),
            line: s.line + 1,
            character: s.character + 1,
        };
    } catch {
        return null;
    }
}

export interface CompilerQueryOptions {
    tsPath?: string;
    scope?: string;
    dtsTarget?: boolean;
    fileCap?: number;
}

function inScope(l: TebGoldLocation, scope: string, dtsTarget: boolean): boolean {
    const prefix = (scope ?? "").replace(/^\.\//, "").replace(/\/$/, "");
    if (prefix !== "" && l.path !== prefix && !l.path.startsWith(`${prefix}/`)) return false;
    if (!dtsTarget && l.path.endsWith(".d.ts")) return false;
    return true;
}

/** Definition + references + implementations for a 1-based anchor via the compiler API. */
export function compilerCheck(
    root: string,
    anchor: { path: string; line: number; character: number },
    opts: CompilerQueryOptions = {},
): CompilerCheckResult {
    const { ts, version, resolvedFrom } = loadTypescript(opts.tsPath);
    const absRoot = realpathSync(resolve(root));
    const files = listProjectFiles(absRoot, opts.fileCap ?? 2000).map((f) => realpathSync(f));
    const service = createCompilerService(ts, absRoot, files);
    const absFile = realpathSync(join(absRoot, anchor.path));
    const text = readFileSync(absFile, "utf-8");
    const sf = ts.createSourceFile(absFile, text, ts.ScriptTarget.ESNext, true);
    const offset = ts.getPositionOfLineAndCharacter(sf, anchor.line - 1, anchor.character - 1);
    const scope = opts.scope ?? "";
    const dts = opts.dtsTarget ?? false;

    const defs = (service.getDefinitionAtPosition(absFile, offset) ?? [])
        .map((d) => spanToGold(ts, absRoot, d.fileName, d.textSpan))
        .filter((l): l is TebGoldLocation => l !== null && inScope(l, scope, dts));
    const refs = (service.getReferencesAtPosition(absFile, offset) ?? [])
        .map((r) => spanToGold(ts, absRoot, r.fileName, r.textSpan))
        .filter((l): l is TebGoldLocation => l !== null && inScope(l, scope, dts));
    const impls = (service.getImplementationAtPosition(absFile, offset) ?? [])
        .map((d) => spanToGold(ts, absRoot, d.fileName, d.textSpan))
        .filter((l): l is TebGoldLocation => l !== null && inScope(l, scope, dts));
    return { typescriptVersion: version, resolvedFrom, definition: defs, references: refs, implementations: impls };
}

function samePoint(a: TebGoldLocation, b: TebGoldLocation): boolean {
    return a.path === b.path && a.line === b.line && Math.abs(a.character - b.character) <= 2;
}

/** Server/compiler set agreement on declaration-aligned sets (Jaccard ≥ 0.9 → agree).
 *
 * The pinned server requests references with `includeDeclaration:false`
 * (server-labels.ts) while the compiler `getReferencesAtPosition` includes
 * the declaration, so callers pass the definition sites via
 * `opts.declaration` and matching compiler points are filtered before the
 * comparison. Sets compare by point (`samePoint`, col tolerance ±2) with
 * one-to-one matching: Jaccard = |I| / |union|; below threshold the class
 * is decided by inclusion — compiler ⊆ server → "server-only",
 * server ⊆ compiler → "compiler-only", else "adjudicated". */
export function classifySetAgreement(
    server: TebGoldLocation[],
    compiler: TebGoldLocation[],
    opts: { declaration?: TebGoldLocation[] } = {},
): AgreementClass {
    const decl = opts.declaration ?? [];
    const comp = decl.length > 0 ? compiler.filter((c) => !decl.some((d) => samePoint(c, d))) : compiler;
    if (server.length === 0 && comp.length === 0) return "agree";
    if (server.length > 0 && comp.length === 0) return "server-only";
    if (server.length === 0 && comp.length > 0) return "compiler-only";
    // One-to-one point matching so duplicates cannot inflate the intersection.
    const remaining = [...comp];
    let intersect = 0;
    for (const s of server) {
        const idx = remaining.findIndex((c) => samePoint(s, c));
        if (idx >= 0) {
            intersect += 1;
            remaining.splice(idx, 1);
        }
    }
    const union = server.length + comp.length - intersect;
    if (union > 0 && intersect / union >= 0.9) return "agree";
    const serverCovered = intersect === server.length;
    const compilerCovered = intersect === comp.length;
    if (serverCovered && !compilerCovered) return "compiler-only";
    if (compilerCovered && !serverCovered) return "server-only";
    return "adjudicated";
}

// ---------------------------------------------------------------------------
// Structural families: import graph + package exports
// ---------------------------------------------------------------------------

/** Strip an ESM-style JS specifier suffix so `./a.js` resolves to a TS source. */
function stripJsSpecifierSuffix(base: string): string | null {
    for (const ext of [".js", ".jsx", ".mjs", ".cjs"]) {
        if (base.endsWith(ext)) return base.slice(0, -ext.length);
    }
    return null;
}

/** Resolve a relative import specifier to a repo-relative path (tries TS/JS extensions + index). */
export function resolveImportSpecifier(fromFile: string, spec: string): string | null {
    if (!spec.startsWith(".")) return null;
    const base = resolve(dirname(fromFile), spec);
    if (isAbsolute(spec)) return null;
    const stripped = stripJsSpecifierSuffix(base);
    const candidates = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.mts`,
        `${base}.cts`,
        `${base}.js`,
        `${base}.jsx`,
        `${base}.d.ts`,
        join(base, "index.ts"),
        join(base, "index.tsx"),
        join(base, "index.js"),
    ];
    if (stripped !== null) {
        candidates.push(
            stripped,
            `${stripped}.ts`,
            `${stripped}.tsx`,
            `${stripped}.mts`,
            `${stripped}.cts`,
            `${stripped}.d.ts`,
            join(stripped, "index.ts"),
            join(stripped, "index.tsx"),
        );
    }
    for (const c of candidates) {
        try {
            if (statSync(c).isFile()) return c;
        } catch {
            /* try next */
        }
    }
    return null;
}

const IMPORT_RE = /(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']|import\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Direct importers (depth-1 reverse imports) of a module, resolved from source. */
export function directImporters(root: string, modulePath: string, files?: string[]): string[] {
    const absRoot = realpathSync(resolve(root));
    const absModule = realpathSync(join(absRoot, modulePath));
    const scan = (files ?? listProjectFiles(absRoot)).map((f) => {
        try {
            return realpathSync(f);
        } catch {
            return f;
        }
    });
    const out: string[] = [];
    for (const f of scan) {
        if (f === absModule) continue;
        let text: string;
        try {
            text = readFileSync(f, "utf-8");
        } catch {
            continue;
        }
        const specs: string[] = [];
        for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) specs.push(m[1] ?? m[2] ?? "");
        }
        for (const spec of specs) {
            const resolved = resolveImportSpecifier(f, spec);
            if (resolved === absModule) {
                out.push(relative(absRoot, f));
                break;
            }
        }
    }
    return out.sort();
}

function exportsFieldToPaths(exportsField: unknown): string[] {
    const out: string[] = [];
    const collect = (v: unknown): void => {
        if (typeof v === "string") out.push(v);
        else if (Array.isArray(v)) for (const e of v) collect(e);
        else if (v !== null && typeof v === "object") {
            for (const e of Object.values(v as Record<string, unknown>)) collect(e);
        }
    };
    collect(exportsField);
    return out;
}

/**
 * Package entry FILES from package.json `exports`/`main`/`types`/`typings`,
 * resolved to paths relative to the package dir. Files only — no symbol
 * enumeration (E10.2).
 */
export function packageEntryFiles(pkgDir: string): string[] {
    const pkgJsonPath = join(realpathSync(resolve(pkgDir)), "package.json");
    if (!existsSync(pkgJsonPath)) throw new Error(`no package.json in ${pkgDir}`);
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as Record<string, unknown>;
    const found = new Set<string>();
    const dir = dirname(pkgJsonPath);
    const consider = (p: string): void => {
        const rel = p.replace(/^\.\//, "");
        if (!rel.startsWith(".")) {
            const abs = join(dir, rel);
            try {
                if (statSync(abs).isFile()) found.add(rel);
                return;
            } catch {
                return;
            }
        }
    };
    for (const p of exportsFieldToPaths(pkg.exports)) consider(p);
    for (const key of ["main", "types", "typings"]) {
        if (typeof pkg[key] === "string") consider(pkg[key] as string);
    }
    return [...found].sort();
}
