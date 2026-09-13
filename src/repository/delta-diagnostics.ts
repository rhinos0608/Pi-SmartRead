/**
 * Diagnostic and capability change detection between two snapshots.
 *
 * §3P DiagnosticChange and capability diff for SemanticDelta construction.
 *
 * @module delta-diagnostics
 */

import { createHash } from "node:crypto";
import type { CapabilityReport } from "./repository-intelligence-types.js";

// ── Input/output types ────────────────────────────────────────────

export type Diagnostic = {
  filePath: string;
  message: string;
  severity: number;
  source: string;
};

/**
 * Result of file-level lineage matching between two snapshots.
 * `pathMap` maps before-file-paths to their corresponding after-file-paths
 * for files that were matched as the same entity (possibly moved/renamed).
 */
export type FileLineageResult = {
  pathMap: Record<string, string>;
};

export type DiagnosticChange = {
  kind: "ADDED" | "REMOVED" | "MODIFIED";
  filePath?: string;
  beforeFingerprint?: string;
  afterFingerprint?: string;
};

export type CapabilityChange = {
  before: CapabilityReport;
  after: CapabilityReport;
  /** Top-level keys whose values differ between before and after. */
  changedKeys: string[];
};

// ── Fingerprint ────────────────────────────────────────────────────

function fingerprint(diag: Diagnostic): string {
  const payload = `${diag.message}\0${diag.severity}\0${diag.source}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// ── computeDiagnosticChanges ───────────────────────────────────────

export function computeDiagnosticChanges(
  beforeDiags: Diagnostic[],
  afterDiags: Diagnostic[],
  fileLineage: FileLineageResult,
): DiagnosticChange[] {
  const changes: DiagnosticChange[] = [];

  // Group diagnostics by file path.
  const beforeByFile = groupByFile(beforeDiags);
  const afterByFile = groupByFile(afterDiags);

  // Track which after-file paths have been consumed by lineage matching.
  const consumedAfterPaths = new Set<string>();

  // Process matched files (before → after via lineage).
  for (const [beforePath, beforeFileDiags] of beforeByFile) {
    // Lineage maps before→after; fall back to same path when unmapped.
    const resolvedAfterPath = fileLineage.pathMap[beforePath] ?? beforePath;
    const afterFileDiags = afterByFile.get(resolvedAfterPath);

    if (afterFileDiags == null) {
      // File removed or no lineage match → all diagnostics REMOVED.
      for (const d of beforeFileDiags) {
        changes.push({
          kind: "REMOVED",
          filePath: d.filePath,
          beforeFingerprint: fingerprint(d),
        });
      }
      continue;
    }

    consumedAfterPaths.add(resolvedAfterPath);

    // Match diagnostics within this file by message content.
    const afterByMessage = new Map<string, Diagnostic[]>();
    for (const ad of afterFileDiags) {
      const list = afterByMessage.get(ad.message) ?? [];
      list.push(ad);
      afterByMessage.set(ad.message, list);
    }

    const unmatchedAfterMessages = new Map(afterByMessage);

    for (const bd of beforeFileDiags) {
      const bf = fingerprint(bd);
      const candidates = afterByMessage.get(bd.message);

      if (candidates != null && candidates.length > 0) {
        // Found a diagnostic with the same message in the after snapshot.
        const matched = candidates.shift()!;
        const af = fingerprint(matched);

        if (bf === af) {
          // Unchanged — no change entry.
        } else {
          // Same message, different fingerprint → MODIFIED.
          changes.push({
            kind: "MODIFIED",
            filePath: bd.filePath,
            beforeFingerprint: bf,
            afterFingerprint: af,
          });
        }
        // Remove from unmatched tracking.
        const remaining = unmatchedAfterMessages.get(bd.message);
        if (remaining != null && remaining.length > 0) {
          unmatchedAfterMessages.set(bd.message, remaining);
        } else {
          unmatchedAfterMessages.delete(bd.message);
        }
      } else {
        // Before diagnostic has no after match → REMOVED.
        changes.push({
          kind: "REMOVED",
          filePath: bd.filePath,
          beforeFingerprint: bf,
        });
      }
    }

    // Remaining after diagnostics with no before match → ADDED.
    for (const [, remaining] of unmatchedAfterMessages) {
      for (const ad of remaining) {
        changes.push({
          kind: "ADDED",
          filePath: ad.filePath,
          afterFingerprint: fingerprint(ad),
        });
      }
    }
  }

  // Process after-files with no before counterpart (new files).
  for (const [afterPath, afterFileDiags] of afterByFile) {
    if (consumedAfterPaths.has(afterPath)) continue;

    for (const ad of afterFileDiags) {
      changes.push({
        kind: "ADDED",
        filePath: ad.filePath,
        afterFingerprint: fingerprint(ad),
      });
    }
  }

  return changes;
}

function groupByFile(diags: Diagnostic[]): Map<string, Diagnostic[]> {
  const map = new Map<string, Diagnostic[]>();
  for (const d of diags) {
    const list = map.get(d.filePath) ?? [];
    list.push(d);
    map.set(d.filePath, list);
  }
  return map;
}

// ── computeCapabilityChange ────────────────────────────────────────

export function computeCapabilityChange(
  before: CapabilityReport,
  after: CapabilityReport,
): CapabilityChange {
  const changedKeys: string[] = [];

  if (before.filesObserved !== after.filesObserved) {
    changedKeys.push("filesObserved");
  }

  // Compare byLanguage arrays (by language name + per-language fields).
  if (!byLanguageEqual(before.byLanguage, after.byLanguage)) {
    changedKeys.push("byLanguage");
  }

  if (before.graphAssessment !== after.graphAssessment) {
    changedKeys.push("graphAssessment");
  }

  if (!stringArraysEqual(before.coverageReasons, after.coverageReasons)) {
    changedKeys.push("coverageReasons");
  }

  if (before.omittedEdgeCount !== after.omittedEdgeCount) {
    changedKeys.push("omittedEdgeCount");
  }

  return { before, after, changedKeys };
}

function byLanguageEqual(
  a: CapabilityReport["byLanguage"],
  b: CapabilityReport["byLanguage"],
): boolean {
  if (a.length !== b.length) return false;
  const bByLang = new Map(b.map((e) => [e.language, e]));
  for (const ae of a) {
    const be = bByLang.get(ae.language);
    if (be == null) return false;
    if (
      ae.files !== be.files ||
      ae.tags !== be.tags ||
      ae.structuralFacts !== be.structuralFacts ||
      ae.callGraph !== be.callGraph ||
      ae.lsp !== be.lsp ||
      !stringArraysEqual(ae.reasons, be.reasons)
    ) {
      return false;
    }
  }
  return true;
}

function stringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
