/**
 * Enclosing-symbol result units for the no-index BM25 fallback path (D31).
 *
 * Experimental seam: PI_SMARTREAD_GREP_UNIT_MODE = 'anchor' (default,
 * today's behaviour) | 'symbol'. In symbol mode each top BM25 file emits up
 * to M enclosing function/method units (scored by query-token overlap)
 * instead of one best-line anchor window. Files without parseable symbols
 * and units longer than S lines fall back to the anchor window.
 */

import { readFileSync } from "node:fs";
import Parser from "tree-sitter";
import { filenameToLang } from "../languages.js";
import { getQueryPath, loadLanguage } from "../structural/tags.js";
import { tokenize } from "../scoring.js";
import type { GrepHit } from "./grep-cascade.js";

export const GREP_UNIT_MODE_ENV_VAR = "PI_SMARTREAD_GREP_UNIT_MODE";

export type GrepUnitMode = "anchor" | "symbol";

/** Distinct symbol units emitted per file in symbol mode. */
export const GREP_UNIT_MAX_PER_FILE = 2;
/** Rendered excerpt cap: lines shown per unit, centered on best lines. */
export const GREP_UNIT_EXCERPT_LINES = 12;
/** Units longer than this fall back to the anchor window. */
export const GREP_UNIT_MAX_SYMBOL_LINES = 120;

export function resolveGrepUnitMode(
    env: Record<string, string | undefined> = process.env,
): GrepUnitMode {
    return env[GREP_UNIT_MODE_ENV_VAR] === "symbol" ? "symbol" : "anchor";
}

export interface EnclosingSymbolUnit {
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
}

/**
 * Enumerate definition ranges in file content using the same tree-sitter
 * tag queries as the symbol channel. Never throws: unparseable input
 * yields an empty list (caller falls back to the anchor window).
 */
export function listEnclosingSymbolUnits(
    content: string,
    filePath: string,
): EnclosingSymbolUnit[] {
    try {
        const lang = filenameToLang(filePath);
        if (!lang) return [];
        const grammar = loadLanguage(lang);
        if (!grammar) return [];
        const queryPath = getQueryPath(lang);
        if (!queryPath) return [];
        const source = readFileSync(queryPath, "utf-8");
        const parser = new Parser();
        parser.setLanguage(grammar);
        const tree = parser.parse(content);
        if (!tree?.rootNode) return [];
        let tsQuery: Parser.Query;
        try {
            tsQuery = new Parser.Query(grammar, source);
        } catch {
            return [];
        }
        const units: EnclosingSymbolUnit[] = [];
        for (const match of tsQuery.matches(tree.rootNode)) {
            let name: string | undefined;
            let defNode: Parser.SyntaxNode | undefined;
            let kind = "definition";
            for (const capture of match.captures) {
                if (capture.name.startsWith("name.definition")) {
                    name = capture.node.text;
                } else if (capture.name.startsWith("definition")) {
                    defNode = capture.node;
                    kind = capture.name.replace(/^definition\.?/, "") || "definition";
                }
            }
            if (!name || !defNode) continue;
            units.push({
                name: prefixWithParentName(defNode, name),
                kind,
                startLine: defNode.startPosition.row + 1,
                endLine: defNode.endPosition.row + 1,
            });
        }
        return units;
    } catch {
        return [];
    }
}

function prefixWithParentName(defNode: Parser.SyntaxNode, name: string): string {
    let parent = defNode.parent;
    let safety = 0;
    while (parent && safety < 10) {
        safety++;
        if (
            parent.type === "class_declaration" ||
            parent.type === "class_definition" ||
            parent.type === "interface_declaration" ||
            parent.type === "impl_item"
        ) {
            const nameField = parent.childForFieldName?.("name");
            if (nameField) return `${nameField.text}.${name}`;
            break;
        }
        parent = parent.parent;
    }
    return name;
}

function isFunctionLike(kind: string): boolean {
    return /function|method|constructor|arrow|generator|callback/.test(kind);
}

/**
 * Best token-overlap line within [startLine, endLine] (1-based), mirroring
 * the anchor scorer but bounded to the unit.
 */
