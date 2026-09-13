import { describe, it, expect } from "vitest";
import { enrichRerankSignals } from "../../src/rerank-signal-bridge.js";
import type { RerankerInput } from "../../src/rerank.js";

// ── Fixtures ──────────────────────────────────────────────────────

const TS_SOURCE = `
function greet(name: string): string {
  if (name) {
    if (name.length > 3) {
      return "Hello " + name;
    } else {
      return "Hi";
    }
  }
  return "Hello stranger";
}
export function greetAll(names: string[]): string[] {
  return names.map(greet);
}
`;

const PYTHON_SOURCE = `
def greet(name):
    if name:
        if len(name) > 3:
            return "Hello " + name
        else:
            return "Hi"
    return "Hello stranger"

def greet_all(names):
    return [greet(n) for n in names]
`;

const PARSE_FAILURE_SOURCE = "not valid { javascript {{{";

function makeInput(path: string, overrides?: Partial<RerankerInput>): RerankerInput {
  return { path, rrfScore: 0.5, keywordScore: 0.3, ...overrides };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("enrichRerankSignals", () => {
  it("populates halsteadComplexity, astProfile, minHashProximity for TS source", async () => {
    const inputs = [makeInput("src/greet.ts")];
    const bodyByPath = new Map([["src/greet.ts", TS_SOURCE]]);

    const result = await enrichRerankSignals(inputs, bodyByPath);

    expect(result).toHaveLength(1);
    const r = result[0]!;
    expect(r.halsteadComplexity).toBeGreaterThan(0);
    expect(r.astProfile).toBeGreaterThanOrEqual(0);
    expect(r.astProfile).toBeLessThanOrEqual(1);
    expect(r.minHashProximity).toBeGreaterThanOrEqual(0);
    expect(r.minHashProximity).toBeLessThanOrEqual(1);
  });

  it("populates signals for Python source", async () => {
    const inputs = [makeInput("src/greet.py")];
    const bodyByPath = new Map([["src/greet.py", PYTHON_SOURCE]]);

    const result = await enrichRerankSignals(inputs, bodyByPath);

    expect(result).toHaveLength(1);
    const r = result[0]!;
    expect(r.halsteadComplexity).toBeGreaterThan(0);
    expect(r.astProfile).toBeGreaterThanOrEqual(0);
    expect(r.minHashProximity).toBeGreaterThanOrEqual(0);
  });

  it("computes minHashProximity relative to first parsed candidate", async () => {
    const inputs = [
      makeInput("src/a.ts"),
      makeInput("src/b.ts"),
    ];
    const bodyByPath = new Map([
      ["src/a.ts", TS_SOURCE],
      ["src/b.ts", TS_SOURCE],
    ]);

    const result = await enrichRerankSignals(inputs, bodyByPath);

    // Same source → minHashProximity ≈ 1.0
    expect(result[0]!.minHashProximity).toBeCloseTo(1.0, 1);
    expect(result[1]!.minHashProximity).toBeCloseTo(1.0, 1);
  });

  it("minHashProximity is lower for different sources", async () => {
    const inputs = [
      makeInput("src/a.ts"),
      makeInput("src/b.py"),
    ];
    const bodyByPath = new Map([
      ["src/a.ts", TS_SOURCE],
      ["src/b.py", PYTHON_SOURCE],
    ]);

    const result = await enrichRerankSignals(inputs, bodyByPath);

    // Different sources should produce lower similarity
    expect(result[1]!.minHashProximity).toBeLessThan(1.0);
  });

  it("preserves baseline ranking on parse failure (graceful degradation)", async () => {
    const inputs = [makeInput("src/bad.ts")];
    const bodyByPath = new Map([["src/bad.ts", PARSE_FAILURE_SOURCE]]);

    const result = await enrichRerankSignals(inputs, bodyByPath);

    expect(result).toHaveLength(1);
    // All signal fields should remain undefined
    expect(result[0]!.halsteadComplexity).toBeUndefined();
    expect(result[0]!.astProfile).toBeUndefined();
    expect(result[0]!.minHashProximity).toBeUndefined();
  });

  it("preserves baseline on unsupported language", async () => {
    const inputs = [makeInput("src/app.rb")];
    const bodyByPath = new Map([["src/app.rb", "puts 'hello'"]]);

    const result = await enrichRerankSignals(inputs, bodyByPath);

    expect(result[0]!.halsteadComplexity).toBeUndefined();
    expect(result[0]!.astProfile).toBeUndefined();
    expect(result[0]!.minHashProximity).toBeUndefined();
  });

  it("preserves existing properties from input", async () => {
    const inputs = [makeInput("src/greet.ts", {
      graphDistance: 3,
      pageRank: 0.8,
      probeConfidence: 0.9,
    })];
    const bodyByPath = new Map([["src/greet.ts", TS_SOURCE]]);

    const result = await enrichRerankSignals(inputs, bodyByPath);

    expect(result[0]!.graphDistance).toBe(3);
    expect(result[0]!.pageRank).toBe(0.8);
    expect(result[0]!.probeConfidence).toBe(0.9);
    expect(result[0]!.rrfScore).toBe(0.5);
  });

  it("reference-candidate selection is deterministic across runs", async () => {
    const inputs = [
      makeInput("src/a.ts"),
      makeInput("src/b.ts"),
    ];
    const bodyByPath = new Map([
      ["src/a.ts", TS_SOURCE],
      ["src/b.ts", PYTHON_SOURCE],
    ]);

    // Run twice — results should be identical
    const [r1, r2] = await Promise.all([
      enrichRerankSignals(inputs, bodyByPath),
      enrichRerankSignals(inputs, bodyByPath),
    ]);

    expect(r1[0]!.minHashProximity).toBe(r2[0]!.minHashProximity);
    expect(r1[1]!.minHashProximity).toBe(r2[1]!.minHashProximity);
    expect(r1[0]!.halsteadComplexity).toBe(r2[0]!.halsteadComplexity);
    expect(r1[1]!.halsteadComplexity).toBe(r2[1]!.halsteadComplexity);
  });

  it("leaves inputs beyond MAX_CANDIDATES (20) unchanged", async () => {
    const inputCount = 25;
    const inputs = Array.from({ length: inputCount }, (_, i) =>
      makeInput(`src/file${i}.ts`, { rrfScore: 1 - i * 0.01 }),
    );
    const bodyByPath = new Map(
      Array.from({ length: inputCount }, (_, i) => [`src/file${i}.ts`, TS_SOURCE]),
    );

    const result = await enrichRerankSignals(inputs, bodyByPath);

    expect(result).toHaveLength(inputCount);
    // First 20 get enriched
    expect(result[0]!.halsteadComplexity).toBeGreaterThan(0);
    // Last 5 stay unchanged
    expect(result[20]!.halsteadComplexity).toBeUndefined();
    expect(result[24]!.halsteadComplexity).toBeUndefined();
  });

  it("returns empty array for empty inputs", async () => {
    const result = await enrichRerankSignals([], new Map());
    expect(result).toEqual([]);
  });
});
