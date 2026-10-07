import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateInspectionEnvelope } from "@rhinos0608/pi-workspace-protocol";
import { computePathEvidence } from "../../../src/evidence/path-evidence.js";
import { buildBatchWorkspaceEvidence } from "../../../src/evidence/read-many-evidence.js";

describe("buildBatchWorkspaceEvidence mode + dedupe options (§6)", () => {
    let dir: string;
    const session = "/tmp/fake-script-mode-session.jsonl";

    beforeAll(() => {
        dir = realpathSync(mkdtempSync(path.join(tmpdir(), "script-evidence-")));
        writeFileSync(path.join(dir, "a.ts"), "v1\n");
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    function perFileOf(contents: string[]): Map<number, ReturnType<typeof computePathEvidence>["workspaceEvidence"]> {
        const map = new Map<number, ReturnType<typeof computePathEvidence>["workspaceEvidence"]>();
        contents.forEach((content, i) => {
            writeFileSync(path.join(dir, "a.ts"), content);
            map.set(i, computePathEvidence({ path: "a.ts", cwd: dir, sessionFilePath: session }).workspaceEvidence);
        });
        return map;
    }

    it("defaults to first-wins + mode path (existing read behavior unchanged)", () => {
        const merged = buildBatchWorkspaceEvidence({ cwd: dir, sessionFilePath: session, perFile: perFileOf(["v1\n", "v2\n"]) });
        expect(merged).not.toBeNull();
        expect(merged!.mode).toBe("path");
        expect(merged!.resources).toHaveLength(1);
        expect(merged!.resources[0]!.fullFileSha256).toBe(
            perFileOf(["v1\n"]).get(0)!.resources[0]!.fullFileSha256,
        );
        expect(validateInspectionEnvelope(merged!).ok).toBe(true);
    });

    it("last-wins keeps the later observation for a repeated resourceId", () => {
        const perFile = perFileOf(["v1\n", "v2\n"]);
        const firstSha = perFile.get(0)!.resources[0]!.fullFileSha256;
        const laterSha = perFile.get(1)!.resources[0]!.fullFileSha256;
        expect(firstSha).not.toBe(laterSha);
        // Same resourceId (same path+kind+range), different content hash.
        expect(perFile.get(0)!.resources[0]!.resourceId).toBe(perFile.get(1)!.resources[0]!.resourceId);

        const merged = buildBatchWorkspaceEvidence({
            cwd: dir,
            sessionFilePath: session,
            perFile,
            mode: "query",
            dedupe: "last-wins",
        });
        expect(merged).not.toBeNull();
        expect(merged!.mode).toBe("query");
        expect(merged!.resources).toHaveLength(1);
        expect(merged!.resources[0]!.fullFileSha256).toBe(laterSha);
        expect(validateInspectionEnvelope(merged!).ok).toBe(true);
    });

    it("keeps distinct resourceIds side by side under either policy", () => {
        writeFileSync(path.join(dir, "a.ts"), "v1\n");
        const full = computePathEvidence({ path: "a.ts", cwd: dir, sessionFilePath: session }).workspaceEvidence;
        const range = computePathEvidence({ path: "a.ts", offset: 1, limit: 1, cwd: dir, sessionFilePath: session }).workspaceEvidence;
        expect(full.resources[0]!.resourceId).not.toBe(range.resources[0]!.resourceId);
        for (const dedupe of ["first-wins", "last-wins"] as const) {
            const merged = buildBatchWorkspaceEvidence({
                cwd: dir,
                sessionFilePath: session,
                perFile: new Map([[0, full], [1, range]]),
                mode: "query",
                dedupe,
            });
            expect(merged!.resources).toHaveLength(2);
        }
    });

    it("returns null for an empty batch", () => {
        expect(buildBatchWorkspaceEvidence({ cwd: dir, sessionFilePath: session, perFile: new Map() })).toBeNull();
    });
});
