/**
 * Deterministic seeded position sampler for the external LSP benchmark.
 *
 * Enumerates identifiers via the TypeScript compiler API and stratifies
 * across syntactic roles (function/method names, imported aliases, type
 * references, property accesses, re-exports, declarations vs uses).
 * Positions are recorded explicitly as 0-based UTF-16 line/character,
 * matching the LSP wire convention (ts.getLineAndCharacterOfPosition is
 * already 0-based UTF-16).
 */
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { BenchPosition } from "./metrics.js";

const require = createRequire(import.meta.url);
// Pinned TS for sampling; falls back to the repo's TS when the pinned
// install is absent (sampling is version-insensitive identifier enumeration).
let ts: typeof import("typescript");
try {
  ts = require(
    `${process.env.HOME}/.cache/pi-smartread-bench/tools/lsp-pinned/node_modules/typescript/lib/typescript.js`,
  ) as typeof import("typescript");
} catch {
  ts = require("typescript") as typeof import("typescript");
}

export type SampleStratum =
  | "function-name"
  | "method-name"
  | "imported-alias"
  | "type-reference"
  | "property-access"
  | "re-export"
  | "declaration"
  | "use";

export interface SampledPosition extends BenchPosition {
  name: string;
  stratum: SampleStratum;
  sourceFile: string; // repo-relative path of the sampling source
}

export const STRATA: readonly SampleStratum[] = [
  "function-name",
  "method-name",
  "imported-alias",
  "type-reference",
  "property-access",
  "re-export",
  "declaration",
  "use",
];

/** mulberry32 — deterministic seeded RNG. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(m|c)?tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

interface Candidate extends SampledPosition {
  offset: number;
}

function classifyIdentifier(
  node: import("typescript").Identifier,
  source: import("typescript").SourceFile,
  text: string,
): SampleStratum {
  const parent = node.parent;
  const SyntaxKind = ts.SyntaxKind;
  if (parent === undefined) return "use";
  switch (parent.kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
      return "function-name";
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      return "method-name";
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.ImportClause:
    case SyntaxKind.NamespaceImport:
      return "imported-alias";
    case SyntaxKind.TypeReference:
      return "type-reference";
    case SyntaxKind.PropertyAccessExpression:
      return (parent as import("typescript").PropertyAccessExpression).name === node
        ? "property-access"
        : "use";
    case SyntaxKind.ExportSpecifier:
    case SyntaxKind.ExportAssignment:
      return "re-export";
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.Parameter:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.EnumDeclaration:
      return "declaration";
    default: {
      // Imported-alias detection via lexical import binding is handled by
      // the ImportSpecifier case above; everything else is a use-site.
      void source;
      void text;
      return "use";
  }
  }
}

/** Enumerate identifier candidates in one file (unsampled, deterministic order). */
export function enumerateFile(root: string, absFile: string): Candidate[] {
  const text = readFileSync(absFile, "utf-8");
  const source = ts.createSourceFile(absFile, text, ts.ScriptTarget.ESNext, true);
  const out: Candidate[] = [];
  const visit = (node: import("typescript").Node): void => {
    if (ts.isIdentifier(node)) {
      const start = node.getStart(source);
      const lc = ts.getLineAndCharacterOfPosition(source, start);
      out.push({
        file: absFile,
        line: lc.line,
        character: lc.character,
        name: node.text,
        stratum: classifyIdentifier(node, source, text),
        sourceFile: relative(root, absFile),
        offset: start,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

export interface SampleOptions {
  seed: number;
  perCorpus: number;
}

/**
 * Sample up to `perCorpus` positions, round-robin across strata so small
 * corpora degrade gracefully (fewer positions, same determinism).
 */
export function sampleCorpus(root: string, opts: SampleOptions): SampledPosition[] {
  const absRoot = resolve(root);
  const rng = seededRng(opts.seed);
  const byStratum = new Map<SampleStratum, Candidate[]>();
  for (const s of STRATA) byStratum.set(s, []);
  for (const f of listTsFiles(absRoot)) {
    for (const c of enumerateFile(absRoot, f)) byStratum.get(c.stratum)?.push(c);
  }
  // Deterministic shuffle within each stratum.
  for (const list of byStratum.values()) {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor((rng() as number) * (i + 1));
      const a = list[i];
      const b = list[j];
      if (a !== undefined && b !== undefined) {
        list[i] = b;
        list[j] = a;
      }
    }
  }
  const out: SampledPosition[] = [];
  let round = 0;
  while (out.length < opts.perCorpus) {
    let progressed = false;
    for (const s of STRATA) {
      if (out.length >= opts.perCorpus) break;
      const list = byStratum.get(s);
      const next = list?.[round];
      if (next) {
        const { offset: _offset, ...pos } = next;
        out.push(pos);
        progressed = true;
      }
    }
    if (!progressed) break;
    round += 1;
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.character - b.character);
}
