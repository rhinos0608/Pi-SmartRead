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
  /** Reference workspace/symbol time: setup, not answer latency. */
  setupMs: number;
}

export interface LatencySummary {
  p50: number;
  p95: number;
  n: number;
}

export interface LatencyReport {
  reference: Record<LatencyOperation | "perPositionTotal", LatencySummary>;
  system: Record<LatencyOperation | "perPositionTotal", LatencySummary>;
  /** Labeled separately: index/setup time, not comparable answer latency. */
  setup: LatencySummary;
}

function summarize(values: number[]): LatencySummary {
  if (values.length === 0) return { p50: 0, p95: 0, n: 0 };
  return { p50: percentile(values, 50), p95: percentile(values, 95), n: values.length };
}

/**
 * Aggregate per-operation latency in matching units for both sides.
 * Reference and system each get definition/references/hover distributions
 * plus a per-position total (def+refs+hov); workspace/symbol time is
 * reported separately as setup so it never mixes with answer latency.
 */
export function summarizeLatency(positions: PositionLatency[]): LatencyReport {
  const ops: LatencyOperation[] = ["definition", "references", "hover"];
  const ref: Record<LatencyOperation, number[]> = { definition: [], references: [], hover: [] };
  const sys: Record<LatencyOperation, number[]> = { definition: [], references: [], hover: [] };
  const refTotals: number[] = [];
  const sysTotals: number[] = [];
  const setup: number[] = [];
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
    setup.push(p.setupMs);
  }
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
    setup: summarize(setup),
  };
}
