export type SignalName = "complexity"|"public-api"|"reuse"|"recency"|"tests"|"deprecation";
export interface SignalResult {
  name: SignalName; label: string; value: string; detail?: string;
  confidence: "high"|"medium"|"low"|"none"; source: string;
}
export interface FileSignals {
  path: string; signals: SignalResult[];
  computedAt: string; fallbackNotices: string[];
}
