import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCallGraph } from "../../src/callgraph.js";
import { extractStructuralFacts } from "../../src/structural-facts.js";

describe("callgraph foundation", () => {
  it("inventories leaves and gives duplicate declarations distinct IDs", async () => {
    const d = mkdtempSync(join(tmpdir(), "cg-"));
    try { const a=join(d,"a.ts"), b=join(d,"b.ts"); writeFileSync(a,"export function same(){}\n"); writeFileSync(b,"export function same(){}\nfunction caller(){same()}\n"); const g=await buildCallGraph([a,b]); expect(g.functions.filter(f=>f.name==="same")).toHaveLength(2); expect(new Set(g.functions.map(f=>f.id)).size).toBe(g.functions.length); expect(g.edgeCount).toBe(1); } finally { rmSync(d,{recursive:true,force:true}); }
  });
  it("keeps unknown receiver calls diagnostic and out of traversable edges", async () => {
    const d=mkdtempSync(join(tmpdir(),"cg-")); try { const p=join(d,"x.ts"); writeFileSync(p,"function run(x:any){x.work()}\n"); const g=await buildCallGraph([p]); const e=g.edgeList?.[0]; expect(e?.receiver).toBe("x"); expect(e?.resolved).toBe(false); expect(g.edgeCount).toBe(0); } finally { rmSync(d,{recursive:true,force:true}); }
  });
  it("supports exact ID query without collapsing same names", async () => {
    const d=mkdtempSync(join(tmpdir(),"cg-")); try { const p=join(d,"x.ts"); writeFileSync(p,"function one(){}\nfunction two(){one()}\n"); const g=await buildCallGraph([p]); const one=g.functions.find(f=>f.name==="one")!; expect(g.findById?.(one.id!)).toBe(one); expect(g.findById?.("one")).toBeUndefined(); } finally { rmSync(d,{recursive:true,force:true}); }
  });
});

describe("override foundation", () => {
  it("requires matching same-file parent member", async () => {
    const d=mkdtempSync(join(tmpdir(),"ov-")); try { const p=join(d,"x.ts"); writeFileSync(p,"class Base { draw(){} } class Child extends Base { override area(){} override draw(){} }\n"); const f=await extractStructuralFacts(p,d); expect(f.overrides.map(o=>o.methodName)).toEqual(["draw"]); } finally { rmSync(d,{recursive:true,force:true}); }
  });
  it("requires matching Python parent member", async () => {
    const d=mkdtempSync(join(tmpdir(),"ov-")); try { const p=join(d,"x.py"); writeFileSync(p,"class Base:\n def draw(self): pass\nclass Child(Base):\n def area(self): pass\n"); const f=await extractStructuralFacts(p,d); expect(f.overrides.map(o=>o.methodName)).toEqual(["draw"]); } finally { rmSync(d,{recursive:true,force:true}); }
  });
});
