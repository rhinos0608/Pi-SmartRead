import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mergeAttemptReports } from "../../../scripts/holdout-v2/merge-attempts.js";

const dirs: string[] = [];
function tempDir(): string {
    // Canonical temp root: the merger refuses symlinked ancestors (macOS /var -> /private/var).
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "holdout-v2-merge-")));
    dirs.push(dir);
    return dir;
}
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const ids = ["synthetic-a", "synthetic-b"];
const formulations = ["title", "body"];
type Row = { instanceId: string; formulation: string; status: string; rankedFiles: string[]; successAt5: boolean; elapsedMs: number; score: number };
function outcome(instanceId: string, formulation: string, status = "ok", score = 0.4): Row {
    return { instanceId, formulation, status, rankedFiles: [`src/${instanceId}.ts`], successAt5: status === "ok", elapsedMs: 9, score };
}
function report(rows = ids.flatMap((id) => formulations.map((f) => outcome(id, f))), override: Record<string, unknown> = {}) {
    return {
        generatedAt: "2026-10-09T00:00:00.000Z", engine: "smartread-grep", judge: "off", split: "holdout",
        formulations, manifestSha256: "a".repeat(64), engineSourceHash: "sha256:synthetic-engine", rankingKnobs: { rankBm25b: 0.75 },
        summary: { runs: rows.length, errors: rows.filter((r) => r.status.startsWith("error:") || r.status.startsWith("timeout:")).length },
        outcomes: rows, ...override,
    };
}
function merge(reports: ReturnType<typeof report>[], outputPath = join(tempDir(), "merged.json")) {
    return mergeAttemptReports({ attempts: reports.map((value, i) => ({ path: `synthetic-attempt-${i + 1}.json`, report: value })), expectedInstanceIds: ids, outputPath });
}
const errorPair = (r: ReturnType<typeof report>, id = ids[0]!, f = "title") => ({ ...r, outcomes: r.outcomes.map((row) => row.instanceId === id && row.formulation === f ? { ...row, status: "error:timeout" } : row), summary: { ...r.summary, errors: 1 } });

describe("mergeAttemptReports", () => {
    it("passes through one complete no-error attempt", () => {
        const input = report();
        const { report: merged } = merge([input]);
        expect(merged.outcomes).toEqual(input.outcomes);
        expect((merged.attemptMerge as { pairsTakenFromEachAttempt: number[] }).pairsTakenFromEachAttempt).toEqual([4]);
    });
    it("recovers an error pair from the earliest later successful attempt without changing fields", () => {
        const first = errorPair(report());
        const second = report(ids.flatMap((id) => formulations.map((f) => outcome(id, f, "ok", 0.8))));
        const { report: merged } = merge([first, second]);
        const picked = (merged.outcomes as Row[]).find((row) => row.instanceId === ids[0] && row.formulation === "title");
        expect(picked).toEqual(second.outcomes.find((row) => row.instanceId === ids[0] && row.formulation === "title"));
        expect((merged.attemptMerge as { pairsTakenFromEachAttempt: number[] }).pairsTakenFromEachAttempt).toEqual([3, 1]);
    });
    it("discloses a pair that errors in all three attempts", () => {
        const attempts = [report(), report(), report()].map((r) => errorPair(r));
        const { report: merged } = merge(attempts);
        expect(merged.outcomes).toHaveLength(3);
        expect((merged.attemptMerge as { exclusions: unknown[] }).exclusions).toEqual([
            { instanceId: ids[0], formulation: "title", status: "error:timeout" },
        ]);
    });
    it("refuses an unnecessary second attempt and mismatched run identities", () => {
        expect(() => merge([report(), report()])).toThrow(/preceding attempt had no errors/);
        const first = errorPair(report());
        for (const changed of [
            report(undefined, { rankingKnobs: { rankBm25b: 0.5 } }),
            // A5 differs from A0 only in ranking knobs; its report must not merge into A0.
            report(undefined, { rankingKnobs: { rankBm25b: 0.75, rankCoverage: true } }),
            report(undefined, { manifestSha256: "b".repeat(64) }),
            report(undefined, { engineSourceHash: "sha256:other" }),
            report(undefined, { split: "dev" }),
            report(undefined, { formulations: ["body", "title"] }),
        ]) expect(() => merge([first, changed])).toThrow(/identity mismatch/);
        expect(() => merge([first, report(undefined, { judge: "local" })])).toThrow(/judge-off evidence/);
    });
    it("refuses relative, missing-parent, symlinked-parent, and occupied output paths", () => {
        expect(() => merge([report()], "relative/merged.json")).toThrow(/must be absolute/);
        expect(() => merge([report()], join(tempDir(), "absent", "merged.json"))).toThrow(/does not exist/);
        const root = tempDir();
        const target = join(root, "elsewhere");
        mkdirSync(target);
        const link = join(root, "expected");
        symlinkSync(target, link, "junction");
        expect(() => merge([report()], join(link, "merged.json"))).toThrow(/symlinked ancestor/);
    });
    // File symlinks need elevated privileges on Windows; directory junctions (above) do not.
    it.skipIf(process.platform === "win32")("refuses an output path occupied by a dangling symlink", () => {
        const root = tempDir();
        const dangling = join(root, "dangling.json");
        symlinkSync(join(root, "nowhere.json"), dangling);
        expect(() => merge([report()], dangling)).toThrow(/refusing to overwrite/);
    });
    it.skipIf(process.platform === "win32")("reads file inputs through canonical paths and records both paths", () => {
        const root = tempDir();
        const real = join(root, "attempt-1.json");
        writeFileSync(real, JSON.stringify(report()));
        const linked = join(root, "attempt-link.json");
        symlinkSync(real, linked);
        const { report: merged } = mergeAttemptReports({ attempts: [{ path: linked }], expectedInstanceIds: ids, outputPath: join(root, "merged.json") });
        const [entry] = (merged.attemptMerge as { attempts: Array<{ path: string; suppliedPath: string }> }).attempts;
        expect(entry).toMatchObject({ path: real, suppliedPath: linked });
    });
    it("refuses a missing expected pair", () => {
        const incomplete = report();
        incomplete.outcomes.pop();
        incomplete.summary.runs--;
        expect(() => merge([incomplete])).toThrow(/missing one or more expected/);
    });
    it("preserves the complete outcome object and refuses four attempts", () => {
        const input = report();
        const { report: merged } = merge([input]);
        expect(JSON.stringify(merged.outcomes)).toBe(JSON.stringify(input.outcomes));
        expect(() => merge([errorPair(report()), report(), report(), report()])).toThrow(/one to three/);
    });
    it("refuses overwrite and creates output mode 0600", () => {
        const dir = tempDir();
        const output = join(dir, "merged.json");
        merge([report()], output);
        expect(statSync(output).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(output, "utf8")).outcomes).toHaveLength(4);
        expect(() => merge([report()], output)).toThrow(/refusing to overwrite/);
    });
});
