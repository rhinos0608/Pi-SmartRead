import { describe, expect, it } from "vitest";
import {
  rankByDiagnosticProximity,
  type DiagnosticInput,
} from "../../../src/rank-channels/diagnostic-proximity.js";

describe("diagnostic-proximity channel", () => {
  it("returns unavailable when inputs are empty", () => {
    const result = rankByDiagnosticProximity([]);
    expect(result.channel).toBe("diagnostic-proximity");
    expect(result.unavailable).toBeDefined();
    expect(result.unavailable!.reason).toBe("no diagnostics provided");
    expect(result.candidates).toHaveLength(0);
  });

  it("returns unavailable when all files have zero diagnostics", () => {
    const inputs: DiagnosticInput[] = [
      { file: "a.ts", lineCount: 100, errors: 0, warnings: 0 },
      { file: "b.ts", lineCount: 200, errors: 0, warnings: 0 },
    ];
    const result = rankByDiagnosticProximity(inputs);
    expect(result.unavailable).toBeDefined();
    expect(result.unavailable!.reason).toBe("all files have zero diagnostics");
    expect(result.candidates).toHaveLength(0);
  });

  it("ranks files by diagnostic density (descending)", () => {
    const inputs: DiagnosticInput[] = [
      { file: "low.ts", lineCount: 1000, errors: 1, warnings: 1 },
      { file: "high.ts", lineCount: 10, errors: 5, warnings: 5 },
      { file: "mid.ts", lineCount: 100, errors: 2, warnings: 3 },
    ];
    const result = rankByDiagnosticProximity(inputs);

    expect(result.channel).toBe("diagnostic-proximity");
    expect(result.candidates).toHaveLength(3);

    // high.ts: 10/10 = 1.0
    expect(result.candidates[0]!.file).toBe("high.ts");
    expect(result.candidates[0]!.rawScore).toBeCloseTo(1.0);
    // mid.ts: 5/100 = 0.05
    expect(result.candidates[1]!.file).toBe("mid.ts");
    expect(result.candidates[1]!.rawScore).toBeCloseTo(0.05);
    // low.ts: 2/1000 = 0.002
    expect(result.candidates[2]!.file).toBe("low.ts");
    expect(result.candidates[2]!.rawScore).toBeCloseTo(0.002);
  });

  it("reports severity in kind field", () => {
    const inputs: DiagnosticInput[] = [
      { file: "errors-only.ts", lineCount: 50, errors: 3, warnings: 0 },
      { file: "warnings-only.ts", lineCount: 50, errors: 0, warnings: 3 },
    ];
    const result = rankByDiagnosticProximity(inputs);

    const errorCandidate = result.candidates.find(
      (c) => c.file === "errors-only.ts",
    );
    const warningCandidate = result.candidates.find(
      (c) => c.file === "warnings-only.ts",
    );

    expect(errorCandidate!.kind).toBe("error:3");
    expect(warningCandidate!.kind).toBe("warning:3");
  });

  it("includes metadata about total and filtered counts", () => {
    const inputs: DiagnosticInput[] = [
      { file: "a.ts", lineCount: 100, errors: 1, warnings: 0 },
      { file: "b.ts", lineCount: 100, errors: 0, warnings: 0 },
    ];
    const result = rankByDiagnosticProximity(inputs);
    expect(result.metadata).toEqual({
      totalFiles: 2,
      filesWithDiagnostics: 1,
      maxCandidates: 500,
    });
  });

  it("bounds results to 500 candidates", () => {
    const inputs: DiagnosticInput[] = Array.from({ length: 600 }, (_, i) => ({
      file: `file-${i}.ts`,
      lineCount: 100,
      errors: 1,
      warnings: 0,
    }));
    const result = rankByDiagnosticProximity(inputs);
    expect(result.candidates).toHaveLength(500);
  });

  it("skips files with zero diagnostics when others have them", () => {
    const inputs: DiagnosticInput[] = [
      { file: "clean.ts", lineCount: 100, errors: 0, warnings: 0 },
      { file: "dirty.ts", lineCount: 100, errors: 2, warnings: 1 },
    ];
    const result = rankByDiagnosticProximity(inputs);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.file).toBe("dirty.ts");
  });

  it("uses lineCount=1 floor for zero-line files", () => {
    const inputs: DiagnosticInput[] = [
      { file: "empty.ts", lineCount: 0, errors: 1, warnings: 0 },
    ];
    const result = rankByDiagnosticProximity(inputs);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.rawScore).toBe(1);
  });
});
