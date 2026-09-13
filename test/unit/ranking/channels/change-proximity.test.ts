import { describe, expect, it } from "vitest";
import type { Provenance } from "../../../src/context-graph.js";
import {
  runChangeProximity,
  type ChangeProximityOptions,
} from "../../../src/rank-channels/change-proximity.js";

// ── Helpers ──────────────────────────────────────────────────────

function p(from: string, to: string, type: Provenance["type"] = "imports"): Provenance {
  return { from, to, type, confidence: 1 };
}

function run(opts: Partial<ChangeProximityOptions> & { changedPaths: string[]; provenances: Provenance[] }) {
  return runChangeProximity(opts);
}

// ── Tests ────────────────────────────────────────────────────────

describe("change-proximity", () => {
  it("returns unavailable when changedPaths is empty", () => {
    const result = run({ changedPaths: [], provenances: [] });
    expect(result.channel).toBe("change-proximity");
    expect(result.unavailable).toEqual({ reason: "no changed files provided" });
    expect(result.candidates).toEqual([]);
  });

  it("scores changed files at depth 0 with rawScore 1.0", () => {
    const result = run({
      changedPaths: ["src/foo.ts"],
      provenances: [],
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.file).toBe("src/foo.ts");
    expect(result.candidates[0]!.rawScore).toBe(1.0);
    expect(result.candidates[0]!.kind).toBe("changed");
  });

  it("scores direct importers at depth 1 with rawScore 0.8", () => {
    const result = run({
      changedPaths: ["src/a.ts"],
      // b imports a
      provenances: [p("src/b.ts", "src/a.ts")],
    });
    expect(result.candidates).toHaveLength(2);
    const b = result.candidates.find((c) => c.file === "src/b.ts");
    expect(b).toBeDefined();
    expect(b!.rawScore).toBe(0.8);
    expect(b!.kind).toBe("importer");
  });

  it("scores transitive importers at depth 2 with rawScore 0.6", () => {
    const result = run({
      changedPaths: ["src/a.ts"],
      // b imports a, c imports b
      provenances: [p("src/b.ts", "src/a.ts"), p("src/c.ts", "src/b.ts")],
    });
    const c = result.candidates.find((cc) => cc.file === "src/c.ts");
    expect(c).toBeDefined();
    expect(c!.rawScore).toBe(0.6);
  });

  it("scores depth 3 importers with rawScore 0.4 and stops at depth 3", () => {
    const result = run({
      changedPaths: ["src/a.ts"],
      // b imports a, c imports b, d imports c, e imports d
      provenances: [
        p("src/b.ts", "src/a.ts"),
        p("src/c.ts", "src/b.ts"),
        p("src/d.ts", "src/c.ts"),
        p("src/e.ts", "src/d.ts"),
      ],
    });
    const d = result.candidates.find((cc) => cc.file === "src/d.ts");
    expect(d).toBeDefined();
    expect(d!.rawScore).toBe(0.4);

    // e should NOT appear (depth 4, beyond max)
    const e = result.candidates.find((cc) => cc.file === "src/e.ts");
    expect(e).toBeUndefined();
  });

  it("does not follow non-import edges for proximity", () => {
    const result = run({
      changedPaths: ["src/a.ts"],
      // b calls a — calls edge should not make b a proximity match
      provenances: [{ from: "src/b.ts", to: "src/a.ts", type: "calls", confidence: 1 }],
    });
    // Only a itself
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.file).toBe("src/a.ts");
  });

  it("deduplicates via visited set (diamond import graph)", () => {
    //   b imports a, c imports a, d imports b AND c
    const result = run({
      changedPaths: ["src/a.ts"],
      provenances: [
        p("src/b.ts", "src/a.ts"),
        p("src/c.ts", "src/a.ts"),
        p("src/d.ts", "src/b.ts"),
        p("src/d.ts", "src/c.ts"),
      ],
    });
    const d = result.candidates.find((cc) => cc.file === "src/d.ts");
    expect(d).toBeDefined();
    expect(d!.rawScore).toBe(0.6); // depth 2 via either path, not duplicated
    // No duplicate d entries
    expect(result.candidates.filter((cc) => cc.file === "src/d.ts")).toHaveLength(1);
  });

  it("respects the max parameter", () => {
    const provenances: Provenance[] = [];
    for (let i = 0; i < 10; i++) {
      // src/i.ts imports src/a.ts
      provenances.push(p(`src/${i}.ts`, "src/a.ts"));
    }
    const result = run({
      changedPaths: ["src/a.ts"],
      provenances,
      max: 3,
    });
    expect(result.candidates).toHaveLength(3);
  });

  it("sorts by score descending, then file path for stability", () => {
    const result = run({
      changedPaths: ["src/a.ts", "src/b.ts"],
      provenances: [
        p("src/c.ts", "src/a.ts"), // c is importer of a
        p("src/d.ts", "src/b.ts"), // d is importer of b
      ],
    });
    // Changed files first (score 1.0), then importers (0.8)
    expect(result.candidates[0]!.rawScore).toBe(1.0);
    expect(result.candidates[1]!.rawScore).toBe(1.0);
    // Importers sorted by path
    const importers = result.candidates.filter((c) => c.rawScore === 0.8);
    expect(importers.map((c) => c.file)).toEqual(["src/c.ts", "src/d.ts"]);
  });

  it("includes metadata with counts", () => {
    const result = run({
      changedPaths: ["src/a.ts"],
      provenances: [p("src/b.ts", "src/a.ts")],
    });
    expect(result.metadata).toEqual({
      totalProximityHits: 2,
      maxDepth: 3,
      changedCount: 1,
    });
  });

  it("returns channel name 'change-proximity'", () => {
    const result = run({ changedPaths: ["x.ts"], provenances: [] });
    expect(result.channel).toBe("change-proximity");
  });
});
