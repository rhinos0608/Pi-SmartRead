/**
 * Pure comparison/normalization helpers for the external LSP benchmark.
 *
 * Dependency-free: no transport, no server, no FS writes. Unit-tested in
 * test/unit/eval/external-lsp.test.ts.
 */

export interface BenchPosition {
  file: string;
  line: number; // 0-based, UTF-16 code units
  character: number; // 0-based, UTF-16 code units
}

export interface BenchLocation {
  file: string; // canonical absolute path (realpath)
  start: BenchPosition;
  end: BenchPosition;
}

export type NonAnswerStatus =
  | "unsupported"
  | "unavailable"
  | "not_ready"
  | "timeout"
  | "cancelled"
  | "error"
  | "ambiguous";

/** Statuses that mean "no answer given" — counted separately from wrong answers. */
const NON_ANSWER: ReadonlySet<string> = new Set<string>([
  "unsupported",
  "unavailable",
  "not_ready",
  "timeout",
  "cancelled",
  "error",
  "ambiguous",
]);

/** True when the envelope status is a non-answer (not evidence of a wrong answer). */
export function isNonAnswer(status: string): boolean {
  return NON_ANSWER.has(status);
}

/** True when the status counts as an attempted answer (ok or empty). */
export function isAnswered(status: string): boolean {
  return status === "ok" || status === "empty";
}

/** Canonical key for exact-location matching. */
export function locKey(loc: BenchLocation): string {
  return `${loc.file}:${loc.start.line}:${loc.start.character}:${loc.end.line}:${loc.end.character}`;
}

/** Exact-location match: same canonical file and same start position and end. */
export function definitionMatches(ref: BenchLocation, ours: BenchLocation): boolean {
  return (
    ref.file === ours.file &&
    ref.start.line === ours.start.line &&
    ref.start.character === ours.start.character &&
    ref.end.line === ours.end.line &&
    ref.end.character === ours.end.character
  );
}

/** Start-anchored match: same file and same start (tolerates end-column drift). */
export function definitionMatchesStart(ref: BenchLocation, ours: BenchLocation): boolean {
  return (
    ref.file === ours.file &&
    ref.start.line === ours.start.line &&
    ref.start.character === ours.start.character
  );
}

export interface SetMetrics {
  precision: number;
  recall: number;
  f1: number;
  refSize: number;
  ourSize: number;
  intersection: number;
}

/** Precision/recall/F1 over canonical location keys. Empty/empty scores 1. */
export function setMetrics(refKeys: string[], ourKeys: string[]): SetMetrics {
  const ref = new Set(refKeys);
  const our = new Set(ourKeys);
  let inter = 0;
  for (const k of our) if (ref.has(k)) inter += 1;
  const precision = our.size === 0 ? (ref.size === 0 ? 1 : 0) : inter / our.size;
  const recall = ref.size === 0 ? 1 : inter / ref.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, refSize: ref.size, ourSize: our.size, intersection: inter };
}

export interface HoverCheck {
  nonEmpty: boolean;
  signatureMatch: boolean;
}

/**
 * Hover check: non-empty contents, plus whether the sampled identifier text
 * appears in the hover payload (type-signature match proxy).
 */
export function checkHover(contents: string, sampledName: string): HoverCheck {
  const nonEmpty = contents.trim().length > 0;
  const signatureMatch = nonEmpty && sampledName.length > 0 && contents.includes(sampledName);
  return { nonEmpty, signatureMatch };
}

/** Dedupe ranked locations by first file appearance (rank = first index). */
export function dedupeByFile(locs: BenchLocation[]): BenchLocation[] {
  const seen = new Set<string>();
  const out: BenchLocation[] = [];
  for (const loc of locs) {
    if (seen.has(loc.file)) continue;
    seen.add(loc.file);
    out.push(loc);
  }
  return out;
}

export type DisagreementCategory =
  | "lib-external-decl"
  | "alias"
  | "declaration-vs-definition"
  | "other";

export interface DisagreementInput {
  refFile: string;
  altFile: string;
  refIsDeclaration: boolean;
  altIsDeclaration: boolean;
  nameInRefTarget: boolean;
}

/**
 * Categorize a reference-vs-crosscheck disagreement. Lib/external
 * declarations (node_modules / .d.ts targets) and alias indirection are
 * expected divergences, not failures — they are counted, not dropped.
 */
export function classifyDisagreement(input: DisagreementInput): DisagreementCategory {
  const libish = (f: string): boolean => f.includes("node_modules") || f.endsWith(".d.ts");
  if (libish(input.refFile) || libish(input.altFile)) return "lib-external-decl";
  if (!input.nameInRefTarget) return "alias";
  if (input.refIsDeclaration !== input.altIsDeclaration) return "declaration-vs-definition";
  return "other";
}

/** Nearest-rank percentile (p in 0..100) over a non-empty sample. */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) throw new Error("percentile of empty sample");
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  const value = sorted[rank];
  if (value === undefined) throw new Error("percentile rank out of range");
  return value;
}

/** Rough rendered-token estimate (chars/4) for output-cost comparison. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
