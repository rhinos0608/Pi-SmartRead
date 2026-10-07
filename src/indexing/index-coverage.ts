import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type CoverageStatus = "indexed" | "ignored" | "unsupported" | "binary" | "parse_error" | "partial" | "read_error";

export interface IndexCoverageRecord {
  file: string;
  phase: string;
  status: CoverageStatus;
  reason?: string;
  lineRanges?: Array<{ start: number; end: number }>;
  updatedAt: number;
}

export interface IndexCoverageSummary {
  total: number;
  byStatus: Record<string, number>;
  problematic: number;
}

export function coveragePath(root: string): string {
  return join(resolve(root), ".pi-smartread", "index-coverage.json");
}

export function readCoverage(root: string): IndexCoverageRecord[] {
  const path = coveragePath(root);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { records?: IndexCoverageRecord[] };
    return Array.isArray(parsed.records) ? parsed.records : [];
  } catch {
    return [];
  }
}

export function writeCoverage(root: string, records: IndexCoverageRecord[]): void {
  const path = coveragePath(root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const existing = readCoverage(root);
  const merged = new Map<string, IndexCoverageRecord>();
  for (const record of existing) merged.set(`${record.file}:${record.phase}`, record);
  for (const record of records) merged.set(`${record.file}:${record.phase}`, record);
  writeFileSync(path, JSON.stringify({ version: 1, records: [...merged.values()] }, null, 2), { mode: 0o600 });
}

export function recordCoverage(root: string, record: Omit<IndexCoverageRecord, "updatedAt">): void {
  const records = readCoverage(root).filter((r) => !(r.file === record.file && r.phase === record.phase));
  records.push({ ...record, updatedAt: Date.now() });
  writeCoverage(root, records);
}

export function summarizeCoverage(records: IndexCoverageRecord[]): IndexCoverageSummary {
  const byStatus: Record<string, number> = {};
  for (const record of records) {
    byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;
  }
  const problematic = records.filter((r) => r.status !== "indexed").length;
  return { total: records.length, byStatus, problematic };
}
