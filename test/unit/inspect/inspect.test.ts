import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtendedReadTool } from "../../src/hook.js";
import {
    PROTOCOL_SCHEMA_VERSION,
    validateInspectionEnvelope,
    validateEvidenceRef,
} from "@rhinos0608/pi-workspace-protocol";

function makeCtx(cwd: string, sessionFile: string | null) {
  return {
    cwd,
    sessionManager: sessionFile ? { getSessionFile: () => sessionFile } : undefined,
  } as any;
}

let workdir: string;
let file: string;
let canonicalFile: string;
let canonicalRoot: string;

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "inspect-")));
    mkdirSync(workdir, { recursive: true });
    file = join(workdir, "hello.ts");
    writeFileSync(file, "alpha\nbeta\ngamma\ndelta\n", "utf8");
    canonicalFile = realpathSync(file);
    canonicalRoot = realpathSync(workdir);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("read tool evidence (replaces inspect path mode evidence)", () => {
    it("returns a schema-version-1 envelope with full-file resource for the whole file", async () => {
        const tool = createExtendedReadTool();
        const result = await tool.execute("t1", { path: "hello.ts" }, undefined, undefined, makeCtx(workdir, "/sessions/abc.jsonl"));
        const env = (result.details as any).workspaceEvidence;
        expect(env.schemaVersion).toBe(PROTOCOL_SCHEMA_VERSION);
        const v = validateInspectionEnvelope(env);
        expect(v.ok).toBe(true);
        expect(env.resources).toHaveLength(1);
        const r = env.resources[0]!;
        expect(r.kind).toBe("full");
        expect(r.coverage).toBe("full-file");
        expect(r.fresh).toBe(true);
        expect(r.fullFileSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(r.canonicalPath).toBe(canonicalFile);
        expect(r.allowedRanges).toEqual([{ startLine: 1, endLine: 5 }]);
        expect(env.canonicalWorkspaceRoot).toBe(canonicalRoot);
    });

    it("returns a line-range resource when offset/limit are given", async () => {
        const tool = createExtendedReadTool();
        const result = await tool.execute("t2", { path: "hello.ts", offset: 2, limit: 2 }, undefined, undefined, makeCtx(workdir, "/sessions/abc.jsonl"));
        const env = (result.details as any).workspaceEvidence;
        expect(env.resources).toHaveLength(1);
        const r = env.resources[0]!;
        expect(r.kind).toBe("range");
        expect(r.coverage).toBe("line-range");
        expect(r.allowedRanges).toEqual([{ startLine: 2, endLine: 3 }]);
        expect(r.fresh).toBe(true);
        expect(r.fullFileSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("inspectionId is a 64-char hex sha256", async () => {
        const tool = createExtendedReadTool();
        const result = await tool.execute("t3", { path: "hello.ts" }, undefined, undefined, makeCtx(workdir, "/sessions/abc.jsonl"));
        const env = (result.details as any).workspaceEvidence;
        expect(env.inspectionId).toMatch(/^[0-9a-f]{64}$/);
    });

    it("sessionId is a 64-char hex sha256 derived from the session file path", async () => {
        const tool = createExtendedReadTool();
        const result = await tool.execute("t4", { path: "hello.ts" }, undefined, undefined, makeCtx(workdir, "/sessions/abc.jsonl"));
        const env = (result.details as any).workspaceEvidence;
        expect(env.sessionId).toMatch(/^[0-9a-f]{64}$/);
    });

    it("two calls with the same session produce stable inspectionId for same file", async () => {
        const tool = createExtendedReadTool();
        const a = await tool.execute("t5", { path: "hello.ts" }, undefined, undefined, makeCtx(workdir, "/sessions/abc.jsonl"));
        const b = await tool.execute("t6", { path: "hello.ts" }, undefined, undefined, makeCtx(workdir, "/sessions/abc.jsonl"));
        const aEnv = (a.details as any).workspaceEvidence;
        const bEnv = (b.details as any).workspaceEvidence;
        expect(aEnv.inspectionId).toBe(bEnv.inspectionId);
    });

    it("different session file path produces different inspectionId", async () => {
        const tool = createExtendedReadTool();
        const a = await tool.execute("t7", { path: "hello.ts" }, undefined, undefined, makeCtx(workdir, "/sessions/a.jsonl"));
        const b = await tool.execute("t8", { path: "hello.ts" }, undefined, undefined, makeCtx(workdir, "/sessions/b.jsonl"));
        const aEnv = (a.details as any).workspaceEvidence;
        const bEnv = (b.details as any).workspaceEvidence;
        expect(aEnv.inspectionId).not.toBe(bEnv.inspectionId);
    });

    it("rejects ephemeral session identity (no session file path)", async () => {
        const tool = createExtendedReadTool();
        const result = await tool.execute("t9", { path: "hello.ts" }, undefined, undefined, makeCtx(workdir, null));
        expect((result.details as any)?.workspaceEvidence).toBeUndefined();
    });

    it("validates as a schema-1 envelope", async () => {
        const tool = createExtendedReadTool();
        const result = await tool.execute("t10", { path: "hello.ts" }, undefined, undefined, makeCtx(workdir, "/sessions/abc.jsonl"));
        const env = (result.details as any).workspaceEvidence;
        const v = validateInspectionEnvelope(env);
        expect(v.ok).toBe(true);
    });
});

describe("evidenceRef helpers", () => {
    it("validateEvidenceRef accepts a valid ref from a details payload", async () => {
        const tool = createExtendedReadTool();
        const result = await tool.execute("t11", { path: "hello.ts" }, undefined, undefined, makeCtx(workdir, "/sessions/abc.jsonl"));
        const env = (result.details as any).workspaceEvidence;
        const ref = {
            inspectionId: env.inspectionId,
            resourceIds: env.resources.map((r: any) => r.resourceId),
        };
        expect(validateEvidenceRef(ref).ok).toBe(true);
    });
});
