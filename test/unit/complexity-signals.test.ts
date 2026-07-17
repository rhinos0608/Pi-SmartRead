import { describe, it, expect } from "vitest";
import {
  computeHalsteadLite,
  computeAstProfile,
  computeMinHashProximity,
  type ComplexityASTNode,
} from "../../src/complexity-signals.js";

// ── Fixture ASTs ──────────────────────────────────────────────────

/** if (x > 0) { return x; } */
const simpleIf: ComplexityASTNode = {
  type: "program",
  children: [
    {
      type: "if_statement",
      children: [
        {
          type: "binary_expression",
          children: [
            { type: "identifier" },
            { type: ">" },
            { type: "number" },
          ],
        },
        {
          type: "block",
          children: [
            {
              type: "return_statement",
              children: [{ type: "identifier" }],
            },
          ],
        },
      ],
    },
  ],
};

/** Two nested ifs → higher depth, higher cyclomatic */
const nestedIfs: ComplexityASTNode = {
  type: "program",
  children: [
    {
      type: "if_statement",
      children: [
        {
          type: "binary_expression",
          children: [
            { type: "identifier" },
            { type: ">" },
            { type: "number" },
          ],
        },
        {
          type: "block",
          children: [
            {
              type: "if_statement",
              children: [
                {
                  type: "binary_expression",
                  children: [
                    { type: "identifier" },
                    { type: "===" },
                    { type: "number" },
                  ],
                },
                {
                  type: "block",
                  children: [
                    {
                      type: "return_statement",
                      children: [{ type: "identifier" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/** Identical structure to simpleIf */
const identicalToSimple: ComplexityASTNode = {
  type: "program",
  children: [
    {
      type: "if_statement",
      children: [
        {
          type: "binary_expression",
          children: [
            { type: "identifier" },
            { type: ">" },
            { type: "number" },
          ],
        },
        {
          type: "block",
          children: [
            {
              type: "return_statement",
              children: [{ type: "identifier" }],
            },
          ],
        },
      ],
    },
  ],
};

/** Very different: for-loop with try/catch */
const dissimilarAst: ComplexityASTNode = {
  type: "program",
  children: [
    {
      type: "for_statement",
      children: [
        { type: "variable_declaration", children: [{ type: "identifier" }, { type: "number" }] },
        { type: "binary_expression", children: [{ type: "identifier" }, { type: "<" }, { type: "number" }] },
        { type: "update_expression", children: [{ type: "identifier" }, { type: "++" }] },
        {
          type: "block",
          children: [
            {
              type: "try_statement",
              children: [
                {
                  type: "block",
                  children: [
                    { type: "call_expression", children: [{ type: "identifier" }, { type: "identifier" }] },
                  ],
                },
                {
                  type: "catch_clause",
                  children: [
                    { type: "identifier" },
                    {
                      type: "block",
                      children: [
                        { type: "throw_statement", children: [{ type: "identifier" }] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

// ── Halstead-lite ─────────────────────────────────────────────────

describe("computeHalsteadLite", () => {
  it("returns zero for empty AST", () => {
    const r = computeHalsteadLite({ type: "empty" });
    expect(r.operandCount).toBe(0);
    expect(r.operatorCount).toBe(0);
    expect(r.vocabulary).toBe(0);
    expect(r.volume).toBe(0);
  });

  it("counts operators and operands from a simple if-AST", () => {
    const r = computeHalsteadLite(simpleIf);
    // operators: > (binary_expression), return
    expect(r.operatorCount).toBeGreaterThanOrEqual(1);
    // operands: identifier, number
    expect(r.operandCount).toBeGreaterThanOrEqual(2);
    expect(r.vocabulary).toBeGreaterThanOrEqual(3);
    expect(r.volume).toBeGreaterThan(0);
  });

  it("produces higher volume for more complex AST", () => {
    const simple = computeHalsteadLite(simpleIf);
    const complex = computeHalsteadLite(nestedIfs);
    // nestedIfs has more operators/operands → higher volume
    expect(complex.volume).toBeGreaterThanOrEqual(simple.volume);
    expect(complex.operatorCount).toBeGreaterThanOrEqual(simple.operatorCount);
  });
});

// ── AST profile ───────────────────────────────────────────────────

describe("computeAstProfile", () => {
  it("computes depth correctly for flat AST", () => {
    const r = computeAstProfile(simpleIf);
    // program → if_statement → block → return_statement = depth 3
    expect(r.depth).toBeGreaterThanOrEqual(3);
    expect(r.nodeCount).toBeGreaterThan(0);
  });

  it("nested ASTs have greater depth", () => {
    const simple = computeAstProfile(simpleIf);
    const nested = computeAstProfile(nestedIfs);
    expect(nested.depth).toBeGreaterThan(simple.depth);
  });

  it("cyclomatic complexity increases with branching", () => {
    const simple = computeAstProfile(simpleIf);
    const nested = computeAstProfile(nestedIfs);
    // simpleIf has 1 decision point → CC = 2; nestedIfs has 2 → CC = 3
    expect(nested.cyclomaticComplexity).toBeGreaterThan(simple.cyclomaticComplexity);
  });

  it("returns sensible defaults for empty AST", () => {
    const r = computeAstProfile({ type: "leaf" });
    expect(r.depth).toBe(0);
    expect(r.nodeCount).toBe(1);
    expect(r.branchingFactor).toBe(0);
    expect(r.cyclomaticComplexity).toBe(1);
  });
});

// ── MinHash proximity ─────────────────────────────────────────────

describe("computeMinHashProximity", () => {
  it("returns 1.0 for identical ASTs", () => {
    const score = computeMinHashProximity(simpleIf, identicalToSimple);
    expect(score).toBeCloseTo(1.0, 1);
  });

  it("returns high score for very similar ASTs", () => {
    // simpleIf and its identical copy should score ~1.0
    const score = computeMinHashProximity(simpleIf, identicalToSimple);
    expect(score).toBeGreaterThan(0.9);
  });

  it("returns lower score for dissimilar ASTs", () => {
    const score = computeMinHashProximity(simpleIf, dissimilarAst);
    expect(score).toBeLessThan(0.8);
  });

  it("returns 0 when one AST is empty", () => {
    const empty: ComplexityASTNode = { type: "empty" };
    const score = computeMinHashProximity(simpleIf, empty);
    expect(score).toBe(0);
  });

  it("returns 1 for two empty ASTs", () => {
    const a: ComplexityASTNode = { type: "empty" };
    const b: ComplexityASTNode = { type: "empty" };
    expect(computeMinHashProximity(a, b)).toBe(1);
  });

  it("is symmetric", () => {
    const ab = computeMinHashProximity(simpleIf, dissimilarAst);
    const ba = computeMinHashProximity(dissimilarAst, simpleIf);
    expect(ab).toBeCloseTo(ba, 10);
  });
});
