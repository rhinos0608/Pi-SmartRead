import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildMatrix, classifyContribution, compareCohort, type MatrixSpec } from "../../../scripts/eval/judge/variant-matrix.js";

function internalReport(qids: string[], vals: Record<string, { fileHit: boolean; readReady?: boolean }>): object {
    return {
        manifest: {
            fixtureSha: "f",
            inventoryHashBefore: "c",
            sourceRef: "r",
            corpusKind: "k",
            gateConstants: { keep: 0.4 },
            retrievalConditions: { rankTestDemote: 0.7 },
            engineSourceHash: "sha256:abc:1-files",
        },
        queries: qids.map((qid) => ({
            qid,
            fileHit: vals[qid]?.fileHit ?? false,
            ...(vals[qid]?.readReady === undefined ? {} : { readReady: vals[qid]!.readReady }),
            abstained: false,
            renderedTokens: 10,
        })),
    };
}

function externalReport(rows: Array<{ id: string; formulation: string; success: boolean }>): object {
    return {
        rankingKnobs: { rankTestDemote: 0.7 },
        engineSourceHash: null,
        outcomes: rows.map((r) => ({ instanceId: r.id, formulation: r.formulation, successAt5: r.success })),
    };
}

function writeTmp(obj: object): string {
    const dir = mkdtempSync(join(tmpdir(), "vmatrix-"));
    const p = join(dir, "r.json");
    writeFileSync(p, JSON.stringify(obj));
    return p;
}

