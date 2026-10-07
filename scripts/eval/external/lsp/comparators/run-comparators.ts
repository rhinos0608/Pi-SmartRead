#!/usr/bin/env node
/**
 * External LSP comparator runner: pinned reference vs pi-lsp / mcp-language-server.
 *
 * Companion to ../run.ts (which benchmarks our strict-LSP path). This script
 * is intentionally separate: it selects --system pi-lsp|mcp-language-server
 * and reuses the same sampled positions (sample.ts), reference ground truth
 * (pinned typescript-language-server driven directly over stdio), pure
 * metric helpers (metrics.ts), and report shape/permissions.
 *
 * Only operations a comparator natively supports are scored; the rest are
 * recorded as `unsupported`, never as wrong answers (D16/D17).
 *
 * Usage:
 *   node --import tsx scripts/eval/external/lsp/comparators/run-comparators.ts \
 *     --system pi-lsp|mcp-language-server --corpus self|mitt --limit 150 --seed 20261005
 *
 * Terminates on its own: the comparator and the reference connection are
 * shut down in a finally block (comparator children are killed by their
 * adapters when they fail to exit).
 */
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LSPConnection } from "../../../../../src/lsp/lsp-connection.js";
import { shutdownAllManagers } from "../../../../../src/lsp/lsp-manager.js";
import {
  checkHover,
  dedupeByFile,
  definitionMatches,
  definitionMatchesStart,
  isNonAnswer,
  locKey,
  setMetrics,
  type BenchLocation,
} from "../metrics.js";
import { sampleCorpus, type SampledPosition } from "../sample.js";
import { createMcpComparator } from "./mcp-server.js";
import { createPiLspComparator } from "./pi-lsp.js";
import { createSerenaComparator, lineKey, SERENA_PIN } from "./serena.js";
import { summarizeLatency, type PositionLatency } from "./latency.js";
import { startKey, type Comparator, type ComparatorCall } from "./types.js";

const BENCH = join(homedir(), ".cache", "pi-smartread-bench");
const TOOLS = join(BENCH, "tools", "lsp-pinned");
const TLS_BIN = join(TOOLS, "node_modules", ".bin", "typescript-language-server");
const PINNED_BIN_DIR = join(TOOLS, "node_modules", ".bin");
const CORPORA: Record<string, string> = {
  self: join(BENCH, "corpora", "pi-smartread-18f6463"),
  mitt: join(BENCH, "corpora", "mitt"),
};

const RAW_CAP = 8000;
const OP_TIMEOUT_MS = 90000;

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

function capRaw(raw: string): { text: string; truncated: boolean } {
  if (raw.length <= RAW_CAP) return { text: raw, truncated: false };
  return { text: raw.slice(0, RAW_CAP), truncated: true };
}