export function bestLineInRange(
    lines: string[],
    startLine: number,
    endLine: number,
    queryTokens: string[],
): number {
    let bestLine = startLine;
    let bestCount = -1;
    for (let i = startLine - 1; i <= endLine - 1 && i < lines.length; i++) {
        if (i < 0) continue;
        const lower = (lines[i] ?? "").toLowerCase();
        let count = 0;
        for (const tok of queryTokens) if (lower.includes(tok)) count++;
        if (count > bestCount) {
            bestCount = count;
            bestLine = i + 1;
        }
    }
    return bestLine;
}

/**
 * Bounded line-numbered excerpt from within [startLine, endLine], centered
 * on centerLine and capped at GREP_UNIT_EXCERPT_LINES. Never renders lines
 * outside the unit. Same `    NNNN | text` format as the anchor snippet.
 */
export function formatUnitSnippet(
    lines: string[],
    startLine: number,
    endLine: number,
    centerLine: number,
    maxLines: number = GREP_UNIT_EXCERPT_LINES,
): string {
    const clampedCenter = Math.min(Math.max(centerLine, startLine), endLine);
    const half = Math.floor(maxLines / 2);
    let start = Math.max(startLine, clampedCenter - half);
    const end = Math.min(endLine, start + maxLines - 1);
    start = Math.max(startLine, end - maxLines + 1);
    const out: string[] = [];
    for (let i = start; i <= end; i++) {
        out.push(`    ${String(i).padStart(4, " ")} | ${lines[i - 1] ?? ""}`);
    }
    return out.join("\n");
}

export interface SymbolUnitHitInput {
    absPath: string;
    relFile: string;
    content: string;
    filePathForLang: string;
    pattern: string;
    fileScore: number;
    contextLines: number;
}

/**
 * Build up to GREP_UNIT_MAX_PER_FILE symbol-unit hits for one BM25 file.
 * File order is the caller's concern (file-level BM25 rank is preserved by
 * keeping fileScore on each hit). Returns null when symbol units are
 * unavailable — the caller must use the anchor window instead.
 */
export function buildSymbolUnitHits(input: SymbolUnitHitInput): GrepHit[] | null {
    const { absPath, relFile, content, filePathForLang, pattern, fileScore } = input;
    const lines = content.split(/\r?\n/);
    const queryTokens = tokenize(pattern);
    if (queryTokens.length === 0) return null;
    const units = listEnclosingSymbolUnits(content, filePathForLang);
    if (units.length === 0) return null;

    const scored: Array<{ unit: EnclosingSymbolUnit; score: number; size: number }> = [];
    const seen = new Set<string>();
    for (const unit of units) {
        const key = `${unit.name}:${unit.startLine}-${unit.endLine}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const size = unit.endLine - unit.startLine + 1;
        if (size <= 0 || size > GREP_UNIT_MAX_SYMBOL_LINES) continue;
        const text = lines.slice(unit.startLine - 1, unit.endLine).join("\n").toLowerCase();
        let score = 0;
        for (const tok of queryTokens) if (text.includes(tok)) score++;
        if (score === 0) continue;
        scored.push({ unit, score, size });
    }
    if (scored.length === 0) return null;
    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const aFn = isFunctionLike(a.unit.kind) ? 0 : 1;
        const bFn = isFunctionLike(b.unit.kind) ? 0 : 1;
        if (aFn !== bFn) return aFn - bFn;
        if (a.size !== b.size) return a.size - b.size;
        return a.unit.startLine - b.unit.startLine;
    });

    const hits: GrepHit[] = [];
    for (const { unit } of scored.slice(0, GREP_UNIT_MAX_PER_FILE)) {
        const center = bestLineInRange(lines, unit.startLine, unit.endLine, queryTokens);
        hits.push({
            file: absPath,
            relFile,
            line: unit.startLine,
            endLine: unit.endLine,
            name: unit.name,
            kind: "bm25",
            snippet: formatUnitSnippet(lines, unit.startLine, unit.endLine, center),
            engines: ["bm25"],
            score: fileScore,
        });
    }
    return hits.length > 0 ? hits : null;
}
