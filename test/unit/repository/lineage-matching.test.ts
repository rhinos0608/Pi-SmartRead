import { describe, it, expect } from "vitest";
import { computeFileLineage } from "../../src/lineage-files.js";

type FileEntry = { path: string; contentHash: string; content?: string; edges?: Array<{ to: string; type: string }> };

describe("max-weight matching", () => {
  it("three files with path swaps: max-weight resolves correctly", () => {
    // Use long enough content for meaningful shingle Jaccard
    const A = "import { helper } from './helper'; import { utils } from './utils'; import { config } from './config'; import { logger } from './logger'; import { types } from './types'; export function alpha() { return helper.run('test'); }";
    const B = "import { helper } from './helper'; import { utils } from './utils'; import { config } from './config'; import { logger } from './logger'; import { types } from './types'; export function beta() { return helper.run('prod'); }";
    const C = "import { helper } from './helper'; import { utils } from './utils'; import { config } from './config'; import { logger } from './logger'; import { types } from './types'; export function gamma() { return helper.run('dev'); }";
    const Ap = "import { helper } from './helper'; import { utils } from './utils'; import { config } from './config'; import { logger } from './logger'; import { types } from './types'; export function alpha() { return helper.run('test', true); }";
    const Bp = "import { helper } from './helper'; import { utils } from './utils'; import { config } from './config'; import { logger } from './logger'; import { types } from './types'; export function beta() { return helper.run('prod', true); }";
    const Cp = "import { helper } from './helper'; import { utils } from './utils'; import { config } from './config'; import { logger } from './logger'; import { types } from './types'; export function gamma() { return helper.run('dev', true); }";

    // A and C swapped in path, B stays
    const before: FileEntry[] = [
      { path: "src/a.ts", contentHash: "hash_a", content: A },
      { path: "src/b.ts", contentHash: "hash_b", content: B },
      { path: "src/c.ts", contentHash: "hash_c", content: C },
    ];
    const after: FileEntry[] = [
      { path: "src/a.ts", contentHash: "hash_cp", content: Cp },
      { path: "src/b.ts", contentHash: "hash_bp", content: Bp },
      { path: "src/c.ts", contentHash: "hash_ap", content: Ap },
    ];

    const result = computeFileLineage(before, after);

    // All three should be matched (any non-terminal kind)
    const matched = result.changes.filter(
      (c) => c.kind !== "REMOVED" && c.kind !== "ADDED",
    );
    expect(matched.length).toBe(3);

    // Max-weight should resolve:
    //   src/a.ts (A) → src/c.ts (Ap)   [content A≈Ap]
    //   src/b.ts (B) → src/b.ts (Bp)   [content B≈Bp]
    //   src/c.ts (C) → src/a.ts (Cp)   [content C≈Cp]
    const aMatch = matched.find((m) => m.beforePath === "src/a.ts");
    const bMatch = matched.find((m) => m.beforePath === "src/b.ts");
    const cMatch = matched.find((m) => m.beforePath === "src/c.ts");
    expect(aMatch?.afterPath).toBe("src/c.ts");
    expect(bMatch?.afterPath).toBe("src/b.ts");
    expect(cMatch?.afterPath).toBe("src/a.ts");

    // No unmatched
    expect(result.metadata.unmatchedBeforeCount).toBe(0);
    expect(result.metadata.unmatchedAfterCount).toBe(0);
  });

  it("three files same path: max-weight matches each to itself", () => {
    const A = "import { helper } from './helper'; import { utils } from './utils'; import { config } from './config'; import { logger } from './logger'; import { types } from './types'; export function alpha() { return helper.run('test'); }";
    const B = "import { helper } from './helper'; import { utils } from './utils'; import { config } from './config'; import { logger } from './logger'; import { types } from './types'; export function beta() { return helper.run('prod'); }";
    const C = "import { helper } from './helper'; import { utils } from './utils'; import { config } from './config'; import { logger } from './logger'; import { types } from './types'; export function gamma() { return helper.run('dev'); }";
    const Ap = "import { helper } from './helper'; import { utils } from './utils'; import { config } from './config'; import { logger } from './logger'; import { types } from './types'; export function alpha() { return helper.run('test', true); }";
    const Bp = "import { helper } from './helper'; import { utils } from './utils'; import { config } from './config'; import { logger } from './logger'; import { types } from './types'; export function beta() { return helper.run('prod', true); }";
    const Cp = "import { helper } from './helper'; import { utils } from './utils'; import { config } from './config'; import { logger } from './logger'; import { types } from './types'; export function gamma() { return helper.run('dev', true); }";

    const before: FileEntry[] = [
      { path: "src/a.ts", contentHash: "hash_a", content: A },
      { path: "src/b.ts", contentHash: "hash_b", content: B },
      { path: "src/c.ts", contentHash: "hash_c", content: C },
    ];
    const after: FileEntry[] = [
      { path: "src/a.ts", contentHash: "hash_ap", content: Ap },
      { path: "src/b.ts", contentHash: "hash_bp", content: Bp },
      { path: "src/c.ts", contentHash: "hash_cp", content: Cp },
    ];

    const result = computeFileLineage(before, after);

    const matched = result.changes.filter(
      (c) => c.kind !== "REMOVED" && c.kind !== "ADDED",
    );
    expect(matched.length).toBe(3);

    // Each before file maps to same-path after file
    for (const m of matched) {
      expect(m.beforePath).toBeTruthy();
      expect(m.afterPath).toBeTruthy();
      const beforeBase = m.beforePath!.replace("src/", "");
      const afterBase = m.afterPath!.replace("src/", "");
      expect(beforeBase).toBe(afterBase);
    }

    expect(result.metadata.unmatchedBeforeCount).toBe(0);
    expect(result.metadata.unmatchedAfterCount).toBe(0);
  });

  it("content field used for shingles when provided", () => {
    // Same contentHash but different content → verified unchanged (path+hash match)
    const before: FileEntry[] = [
      { path: "src/a.ts", contentHash: "same_hash", content: "export function alpha() { return 1; }" },
    ];
    const after: FileEntry[] = [
      { path: "src/a.ts", contentHash: "same_hash", content: "export function beta() { return 2; }" },
    ];

    const result = computeFileLineage(before, after);
    // Same path + same contentHash = verified unchanged
    expect(result.changes[0]?.kind).toBe("UNCHANGED");
  });
});
