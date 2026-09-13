import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeFileLineage } from "../../src/lineage-files.js";

type Entry = { path: string; contentHash: string; edges?: Array<{ to: string; type: string }> };
type Expected = { kind: string; beforePath?: string; afterPath?: string };
type Fixture = { before: Entry[]; after: Entry[]; expected: Expected[]; description: string; category: string };

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/lineage-v1");
const fixtures = readdirSync(fixtureDir).filter((name) => name.endsWith(".json")).sort().map((name) => ({
  name,
  fixture: JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as Fixture,
}));

function expectedChange(result: ReturnType<typeof computeFileLineage>, expected: Expected): boolean {
  return result.changes.some((change) => change.kind === expected.kind
    && (expected.beforePath === undefined || change.beforePath === expected.beforePath)
    && (expected.afterPath === undefined || change.afterPath === expected.afterPath));
}

describe("lineage-v1 labeled corpus", () => {
  it("contains focused corpus size and language coverage", () => {
    expect(fixtures).toHaveLength(40);
    const positive = fixtures.filter(({ fixture }) => fixture.category === "positive");
    expect(positive).toHaveLength(20);
    expect(fixtures.filter(({ fixture }) => fixture.category === "hard-negative")).toHaveLength(10);
    expect(fixtures.filter(({ fixture }) => fixture.category === "edge-case")).toHaveLength(10);
    const paths = positive.flatMap(({ fixture }) => [...fixture.before, ...fixture.after].map((entry) => entry.path));
    expect(paths.some((path) => path.endsWith(".ts"))).toBe(true);
    expect(paths.some((path) => path.endsWith(".js"))).toBe(true);
    expect(paths.some((path) => path.endsWith(".py"))).toBe(true);
  });

  for (const { name, fixture } of fixtures) {
    it(`${name}: deterministic, correct, and metadata-consistent`, () => {
      const first = computeFileLineage(fixture.before, fixture.after);
      const second = computeFileLineage(fixture.before, fixture.after);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(first.algorithmVersion).toBe("lineage-v1");

      for (const expected of fixture.expected) {
        expect(expectedChange(first, expected), `${fixture.description}: ${expected.kind}`).toBe(true);
      }

      if (fixture.category === "positive") {
        expect(first.changes.some(({ kind }) => ["UNCHANGED", "MOVED", "RENAMED", "MOVED_AND_MODIFIED", "MODIFIED", "POSSIBLE_MATCH"].includes(kind))).toBe(true);
      }
      if (fixture.category === "hard-negative") {
        expect(first.changes.every(({ kind }) => kind === "REMOVED" || kind === "ADDED")).toBe(true);
      }

      const { metadata, changes } = first;
      expect(metadata.beforeCount).toBe(fixture.before.length);
      expect(metadata.afterCount).toBe(fixture.after.length);
      expect(metadata.matchedCount + metadata.possibleMatchCount + metadata.unmatchedBeforeCount).toBe(metadata.beforeCount);
      expect(metadata.matchedCount + metadata.possibleMatchCount + metadata.unmatchedAfterCount).toBe(metadata.afterCount);
      expect(metadata.matchedCount).toBe(changes.filter(({ confidence }) => ["verified", "high", "medium"].includes(confidence)).length);
      expect(metadata.possibleMatchCount).toBe(changes.filter(({ confidence }) => confidence === "POSSIBLE_MATCH").length);
      expect(metadata.unmatchedBeforeCount).toBe(changes.filter(({ kind }) => kind === "REMOVED").length);
      expect(metadata.unmatchedAfterCount).toBe(changes.filter(({ kind }) => kind === "ADDED").length);
    });
  }
});
