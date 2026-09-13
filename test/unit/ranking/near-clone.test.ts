import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findNearClones, jaccard, normalizeCodeForCloneDetection, shingles } from "../../src/near-clone.js";

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "smartread-clone-")); mkdirSync(join(root, "src")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("near clone detection", () => {
  it("normalizes identifiers and literals", () => {
    expect(normalizeCodeForCloneDetection("const alpha = 123; // hi")).toEqual(["const", "ID", "=", "NUM", ";"]);
  });

  it("computes jaccard over shingles", () => {
    expect(jaccard(shingles(["a", "b", "c"]), shingles(["a", "b", "c"]))).toBe(1);
  });

  it("finds structurally similar files with renamed identifiers", () => {
    const a = join(root, "src", "a.ts");
    const b = join(root, "src", "b.ts");
    const c = join(root, "src", "c.ts");
    writeFileSync(a, "export function addUser(user) { const total = user.count + 1; return total; }");
    writeFileSync(b, "export function addAccount(account) { const value = account.count + 1; return value; }");
    writeFileSync(c, "export const unrelated = Math.random();");
    const pairs = findNearClones([a, b, c], { threshold: 0.8 });
    expect(pairs[0]).toMatchObject({ a, b });
    expect(pairs[0]!.jaccard).toBeGreaterThanOrEqual(0.8);
  });
});
