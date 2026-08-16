export type DegradationBackend = "bm25" | "symbol" | "semantic" | "lsp" | "lexical";

export interface DegradationRecord {
  backend: DegradationBackend;
  code: string;
  ts: number;
}

const RECENT_CAP = 20;
const recent: DegradationRecord[] = [];

export function recordDegradation(code: string, backend: DegradationBackend): void {
  // A backend can be unavailable for an entire session (for example when the
  // optional semantic index is not installed). Do not turn every subsequent
  // search into an identical degradation-history entry; retain a new record when
  // the observed degradation changes or a different backend intervenes.
  const previous = recent[recent.length - 1];
  if (previous?.backend === backend && previous.code === code) {
    previous.ts = Date.now();
    return;
  }
  recent.push({ backend, code, ts: Date.now() });
  if (recent.length > RECENT_CAP) recent.shift();
}

export function recentDegradations(): DegradationRecord[] {
  return recent.slice();
}

export function resetRuntimeHealth(): void {
  recent.length = 0;
}