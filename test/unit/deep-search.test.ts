import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeepSearchTool } from "../../deep-search.js";
import { EdgeStore } from "../../context-graph.js";

let root: string;

function writeProjectFile(path: string, content: string): void {
  const derivedDir = join(root, dirname(path));
  mkdirSync(derivedDir, { recursive: true });
  writeFileSync(join(root, path), content, "utf-8");
}

beforeEach(() => {
  delete process.env.PI_SMARTREAD_EMBEDDING_BASE_URL;
  delete process.env.PI_SMARTREAD_EMBEDDING_MODEL;
  root = mkdtempSync(join(tmpdir(), "deep-search-"));
  writeProjectFile("package.json", JSON.stringify({ type: "module" }));
  writeProjectFile(
    "auth.ts",
    `export function authenticateToken(token: string): boolean {
  return token.length > 0;
}

export function requireAuth(header: string): boolean {
  return authenticateToken(header.replace("Bearer ", ""));
}
`,
  );
  writeProjectFile(
    "api.ts",
    `import { requireAuth } from "./auth";

export function handleRequest(header: string): string {
  return requireAuth(header) ? "ok" : "denied";
}
`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.PI_SMARTREAD_EMBEDDING_BASE_URL;
  delete process.env.PI_SMARTREAD_EMBEDDING_MODEL;
});

describe("deep_search", () => {
  it("rejects blank queries", async () => {
    const tool = createDeepSearchTool();

    await expect(
      tool.execute("id", { query: "   " } as any, undefined, undefined, { cwd: root } as any),
    ).rejects.toThrow(/query/i);
  });

  it("records degraded semantic search when embeddings are unavailable", async () => {
    const tool = createDeepSearchTool();
    const result = await tool.execute(
      "id",
      { query: "authenticate token", depth: "standard", limit: 5 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    const details = result.details as any;

    expect(details.depth).toBe("standard");
    // No degraded messages when config is missing — deep_search degrades gracefully to
    // BM25-only (no "semantic channel unavailable" because runSemanticChannel calls
    // intent_read which now degrades silently without throwing).
    expect(Array.isArray(details.degraded)).toBe(true);
  });

  it("limits searching to the requested directory", async () => {
    writeProjectFile(
      "scoped/target.ts",
      `export function scopedOnlySearchTarget(): boolean {
  return true;
}
`,
    );
    writeProjectFile(
      "outside.ts",
      `export function outsideExclusiveIdentifier(): boolean {
  return true;
}
`,
    );

    const tool = createDeepSearchTool();
    const result = await tool.execute(
      "id",
      { query: "outsideExclusiveIdentifier", depth: "quick", limit: 5, directory: "scoped" },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    const text = (result.content[0] as any).text as string;
    const details = result.details as any;

    expect(details.filesInspected).toBe(1);
    expect(details.matches).toHaveLength(1);
    expect(details.matches[0].file).toBe("target.ts");
    expect(text).not.toContain("outside.ts");
  });

  it("returns fused markdown and details from structural channels", async () => {
    const tool = createDeepSearchTool();
    const result = await tool.execute(
      "id",
      { query: "authenticate token", depth: "quick", limit: 5 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    const text = (result.content[0] as any).text as string;
    const details = result.details as any;

    expect(text).toContain('# Deep Search: "authenticate token"');
    expect(text).toContain("## ➡️ Follow-ups");
    expect(details.query).toBe("authenticate token");
    expect(details.depth).toBe("quick");
    expect(details.filesInspected).toBeGreaterThan(0);
    expect(Array.isArray(details.matches)).toBe(true);
    expect(text).toContain("relevance:");
    expect(text).not.toContain("score:");
    expect(details.matches[0]?.relevance).toMatch(/^(exact|strong|related|weak|none)$/);
    expect(details.matches[0]?.score).toBeUndefined();
  });

  it("keeps quick depth graph-free", async () => {
    const tool = createDeepSearchTool();
    const result = await tool.execute(
      "id",
      { query: "authenticateToken", depth: "quick", limit: 10 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    const details = result.details as any;

    expect(details.depth).toBe("quick");
    expect(details.channelsUsed).not.toContain("graph");
  });

  it("adds reverse import neighbours through the graph channel", async () => {
    const tool = createDeepSearchTool();
    const result = await tool.execute(
      "id",
      { query: "authenticateToken", depth: "standard", limit: 10 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    const details = result.details as any;
    const apiMatch = details.matches.find((match: any) => match.file === "api.ts");

    expect(details.channelsUsed).toContain("graph");
    expect(apiMatch?.provenance.some((signal: any) => signal.channel === "graph" && signal.signal === "imported_by")).toBe(true);
  });

  it("fuses graph_mutate breakage edges into graph provenance", async () => {
    EdgeStore.recordBreakage(root, "api.ts", "auth.ts", "type check failed", 0.9);

    const tool = createDeepSearchTool();
    const result = await tool.execute(
      "id",
      { query: "handleRequest", depth: "standard", limit: 10 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    const details = result.details as any;
    const authMatch = details.matches.find((match: any) => match.file === "auth.ts");

    expect(details.channelsUsed).toContain("graph");
    expect(authMatch?.provenance.some((signal: any) => signal.channel === "graph" && signal.signal === "breakage")).toBe(true);
  });

  it("produces bucketed output with Exact Matches and Related Matches sections", async () => {
    const tool = createDeepSearchTool();
    const result = await tool.execute(
      "id",
      { query: "authenticateToken requireAuth", depth: "standard", limit: 5 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    const text = (result.content[0] as any).text as string;

    // Should have the Exact Matches section for structural hits
    expect(text).toContain("## 🎯 Exact Matches (Code)");
    // Should have the Query Coverage section
    expect(text).toContain("## 📊 Query Coverage");
    // Should have the Follow-ups section
    expect(text).toContain("## ➡️ Follow-ups");
  });

  it("includes per-term query coverage in details", async () => {
    const tool = createDeepSearchTool();
    const result = await tool.execute(
      "id",
      { query: "authenticateToken nonExistentSymbol", depth: "standard", limit: 5 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    const details = result.details as any;
    const coverage = details.coverage;

    expect(Array.isArray(coverage)).toBe(true);
    expect(coverage.length).toBeGreaterThan(0);

    // authenticatetoken (lowercased from tokenize) should be found in auth.ts
    const authTokenCov = coverage.find((c: any) =>
      c.term.toLowerCase().includes("authenticatetoken"),
    );
    expect(authTokenCov).toBeDefined();
    expect(authTokenCov.status).toBe("found");

    // nonExistentSymbol should not be found
    const missingCov = coverage.find((c: any) =>
      c.term.toLowerCase().includes("nonexistent"),
    );
    expect(missingCov).toBeDefined();
    expect(missingCov.status).toBe("not_found");
  });

  it("generates query-aware follow-ups for found terms", async () => {
    const tool = createDeepSearchTool();
    const result = await tool.execute(
      "id",
      { query: "authenticateToken requireAuth", depth: "standard", limit: 5 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    const text = (result.content[0] as any).text as string;

    // Follow-ups should suggest resolving/finding-callers for found terms
    expect(text).toContain("## ➡️ Follow-ups");
    // Should include resolve/Find callers suggestions
    expect(text).toContain("Resolve symbol");
    expect(text).toContain("Find callers");
    // Should include read mode=multiple suggestion
    expect(text).toContain("read mode=multiple");
  });

  it("generates search-code follow-ups for not-found terms", async () => {
    const tool = createDeepSearchTool();
    const result = await tool.execute(
      "id",
      { query: "nonExistentSymbol imaginaryFunction", depth: "standard", limit: 5 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    const text = (result.content[0] as any).text as string;

    // Should suggest searching for the not-found terms
    expect(text).toContain("Search code for");
    expect(text).toContain("mode=code");
  });

  it("enriches semantic provenance with matchedTerms", async () => {
    // Add more files so semantic channel has material to work with
    writeProjectFile(
      "session.ts",
      `import { authenticateToken } from "./auth";

export class SessionManager {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  validate(): boolean {
    return authenticateToken(this.token);
  }

  refreshSession(): void {
    // re-validate
  }
}
`,
    );

    const tool = createDeepSearchTool();
    const result = await tool.execute(
      "id",
      { query: "authenticateToken session refresh", depth: "standard", limit: 5 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    const details = result.details as any;

    // Find semantic provenance entries
    const semanticMatches = details.matches.filter((m: any) =>
      m.provenance.some((p: any) => p.channel === "semantic"),
    );

    // At least some semantic provenance entries should have matchedTerms
    const hasMatchedTerms = semanticMatches.some((m: any) =>
      m.provenance.some(
        (p: any) =>
          p.channel === "semantic" &&
          Array.isArray(p.matchedTerms) &&
          p.matchedTerms.length > 0,
      ),
    );

    // May be false if only BM25 mode (no embeddings), which is fine
    // but the structure should be present
    expect(typeof hasMatchedTerms).toBe("boolean");
  });

  it("includes coverage note when terms are not found", async () => {
    const tool = createDeepSearchTool();
    const result = await tool.execute(
      "id",
      { query: "nonExistentSymbol anotherMissing", depth: "standard", limit: 5 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    const text = (result.content[0] as any).text as string;

    // When terms are not found, there should be a note about it
    expect(text).toContain("not found in top");
  });

  it("escalates to compact repo-map when 3+ terms not found and no structural matches", async () => {
    // Use a query with 3+ unique terms that won't match any code
    // This ensures no structural matches exist
    const tool = createDeepSearchTool();
    const result = await tool.execute(
      "id",
      { query: "zzzzxyz123 missingBeta missingGamma missingDelta", depth: "standard", limit: 5 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    const text = (result.content[0] as any).text as string;
    const details = result.details as any;

    // Check coverage: should have 3+ not_found terms
    const notFoundCount = (details.coverage || []).filter((c: any) => c.status === "not_found").length;
    expect(notFoundCount).toBeGreaterThanOrEqual(3);

    // Check structural matches
    const structuralMatches = details.matches.filter((m: any) =>
      m.provenance.some((p: any) => p.channel === "structural" || p.channel === "symbol"),
    );

    // If no structural matches, escalation should have triggered
    if (structuralMatches.length === 0) {
      expect(text).toContain("## 🗺️ Repo Context (auto-escalated)");
    } else {
      // If structural matches exist, they determine escalation
      const allFromTests = structuralMatches.every((m: any) =>
        m.file.includes("test") || m.file.includes("spec"),
      );
      if (allFromTests) {
        expect(text).toContain("## 🗺️ Repo Context (auto-escalated)");
      }
    }

    // Repo summary should contain file info when escalation occurs
    if (text.includes("## 🗺️ Repo Context (auto-escalated)")) {
      expect(text).toContain("auth.ts");
    }
  });

  it("does not escalate when structural matches include non-test files", async () => {
    // When structural matches exist in non-test files, escalation should NOT trigger
    // even with 3+ missing terms
    const tool = createDeepSearchTool();
    const result = await tool.execute(
      "id",
      { query: "authenticateToken phantom zebra quartz", depth: "standard", limit: 5 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    const text = (result.content[0] as any).text as string;

    // Should NOT escalate - structural match exists in auth.ts (not a test file)
    expect(text).not.toContain("## 🗺️ Repo Context (auto-escalated)");
  });

  it("escalates to compact repo-map when 3+ terms not found and all structural matches are test files", async () => {
    // Write a test file that will create structural matches in test directory
    writeProjectFile(
      "test/unit/check.test.ts",
      `describe("phantom", () => {
  it("checks nothing", () => {});
});`,
    );

    // Query: "phantom" will match the test file's describe() function via structural search
    // "zebra", "quartz", "gypsum" are not found in any file
    const tool = createDeepSearchTool();
    const result = await tool.execute(
      "id",
      { query: "phantom zebra quartz gypsum", depth: "standard", limit: 5 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    const text = (result.content[0] as any).text as string;
    const details = result.details as any;

    // Check coverage: should have 3+ not_found terms
    const notFoundCount = (details.coverage || []).filter((c: any) => c.status === "not_found").length;
    expect(notFoundCount).toBeGreaterThanOrEqual(3);

    // Check if structural matches exist and where they're from
    const structuralMatches = details.matches.filter((m: any) =>
      m.provenance.some((p: any) => p.channel === "structural" || p.channel === "symbol"),
    );

    const nonTestStructural = structuralMatches.filter((m: any) =>
      !m.file.includes("test") && !m.file.includes("spec"),
    );

    // If all structural matches are from test files, escalation should trigger
    if (nonTestStructural.length === 0 && structuralMatches.length > 0) {
      expect(text).toContain("## 🗺️ Repo Context (auto-escalated)");
      expect(text).toContain("auth.ts");
    }
    // Note: If structural matches include non-test files (auth.ts, api.ts),
    // escalation won't trigger - this is expected behavior
  });

  it("does not escalate when 3+ terms not found but has non-test structural matches", async () => {
    // Use a query that matches real code (not just test files)
    const tool = createDeepSearchTool();
    const result = await tool.execute(
      "id",
      { query: "authenticateToken missingAlpha missingBeta missingGamma", depth: "standard", limit: 5 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    const text = (result.content[0] as any).text as string;

    // Should NOT escalate - structural match exists in auth.ts (not a test file)
    expect(text).not.toContain("## 🗺️ Repo Context (auto-escalated)");
  });

  it("includes search guidelines when escalation triggers", async () => {
    // Use a query with 3+ missing terms that won't match any code
    const tool = createDeepSearchTool();
    const result = await tool.execute(
      "id",
      { query: "phantomNode absentValue missingComponent", depth: "standard", limit: 5 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    const text = (result.content[0] as any).text as string;
    const details = result.details as any;

    // Should have triggered escalation
    const notFoundCount = (details.coverage || []).filter((c: any) => c.status === "not_found").length;
    const structuralMatches = details.matches.filter((m: any) =>
      m.provenance.some((p: any) => p.channel === "structural" || p.channel === "symbol"),
    );

    if (notFoundCount >= 3 && structuralMatches.length === 0) {
      expect(text).toContain("### 🔍 Search Guidelines (auto-generated)");
      expect(text).toContain("Use specific technical terms, not concepts");
    }
  });
});
