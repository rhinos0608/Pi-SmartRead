#!/usr/bin/env node
/**
 * External LSP benchmark runner: pinned reference vs our strict-LSP path.
 *
 * Reference ground truth: the pinned typescript-language-server driven
 * DIRECTLY over stdio via LSPConnection (transport only — no tool/executor
 * layer), plus a ts.LanguageService cross-check. Our tool: the strict
 * executor (executeLspOperation) at the same positions.
 *
 * Usage:
 *   node --import tsx scripts/eval/external/lsp/run.ts \
 *     --corpus self|mitt --limit 150 --seed 20261005
 *
 * Terminates on its own: reference connections and the manager cache are
 * shut down in a finally block.
 */
import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LSPConnection } from "../../../../src/lsp/lsp-connection.js";
import { executeLspOperation } from "../../../../src/lsp/lsp-executor.js";
import { shutdownAllManagers } from "../../../../src/lsp/lsp-manager.js";
import {
  checkHover,
  classifyDisagreement,
  dedupeByFile,
  definitionMatches,
  definitionMatchesStart,
  estimateTokens,
  isNonAnswer,
  locKey,
  percentile,
  setMetrics,
  type BenchLocation,
  type DisagreementCategory,
} from "./metrics.js";
import { sampleCorpus, type SampledPosition } from "./sample.js";

const BENCH = join(homedir(), ".cache", "pi-smartread-bench");
const TOOLS = join(BENCH, "tools", "lsp-pinned");
const TLS_BIN = join(TOOLS, "node_modules", ".bin", "typescript-language-server");
const PINNED_TS = join(TOOLS, "node_modules", "typescript", "lib", "typescript.js");
const CORPORA: Record<string, string> = {
  self: join(BENCH, "corpora", "pi-smartread-18f6463"),
  mitt: join(BENCH, "corpora", "mitt"),
};

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pinnedTs = require(PINNED_TS) as typeof import("typescript");

interface RawLoc {
  uri?: string;
  targetUri?: string;
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
  targetRange?: { start: { line: number; character: number }; end: { line: number; character: number } };
  targetSelectionRange?: { start: { line: number; character: number }; end: { line: number; character: number } };
}

function uriToFile(uri: string): string | null {
  try {
    if (!uri.startsWith("file:")) return null;
    return realpathSync(fileURLToPath(uri));
  } catch {
    return null;
  }
}

function rawToLocs(raw: unknown): BenchLocation[] {
  if (raw === null || raw === undefined) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: BenchLocation[] = [];
  for (const entry of arr as RawLoc[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const uri = entry.uri ?? entry.targetUri;
    const range = entry.range ?? entry.targetSelectionRange ?? entry.targetRange;
    if (typeof uri !== "string" || !range) continue;
    const file = uriToFile(uri);
    if (!file) continue;
    out.push({
      file,
      start: { file, line: range.start.line, character: range.start.character },
      end: { file, line: range.end.line, character: range.end.character },
    });
  }
  return out;
}

function hoverText(raw: unknown): string {
  // Normalized executor shape {contents:[{kind,value}]} or raw LSP hover.
  const chunks: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string") chunks.push(v);
    else if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.value === "string") chunks.push(o.value);
    }
  };
  if (raw !== null && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const c = o.contents;
    if (Array.isArray(c)) for (const e of c) push(e);
    else push(c);
  } else push(raw);
  return chunks.join("\n");
}

