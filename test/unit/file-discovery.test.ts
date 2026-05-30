/**
 * Tests for file-discovery.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverFiles, findSearchableTextFiles, findSrcFiles } from "../../file-discovery.js";

describe("findSrcFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "file-discovery-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds source files in a directory", async () => {
    writeFileSync(join(tmpDir, "main.ts"), "// test");
    writeFileSync(join(tmpDir, "utils.py"), "# test");

    const files = await findSrcFiles(tmpDir);
    expect(files).toContain(join(tmpDir, "main.ts"));
    expect(files).toContain(join(tmpDir, "utils.py"));
  });

  it("ignores unsupported files", async () => {
    writeFileSync(join(tmpDir, "readme.md"), "# Readme");
    writeFileSync(join(tmpDir, "notes.txt"), "notes");
    writeFileSync(join(tmpDir, "code.ts"), "// test");

    const files = await findSrcFiles(tmpDir);
    expect(files).not.toContain(join(tmpDir, "readme.md"));
    expect(files).not.toContain(join(tmpDir, "notes.txt"));
    expect(files).toContain(join(tmpDir, "code.ts"));
  });

  it("recurses into subdirectories", async () => {
    const subDir = join(tmpDir, "src", "lib");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "helper.ts"), "// helper");

    const files = await findSrcFiles(tmpDir);
    expect(files).toContain(join(subDir, "helper.ts"));
  });

  it("ignores node_modules and other common ignore dirs", async () => {
    mkdirSync(join(tmpDir, "node_modules"), { recursive: true });
    writeFileSync(join(tmpDir, "node_modules", "dep.ts"), "// dep");

    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFileSync(join(tmpDir, ".git", "config"), "config");

    mkdirSync(join(tmpDir, "dist"), { recursive: true });
    writeFileSync(join(tmpDir, "dist", "bundle.ts"), "// bundle");

    writeFileSync(join(tmpDir, "main.ts"), "// main");

    const files = await findSrcFiles(tmpDir);
    expect(files).not.toContain(join(tmpDir, "node_modules", "dep.ts"));
    expect(files).not.toContain(join(tmpDir, ".git", "config"));
    expect(files).not.toContain(join(tmpDir, "dist", "bundle.ts"));
    expect(files).toContain(join(tmpDir, "main.ts"));
  });

  it("handles empty directories", async () => {
    const files = await findSrcFiles(tmpDir);
    expect(files).toEqual([]);
  });

  it("handles non-existent directories gracefully", async () => {
    const files = await findSrcFiles(join(tmpDir, "nonexistent"));
    expect(files).toEqual([]);
  });

  it("respects maxFiles limit", async () => {
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(tmpDir, `f${i}.ts`), "// test");
    }

    const files = await findSrcFiles(tmpDir, 10);
    expect(files.length).toBeLessThanOrEqual(10);
  });

  it("discovers files with various supported extensions", async () => {
    const exts = [".ts", ".js", ".py", ".rs", ".go", ".java", ".rb", ".c", ".cpp"];
    for (const ext of exts) {
      writeFileSync(join(tmpDir, `file${ext}`), "// test");
    }

    const files = await findSrcFiles(tmpDir);
    for (const ext of exts) {
      expect(files).toContain(join(tmpDir, `file${ext}`));
    }
  });

  it("discovers searchable text files beyond supported code extensions", async () => {
    writeFileSync(join(tmpDir, "README.md"), "# Readme");
    writeFileSync(join(tmpDir, "config.yaml"), "name: test");
    writeFileSync(join(tmpDir, "Procfile"), "web: node server.js");
    writeFileSync(join(tmpDir, "main.ts"), "export const value = 1;");

    const files = await findSearchableTextFiles(tmpDir);
    expect(files).toContain(join(tmpDir, "README.md"));
    expect(files).toContain(join(tmpDir, "config.yaml"));
    expect(files).toContain(join(tmpDir, "Procfile"));
    expect(files).toContain(join(tmpDir, "main.ts"));
  });

  it("keeps searchable hidden paths unless denied by ignore rules", async () => {
    mkdirSync(join(tmpDir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(tmpDir, ".github", "workflows", "ci.yml"), "name: ci");

    const files = await findSearchableTextFiles(tmpDir);
    expect(files).toContain(join(tmpDir, ".github", "workflows", "ci.yml"));
  });

  it("tracks binary files separately in text discovery diagnostics", async () => {
    writeFileSync(join(tmpDir, "notes.txt"), "plain text");
    writeFileSync(join(tmpDir, "blob.bin"), Buffer.from([0, 1, 2, 3, 4]));

    const result = await discoverFiles(tmpDir, "text");
    expect(result.files).toContain(join(tmpDir, "notes.txt"));
    expect(result.files).not.toContain(join(tmpDir, "blob.bin"));
    expect(result.diagnostics.filesSkippedBinary).toBe(1);
  });

});
