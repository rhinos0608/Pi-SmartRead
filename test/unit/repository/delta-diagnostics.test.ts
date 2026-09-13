import { describe, expect, it } from "vitest";
import {
  computeDiagnosticChanges,
  computeCapabilityChange,
} from "../../src/delta-diagnostics.js";
import type {
  Diagnostic,
  FileLineageResult,
} from "../../src/delta-diagnostics.js";
import type { CapabilityReport } from "../../src/repository-intelligence-types.js";

// ── Helpers ────────────────────────────────────────────────────────

function diag(
  filePath: string,
  message: string,
  severity: number,
  source: string,
): Diagnostic {
  return { filePath, message, severity, source };
}

const NO_LINEAGE: FileLineageResult = { pathMap: {} };

function capReport(
  overrides: Partial<CapabilityReport> = {},
): CapabilityReport {
  return {
    filesObserved: 10,
    byLanguage: [
      {
        language: "typescript",
        files: 8,
        tags: "AVAILABLE",
        structuralFacts: "AVAILABLE",
        callGraph: "PARTIAL",
        lsp: "AVAILABLE",
        reasons: [],
      },
    ],
    graphAssessment: "complete",
    coverageReasons: [],
    omittedEdgeCount: 0,
    ...overrides,
  };
}

// ── Diagnostic change tests ────────────────────────────────────────

describe("computeDiagnosticChanges", () => {
  it("detects added diagnostic", () => {
    const before: Diagnostic[] = [];
    const after: Diagnostic[] = [diag("/a.ts", "unused var", 2, "eslint")];

    const changes = computeDiagnosticChanges(before, after, NO_LINEAGE);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      kind: "ADDED",
      filePath: "/a.ts",
      afterFingerprint: expect.any(String),
    });
  });

  it("detects removed diagnostic", () => {
    const before: Diagnostic[] = [diag("/a.ts", "unused var", 2, "eslint")];
    const after: Diagnostic[] = [];

    const changes = computeDiagnosticChanges(before, after, NO_LINEAGE);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      kind: "REMOVED",
      filePath: "/a.ts",
      beforeFingerprint: expect.any(String),
    });
  });

  it("detects modified diagnostic (severity changed)", () => {
    const before: Diagnostic[] = [diag("/a.ts", "unused var", 2, "eslint")];
    const after: Diagnostic[] = [diag("/a.ts", "unused var", 1, "eslint")];

    const changes = computeDiagnosticChanges(before, after, NO_LINEAGE);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe("MODIFIED");
    expect(changes[0]!.filePath).toBe("/a.ts");
    expect(changes[0]!.beforeFingerprint).toBeDefined();
    expect(changes[0]!.afterFingerprint).toBeDefined();
    expect(changes[0]!.beforeFingerprint).not.toBe(changes[0]!.afterFingerprint);
  });

  it("detects modified diagnostic (source changed)", () => {
    const before: Diagnostic[] = [diag("/a.ts", "unused var", 2, "eslint")];
    const after: Diagnostic[] = [diag("/a.ts", "unused var", 2, "typescript")];

    const changes = computeDiagnosticChanges(before, after, NO_LINEAGE);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe("MODIFIED");
  });

  it("ignores unchanged diagnostics", () => {
    const before: Diagnostic[] = [
      diag("/a.ts", "unused var", 2, "eslint"),
      diag("/a.ts", "missing return", 1, "typescript"),
    ];
    const after: Diagnostic[] = [
      diag("/a.ts", "unused var", 2, "eslint"),
      diag("/a.ts", "missing return", 1, "typescript"),
    ];

    const changes = computeDiagnosticChanges(before, after, NO_LINEAGE);
    expect(changes).toHaveLength(0);
  });

  it("translates moved file paths via lineage", () => {
    const before: Diagnostic[] = [diag("/old/a.ts", "err", 1, "ts")];
    const after: Diagnostic[] = [diag("/new/a.ts", "err", 1, "ts")];
    const lineage: FileLineageResult = { pathMap: { "/old/a.ts": "/new/a.ts" } };

    const changes = computeDiagnosticChanges(before, after, lineage);
    // Same diagnostic, just moved → unchanged.
    expect(changes).toHaveLength(0);
  });

  it("reports REMOVED for moved file that disappears", () => {
    const before: Diagnostic[] = [diag("/old/a.ts", "err", 1, "ts")];
    const after: Diagnostic[] = [];
    const lineage: FileLineageResult = { pathMap: { "/old/a.ts": "/new/a.ts" } };

    const changes = computeDiagnosticChanges(before, after, lineage);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe("REMOVED");
    expect(changes[0]!.filePath).toBe("/old/a.ts");
  });

  it("reports ADDED for new file diagnostics", () => {
    const before: Diagnostic[] = [];
    const after: Diagnostic[] = [diag("/brand-new.ts", "issue", 2, "eslint")];

    const changes = computeDiagnosticChanges(before, after, NO_LINEAGE);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe("ADDED");
  });

  it("handles multiple diagnostics per file correctly", () => {
    const before: Diagnostic[] = [
      diag("/a.ts", "err1", 1, "ts"),
      diag("/a.ts", "err2", 2, "eslint"),
      diag("/a.ts", "err3", 3, "ts"),
    ];
    const after: Diagnostic[] = [
      diag("/a.ts", "err1", 1, "ts"), // unchanged
      diag("/a.ts", "err2-modified", 2, "eslint"), // ADDED (new message)
      // err3 removed
    ];

    const changes = computeDiagnosticChanges(before, after, NO_LINEAGE);
    // err2 (message changed) and err3 both REMOVED; err2-modified ADDED.
    const removed = changes.filter((c) => c.kind === "REMOVED");
    const added = changes.filter((c) => c.kind === "ADDED");
    expect(removed).toHaveLength(2);
    expect(removed.every((c) => c.filePath === "/a.ts")).toBe(true);
    expect(added).toHaveLength(1);
    expect(added[0]!.filePath).toBe("/a.ts");
  });

  it("unmatched before files all get REMOVED", () => {
    const before: Diagnostic[] = [
      diag("/x.ts", "a", 1, "ts"),
      diag("/y.ts", "b", 2, "eslint"),
    ];
    const after: Diagnostic[] = [diag("/z.ts", "c", 1, "ts")];

    const changes = computeDiagnosticChanges(before, after, NO_LINEAGE);
    const removed = changes.filter((c) => c.kind === "REMOVED");
    const added = changes.filter((c) => c.kind === "ADDED");
    expect(removed).toHaveLength(2);
    expect(added).toHaveLength(1);
  });

  it("mixed add/remove/modify in one call", () => {
    const before: Diagnostic[] = [
      diag("/a.ts", "shared", 1, "ts"),
      diag("/b.ts", "only-before", 2, "eslint"),
    ];
    const after: Diagnostic[] = [
      diag("/a.ts", "shared", 2, "ts"), // MODIFIED (severity changed)
      diag("/c.ts", "only-after", 1, "eslint"), // ADDED
    ];

    const changes = computeDiagnosticChanges(before, after, NO_LINEAGE);
    const kinds = changes.map((c) => c.kind).sort();
    expect(kinds).toEqual(["ADDED", "MODIFIED", "REMOVED"]);
  });
});