function listTsFiles(root: string, cap: number): string[] {
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

/** Minimal LanguageService host over disk reads (cross-check only). */
function createService(root: string, files: string[]): import("typescript").LanguageService {
  const snapshots = new Map<string, import("typescript").IScriptSnapshot | undefined>();
  const host: import("typescript").LanguageServiceHost = {
    getCompilationSettings: () => ({ target: pinnedTs.ScriptTarget.ESNext, module: pinnedTs.ModuleKind.ESNext, strict: true }),
    getScriptFileNames: () => files,
    getScriptVersion: () => "0",
    getScriptSnapshot: (f) => {
      const cached = snapshots.get(f);
      if (cached !== undefined) return cached;
      try {
        const snap = pinnedTs.ScriptSnapshot.fromString(readFileSync(f, "utf-8"));
        snapshots.set(f, snap);
        return snap;
      } catch {
        snapshots.set(f, undefined);
        return undefined;
      }
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (o) => pinnedTs.getDefaultLibFilePath(o),
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
  return pinnedTs.createLanguageService(host);
}

function offsetOf(pos: { line: number; character: number }, file: string): number {
  const text = readFileSync(file, "utf-8");
  return pinnedTs.getPositionOfLineAndCharacter(
    pinnedTs.createSourceFile(file, text, pinnedTs.ScriptTarget.ESNext, true),
    pos.line,
    pos.character,
  );
}

function spanToLoc(file: string, span: { start: number; length: number }): BenchLocation | null {
  try {
    const text = readFileSync(file, "utf-8");
    const sf = pinnedTs.createSourceFile(file, text, pinnedTs.ScriptTarget.ESNext, true);
    const s = pinnedTs.getLineAndCharacterOfPosition(sf, span.start);
    const e = pinnedTs.getLineAndCharacterOfPosition(sf, span.start + span.length);
    const canon = realpathSync(file);
    return {
      file: canon,
      start: { file: canon, line: s.line, character: s.character },
      end: { file: canon, line: e.line, character: e.character },
    };
  } catch {
    return null;
  }
}

interface Args {
  corpus: string;
  limit: number;
  seed: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { corpus: "mitt", limit: 150, seed: 20261005 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--corpus") out.corpus = argv[i + 1] ?? out.corpus;
    else if (a === "--limit") out.limit = Number(argv[i + 1] ?? out.limit);
    else if (a === "--seed") out.seed = Number(argv[i + 1] ?? out.seed);
  }
  return out;
}

interface PositionResult {
  position: SampledPosition;
  reference: { definitions: BenchLocation[]; referencesIncl: BenchLocation[]; referencesExcl: BenchLocation[]; hover: string; symbols: number; ms: number };
  crosscheck: { definition: BenchLocation | null; references: number; agreement: boolean; category: DisagreementCategory | null };
  ours: Record<string, { status: string; ms: number; tokens: number }>;
  definitionExact: boolean | null;
  definitionStart: boolean | null;
  refF1: number | null;
  hoverNonEmpty: boolean | null;
  hoverSig: boolean | null;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = CORPORA[args.corpus];
  if (!root) throw new Error(`unknown corpus: ${args.corpus}`);
  // Route our strict path at the pinned binary: exact descriptor + PATH first.
  process.env.PATH = `${join(TOOLS, "node_modules", ".bin")}:${process.env.PATH ?? ""}`;

  const positions = sampleCorpus(root, { seed: args.seed, perCorpus: args.limit }).slice(0, args.limit);
  const stratumCounts = new Map<string, number>();
  for (const p of positions) stratumCounts.set(p.stratum, (stratumCounts.get(p.stratum) ?? 0) + 1);

  const refConn = new LSPConnection();
  const ourLat: number[] = [];
  const refLat: number[] = [];
  const results: PositionResult[] = [];
  const disagreementCounts = new Map<string, number>();
  let defExact = 0;
  let defStart = 0;
  let defAnswered = 0;
  let f1Sum = 0;
  let f1N = 0;
  let hoverNE = 0;
  let hoverSig = 0;
  let hoverAnswered = 0;
  let agree = 0;
  let agreeN = 0;
  const statusCounts = new Map<string, number>();

  try {
    await refConn.start(TLS_BIN, ["--stdio"], root);
    const files = listTsFiles(root, 2000);
    const service = createService(root, files);

    for (const pos of positions) {
      const uri = pathToFileURL(pos.file).href;
      const position = { line: pos.line, character: pos.character };
      await refConn.prepareDocument(pos.file);

      const def = await timed(() => refConn.request("textDocument/definition", { textDocument: { uri }, position }));
      const refsIncl = await timed(() =>
        refConn.request("textDocument/references", { textDocument: { uri }, position, context: { includeDeclaration: true } }),
      );
      const hov = await timed(() => refConn.request("textDocument/hover", { textDocument: { uri }, position }));
      const sym = await timed(() => refConn.request("workspace/symbol", { query: pos.name }));
      refLat.push(def.ms + refsIncl.ms + hov.ms);

      const refDefs = rawToLocs(def.value);
      const refRefsIncl = rawToLocs(refsIncl.value);
      const refHover = hoverText(hov.value);
      const symCount = Array.isArray(sym.value) ? sym.value.length : 0;

      // Cross-check via ts.LanguageService.
      let ccDef: BenchLocation | null = null;
      let ccRefs = 0;
      let agreement = false;
      let category: DisagreementCategory | null = null;
      try {
        const off = offsetOf(position, pos.file);
        const defs = service.getDefinitionAtPosition(pos.file, off) ?? [];
        const refs = service.getReferencesAtPosition(pos.file, off) ?? [];
        ccRefs = refs.length;
        const first = defs[0];
        if (first) ccDef = spanToLoc(first.fileName, first.textSpan);
        if (refDefs[0] && ccDef) {
          agreement = definitionMatchesStart(refDefs[0], ccDef);
          if (!agreement) {
            let targetText = "";
            try {
              const t = readFileSync(ccDef.file, "utf-8");
              const sf = pinnedTs.createSourceFile(ccDef.file, t, pinnedTs.ScriptTarget.ESNext, true);
              targetText = t.slice(
                pinnedTs.getPositionOfLineAndCharacter(sf, ccDef.start.line, ccDef.start.character),
                pinnedTs.getPositionOfLineAndCharacter(sf, ccDef.end.line, ccDef.end.character),
              );
            } catch { /* best effort */ }
            category = classifyDisagreement({
              refFile: refDefs[0].file,
              altFile: ccDef.file,
              refIsDeclaration: refDefs[0].file.endsWith(".d.ts"),
              altIsDeclaration: ccDef.file.endsWith(".d.ts"),
              nameInRefTarget: targetText.includes(pos.name),
            });
            disagreementCounts.set(category, (disagreementCounts.get(category) ?? 0) + 1);
          }
          agreeN += 1;
          if (agreement) agree += 1;
        }
      } catch { /* cross-check is best effort */ }

      // Our strict path at the same positions.
      const ours: PositionResult["ours"] = {};
      const runOurs = async (key: string, req: Record<string, unknown>): Promise<unknown> => {
        const t = await timed(() => executeLspOperation({ timeoutMs: 20000, workspace: root, server: "typescript", ...req }, { cwd: root }));
        ours[key] = { status: String(t.value.status), ms: t.ms, tokens: estimateTokens(JSON.stringify(t.value.result ?? "")) };
        statusCounts.set(String(t.value.status), (statusCounts.get(String(t.value.status)) ?? 0) + 1);
        ourLat.push(t.ms);
        return t.value.result;
      };
      const ourDefRaw = await runOurs("goToDefinition", { operation: "goToDefinition", path: pos.file, position });
      const ourRefsRaw = await runOurs("findReferences", { operation: "findReferences", path: pos.file, position, includeDeclaration: true });
      const ourHovRaw = await runOurs("hover", { operation: "hover", path: pos.file, position });
      await runOurs("workspaceSymbols", { operation: "workspaceSymbols", query: pos.name });

      // Metrics.
      const ourDefs = rawToLocs(ourDefRaw);
      const ourRefs = rawToLocs(ourRefsRaw);
      let exact: boolean | null = null;
      let start: boolean | null = null;
      if (refDefs.length > 0 && !isNonAnswer(ours.goToDefinition?.status ?? "")) {
        defAnswered += 1;
        exact = ourDefs.some((o) => refDefs.some((r) => definitionMatches(r, o)));
        start = ourDefs.some((o) => refDefs.some((r) => definitionMatchesStart(r, o)));
        if (exact) defExact += 1;
        if (start) defStart += 1;
      }
      let f1: number | null = null;
      if (!isNonAnswer(ours.findReferences?.status ?? "")) {
        const m = setMetrics(refRefsIncl.map(locKey), ourRefs.map(locKey));
        f1 = m.f1;
        f1Sum += m.f1;
        f1N += 1;
      }
      let hNE: boolean | null = null;
      let hSig: boolean | null = null;
      if (!isNonAnswer(ours.hover?.status ?? "")) {
        hoverAnswered += 1;
        const c = checkHover(hoverText(ourHovRaw), pos.name);
        hNE = c.nonEmpty;
        hSig = c.signatureMatch;
        if (c.nonEmpty) hoverNE += 1;
        if (c.signatureMatch) hoverSig += 1;
      }

      results.push({
        position: pos,
        reference: {
          definitions: dedupeByFile(refDefs),
          referencesIncl: dedupeByFile(refRefsIncl),
          referencesExcl: [],
          hover: refHover.slice(0, 2000),
          symbols: symCount,
          ms: def.ms + refsIncl.ms + hov.ms,
        },
        crosscheck: { definition: ccDef, references: ccRefs, agreement, category },
        ours,
        definitionExact: exact,
        definitionStart: start,
        refF1: f1,
        hoverNonEmpty: hNE,
        hoverSig: hSig,
      });
    }
  } finally {
    try {
      refConn.shutdown();
    } catch { /* best effort */ }
    await shutdownAllManagers().catch(() => {});
  }

  const refLatSafe = refLat.length > 0 ? refLat : [0];
  const ourLatSafe = ourLat.length > 0 ? ourLat : [0];
  const report = {
    tool: "external-lsp-benchmark",
    corpus: args.corpus,
    root,
    seed: args.seed,
    pinned: {
      typescriptLanguageServer: "6.0.0",
      typescriptLanguageServerIntegrity: "sha512-LXtzY3UZGfghWA5eRU6/T5j1+YiGRgy14mR3GOKyTKlE1op1TYKQnLVxwBsmnXeDhGLuvzZyIHBAqvrekAITYQ==",
      typescript: "5.9.2",
      typescriptIntegrity: "sha512-CWBzXQrc/qOkhidw1OzBTQuYRbfyxDXJMVJ1XNwUHGROVmuaeiEm3OslpZ1RV96d7SKKjZKrSJu3+t/xlw3R9A==",
      bin: TLS_BIN,
      tsLibSha256: "aa2ab5a5d765774cbdfdd53cb188d6a6a5749d6f65629bf7c411a3cef6902e79",
    },
    positions: results.length,
    stratumCounts: Object.fromEntries(stratumCounts),
    definition: {
      answered: defAnswered,
      exactMatchRate: defAnswered === 0 ? null : defExact / defAnswered,
      startMatchRate: defAnswered === 0 ? null : defStart / defAnswered,
    },
    references: { measured: f1N, meanF1: f1N === 0 ? null : f1Sum / f1N },
    hover: {
      answered: hoverAnswered,
      nonEmptyRate: hoverAnswered === 0 ? null : hoverNE / hoverAnswered,
      signatureRate: hoverAnswered === 0 ? null : hoverSig / hoverAnswered,
    },
    crosscheck: { agreementRate: agreeN === 0 ? null : agree / agreeN, compared: agreeN, disagreements: Object.fromEntries(disagreementCounts) },
    statusCounts: Object.fromEntries(statusCounts),
    latencyMs: {
      reference: { p50: percentile(refLatSafe, 50), p95: percentile(refLatSafe, 95) },
      ours: { p50: percentile(ourLatSafe, 50), p95: percentile(ourLatSafe, 95) },
    },
    results,
  };

  const outDir = join(BENCH, "reports");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(outDir, `lsp-${args.corpus}-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  chmodSync(outPath, 0o600);
  const summary = {
    corpus: args.corpus,
    positions: results.length,
    defExact: report.definition.exactMatchRate,
    defStart: report.definition.startMatchRate,
    meanF1: report.references.meanF1,
    hoverSig: report.hover.signatureRate,
    agreement: report.crosscheck.agreementRate,
    disagreements: report.crosscheck.disagreements,
    statusCounts: report.statusCounts,
    outPath,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`benchmark failed: ${String((err as Error)?.message ?? err)}\n`);
  process.exitCode = 1;
});
