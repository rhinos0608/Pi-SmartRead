import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateInspectionEnvelope } from "@rhinos0608/pi-workspace-protocol";
import { createReadTool } from "../../src/unified-read.js";

function makeCtx(cwd: string, sessionFile: string | null) {
  return {
    cwd,
    sessionManager: sessionFile ? { getSessionFile: () => sessionFile } : undefined,
  } as any;
}

function bigTsClass(methodCount: number): string {
  const methods = Array.from({ length: methodCount }, (_, i) =>
    `  method${i}(x: number, y: number): number {\n    const sum = x + y + ${i};\n    return sum;\n  }\n`,
  ).join("\n");
  return `export class BigClass {\n${methods}}\n`;
}

describe("large-file structural AST outline (read tool wiring)", () => {
  let dir: string;
  let session: string;
  const bigCode = bigTsClass(250); // > 20KB, well under the 300-symbol render cap

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ast-outline-read-")));
    session = path.join(dir, "session.jsonl");
    writeFileSync(path.join(dir, "big.ts"), bigCode);
    writeFileSync(path.join(dir, "small.ts"), "export function tiny() { return 1; }\n");
    writeFileSync(path.join(dir, "big.md"), "# Notes\n\n" + "word ".repeat(6000));
    writeFileSync(path.join(dir, "broken.ts"), "export class Broken {\n  method(: number {\n".repeat(600));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => {
    delete process.env.PI_SMARTREAD_AST_OUTLINE;
    delete process.env.PI_SMARTREAD_AST_OUTLINE_BYTES;
  });

  it("returns a structural outline instead of the full file above the threshold", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("o1", { path: "big.ts" }, undefined, undefined, makeCtx(dir, session));
    expect(res.details.structuralOutline).toBe(true);
    expect(res.content[0].text).toContain("Structural outline: big.ts");
    expect(res.content[0].text).toContain("BigClass");
    expect(res.content[0].text).toContain("method0(x: number, y: number): number");
    expect(res.content[0].text).not.toContain("const sum ="); // bodies must not appear
  });

  it("attaches multi-resource line-range evidence, never full-file coverage", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("o2", { path: "big.ts" }, undefined, undefined, makeCtx(dir, session));
    const env = res.details.workspaceEvidence;
    expect(env).toBeDefined();
    expect(validateInspectionEnvelope(env).ok).toBe(true);
    expect(env.mode).toBe("path");
    expect(env.resources.length).toBeGreaterThan(1);
    for (const resource of env.resources) {
      expect(resource.coverage).toBe("line-range");
      expect(resource.allowedRanges[0].startLine).toBe(resource.allowedRanges[0].endLine);
    }
    expect(env.resources.some((r: any) => r.coverage === "full-file")).toBe(false);
  });

  it("publishes the outline evidence", async () => {
    let published: unknown;
    const tool = createReadTool({ publishInspection: (env) => { published = env; } });
    const res: any = await tool.execute("o3", { path: "big.ts" }, undefined, undefined, makeCtx(dir, session));
    expect(published).toBe(res.details.workspaceEvidence);
  });

  it("falls back to a normal full read below the size threshold", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("o4", { path: "small.ts" }, undefined, undefined, makeCtx(dir, session));
    expect(res.details.structuralOutline).toBeUndefined();
    expect(res.content[0].text).toContain("tiny()");
    expect(res.details.workspaceEvidence.resources[0].coverage).toBe("full-file");
  });

  it("preserves explicit offset/limit reads even for large supported files", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("o5", { path: "big.ts", offset: 1, limit: 3 }, undefined, undefined, makeCtx(dir, session));
    expect(res.details.structuralOutline).toBeUndefined();
    expect(res.content[0].text).toContain("export class BigClass");
    expect(res.details.workspaceEvidence.resources[0].coverage).toBe("line-range");
  });

  it("preserves raw selector reads for large supported files", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("o6", { path: "big.ts:raw" }, undefined, undefined, makeCtx(dir, session));
    expect(res.details?.structuralOutline).toBeUndefined();
    expect(res.details?.workspaceEvidence).toBeUndefined();
    expect(res.content[0].text).toContain("const sum ="); // full raw content, bodies included
  });

  it("falls back cleanly for unsupported languages above the size threshold", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("o7", { path: "big.md" }, undefined, undefined, makeCtx(dir, session));
    expect(res.details.structuralOutline).toBeUndefined();
    expect(res.content[0].text).toContain("# Notes");
  });

  it("falls back cleanly on parser failure above the size threshold", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("o8", { path: "broken.ts" }, undefined, undefined, makeCtx(dir, session));
    expect(res.details.structuralOutline).toBeUndefined();
    expect(res.content[0].text).toContain("class Broken");
  });

  it("still returns an outline (without evidence) when there is no session file", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("o9", { path: "big.ts" }, undefined, undefined, makeCtx(dir, null));
    expect(res.details.structuralOutline).toBe(true);
    expect(res.details.workspaceEvidence).toBeUndefined();
  });

  it("PI_SMARTREAD_AST_OUTLINE=0 disables the outline entirely", async () => {
    process.env.PI_SMARTREAD_AST_OUTLINE = "0";
    const tool = createReadTool();
    const res: any = await tool.execute("o10", { path: "big.ts" }, undefined, undefined, makeCtx(dir, session));
    expect(res.details.structuralOutline).toBeUndefined();
    expect(res.content[0].text).toContain("const sum =");
  });

  it("PI_SMARTREAD_AST_OUTLINE_BYTES raises the threshold above the file size", async () => {
    process.env.PI_SMARTREAD_AST_OUTLINE_BYTES = String(Buffer.byteLength(bigCode, "utf8") + 1);
    const tool = createReadTool();
    const res: any = await tool.execute("o11", { path: "big.ts" }, undefined, undefined, makeCtx(dir, session));
    expect(res.details.structuralOutline).toBeUndefined();
  });

  it("symbol-mode reads are unaffected (existing symbol reads preserved)", async () => {
    const tool = createReadTool({
      resolveSymbol: async (symbol) => (symbol === "BigClass" ? { path: "big.ts", line: 1 } : null),
    });
    const res: any = await tool.execute("o12", { symbol: "BigClass" }, undefined, undefined, makeCtx(dir, session));
    expect(res.details.structuralOutline).toBeUndefined();
    expect(res.content[0].text).toContain("export class BigClass");
  });

  it("batch (paths) mode does not trigger the outline for large files", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("o13", { paths: [{ path: "big.ts" }] }, undefined, undefined, makeCtx(dir, session));
    expect(res.content[0].text).not.toContain("Structural outline:");
  });
});