// ── Capability change tests ────────────────────────────────────────

describe("computeCapabilityChange", () => {
  it("detects unchanged capability reports", () => {
    const report = capReport();
    const result = computeCapabilityChange(report, report);
    expect(result.changedKeys).toHaveLength(0);
    expect(result.before).toBe(report);
    expect(result.after).toBe(report);
  });

  it("detects filesObserved change", () => {
    const a = capReport({ filesObserved: 10 });
    const b = capReport({ filesObserved: 12 });
    const result = computeCapabilityChange(a, b);
    expect(result.changedKeys).toContain("filesObserved");
    expect(result.changedKeys).toHaveLength(1);
  });

  it("detects graphAssessment change", () => {
    const a = capReport({ graphAssessment: "complete" });
    const b = capReport({ graphAssessment: "partial" });
    const result = computeCapabilityChange(a, b);
    expect(result.changedKeys).toContain("graphAssessment");
  });

  it("detects byLanguage change", () => {
    const a = capReport();
    const b = capReport({
      byLanguage: [
        {
          language: "typescript",
          files: 8,
          tags: "AVAILABLE",
          structuralFacts: "AVAILABLE",
          callGraph: "UNAVAILABLE",
          lsp: "AVAILABLE",
          reasons: [],
        },
      ],
    });
    const result = computeCapabilityChange(a, b);
    expect(result.changedKeys).toContain("byLanguage");
  });

  it("detects byLanguage addition", () => {
    const a = capReport();
    const b = capReport({
      byLanguage: [
        {
          language: "typescript",
          files: 8,
          tags: "AVAILABLE",
          structuralFacts: "AVAILABLE",
          callGraph: "PARTIAL",
          lsp: "AVAILABLE",
          reasons: [],
        },
        {
          language: "python",
          files: 3,
          tags: "PARTIAL",
          structuralFacts: "PARTIAL",
          callGraph: "UNAVAILABLE",
          lsp: "UNAVAILABLE",
          reasons: ["no LSP server"],
        },
      ],
    });
    const result = computeCapabilityChange(a, b);
    expect(result.changedKeys).toContain("byLanguage");
  });

  it("detects coverageReasons change", () => {
    const a = capReport({ coverageReasons: ["reason1"] });
    const b = capReport({ coverageReasons: ["reason1", "reason2"] });
    const result = computeCapabilityChange(a, b);
    expect(result.changedKeys).toContain("coverageReasons");
  });

  it("detects omittedEdgeCount change", () => {
    const a = capReport({ omittedEdgeCount: 0 });
    const b = capReport({ omittedEdgeCount: 5 });
    const result = computeCapabilityChange(a, b);
    expect(result.changedKeys).toContain("omittedEdgeCount");
  });

  it("detects multiple changes at once", () => {
    const a = capReport({ filesObserved: 10, omittedEdgeCount: 0 });
    const b = capReport({ filesObserved: 20, omittedEdgeCount: 3 });
    const result = computeCapabilityChange(a, b);
    expect(result.changedKeys).toContain("filesObserved");
    expect(result.changedKeys).toContain("omittedEdgeCount");
    expect(result.changedKeys).toHaveLength(2);
  });
});
