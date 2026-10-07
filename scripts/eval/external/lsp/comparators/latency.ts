/**
 * Run-level latency aggregation for the external LSP comparator benchmark.
 *
 * Side-effect-free: importing this module never starts the CLI, so unit
 * tests can use it without triggering the runner's top-level main().
 */
import { percentile } from "../metrics.js";

export type LatencyOperation = "definition" | "references" | "hover";

export interface PositionLatency {
  reference: Record<LatencyOperation, number>;
  system: Record<LatencyOperation, number>;
  /** Reference workspace/symbol time: its own series, not setup/index time. */
  workspaceSymbolMs: number;
}

/** Run-level setup/index timing: measured once per run, never per position. */
export interface RunSetupTiming {
  /** Measured startup/index work; null when untimed (never zero). */
  ms: number | null;
  /** Present when ms is null: why setup timing is unavailable. */
  reason?: string | null;
}

export interface LatencySummary {
  p50: number;
  p95: number;
  n: number;
}

export interface NullableLatencySummary {
  p50: number | null;
  p95: number | null;
  n: number;
}

export interface LatencyReport {
  reference: Record<LatencyOperation | "perPositionTotal", LatencySummary>;
  system: Record<LatencyOperation | "perPositionTotal", LatencySummary>;
  /** Reference workspace/symbol latency, kept apart from answer latency. */
  workspaceSymbol: LatencySummary;
  /** Labeled separately: index/setup time, not comparable answer latency. */
  setup: NullableLatencySummary;
  /** Present when setup is unmeasured: why, instead of a zero placeholder. */
  setupNote: string | null;
}

function summarize(values: number[]): LatencySummary {
  if (values.length === 0) return { p50: 0, p95: 0, n: 0 };
  return { p50: percentile(values, 50), p95: percentile(values, 95), n: values.length };
}

/** Setup summarization: untimed entries are excluded; all-untimed yields nulls, never zeros. */
function summarizeSetup(values: Array<number | null>): NullableLatencySummary {
  const measured = values.filter((v): v is number => typeof v === "number");
  if (measured.length === 0) return { p50: null, p95: null, n: 0 };
  return { p50: percentile(measured, 50), p95: percentile(measured, 95), n: measured.length };
}

/**
 * Aggregate per-operation latency in matching units for both sides.
 * Reference and system each get definition/references/hover distributions
 * plus a per-position total (def+refs+hov); workspace/symbol time is
 * reported separately as workspaceSymbol and setup so neither mixes with
 * answer latency. Setup is run-level (n is 0 or 1), never copied per position.
 */
export function summarizeLatency(positions: PositionLatency[], setup: RunSetupTiming): LatencyReport {
  const ops: LatencyOperation[] = ["definition", "references", "hover"];
  const ref: Record<LatencyOperation, number[]> = { definition: [], references: [], hover: [] };
  const sys: Record<LatencyOperation, number[]> = { definition: [], references: [], hover: [] };
  const refTotals: number[] = [];
  const sysTotals: number[] = [];
  const workspaceSymbol: number[] = [];
  for (const p of positions) {
    let refTotal = 0;
    let sysTotal = 0;
    for (const op of ops) {
      ref[op].push(p.reference[op]);
      sys[op].push(p.system[op]);
      refTotal += p.reference[op];
      sysTotal += p.system[op];
    }
    refTotals.push(refTotal);
    sysTotals.push(sysTotal);
    workspaceSymbol.push(p.workspaceSymbolMs);
  }
  const setupSummary = summarizeSetup(setup.ms === null ? [] : [setup.ms]);
  return {
    reference: {
      definition: summarize(ref.definition),
      references: summarize(ref.references),
      hover: summarize(ref.hover),
      perPositionTotal: summarize(refTotals),
    },
    system: {
      definition: summarize(sys.definition),
      references: summarize(sys.references),
      hover: summarize(sys.hover),
      perPositionTotal: summarize(sysTotals),
    },
    workspaceSymbol: summarize(workspaceSymbol),
    setup: setupSummary,
    setupNote: setupSummary.n === 0 ? (setup.reason ?? "setup timing unavailable") : null,
  };
}
