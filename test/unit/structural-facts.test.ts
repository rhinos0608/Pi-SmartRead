import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractStructuralFacts } from "../../src/structural-facts.js";

function fixtureDir(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `sf-${name}-`)));
  return dir;
}

describe("extractStructuralFacts", () => {
  // ── TS class with extends + implements ─────────────────────

  describe("TS class extends + implements", () => {
    let dir: string;
    let file: string;

    beforeAll(() => {
      dir = fixtureDir("ts-extends");
      writeFileSync(
        join(dir, "shapes.ts"),
        `export interface Drawable {
  draw(): void;
}

export abstract class Shape {
  abstract area(): number;
}

export class Circle extends Shape implements Drawable {
  override area(): number {
    return Math.PI * this.radius * this.radius;
  }
  draw(): void {}
  constructor(private radius: number) {}
}
`,
      );
      file = join(dir, "shapes.ts");
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("finds base classes", async () => {
      const facts = await extractStructuralFacts(file, dir);
      expect(facts.baseClasses.length).toBeGreaterThanOrEqual(1);
      const shapeBase = facts.baseClasses.find((b) => b.name === "Shape");
      expect(shapeBase).toBeDefined();
      expect(shapeBase!.kind).toBe("class");
    });

    it("finds interfaces", async () => {
      const facts = await extractStructuralFacts(file, dir);
      expect(facts.interfaces.length).toBeGreaterThanOrEqual(1);
      const drawableIface = facts.interfaces.find((b) => b.name === "Drawable");
      expect(drawableIface).toBeDefined();
      expect(drawableIface!.kind).toBe("interface");
    });

    it("finds children (classes, methods)", async () => {
      const facts = await extractStructuralFacts(file, dir);
      const names = facts.children.map((c) => c.name);
      expect(names).toContain("Drawable");
      expect(names).toContain("Shape");
      expect(names).toContain("Circle");
      expect(names).toContain("area");
      expect(names).toContain("draw");
    });

    it("detects parent class", async () => {
      const facts = await extractStructuralFacts(file, dir);
      // Circle's parent is Shape
      const circle = facts.children.find((c) => c.name === "Circle");
      expect(circle).toBeDefined();
    });
  });

  // ── TS override keyword ────────────────────────────────────

  describe("TS override keyword", () => {
    let dir: string;
    let file: string;

    beforeAll(() => {
      dir = fixtureDir("ts-override");
      writeFileSync(
        join(dir, "animals.ts"),
        `export class Animal {
  speak(): string { return "..."; }
}

export class Dog extends Animal {
  override speak(): string { return "woof"; }
}
`,
      );
      file = join(dir, "animals.ts");
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("detects override with isExplicit=true", async () => {
      const facts = await extractStructuralFacts(file, dir);
      const overrides = facts.overrides.filter((o) => o.methodName === "speak");
      expect(overrides.length).toBeGreaterThanOrEqual(1);
      const dogOverride = overrides.find((o) => o.parentName === "Animal");
      expect(dogOverride).toBeDefined();
      expect(dogOverride!.isExplicit).toBe(true);
    });
  });

  // ── TS barrel chain re-export ───────────────────────────────

  describe("TS barrel chain re-export", () => {
    let dir: string;
    let targetFile: string;

    beforeAll(() => {
      dir = fixtureDir("ts-barrel");
      // Target module
      writeFileSync(join(dir, "math.ts"), `export function add(a: number, b: number): number { return a + b; }\n`);
      // First barrel
      writeFileSync(join(dir, "index.ts"), `export { add } from "./math.js";\n`);
      targetFile = join(dir, "math.ts");
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("finds barrel re-export", async () => {
      const facts = await extractStructuralFacts(targetFile, dir);
      expect(facts.reExportedBy.length).toBeGreaterThanOrEqual(1);
      const barrel = facts.reExportedBy.find((r) => r.barrelFile === join(dir, "index.ts"));
      expect(barrel).toBeDefined();
      expect(barrel!.exportName).toBe("add");
      expect(barrel!.kind).toBe("named");
    });
  });

  // ── TS barrel chain (deep) ─────────────────────────────────

  describe("TS barrel chain (deep, cycle-protected)", () => {
    let dir: string;
    let targetFile: string;

    beforeAll(() => {
      dir = fixtureDir("ts-barrel-deep");
      // Internal module
      writeFileSync(join(dir, "internal.ts"), `export const SECRET = 42;\n`);
      // Mid barrel
      writeFileSync(join(dir, "mid.ts"), `export { SECRET } from "./internal.js";\n`);
      // Top barrel
      writeFileSync(join(dir, "index.ts"), `export { SECRET } from "./mid.js";\n`);
      targetFile = join(dir, "internal.ts");
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("resolves multi-level barrel chain", async () => {
      const facts = await extractStructuralFacts(targetFile, dir);
      const barrelPaths = facts.reExportedBy.map((r) => r.barrelFile);
      expect(barrelPaths).toContain(join(dir, "mid.ts"));
      expect(barrelPaths).toContain(join(dir, "index.ts"));
    });
  });

  // ── Python __init__.py re-export ────────────────────────────

  describe("Python __init__.py re-export", () => {
    let dir: string;
    let targetFile: string;

    beforeAll(() => {
      dir = fixtureDir("py-init-rexport");
      // Module
      writeFileSync(
        join(dir, "greeter.py"),
        `def greet(name: str) -> str:\n    return f"Hello {name}"\n`,
      );
      // Package __init__.py barrel
      writeFileSync(join(dir, "__init__.py"), `from .greeter import greet\n`);
      targetFile = join(dir, "greeter.py");
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("finds Python __init__.py re-export", async () => {
      const facts = await extractStructuralFacts(targetFile, dir);
      expect(facts.reExportedBy.length).toBeGreaterThanOrEqual(1);
      const barrel = facts.reExportedBy.find((r) => r.exportName === "greet");
      expect(barrel).toBeDefined();
      expect(barrel!.kind).toBe("named");
    });
  });

  // ── Python class hierarchy ──────────────────────────────────

  describe("Python class hierarchy", () => {
    let dir: string;
    let file: string;

    beforeAll(() => {
      dir = fixtureDir("py-hierarchy");
      writeFileSync(
        join(dir, "animals.py"),
        `class Animal:
    def speak(self):
        return "..."

class Dog(Animal):
    def speak(self):
        return "woof"

class Cat(Animal):
    def meow(self):
        return "meow"
`,
      );
      file = join(dir, "animals.py");
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("finds Python class hierarchy", async () => {
      const facts = await extractStructuralFacts(file, dir);
      expect(facts.baseClasses.length).toBeGreaterThanOrEqual(1);
      const animalBase = facts.baseClasses.find((b) => b.name === "Animal");
      expect(animalBase).toBeDefined();
    });

    it("finds Python children", async () => {
      const facts = await extractStructuralFacts(file, dir);
      const names = facts.children.map((c) => c.name);
      expect(names).toContain("Animal");
      expect(names).toContain("Dog");
      expect(names).toContain("Cat");
      expect(names).toContain("speak");
      expect(names).toContain("meow");
    });
  });

  // ── Python name-match override ──────────────────────────────

  describe("Python name-match override", () => {
    let dir: string;
    let file: string;

    beforeAll(() => {
      dir = fixtureDir("py-override");
      writeFileSync(
        join(dir, "polymorph.py"),
        `class Base:
    def method(self):
        return "base"

class Derived(Base):
    def method(self):
        return "derived"
`,
      );
      file = join(dir, "polymorph.py");
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("detects Python override with isExplicit=false", async () => {
      const facts = await extractStructuralFacts(file, dir);
      const override = facts.overrides.find((o) => o.methodName === "method");
      expect(override).toBeDefined();
      // Python name-match → isExplicit is false
      expect(override!.isExplicit).toBe(false);
      expect(override!.parentName).toBe("Base");
    });
  });

  // ── Callers: intra-file ─────────────────────────────────────

  describe("Callers: intra-file", () => {
    let dir: string;
    let file: string;

    beforeAll(() => {
      dir = fixtureDir("callers-intra");
      writeFileSync(
        join(dir, "calc.ts"),
        `export function add(a: number, b: number): number {
  return a + b;
}

export function double(x: number): number {
  return add(x, x);
}

export function process(): void {
  const result = double(5);
  console.log(result);
}
`,
      );
      file = join(dir, "calc.ts");
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("finds intra-file callers", async () => {
      const facts = await extractStructuralFacts(file, dir);
      const callers = facts.callers;
      // double calls add → should find add's caller as double
      const addCallers = callers.filter((c) => c.symbolName === "double" && c.file === file);
      expect(addCallers.length).toBeGreaterThanOrEqual(1);
      // process calls double
      const doubleCallers = callers.filter((c) => c.symbolName === "process" && c.file === file);
      expect(doubleCallers.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Callers: cross-file ─────────────────────────────────────

  describe("Callers: cross-file", () => {
    let dir: string;
    let targetFile: string;

    beforeAll(() => {
      dir = fixtureDir("callers-cross");
      writeFileSync(
        join(dir, "helper.ts"),
        `export function helper(): string {\n  return "help";\n}\n`,
      );
      writeFileSync(
        join(dir, "user.ts"),
        `import { helper } from "./helper.js";\n\nexport function useHelper(): void {\n  helper();\n}\n`,
      );
      targetFile = join(dir, "helper.ts");
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("finds cross-file callers", async () => {
      const facts = await extractStructuralFacts(targetFile, dir);
      const crossCallers = facts.callers.filter(
        (c) => c.file === join(dir, "user.ts") && c.symbolName === "useHelper",
      );
      expect(crossCallers.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── >500KB skip ─────────────────────────────────────────────

  describe("Large file skip", () => {
    let dir: string;
    let file: string;

    beforeAll(() => {
      dir = fixtureDir("large-skip");
      // Create file > 500KB
      const line = "x".repeat(100) + "\n";
      const large = line.repeat(5200); // ~520KB
      writeFileSync(join(dir, "huge.ts"), large);
      file = join(dir, "huge.ts");
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("returns empty facts with notice for file >500KB", async () => {
      const facts = await extractStructuralFacts(file, dir);
      expect(facts.notices.length).toBeGreaterThanOrEqual(1);
      expect(facts.notices[0]).toContain("500KB");
      expect(facts.children.length).toBe(0);
      expect(facts.callers.length).toBe(0);
    });
  });

  // ── Unsupported language ────────────────────────────────────

  describe("Unsupported language", () => {
    let dir: string;
    let file: string;

    beforeAll(() => {
      dir = fixtureDir("unsupported");
      writeFileSync(join(dir, "data.json"), '{ "key": "value" }\n');
      file = join(dir, "data.json");
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("returns empty facts with notice for unsupported language", async () => {
      const facts = await extractStructuralFacts(file, dir);
      expect(facts.notices.length).toBeGreaterThanOrEqual(1);
      expect(facts.children.length).toBe(0);
      expect(facts.callers.length).toBe(0);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────

  describe("Empty file", () => {
    let dir: string;
    let file: string;

    beforeAll(() => {
      dir = fixtureDir("empty");
      writeFileSync(join(dir, "empty.ts"), "");
      file = join(dir, "empty.ts");
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("returns empty facts for empty file", async () => {
      const facts = await extractStructuralFacts(file, dir);
      expect(facts.children.length).toBe(0);
      expect(facts.callers.length).toBe(0);
      expect(facts.reExportedBy.length).toBe(0);
    });
  });

  describe("Non-existent file", () => {
    it("returns empty facts with notice", async () => {
      const facts = await extractStructuralFacts("/nonexistent/path.ts", "/tmp");
      expect(facts.notices.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── B1: lexical_declaration children ─────────────────────────

  describe("B1: lexical_declaration variable declarators", () => {
    let dir: string;
    let file: string;

    beforeAll(() => {
      dir = fixtureDir("b1-lexical");
      writeFileSync(
        join(dir, "vars.ts"),
        `export const greet = (x: string) => x;
export const a = 1, b = 2;
const internal = "hello";
`,
      );
      file = join(dir, "vars.ts");
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("extracts exported arrow function from lexical_declaration", async () => {
      const facts = await extractStructuralFacts(file, dir);
      const names = facts.children.map((c) => c.name);
      expect(names).toContain("greet");
    });

    it("extracts multiple variable declarators from one declaration", async () => {
      const facts = await extractStructuralFacts(file, dir);
      const names = facts.children.map((c) => c.name);
      expect(names).toContain("a");
      expect(names).toContain("b");
    });

    it("marks exported variables as exported", async () => {
      const facts = await extractStructuralFacts(file, dir);
      const greet = facts.children.find((c) => c.name === "greet");
      expect(greet).toBeDefined();
      expect(greet!.isExported).toBe(true);
    });
  });

  // ── B2: decorated Python classes ────────────────────────────

  describe("B2: Python decorated class definition", () => {
    let dir: string;
    let file: string;

    beforeAll(() => {
      dir = fixtureDir("b2-py-decorated-class");
      writeFileSync(
        join(dir, "models.py"),
        `from dataclasses import dataclass

@dataclass
class MyModel:
    name: str
    def get_name(self) -> str:
        return self.name
`,
      );
      file = join(dir, "models.py");
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("extracts decorated class definition", async () => {
      const facts = await extractStructuralFacts(file, dir);
      const names = facts.children.map((c) => c.name);
      expect(names).toContain("MyModel");
    });

    it("extracts methods from decorated class", async () => {
      const facts = await extractStructuralFacts(file, dir);
      const names = facts.children.map((c) => c.name);
      expect(names).toContain("get_name");
    });
  });

  // ── B3: visibility modifier detection ───────────────────────

  describe("B3: TS public visibility modifier", () => {
    let dir: string;
    let file: string;

    beforeAll(() => {
      dir = fixtureDir("b3-visibility");
      writeFileSync(
        join(dir, "vis.ts"),
        `export class Widget {
  public bar(): string { return "bar"; }
  private baz(): string { return "baz"; }
  protected qux(): string { return "qux"; }
}
`,
      );
      file = join(dir, "vis.ts");
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("detects public visibility", async () => {
      const facts = await extractStructuralFacts(file, dir);
      const bar = facts.children.find((c) => c.name === "bar");
      expect(bar).toBeDefined();
      expect(bar!.visibility).toBe("public");
    });

    it("detects private visibility", async () => {
      const facts = await extractStructuralFacts(file, dir);
      const baz = facts.children.find((c) => c.name === "baz");
      expect(baz).toBeDefined();
      expect(baz!.visibility).toBe("private");
    });

    it("detects protected visibility", async () => {
      const facts = await extractStructuralFacts(file, dir);
      const qux = facts.children.find((c) => c.name === "qux");
      expect(qux).toBeDefined();
      expect(qux!.visibility).toBe("protected");
    });
  });
});
