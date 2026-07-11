import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeInspectDetails } from "../../inspect.js";
import {
    PROTOCOL_SCHEMA_VERSION,
    validateInspectionEnvelope,
    validateEvidenceRef,
} from "@rhinos0608/pi-workspace-protocol";

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

describe("computeInspectDetails", () => {
    it("returns a schema-version-1 envelope with full-file resource for the whole file", () => {
        const details = computeInspectDetails({
            path: "hello.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        expect(details.workspaceEvidence.schemaVersion).toBe(PROTOCOL_SCHEMA_VERSION);
        const v = validateInspectionEnvelope(details.workspaceEvidence);
        expect(v.ok).toBe(true);
        expect(details.workspaceEvidence.resources).toHaveLength(1);
        const r = details.workspaceEvidence.resources[0]!;
        expect(r.kind).toBe("full");
        expect(r.coverage).toBe("full-file");
        expect(r.fresh).toBe(true);
        expect(r.fullFileSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(r.canonicalPath).toBe(canonicalFile);
        expect(r.allowedRanges).toEqual([{ startLine: 1, endLine: 5 }]);
        expect(details.workspaceEvidence.canonicalWorkspaceRoot).toBe(canonicalRoot);
    });

    it("returns a line-range resource when offset/limit are given", () => {
        const details = computeInspectDetails({
            path: "hello.ts",
            offset: 2,
            limit: 2,
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        const env = details.workspaceEvidence;
        expect(env.resources).toHaveLength(1);
        const r = env.resources[0]!;
        expect(r.kind).toBe("range");
        expect(r.coverage).toBe("line-range");
        expect(r.allowedRanges).toEqual([{ startLine: 2, endLine: 3 }]);
        expect(r.fresh).toBe(true);
        // line-range resource MAY also carry fullFileSha256 for inside-queue verification
        expect(r.fullFileSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("inspectionId is a 64-char hex sha256", () => {
        const details = computeInspectDetails({
            path: "hello.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        expect(details.workspaceEvidence.inspectionId).toMatch(/^[0-9a-f]{64}$/);
    });

    it("sessionId is a 64-char hex sha256 derived from the session file path", () => {
        const details = computeInspectDetails({
            path: "hello.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        expect(details.workspaceEvidence.sessionId).toMatch(/^[0-9a-f]{64}$/);
    });

    it("two calls with the same session produce stable inspectionId for same file", () => {
        const a = computeInspectDetails({ path: "hello.ts", cwd: workdir, sessionFilePath: "/sessions/abc.jsonl" });
        const b = computeInspectDetails({ path: "hello.ts", cwd: workdir, sessionFilePath: "/sessions/abc.jsonl" });
        expect(a.workspaceEvidence.inspectionId).toBe(b.workspaceEvidence.inspectionId);
    });

    it("different session file path produces different inspectionId", () => {
        const a = computeInspectDetails({ path: "hello.ts", cwd: workdir, sessionFilePath: "/sessions/a.jsonl" });
        const b = computeInspectDetails({ path: "hello.ts", cwd: workdir, sessionFilePath: "/sessions/b.jsonl" });
        expect(a.workspaceEvidence.inspectionId).not.toBe(b.workspaceEvidence.inspectionId);
    });

    it("rejects ephemeral session identity (no session file path)", () => {
        expect(() =>
            computeInspectDetails({ path: "hello.ts", cwd: workdir, sessionFilePath: "" }),
        ).toThrow(/session/i);
        expect(() =>
            computeInspectDetails({ path: "hello.ts", cwd: workdir, sessionFilePath: undefined as unknown as string }),
        ).toThrow(/session/i);
    });

    it("rejects missing file", () => {
        expect(() =>
            computeInspectDetails({
                path: "nope.ts",
                cwd: workdir,
                sessionFilePath: "/sessions/abc.jsonl",
            }),
        ).toThrow(/not found|no such file|ENOENT/i);
    });

    it("validates as a schema-1 envelope", () => {
        const details = computeInspectDetails({
            path: "hello.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        const v = validateInspectionEnvelope(details.workspaceEvidence);
        expect(v.ok).toBe(true);
    });
});

describe("evidenceRef helpers", () => {
    it("validateEvidenceRef accepts a valid ref from a details payload", () => {
        const details = computeInspectDetails({
            path: "hello.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        const ref = {
            inspectionId: details.workspaceEvidence.inspectionId,
            resourceIds: details.workspaceEvidence.resources.map((r) => r.resourceId),
        };
        expect(validateEvidenceRef(ref).ok).toBe(true);
    });
});
