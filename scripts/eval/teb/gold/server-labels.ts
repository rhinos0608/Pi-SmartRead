#!/usr/bin/env node
/**
 * TEB semantic gold via the pinned typescript-language-server, driven
 * DIRECTLY over stdio with LSPConnection (transport only) — never through
 * SmartRead's LSP tool. Mirrors scripts/eval/external/lsp/run.ts.
 *
 * Operations per the §1.1 probe flow: definition, references (bounded
 * ≤40 in-scope per protocol), implementations, incoming calls anchored
 * at the DEFINITION site (prepareCallHierarchy is empty at use sites),
 * hover → pinned §5 normalised type string.
 *
 * Anchor I/O is 1-based `path:line:col` (protocol prompts); the LSP wire
 * is 0-based.
 */
import { readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { LSPConnection } from "../../../../src/lsp/lsp-connection.js";
import { normalizeTypeString, type TebGoldLocation, type TypeNormalization } from "./normalize.js";

const BENCH = join(homedir(), ".cache", "pi-smartread-bench");
const TOOLS = join(BENCH, "tools", "lsp-pinned");
export const PINNED_TLS_BIN = join(TOOLS, "node_modules", ".bin", "typescript-language-server");

/** Protocol bound: set-valued semantic tasks are admitted only ≤ 40 in-scope refs. */
export const MAX_IN_SCOPE_REFERENCES = 40;

interface RawRange {
    start: { line: number; character: number };
    end: { line: number; character: number };
}

interface RawLoc {
    uri?: string;
    targetUri?: string;
    range?: RawRange;
    targetRange?: RawRange;
    targetSelectionRange?: RawRange;
}

function uriToAbs(uri: string): string | null {
    try {
        if (!uri.startsWith("file:")) return null;
        return realpathSync(fileURLToPath(uri));
    } catch {
        return null;
    }
}

/** Convert raw LSP definition/references/implementation results to absolute locations. */
export function rawToAbsLocs(raw: unknown): Array<{ file: string; line: number; character: number }> {
    if (raw === null || raw === undefined) return [];
    const arr = Array.isArray(raw) ? raw : [raw];
    const out: Array<{ file: string; line: number; character: number }> = [];
    for (const entry of arr as RawLoc[]) {
        if (typeof entry !== "object" || entry === null) continue;
        const uri = entry.uri ?? entry.targetUri;
        const range = entry.range ?? entry.targetSelectionRange ?? entry.targetRange;
        if (typeof uri !== "string" || !range) continue;
        const file = uriToAbs(uri);
        if (!file) continue;
        out.push({ file, line: range.start.line, character: range.start.character });
    }
    return out;
}

/** Parse a 1-based `path:line:col` anchor (path relative to the task root). */
export function parseAnchor(anchor: string): { path: string; line: number; character: number } {
    const m = /^(.*):(\d+):(\d+)$/.exec(anchor.trim());
    if (!m) throw new Error(`bad anchor (want path:line:col): ${anchor}`);
    const line = Number(m[2]);
    const character = Number(m[3]);
    if (!Number.isInteger(line) || line < 1 || !Number.isInteger(character) || character < 1) {
        throw new Error(`bad anchor (1-based coords required): ${anchor}`);
    }
    return { path: m[1] as string, line, character: character };
}

/** Absolute 0-based LSP positions → repo-relative 1-based gold locations. */
export function toGold(
    locs: Array<{ file: string; line: number; character: number }>,
    root: string,
): TebGoldLocation[] {
    const canon = realpathSync(root);
    return locs.map((l) => ({
        path: relative(canon, realpathSync(l.file)),
        line: l.line + 1,
        character: l.character + 1,
    }));
}

/**
 * Scope filter: keep locations inside `scope` (subpath-relative, "" = whole
 * subpath). Out-of-scope hits (docs, specs, tests, .d.ts unless dtsTarget)
 * never count — the labeler records the filter per task.
 */
export function applyScope(
    locs: TebGoldLocation[],
    scope: string,
    opts?: { dtsTarget?: boolean },
): TebGoldLocation[] {
    const prefix = (scope ?? "").replace(/^\.\//, "").replace(/\/$/, "");
    return locs.filter((l) => {
        if (prefix !== "" && l.path !== prefix && !l.path.startsWith(`${prefix}/`)) return false;
        if (!opts?.dtsTarget && l.path.endsWith(".d.ts")) return false;
        return true;
    });
}

export interface HoverGold {
    raw: string;
    normalized: string;
    normalization: TypeNormalization;
}

/** Join hover contents chunks into one string (mirrors the external harness). */
export function hoverText(raw: unknown): string {
    const chunks: string[] = [];
    const push = (v: unknown): void => {
        if (typeof v === "string") chunks.push(v);
        else if (v !== null && typeof v === "object") {
            const o = v as Record<string, unknown>;
            if (typeof o.value === "string") chunks.push(o.value);
        }
    };
    if (raw !== null && typeof raw === "object") {
        const c = (raw as Record<string, unknown>).contents;
        if (Array.isArray(c)) for (const e of c) push(e);
        else push(c);
    } else push(raw);
    return chunks.join("\n");
}

export interface ServerGold {
    definition: TebGoldLocation[];
    references: TebGoldLocation[];
    referencesBounded: boolean;
    implementations: TebGoldLocation[];
    callers: Array<{ name: string; path: string; line: number }>;
    hover: HoverGold;
    anchorSpelling: string;
}

/** Read the source spelling of the symbol at the 1-based anchor (for the task prompt). */
export function anchorSpelling(root: string, anchor: { path: string; line: number; character: number }): string {
    const text = readFileSync(join(root, anchor.path), "utf-8");
    const line = text.split("\n")[anchor.line - 1] ?? "";
    const m = /[A-Za-z_$][A-Za-z0-9_$]*/g.exec(line.slice(anchor.character - 1));
    return m?.[0] ?? "";
}

function callerEntries(
    incoming: unknown,
    root: string,
): Array<{ name: string; path: string; line: number }> {
    const canon = realpathSync(root);
    const out = new Map<string, { name: string; path: string; line: number }>();
    const arr = Array.isArray(incoming) ? incoming : [];
    for (const item of arr as Array<{
        from?: { name?: string; uri?: string; range?: RawRange; selectionRange?: RawRange };
        fromRanges?: RawRange[];
    }>) {
        const from = item?.from;
        if (!from || typeof from.uri !== "string") continue;
        let abs: string;
        try {
            abs = realpathSync(fileURLToPath(from.uri));
        } catch {
            continue;
        }
        const range = from.selectionRange ?? from.range;
        if (!range) continue;
        const key = `${relative(canon, abs)}:${range.start.line}`;
        if (!out.has(key)) {
            out.set(key, {
                name: from.name ?? "",
                path: relative(canon, abs),
                line: range.start.line + 1,
            });
        }
    }
    return [...out.values()].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

export interface ServerLabelOptions {
    scope?: string;
    dtsTarget?: boolean;
    normalization?: TypeNormalization;
    /** Project-load wait ms before the first request (default 8000). */
    loadWaitMs?: number;
    tlsBin?: string;
}

/**
 * Drive the pinned server directly for one anchor. References use
 * `includeDeclaration:false` at label time; the caller applies the
 * declaration-inclusion convention per prompt wording.
 */
export async function deriveServerGold(
    root: string,
    anchor: string,
    opts: ServerLabelOptions = {},
): Promise<ServerGold> {
    const a = parseAnchor(anchor);
    const absRoot = realpathSync(resolve(root));
    const absFile = realpathSync(join(absRoot, a.path));
    const uri = pathToFileURL(absFile).href;
    const position = { line: a.line - 1, character: a.character - 1 };
    const conn = new LSPConnection();
    try {
        await conn.start(opts.tlsBin ?? PINNED_TLS_BIN, ["--stdio"], absRoot);
        await new Promise((r) => setTimeout(r, opts.loadWaitMs ?? 8000));
        await conn.prepareDocument(absFile);

        const defRaw = await conn.request("textDocument/definition", {
            textDocument: { uri },
            position,
        });
        const definitions = applyScope(toGold(rawToAbsLocs(defRaw), absRoot), opts.scope ?? "", {
            dtsTarget: opts.dtsTarget,
        });

        const refsRaw = await conn.request("textDocument/references", {
            textDocument: { uri },
            position,
            context: { includeDeclaration: false },
        });
        const allRefs = applyScope(toGold(rawToAbsLocs(refsRaw), absRoot), opts.scope ?? "", {
            dtsTarget: opts.dtsTarget,
        });
        const referencesBounded = allRefs.length <= MAX_IN_SCOPE_REFERENCES;
        const references = referencesBounded ? allRefs : [];

        const implRaw = await conn.request("textDocument/implementation", {
            textDocument: { uri },
            position,
        });
        const implementations = applyScope(toGold(rawToAbsLocs(implRaw), absRoot), opts.scope ?? "", {
            dtsTarget: opts.dtsTarget,
        });

        // Call hierarchy anchors at the gold DEFINITION site (empty at use sites).
        let callers: Array<{ name: string; path: string; line: number }> = [];
        const defAbs = definitions[0];
        if (defAbs) {
            const defUri = pathToFileURL(join(absRoot, defAbs.path)).href;
            const defPos = { line: defAbs.line - 1, character: defAbs.character - 1 };
            try {
                const items = await conn.request("textDocument/prepareCallHierarchy", {
                    textDocument: { uri: defUri },
                    position: defPos,
                });
                const first = (Array.isArray(items) ? items : [items])[0];
                if (first) {
                    const incoming = await conn.request("callHierarchy/incomingCalls", { item: first });
                    callers = callerEntries(incoming, absRoot);
                }
            } catch {
                callers = [];
            }
        }

        const hovRaw = await conn.request("textDocument/hover", { textDocument: { uri }, position });
        const raw = hoverText(hovRaw);
        const normalization = opts.normalization ?? { arrayRewrite: false, dropUndefined: false };
        return {
            definition: definitions,
            references,
            referencesBounded,
            implementations,
            callers,
            hover: { raw, normalized: normalizeTypeString(raw, normalization), normalization },
            anchorSpelling: anchorSpelling(absRoot, a),
        };
    } finally {
        conn.shutdown();
    }
}

/** List TS files under root (bounded), skipping node_modules and dot dirs. */
export function listTsFiles(root: string, cap = 2000): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        if (out.length >= cap) return;
        for (const entry of readdirSync(dir)) {
            if (out.length >= cap) return;
            if (entry === "node_modules" || entry.startsWith(".")) continue;
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) walk(full);
            else if (/\.(m|c)?tsx?$/.test(entry)) out.push(full);
        }
    };
    walk(root);
    return out.sort();
}
