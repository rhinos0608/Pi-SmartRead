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

    it("finds callers of a Python function", async () => {
      makeFile("a.py", `
def get_config():
    return {"debug": True}

def init_app():
    cfg = get_config()
    setup_logging()

def setup_logging():
    get_config()
`);

      const { initParser } = await import("../../tags.js");
      await initParser();

      const files = [join(tmpDir, "a.py")];
      const callers = await findCallers(files, "get_config");

      expect(callers).toHaveLength(2);
      expect(callers.map((c) => c.callerFunction).sort()).toEqual([
        "init_app",
        "setup_logging",
      ]);
    });

    it("finds callers of a Go function", async () => {
      makeFile("main.go", `package main

func getConfig() map[string]interface{} {
    return map[string]interface{}{"debug": true}
}

func initApp() {
    cfg := getConfig()
    setupLogging()
}

func setupLogging() {
    getConfig()
}
`);

      const { initParser } = await import("../../tags.js");
      await initParser();

      const files = [join(tmpDir, "main.go")];
      const callers = await findCallers(files, "getConfig");

      expect(callers).toHaveLength(2);
      expect(callers.map((c) => c.callerFunction).sort()).toEqual([
        "initApp",
        "setupLogging",
      ]);
    });

    it("finds callers of a Rust function", async () => {
      makeFile("main.rs", `fn get_config() -> Config {
    Config { debug: true }
}

fn init_app() {
    let cfg = get_config();
    setup_logging();
}

fn setup_logging() {
    get_config();
}
`);

      const { initParser } = await import("../../tags.js");
      await initParser();

      const files = [join(tmpDir, "main.rs")];
      const callers = await findCallers(files, "get_config");

      expect(callers).toHaveLength(2);
      expect(callers.map((c) => c.callerFunction).sort()).toEqual([
        "init_app",
        "setup_logging",
      ]);
    });

    it("finds Python method calls", async () => {
      makeFile("service.py", `class UserService:
    def __init__(self, repo):
        self.repo = repo

    def get_user(self, id):
        return self.repo.find(id)

def main():
    svc = UserService(repo)
    svc.get_user(1)
`);

      const { initParser } = await import("../../tags.js");
      await initParser();

      const callers = await findCallers([join(tmpDir, "service.py")], "get_user");

      expect(callers.length).toBeGreaterThanOrEqual(1);
      const names = callers.map((c) => c.callerFunction);
      expect(names).toContain("main");
    });

    it("finds Go method calls via selector_expression", async () => {
      makeFile("service.go", `package main
type Service struct{}
func (s *Service) GetUser(id int) *User { return nil }
func main() {
    svc := &Service{}
    svc.GetUser(1)
}
`);

      const { initParser } = await import("../../tags.js");
      await initParser();

      const callers = await findCallers([join(tmpDir, "service.go")], "GetUser");

      expect(callers.length).toBeGreaterThanOrEqual(1);
      const names = callers.map((c) => c.callerFunction);
      expect(names).toContain("main");
    });

    it("finds Rust method calls via field_expression", async () => {
      makeFile("service.rs", `struct Service {
    repo: Repository,
}

impl Service {
    fn get_user(&self, id: i32) -> User {
        self.repo.find(id)
    }
}

fn main() {
    let svc = Service { repo: Repository::new() };
    svc.get_user(1);
}
`);

      const { initParser } = await import("../../tags.js");
      await initParser();

      const callers = await findCallers([join(tmpDir, "service.rs")], "get_user");

      expect(callers.length).toBeGreaterThanOrEqual(1);
      const names = callers.map((c) => c.callerFunction);
      expect(names).toContain("main");
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

    it("builds a call graph from Python files", async () => {
      makeFile("a.py", `def foo():
    bar()

def bar():
    baz()

def baz():
    pass
`);

      makeFile("b.py", `from a import foo, bar

def qux():
    foo()
    bar()
`);

      const { initParser } = await import("../../tags.js");
      await initParser();

      const result = await buildCallGraph([
        join(tmpDir, "a.py"),
        join(tmpDir, "b.py"),
      ]);

      expect(result.functions.length).toBeGreaterThanOrEqual(3);
      expect(result.edgeCount).toBeGreaterThan(0);
    });

    it("builds a call graph from Go files", async () => {
      makeFile("a.go", `package main
func foo() { bar() }
func bar() { baz() }
func baz() {}
`);

      const { initParser } = await import("../../tags.js");
      await initParser();

      const result = await buildCallGraph([join(tmpDir, "a.go")]);

      // foo and bar make calls (registered); baz makes no calls (not tracked)
      expect(result.functions.length).toBeGreaterThanOrEqual(2);
      expect(result.edgeCount).toBeGreaterThan(0);
    });

    it("builds a call graph from Rust files", async () => {
      makeFile("a.rs", `fn foo() { bar(); }
fn bar() { baz(); }
fn baz() {}
`);

      const { initParser } = await import("../../tags.js");
      await initParser();

      const result = await buildCallGraph([join(tmpDir, "a.rs")]);

      // foo and bar make calls (registered); baz makes no calls (not tracked)
      expect(result.functions.length).toBeGreaterThanOrEqual(2);
      expect(result.edgeCount).toBeGreaterThan(0);
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
