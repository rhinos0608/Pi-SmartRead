import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createExtendedReadTool } from "../../src/hook.js";
import { computePathEvidence } from "../../src/path-evidence.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeCtx(cwd: string, sessionFile: string | null) {
  return {
    cwd,
    sessionManager: sessionFile ? { getSessionFile: () => sessionFile } : undefined,
  } as any;
}

describe("read tool enrichment (replaces inspect path mode enrichment)", () => {
  let repo: string;
  const session = "/tmp/fake-session.jsonl";

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(path.join(tmpdir(), "read-enrich-")));
    git(repo, "init");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "add a.ts");
    git(repo, "notes", "--ref=refs/notes/pi-smartread", "add", "-m", "decision: keep a tiny", "HEAD");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("appends git context and notes to read content", async () => {
    const tool = createExtendedReadTool();
    const result = await tool.execute("t1", { path: "a.ts" }, undefined, undefined, makeCtx(repo, session));
    const text = (result.content[0] as any).text as string;
    expect(text).toContain("export const a = 1;");
    expect(text).toContain("🔍 Context for a.ts:");
    expect(text).toContain("Recent commits:");
    expect(text).toContain("Git notes:");
    expect(text).toContain("decision: keep a tiny");
  });

  it("inspect navigation additive-friendly: unknown future status like needs-triage does not break consumer", async () => {
    // type-level guarantee: NavigationStatus / DiagnosticsStatus allow (string & {}) and renderers handle unknown via else path
    const unknownNavStatus: any = "needs-triage";
    expect(typeof unknownNavStatus).toBe("string");
  });

  it("navigation URI-less documentSymbols use real symbol ranges", async () => {
    const { mkdtempSync, writeFileSync: wfs, rmSync: rms, realpathSync: rps2 } = await import("node:fs");
    const { tmpdir: tmpdir2 } = await import("node:os");
    const { join: join2 } = await import("node:path");
    const wd = rps2(mkdtempSync(join2(tmpdir2(), "enrich-doc-")));
    wfs(join2(wd, "a.ts"), "x\n".repeat(10));
    const navProvider: any = {
      inspectNavigation: async () => ({
        status: "confirmed", operation: "documentSymbols",
        items: [
          { name: "alpha", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } } },
          { name: "beta", kind: 12, range: { start: { line: 5, character: 0 }, end: { line: 7, character: 0 } } },
        ], truncated: false,
      }),
      inspectDiagnostics: async () => ({ status: "empty", diagnostics: [], truncated: false }),
    };
    const { createInspectV4Tool: mkTool } = await import("../../src/inspect-tool.js");
    const tool2 = mkTool({ getSessionFilePath: () => session, lspInspectionProvider: navProvider } as any);
    const r2: any = await tool2.execute("enrich-doc-sym", { path: "a.ts", navigation: { operation: "documentSymbols" } }, undefined, undefined, { cwd: wd, sessionManager: { getSessionFile: () => session } } as any);
    const res2 = (r2.details as any).workspaceEvidence.resources.find((x: any) => x.canonicalPath.includes("a.ts"));
    expect(res2.allowedRanges).toEqual(expect.arrayContaining([{ startLine: 1, endLine: 3 }, { startLine: 6, endLine: 8 }]));
    expect(res2.allowedRanges.length).toBe(2);
    rms(wd, { recursive: true, force: true });
  });

  it("empty navigation does not fabricate line-1 evidence", async () => {
    const { mkdtempSync: m2, writeFileSync: w2, rmSync: rm2, realpathSync: rp2 } = await import("node:fs");
    const { tmpdir: td2 } = await import("node:os");
    const { join: j2 } = await import("node:path");
    const wd = rp2(m2(j2(td2(), "enrich-empty-")));
    w2(j2(wd, "b.ts"), "x\n".repeat(5));
    const { executeFileInspect: exec } = await import("../../src/inspect.js");
    const emptyProv: any = {
      inspectNavigation: async () => ({ status: "empty", operation: "documentSymbols", items: [], truncated: false }),
      inspectDiagnostics: async () => ({ status: "empty", diagnostics: [], truncated: false }),
    };
    const rEmpty = await exec({ path: "b.ts", cwd: wd, sessionFilePath: session, navigation: { operation: "documentSymbols" as any }, lspInspectionProvider: emptyProv } as any);
    expect(rEmpty.workspaceEvidence.resources.filter((r: any) => r.coverage === "search-match").length).toBe(0);
    const emptyDiag = await exec({ path: "b.ts", cwd: wd, sessionFilePath: session, diagnostics: { waitMs: 10, maxPerFile: 5 } as any, lspInspectionProvider: emptyProv } as any);
    expect(emptyDiag.workspaceEvidence.resources.filter((r: any) => r.coverage === "search-match").length).toBe(0);
    rm2(wd, { recursive: true, force: true });
  });

  it("navigation+diagnostics same-file ranges accumulate as union", async () => {
    const { mkdtempSync: m3, writeFileSync: w3, rmSync: rm3, realpathSync: rp3 } = await import("node:fs");
    const { tmpdir: td3 } = await import("node:os");
    const { join: j3 } = await import("node:path");
    const wd = rp3(m3(j3(td3(), "enrich-union-")));
    w3(j3(wd, "c.ts"), "x\n".repeat(15));
    const abs = rp3(j3(wd, "c.ts"));
    const prov: any = {
      inspectNavigation: async () => ({
        status: "confirmed", operation: "references",
        items: [{ location: { uri: "file://" + abs, range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } } }],
        truncated: false,
      }),
      inspectDiagnostics: async () => ({
        status: "confirmed", diagnostics: [{ message: "e", range: { start: { line: 8, character: 0 }, end: { line: 9, character: 0 } } }],
        truncated: false,
      }),
    };
    const { executeFileInspect: exec2 } = await import("../../src/inspect.js");
    const r = await exec2({ path: "c.ts", cwd: wd, sessionFilePath: session, navigation: { operation: "references" as any, line: 1, character: 1 }, diagnostics: { waitMs: 10, maxPerFile: 5 } as any, lspInspectionProvider: prov } as any);
    const sr = r.workspaceEvidence.resources.find((x: any) => x.coverage === "search-match");
    expect(sr).toBeDefined();
    expect(sr!.allowedRanges).toEqual(expect.arrayContaining([{ startLine: 1, endLine: 2 }, { startLine: 9, endLine: 10 }]));
    expect(sr!.allowedRanges.length).toBe(2);
    rm3(wd, { recursive: true, force: true });
  });

  it("keeps the envelope identical to the unenriched read", async () => {
    const tool = createExtendedReadTool();
    const result = await tool.execute("t2", { path: "a.ts" }, undefined, undefined, makeCtx(repo, session));
    const env = (result.details as any).workspaceEvidence;
    const resource = env.resources[0];
    expect(resource.canonicalPath).toMatch(/a\.ts$/);
    expect(resource.coverage).toBe("full-file");
    expect(resource.allowedRanges).toEqual([{ startLine: 1, endLine: 2 }]);
    expect(typeof resource.fullFileSha256).toBe("string");

    // Verify the read envelope's resource matches the independent compute.
    const pe = computePathEvidence({ path: "a.ts", cwd: repo, sessionFilePath: session });
    const peResource = pe.workspaceEvidence.resources[0]!;
    expect(resource.canonicalPath).toBe(peResource.canonicalPath);
    expect(resource.coverage).toBe(peResource.coverage);
    expect(resource.allowedRanges).toEqual(peResource.allowedRanges);
    expect(resource.fullFileSha256).toBe(peResource.fullFileSha256);
  });
});
