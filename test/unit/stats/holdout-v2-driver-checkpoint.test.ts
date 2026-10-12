import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
    appendCheckpointRecord,
    loadCheckpoint,
    pairKey,
} from "../../../scripts/holdout-v2/driver-checkpoint.js";

const dirs: string[] = [];
function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "holdout-v2-ckpt-"));
    dirs.push(dir);
    return dir;
}
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const outcome = (instanceId: string, formulation: string, status = "ok") => ({
    instanceId,
    formulation,
    status,
    rankedFiles: [`src/${instanceId}.ts`],
    successAt5: status === "ok",
    elapsedMs: 9,
});

describe("driver checkpoint", () => {
    it("round-trips outcomes, exclusions, attempts and setup kills", () => {
        const path = join(tempDir(), "ckpt.jsonl");
        appendCheckpointRecord(path, { v: 1, kind: "outcome", pair: pairKey("a", "title"), outcome: outcome("a", "title") });
        appendCheckpointRecord(path, {
            v: 1,
            kind: "excluded",
            instanceId: "b",
            exclusion: { instanceId: "b", reason: "missing-at-base", stage: "materialize" },
        });
        appendCheckpointRecord(path, {
            v: 1,
            kind: "attempt",
            attempt: { instanceId: "a", root: "/r", stage: "materialize", outcome: "success", createdFresh: true },
        });
        appendCheckpointRecord(path, { v: 1, kind: "setup-kill", instanceId: "c", at: "2026-10-12T00:00:00.000Z", elapsedMs: 1 });
        const loaded = loadCheckpoint(path);
        expect(loaded.tornLineDropped).toBe(false);
        expect(loaded.outcomes.get(pairKey("a", "title"))).toEqual(outcome("a", "title"));
        expect(loaded.exclusions).toHaveLength(1);
        expect(loaded.attempts).toHaveLength(1);
        expect(loaded.setupKills.get("c")).toBe(1);
    });
    it("missing file loads as empty state", () => {
        const loaded = loadCheckpoint(join(tempDir(), "absent.jsonl"));
        expect(loaded.outcomes.size).toBe(0);
        expect(loaded.tornLineDropped).toBe(false);
    });
    it("discards only an unparseable last line (crash mid-write)", () => {
        const path = join(tempDir(), "torn.jsonl");
        appendCheckpointRecord(path, { v: 1, kind: "outcome", pair: pairKey("a", "title"), outcome: outcome("a", "title") });
        appendCheckpointRecord(path, { v: 1, kind: "outcome", pair: pairKey("a", "body"), outcome: outcome("a", "body") });
        writeFileSync(path, '{"v":1,"kind":"outcome","pair":broken', { flag: "a" });
        const loaded = loadCheckpoint(path);
        expect(loaded.tornLineDropped).toBe(true);
        expect(loaded.outcomes.size).toBe(2);
        expect(loaded.outcomes.get(pairKey("a", "body"))).toEqual(outcome("a", "body"));
    });
    it("refuses a corrupt non-final line instead of silently skipping it", () => {
        const path = join(tempDir(), "corrupt.jsonl");
        writeFileSync(path, "not-json\n");
        appendCheckpointRecord(path, { v: 1, kind: "outcome", pair: pairKey("a", "title"), outcome: outcome("a", "title") });
        expect(() => loadCheckpoint(path)).toThrow(/line 1/);
    });
    it("rejects duplicate outcome records for the same pair", () => {
        const path = join(tempDir(), "dup.jsonl");
        appendCheckpointRecord(path, { v: 1, kind: "outcome", pair: pairKey("a", "title"), outcome: outcome("a", "title") });
        appendCheckpointRecord(path, { v: 1, kind: "outcome", pair: pairKey("a", "title"), outcome: outcome("a", "title") });
        expect(() => loadCheckpoint(path)).toThrow(/duplicate/);
    });
    it("rejects unknown record versions", () => {
        const path = join(tempDir(), "ver.jsonl");
        writeFileSync(path, `${JSON.stringify({ v: 999, kind: "outcome", pair: pairKey("a", "title"), outcome: outcome("a", "title") })}\n`);
        expect(() => loadCheckpoint(path)).toThrow(/version/);
    });
    it("repairing append preserves complete records and drops only the torn tail", () => {
        const path = join(tempDir(), "repair.jsonl");
        appendCheckpointRecord(path, { v: 1, kind: "outcome", pair: pairKey("a", "title"), outcome: outcome("a", "title") });
        appendCheckpointRecord(path, { v: 1, kind: "outcome", pair: pairKey("a", "body"), outcome: outcome("a", "body") });
        writeFileSync(path, '{"v":1,"kind":"outcome","pair":broken', { flag: "a" });
        appendCheckpointRecord(path, { v: 1, kind: "outcome", pair: pairKey("b", "title"), outcome: outcome("b", "title") });
        const loaded = loadCheckpoint(path);
        expect(loaded.tornLineDropped).toBe(false);
        expect([...loaded.outcomes.keys()]).toEqual([pairKey("a", "title"), pairKey("a", "body"), pairKey("b", "title")]);
        expect(loaded.outcomes.get(pairKey("b", "title"))).toEqual(outcome("b", "title"));
    });
});
