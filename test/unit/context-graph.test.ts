import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { ContextGraph } from "../../context-graph.js";

describe("ContextGraph", () => {
  let root: string;
  let graph: ContextGraph;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-smartread-graph-test-"));
    graph = new ContextGraph(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("extracts direct import neighbours", async () => {
    const fileA = join(root, "a.ts");
    const fileB = join(root, "b.ts");
    writeFileSync(fileA, "import './b'");
    writeFileSync(fileB, "export const b = 1");

    const neighbours = await graph.getFileNeighbours(fileA);
    expect(neighbours.map(n => n.path)).toContain(fileB);
    
    const prov = graph.explainPathAddition(fileB);
    expect(prov).toBeDefined();
    expect(prov?.type).toBe("imports");
    expect(prov?.from).toBe(fileA);
  });

  it("finds symbol definitions across files", async () => {
    const fileA = join(root, "a.ts");
    const fileB = join(root, "b.ts");
    writeFileSync(fileA, "const x = new MyClass();");
    writeFileSync(fileB, "export class MyClass {}");

    // We need to wait for tree-sitter tags to be indexed
    // getFileNeighbours with includeSymbols: true
    const neighbours = await graph.getFileNeighbours(fileA, { includeSymbols: true });
    
    // fileB defines MyClass which is referenced in fileA
    expect(neighbours.map(n => n.path)).toContain(fileB);
    
    const prov = graph.explainPathAddition(fileB);
    expect(prov?.type).toBe("defines");
  });

  it("findSymbolFiles finds files defining or referencing a symbol", async () => {
    const fileA = join(root, "a.ts");
    const fileB = join(root, "b.ts");
    writeFileSync(fileA, "export class MyService {}");
    // typescript-tags.scm captures new_expression (class)
    writeFileSync(fileB, "const x = new MyService();");

    const results = await graph.findSymbolFiles("MyService");
    const paths = results.map(r => r.path);
    
    expect(paths).toContain(fileA); // definition
    expect(paths).toContain(fileB); // reference
    
    const def = results.find(r => r.path === fileA);
    expect(def?.provenance.type).toBe("defines");
    
    const ref = results.find(r => r.path === fileB);
    expect(ref?.provenance.type).toBe("references");
  });

  it("follows parent-relative imports outside the graph root", async () => {
    const parent = mkdtempSync(join(tmpdir(), "pi-smartread-outside-"));
    const localRoot = join(parent, "repo");
    const localGraph = new ContextGraph(localRoot);
    const outside = join(parent, "outside.ts");

    try {
      mkdirSync(localRoot);
      writeFileSync(outside, "export const secret = 1;");
      const fileA = join(localRoot, "a.ts");
      writeFileSync(fileA, "import '../outside';");

      const neighbours = await localGraph.getFileNeighbours(fileA);
      expect(neighbours.map(n => n.path)).toContain(outside);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