describe("variant-matrix", () => {
    it("compares cohorts with wins/losses/net/CI and validity", () => {
        const qids = ["q1", "q2", "q3", "q4"];
        const bOff = writeTmp(internalReport(qids, { q1: { fileHit: false }, q2: { fileHit: true }, q3: { fileHit: false }, q4: { fileHit: false } }));
        const vOff = writeTmp(internalReport(qids, { q1: { fileHit: true }, q2: { fileHit: false }, q3: { fileHit: false }, q4: { fileHit: false } }));
        const bT = writeTmp(internalReport(qids, { q1: { fileHit: true }, q2: { fileHit: true }, q3: { fileHit: true }, q4: { fileHit: true } }));
        const vT = writeTmp(internalReport(qids, { q1: { fileHit: true }, q2: { fileHit: true }, q3: { fileHit: true }, q4: { fileHit: true } }));
        const bExt = writeTmp(externalReport([
            { id: "repoA__1", formulation: "title", success: false },
            { id: "repoA__2", formulation: "title", success: true },
            { id: "repoB__3", formulation: "body", success: false },
        ]));
        const vExt = writeTmp(externalReport([
            { id: "repoA__1", formulation: "title", success: true },
            { id: "repoA__2", formulation: "title", success: true },
            { id: "repoB__3", formulation: "body", success: true },
        ]));
        const spec: MatrixSpec = {
            baseline: "base",
            variants: { base: { internalOff: bOff, internalT040: bT, external: bExt }, v: { internalOff: vOff, internalT040: vT, external: vExt } },
            bootstrap: { seed: 7, iterations: 50 },
        };
        const res = buildMatrix(spec);
        expect(res.validity.length).toBe(6);
        expect(res.validity[0]!.engineSourceHash).toBe("sha256:abc:1-files");
        const fh = res.comparisons.find((c) => c.cohort === "internal-off-file-hit")!;
        expect(fh.wins).toEqual(["q1"]);
        expect(fh.losses).toEqual(["q2"]);
        expect(fh.net).toBe(0);
        expect(fh.ci95.lower).toBeLessThanOrEqual(fh.ci95.upper);
        const title = res.comparisons.find((c) => c.cohort === "external-title-success@5")!;
        expect(title.wins).toEqual(["repoA__1"]);
        expect(title.net).toBe(1);
    });

    it("refuses on pair contract mismatch", () => {
        const good = writeTmp(internalReport(["q1"], { q1: { fileHit: true } }));
        const bad = writeTmp({ manifest: { fixtureSha: "other" }, queries: [{ qid: "q1", fileHit: true }] });
        expect(() => buildMatrix({ baseline: "b", variants: { b: { internalOff: good }, v: { internalOff: bad } } }))
            .toThrowError(/refuses-pair:/);
    });

    it("marks replication noise and annotates W/L", () => {
        const qids = ["q1", "q2"];
        const b = writeTmp(internalReport(qids, { q1: { fileHit: false }, q2: { fileHit: false } }));
        const v = writeTmp(internalReport(qids, { q1: { fileHit: true }, q2: { fileHit: false } }));
        const rep = writeTmp(internalReport(qids, { q1: { fileHit: true }, q2: { fileHit: true } }));
        const res = buildMatrix({
            baseline: "b",
            variants: { b: { internalOff: b }, v: { internalOff: v } },
            replicates: { "v-rep1": { internalOff: rep } },
            bootstrap: { seed: 1, iterations: 20 },
        });
        expect(res.noiseProneByCohort["internal-off-file-hit"]).toEqual(["q2"]);
        const comp = res.comparisons.find((c) => c.cohort === "internal-off-file-hit")!;
        expect(comp.annotatedWins).toEqual([{ id: "q1", stability: "stable" }]);
    });

    it("reports missing metrics as unavailable instead of dropping queries", () => {
        const qids = ["q1", "q2"];
        const b = writeTmp(internalReport(qids, { q1: { fileHit: true }, q2: { fileHit: false } }));
        const v = writeTmp(internalReport(qids, { q1: { fileHit: true }, q2: { fileHit: true } }));
        const res = buildMatrix({
            baseline: "b",
            variants: { b: { internalOff: b }, v: { internalOff: v } },
            bootstrap: { seed: 1, iterations: 20 },
        });
        const rr = res.comparisons.find((c) => c.cohort === "internal-off-read-ready")!;
        expect(rr.queryCount).toBe(2);
        expect(rr.unavailable).toBe(2);
        expect(rr.unavailableIds).toEqual(["q1", "q2"]);
        expect(rr.wins).toEqual([]);
        expect(rr.losses).toEqual([]);
        expect(rr.net).toBe(0);
        const fh = res.comparisons.find((c) => c.cohort === "internal-off-file-hit")!;
        expect(fh.queryCount).toBe(2);
        expect(fh.unavailable).toBe(0);
    });

    it("classifies leave-one-out contributions", () => {
        expect(classifyContribution(2, 2)).toBe("additive");
        expect(classifyContribution(5, 2)).toBe("synergistic");
        expect(classifyContribution(-1, 2)).toBe("antagonistic");
        expect(classifyContribution(0, 3)).toBe("antagonistic");
        expect(classifyContribution(1, null)).toBe("unknown-single");
        // End-to-end: bundle vs bundle-minus-x with singles.
        const qids = ["q1", "q2", "q3", "q4", "q5"];
        const mk = (on: string[]): string => writeTmp(internalReport(
            qids, Object.fromEntries(qids.map((q) => [q, { fileHit: on.includes(q) }]))));
        const res = buildMatrix({
            baseline: "base",
            variants: {
                base: { internalOff: mk([]) },
                bundle: { internalOff: mk(["q1", "q2", "q3"]) },
                "bundle-minus-a": { internalOff: mk(["q3"]) },
                singleA: { internalOff: mk(["q1", "q2"]) },
            },
            singles: { a: "singleA" },
            bootstrap: { seed: 1, iterations: 20 },
        });
        const loo = res.leaveOneOut.find((l) => l.knob === "a" && l.cohort === "internal-off-file-hit")!;
        expect(loo.contribution).toBe(2);
        expect(loo.singleNet).toBe(2);
        expect(loo.classification).toBe("additive");
        expect(compareCohort({
            cohort: "c", baseline: "b", variant: "v",
            baseMap: new Map([["q1", false]]), varMap: new Map([["q1", true]]),
            seed: 1, iterations: 10,
        }).net).toBe(1);
    });
});
