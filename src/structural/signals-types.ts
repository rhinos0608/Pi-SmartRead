export type SignalName = "complexity"|"public-api"|"reuse"|"recency"|"tests"|"deprecation";
export interface SignalResult {
  name: SignalName; label: string; value: string; detail?: string;
  confidence: "high"|"medium"|"low"|"none"; source: string;
}
export interface FileSignals {
  path: string; signals: SignalResult[];
  computedAt: string; fallbackNotices: string[];
}

/** Extended test linkage info — which test files cover a source file. */
export interface TestLinkage {
  sourceFile: string;
  testFile: string;
  coverage: "direct" | "indirect";
}
