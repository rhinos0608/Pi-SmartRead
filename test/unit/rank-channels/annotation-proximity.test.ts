import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { rankAnnotationProximity } from "../../../src/rank-channels/annotation-proximity.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function makeTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "ann-prox-test-"));
  return tmpDir;
}

describe("rankAnnotationProximity", () => {
  it("returns unavailable when no annotations found", () => {
    const dir = makeTmpDir();
    const file = join(dir, "clean.ts");
    writeFileSync(file, "const x = 1;\n", "utf-8");
    const result = rankAnnotationProximity([file]);
    expect(result.channel).toBe("annotation-proximity");
    expect(result.unavailable).toEqual({ reason: "no annotations found" });
    expect(result.candidates).toEqual([]);
  });

  it("returns unavailable for empty input", () => {
    const result = rankAnnotationProximity([]);
    expect(result.channel).toBe("annotation-proximity");
    expect(result.unavailable).toEqual({ reason: "no annotations found" });
  });

  it("scores a file with one TODO", () => {
    const dir = makeTmpDir();
    const file = join(dir, "a.ts");
    writeFileSync(file, "// TODO fix this\nconst x = 1;\n", "utf-8");
    const result = rankAnnotationProximity([file]);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]!.file).toBe(file);
    expect(result.candidates[0]!.rawScore).toBeGreaterThan(0);
    expect(result.candidates[0]!.rawScore).toBeLessThanOrEqual(1.0);
  });

  it("scores more annotations higher", () => {
    const dir = makeTmpDir();
    const few = join(dir, "few.ts");
    writeFileSync(few, "// TODO a\nconst x = 1;\n", "utf-8");
    const many = join(dir, "many.ts");
    writeFileSync(
      many,
      Array.from({ length: 10 }, (_, i) => `// TODO item${i}`).join("\n") + "\n",
      "utf-8",
    );
    const result = rankAnnotationProximity([few, many]);
    const fewScore = result.candidates.find((c) => c.file === few)!.rawScore;
    const manyScore = result.candidates.find((c) => c.file === many)!.rawScore;
    expect(manyScore).toBeGreaterThan(fewScore);
  });

  it("detects FIXME, HACK, XXX markers", () => {
    const dir = makeTmpDir();
    const f1 = join(dir, "f.ts");
    writeFileSync(f1, "// FIXME broken\n", "utf-8");
    const f2 = join(dir, "h.ts");
    writeFileSync(f2, "// HACK workaround\n", "utf-8");
    const f3 = join(dir, "x.ts");
    writeFileSync(f3, "// XXX temp\n", "utf-8");
    const result = rankAnnotationProximity([f1, f2, f3]);
    expect(result.candidates.length).toBe(3);
    const tags = result.candidates.map((c) => c.name);
    expect(tags).toContain("FIXME");
    expect(tags).toContain("HACK");
    expect(tags).toContain("XXX");
  });

  it("reports first annotation line and snippet", () => {
    const dir = makeTmpDir();
    const file = join(dir, "b.ts");
    writeFileSync(file, "const a = 1;\n// TODO fix\nconst b = 2;\n", "utf-8");
    const result = rankAnnotationProximity([file]);
    expect(result.candidates[0]!.line).toBe(2);
    expect(result.candidates[0]!.snippet).toContain("TODO");
  });

  it("is deterministic", () => {
    const dir = makeTmpDir();
    const file = join(dir, "c.ts");
    writeFileSync(file, "// TODO x\n", "utf-8");
    const a = rankAnnotationProximity([file]);
    const b = rankAnnotationProximity([file]);
    expect(a).toEqual(b);
  });

  it("skips unreadable files", () => {
    const dir = makeTmpDir();
    const bad = join(dir, "nonexistent.ts");
    const good = join(dir, "good.ts");
    writeFileSync(good, "// TODO ok\n", "utf-8");
    const result = rankAnnotationProximity([bad, good]);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]!.file).toBe(good);
  });

  it("caps at MAX_CANDIDATES (500)", () => {
    const dir = makeTmpDir();
    const files = Array.from({ length: 600 }, (_, i) => {
      const f = join(dir, `f${i}.ts`);
      writeFileSync(f, `// TODO ${i}\n`, "utf-8");
      return f;
    });
    const result = rankAnnotationProximity(files);
    expect(result.candidates.length).toBe(500);
  });

  it("includes metadata", () => {
    const dir = makeTmpDir();
    const file = join(dir, "m.ts");
    writeFileSync(file, "// TODO test\n", "utf-8");
    const result = rankAnnotationProximity([file]);
    expect(result.metadata?.totalAnnotated).toBe(1);
    expect(result.metadata?.annotationPattern).toBeDefined();
  });
});