async function withOpTimeout(call: Promise<ComparatorCall>): Promise<ComparatorCall> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<ComparatorCall>((resolve) => {
        timer = setTimeout(() => {
          resolve({ status: "timeout", ms: OP_TIMEOUT_MS, tokens: 0, raw: "error: runner op timeout", locations: [] });
        }, OP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createComparator(system: string): Comparator {
  if (system === "pi-lsp") return createPiLspComparator(TLS_BIN);
  if (system === "mcp-language-server") return createMcpComparator(TLS_BIN, PINNED_BIN_DIR);
  if (system === "serena") return createSerenaComparator();
  throw new Error(`unknown system: ${system}`);
}

interface Args {
  system: string;
  corpus: string;
  limit: number;
  seed: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { system: "", corpus: "mitt", limit: 150, seed: 20261005 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--system") out.system = argv[i + 1] ?? out.system;
    else if (a === "--corpus") out.corpus = argv[i + 1] ?? out.corpus;
    else if (a === "--limit") out.limit = Number(argv[i + 1] ?? out.limit);
    else if (a === "--seed") out.seed = Number(argv[i + 1] ?? out.seed);
  }
  return out;
}

interface PositionResult {
  position: SampledPosition;
  reference: {
    definitions: BenchLocation[];
    referencesIncl: BenchLocation[];
    hover: string;
    symbols: number;
    ms: number;
  };
  system: Record<string, { status: string; ms: number; tokens: number }>;
  raw: Record<string, { text: string; truncated: boolean }>;
  definitionExact: boolean | null;
  definitionStart: boolean | null;
  definitionLine: boolean | null;
  refF1: number | null;
  refStartF1: number | null;
  refLineF1: number | null;
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
  if (args.system !== "pi-lsp" && args.system !== "mcp-language-server" && args.system !== "serena") {
    throw new Error("--system must be pi-lsp, mcp-language-server, or serena");
  }
  const root = CORPORA[args.corpus];
  if (!root) throw new Error(`unknown corpus: ${args.corpus}`);
  process.env.PATH = `${PINNED_BIN_DIR}:${process.env.PATH ?? ""}`;

  const comparator = createComparator(args.system);
  const positions = sampleCorpus(root, { seed: args.seed, perCorpus: args.limit }).slice(0, args.limit);
  const stratumCounts = new Map<string, number>();
  for (const p of positions) stratumCounts.set(p.stratum, (stratumCounts.get(p.stratum) ?? 0) + 1);

  const refConn = new LSPConnection();
  const posLatencies: PositionLatency[] = [];
  // Run-level setup timing: measured once, never copied per position.
  let setupMs: number | null = null;
  let setupReason: string | null = "setup timing unavailable: startup/open threw before timing completed";
  const results: PositionResult[] = [];
  const statusCounts = new Map<string, number>();
  const tokenSums = new Map<string, number>();
  const tokenNs = new Map<string, number>();
  let defExact = 0;
  let defStart = 0;
  let defLine = 0;
  let defAnswered = 0;
  let f1Sum = 0;
  let lineF1Sum = 0;
  let f1N = 0;
  let startF1Sum = 0;
  let hoverNE = 0;
  let hoverSig = 0;
  let hoverAnswered = 0;

  const bumpStatus = (status: string): void => {
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  };

  try {
    const setupTimed = await timed(async () => {
      await refConn.start(TLS_BIN, ["--stdio"], root);
      await comparator.open(root);
    });
    setupMs = setupTimed.ms;
    setupReason = null;

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
      posLatencies.push({
        // Reference per-position timing is captured below once the system
        // calls complete; workspace/symbol is its own series, setup tracks
        // actual startup/index work.
        reference: { definition: def.ms, references: refsIncl.ms, hover: hov.ms },
        system: { definition: 0, references: 0, hover: 0 },
        workspaceSymbolMs: sym.ms,
      });

      const refDefs = rawToLocs(def.value);
      const refRefs = rawToLocs(refsIncl.value);
      const refHover = hoverText(hov.value);
      const symCount = Array.isArray(sym.value) ? sym.value.length : 0;

      const sys: PositionResult["system"] = {};
      const raw: PositionResult["raw"] = {};
      const record = (key: string, call: ComparatorCall): void => {
        sys[key] = { status: call.status, ms: call.ms, tokens: call.tokens };
        raw[key] = capRaw(call.raw);
        bumpStatus(call.status);
        if (key === "definition" || key === "references" || key === "hover") {
          const current = posLatencies[posLatencies.length - 1];
          if (current) current.system[key] = call.ms;
        }
        tokenSums.set(key, (tokenSums.get(key) ?? 0) + call.tokens);
        tokenNs.set(key, (tokenNs.get(key) ?? 0) + 1);
      };
      const sysDef = await withOpTimeout(comparator.definition(pos));
      record("definition", sysDef);
      const sysRefs = await withOpTimeout(comparator.references(pos));
      record("references", sysRefs);
      const sysHov = await withOpTimeout(comparator.hover(pos));
      record("hover", sysHov);
      sys["workspaceSymbols"] = { status: "unsupported", ms: 0, tokens: 0 };
      raw["workspaceSymbols"] = { text: "", truncated: false };
      bumpStatus("unsupported");

      let exact: boolean | null = null;
      let start: boolean | null = null;
      let line: boolean | null = null;
      if (refDefs.length > 0 && !isNonAnswer(sysDef.status)) {
        defAnswered += 1;
        exact = sysDef.locations.some((o) => refDefs.some((r) => definitionMatches(r, o)));
        start = sysDef.locations.some((o) => refDefs.some((r) => definitionMatchesStart(r, o)));
        // Line-anchored match (Serena output is line-granular by design).
        line = sysDef.locations.some((o) => refDefs.some((r) => lineKey(r) === lineKey(o)));
        if (exact) defExact += 1;
        if (start) defStart += 1;
        if (line) defLine += 1;
      }
      let f1: number | null = null;
      let startF1: number | null = null;
      let lineF1: number | null = null;
      if (!isNonAnswer(sysRefs.status)) {
        const m = setMetrics(refRefs.map(locKey), sysRefs.locations.map(locKey));
        f1 = m.f1;
        f1Sum += m.f1;
        f1N += 1;
        // Secondary: start-anchored keys (mcp-language-server reports starts only).
        const sm = setMetrics(refRefs.map(startKey), sysRefs.locations.map(startKey));
        startF1 = sm.f1;
        startF1Sum += sm.f1;
        // Secondary: line-anchored keys (Serena reports lines only).
        const lm = setMetrics(refRefs.map(lineKey), sysRefs.locations.map(lineKey));
        lineF1 = lm.f1;
        lineF1Sum += lm.f1;
      }
      let hNE: boolean | null = null;
      let hSig: boolean | null = null;
      if (!isNonAnswer(sysHov.status)) {
        hoverAnswered += 1;
        const c = checkHover(sysHov.hoverText ?? "", pos.name);
        hNE = c.nonEmpty;
        hSig = c.signatureMatch;
        if (c.nonEmpty) hoverNE += 1;
        if (c.signatureMatch) hoverSig += 1;
      }

      results.push({
        position: pos,
        reference: {
          definitions: dedupeByFile(refDefs),
          referencesIncl: dedupeByFile(refRefs),
          hover: refHover.slice(0, 2000),
          symbols: symCount,
          ms: def.ms + refsIncl.ms + hov.ms,
        },
        system: sys,
        raw,
        definitionExact: exact,
        definitionStart: start,
        definitionLine: line,
        refF1: f1,
        refStartF1: startF1,
        refLineF1: lineF1,
        hoverNonEmpty: hNE,
        hoverSig: hSig,
      });
    }
  } finally {
    try {
      await comparator.close();
    } catch {
      /* best effort */
    }
    try {
      refConn.shutdown();
    } catch {
      /* best effort */
    }
    await shutdownAllManagers().catch(() => {});
  }

  const latency = summarizeLatency(posLatencies, { ms: setupMs, reason: setupReason });
  const meanTokens: Record<string, number> = {};
  for (const [k, sum] of tokenSums) {
    const n = tokenNs.get(k) ?? 1;
    meanTokens[k] = sum / n;
  }
  const report = {
    tool: "external-lsp-benchmark",
    system: args.system,
    caveats: comparator.caveats,
    corpus: args.corpus,
    root,
    seed: args.seed,
    pinned: {
      typescriptLanguageServer: "6.0.0",
      typescript: "5.9.2",
      bin: TLS_BIN,
      comparators:
        args.system === "pi-lsp"
          ? { piLsp: "0.0.48", piChildEnv: "0.1.10", typebox: "1.3.35" }
          : args.system === "serena"
            ? { serenaAgent: SERENA_PIN.serenaAgent, typescriptLanguageServer: SERENA_PIN.typescriptLanguageServer, typescript: SERENA_PIN.typescript }
            : { mcpLanguageServer: "v0.1.1 (46e2950)" },
    },
    positions: results.length,
    stratumCounts: Object.fromEntries(stratumCounts),
    definition: {
      answered: defAnswered,
      exactMatchRate: defAnswered === 0 ? null : defExact / defAnswered,
      startMatchRate: defAnswered === 0 ? null : defStart / defAnswered,
      lineMatchRate: defAnswered === 0 ? null : defLine / defAnswered,
    },
    references: {
      measured: f1N,
      meanF1: f1N === 0 ? null : f1Sum / f1N,
      meanStartF1: f1N === 0 ? null : startF1Sum / f1N,
      meanLineF1: f1N === 0 ? null : lineF1Sum / f1N,
      keyMode: "exact-locKey primary; start-anchored secondary (mcp outputs starts only); line-anchored secondary (serena outputs lines only)",
    },
    hover: {
      answered: hoverAnswered,
      nonEmptyRate: hoverAnswered === 0 ? null : hoverNE / hoverAnswered,
      signatureRate: hoverAnswered === 0 ? null : hoverSig / hoverAnswered,
    },
    statusCounts: Object.fromEntries(statusCounts),
    latencyMs: latency,
    meanOutputTokens: meanTokens,
    results,
  };

  const outDir = join(BENCH, "reports");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(outDir, `lsp-${args.system}-${args.corpus}-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  chmodSync(outPath, 0o600);
  const summary = {
    system: args.system,
    corpus: args.corpus,
    positions: results.length,
    defExact: report.definition.exactMatchRate,
    defStart: report.definition.startMatchRate,
    defLine: report.definition.lineMatchRate,
    meanF1: report.references.meanF1,
    meanStartF1: report.references.meanStartF1,
    meanLineF1: report.references.meanLineF1,
    hoverSig: report.hover.signatureRate,
    statusCounts: report.statusCounts,
    meanOutputTokens: meanTokens,
    outPath,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function isDirectExecution(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return pathToFileURL(realpathSync(invoked)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().catch((err) => {
    process.stderr.write(`comparator benchmark failed: ${String((err as Error)?.message ?? err)}\n`);
    process.exitCode = 1;
  });
}
