import { describe, it, expect } from "vitest";
import {
  runTestFailureProximity,
  type TestFailure,
} from "../../../src/rank-channels/test-failure-proximity.js";

const ALL_FILES = [
  "src/auth.ts",
  "src/auth.test.ts",
  "src/utils.ts",
  "src/parser.ts",
  "src/parser.test.ts",
  "src/server.ts",
  "lib/external.ts",
];

describe("test-failure-proximity", () => {
  it("returns unavailable when no failures", () => {
    const result = runTestFailureProximity({ failures: [], allFiles: ALL_FILES });
    expect(result.channel).toBe("test-failure-proximity");
    expect(result.unavailable).toBeDefined();
    expect(result.unavailable!.reason).toMatch(/no test failures/i);
    expect(result.candidates).toEqual([]);
  });

  it("ranks stack-trace files above importers", () => {
    const failures: TestFailure[] = [
      {
        testFile: "src/auth.test.ts",
        stackTrace: [
          "at Object.test (src/auth.test.ts:10:5)",
          "at src/auth.ts:42:11",
        ],
      },
    ];

    const result = runTestFailureProximity({ failures, allFiles: ALL_FILES });
    expect(result.unavailable).toBeUndefined();

    const stackCandidate = result.candidates.find((c) => c.file === "src/auth.ts");
    expect(stackCandidate).toBeDefined();
    expect(stackCandidate!.rawScore).toBe(100);
    expect(stackCandidate!.kind).toBe("stack-trace");

    const testCandidate = result.candidates.find((c) => c.file === "src/auth.test.ts");
    expect(testCandidate).toBeDefined();
    expect(testCandidate!.rawScore).toBe(100);

    // Importers should have lower score
    const importers = result.candidates.filter((c) => c.kind === "importer");
    for (const imp of importers) {
      expect(imp.rawScore).toBeLessThan(100);
    }
  });

  it("caps results at 500", () => {
    // Generate many files that share directory with a stack-trace file
    const manyFiles = Array.from({ length: 600 }, (_, i) => `src/depth${i}/mod.ts`);
    manyFiles.push("src/target.test.ts");

    const failures: TestFailure[] = [
      {
        testFile: "src/target.test.ts",
        stackTrace: ["at src/target.test.ts:5:3"],
      },
    ];

    const result = runTestFailureProximity({ failures, allFiles: manyFiles });
    expect(result.candidates.length).toBeLessThanOrEqual(500);
  });

  it("handles parenthesized paths in stack trace", () => {
    const failures: TestFailure[] = [
      {
        testFile: "test/runner.test.ts",
        stackTrace: [
          "at TestCase.run (/Users/dev/project/src/server.ts:15:10)",
        ],
      },
    ];

    const result = runTestFailureProximity({ failures, allFiles: ALL_FILES });
    const serverCandidate = result.candidates.find((c) => c.file === "/Users/dev/project/src/server.ts");
    expect(serverCandidate).toBeDefined();
    expect(serverCandidate!.rawScore).toBe(100);
  });

  it("returns empty candidates for empty allFiles", () => {
    const failures: TestFailure[] = [
      {
        testFile: "missing.test.ts",
        stackTrace: ["at missing.test.ts:1:1"],
      },
    ];

    const result = runTestFailureProximity({ failures, allFiles: [] });
    expect(result.candidates.length).toBe(1); // The test file itself
    expect(result.candidates[0]!.file).toBe("missing.test.ts");
  });

  it("produces metadata with counts", () => {
    const failures: TestFailure[] = [
      {
        testFile: "src/parser.test.ts",
        stackTrace: ["at src/parser.ts:8:5"],
      },
    ];

    const result = runTestFailureProximity({ failures, allFiles: ALL_FILES });
    expect(result.metadata).toBeDefined();
    expect(result.metadata!.failuresProcessed).toBe(1);
    expect(typeof result.metadata!.stackTraceFiles).toBe("number");
    expect(typeof result.metadata!.importerFiles).toBe("number");
  });
});
