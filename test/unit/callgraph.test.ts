import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { findCallers, buildCallGraph } from "../../callgraph.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("callgraph", () => {
  let tmpDir: string;

  const makeFile = (name: string, content: string) => {
    const fname = join(tmpDir, name);
    writeFileSync(fname, content, "utf-8");
    return fname;
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "callgraph-test-"));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  describe("findCallers", () => {
    it("finds callers of a function across files", async () => {
      makeFile("a.ts", `
        function getConfig() { return { debug: true }; }

        function initApp() {
          const cfg = getConfig();
          setupLogging();
        }

        function setupLogging() {
          getConfig();
        }
      `);

      makeFile("b.ts", `
        function otherInit() {
          getConfig();
        }
      `);

      const { initParser } = await import("../../tags.js");
      await initParser();

      const files = [join(tmpDir, "a.ts"), join(tmpDir, "b.ts")];
      const callers = await findCallers(files, "getConfig");

      expect(callers).toHaveLength(3);
      expect(callers.map((c) => c.callerFunction).sort()).toEqual([
        "initApp",
        "otherInit",
        "setupLogging",
      ]);
    });

    it("returns empty array when no callers exist", async () => {
      makeFile("a.ts", `function unused() { return 42; }`);

      const { initParser } = await import("../../tags.js");
      await initParser();

      const callers = await findCallers([join(tmpDir, "a.ts")], "nonexistent");
      expect(callers).toHaveLength(0);
    });

    it("finds method callers", async () => {
      makeFile("a.ts", `
        class UserService {
          createUser(name: string) { return { name }; }
          process() { this.createUser("test"); }
        }

        function external() {
          new UserService().createUser("ext");
        }
      `);

      const { initParser } = await import("../../tags.js");
      await initParser();

      const callers = await findCallers([join(tmpDir, "a.ts")], "createUser");

      // Should find both the method call and external call
      expect(callers.length).toBeGreaterThanOrEqual(1);
      const names = callers.map((c) => c.callerFunction);
      expect(names).toContain("process");
    });

    it("skips non-TS/JS files", async () => {
      makeFile("a.md", "# Markdown file");
      makeFile("b.txt", "some text");

      const { initParser } = await import("../../tags.js");
      await initParser();

      const callers = await findCallers([join(tmpDir, "a.md"), join(tmpDir, "b.txt")], "anything");
      expect(callers).toHaveLength(0);
    });

    it("handles malformed files gracefully", async () => {
      makeFile("broken.ts", "import { } from } ;;; // not valid");

      const { initParser } = await import("../../tags.js");
      await initParser();

      const callers = await findCallers([join(tmpDir, "broken.ts")], "anything");
      expect(callers).toHaveLength(0);
    });
  });

  describe("buildCallGraph", () => {
    it("builds a call graph from multiple files", async () => {
      makeFile("a.ts", `
        function foo() { bar(); }
        function bar() { baz(); }
        function baz() {}
      `);

      makeFile("b.ts", `
        function qux() { foo(); bar(); }
      `);

      const { initParser } = await import("../../tags.js");
      await initParser();

      const result = await buildCallGraph([
        join(tmpDir, "a.ts"),
        join(tmpDir, "b.ts"),
      ]);

      expect(result.functions.length).toBeGreaterThanOrEqual(3);
      expect(result.edgeCount).toBeGreaterThan(0);

      // Check callersOf
      const barCallers = result.callersOf("bar");
      expect(barCallers.some((f) => f.name === "foo")).toBe(true);
      expect(barCallers.some((f) => f.name === "qux")).toBe(true);
    });

    it("returns empty graph for no files", async () => {
      const { initParser } = await import("../../tags.js");
      await initParser();

      const result = await buildCallGraph([]);
      expect(result.functions).toHaveLength(0);
      expect(result.edgeCount).toBe(0);
    });
  });
});
