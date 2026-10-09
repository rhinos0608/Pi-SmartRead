/**
 * Ranking-knob run identity for grep-e2e (gap A): resolved BM25 ranking
 * knobs must bind the run fingerprint (differently-configured runs never
 * resume together) while paired comparison tolerates them (cross-variant
 * pairing is intended) and surfaces both sides' knobs.
 */
import { describe, expect, it } from "vitest";
import {
    computeRunFingerprint,
    pairReports,
    RANK_SETTING_KEYS,
    toRankReportSettings,
    type PairedReport,
    type RunIdentityInput,
} from "../../../scripts/eval/judge/grep-e2e-contract.js";

function identity(overrides: Partial<RunIdentityInput> = {}): RunIdentityInput {
    return {
        orderedQids: ["q01", "q02"],
        fixtureSha: "aaa",
        corpusInventoryHash: "bbb",
        corpusInventoryFiles: 10,
        corpusKind: "frozen-git-archive-snapshot",
        sourceRef: "18f6463",
        engineSourceHash: "ccc",
        nodeVersion: "v20.0.0",
        modelAlias: "off",
        judgeOrigin: "off",
        gateConstants: { keep: 0.4, pointer: 0.45, exists: 0.35, find: 0.4 },
        appliedKeepOverride: null,
        params: { perQueryLimit: 20, topKWindow: 20, contextLines: 2 },
        timeoutMs: 60000,
        ...overrides,
    };
}

describe("ranking-knob run identity", () => {
    it("exposes the expected flat knob keys", () => {
        expect([...RANK_SETTING_KEYS].sort()).toEqual([
            "rankBm25b",
            "rankBm25k1",
            "rankCoverage",
            "rankFilename",
            "rankStem",
            "rankStopwords",
            "rankTestDemote",
        ]);
    });

    it("maps the product resolver output without re-parsing env", () => {
        expect(toRankReportSettings({
            testDemoteFactor: 0.7,
            filenamePrepend: true,
            bm25k1: 1.2,
            bm25b: 0.75,
            coverageBoost: false,
            stopwords: true,
            stemming: false,
        })).toEqual({
            rankTestDemote: 0.7,
            rankFilename: true,
            rankBm25k1: 1.2,
            rankBm25b: 0.75,
            rankCoverage: false,
            rankStopwords: true,
            rankStem: false,
        });
    });

    it("changes the fingerprint when any ranking knob changes", () => {
        const base = computeRunFingerprint(identity());
        const knobbed = toRankReportSettings({
            testDemoteFactor: 0.7,
            filenamePrepend: false,
            bm25k1: 1.2,
            bm25b: 0.75,
            coverageBoost: false,
            stopwords: false,
            stemming: false,
        });
        expect(computeRunFingerprint(identity({ params: { perQueryLimit: 20, ...knobbed } }))).not.toBe(base);
    });
});

describe("pairReports with ranking knobs", () => {
    const manifest = (overrides: Record<string, unknown> = {}): PairedReport["manifest"] => ({
        fixtureSha: "aaa",
        inventoryHashBefore: "bbb",
        queryCount: 1,
        sourceRef: "abc123",
        corpusKind: "frozen-git-archive-snapshot",
        gateConstants: { keep: 3, pointer: 1, exists: 5, find: 0 },
        retrievalConditions: { perQueryLimit: 40, contextLines: 2 },
        ...overrides,
    });
    const rows: PairedReport["queries"] = [
        { qid: "q01", fileHit: true, covered: true, abstained: false, renderedTokens: 100, readReady: true },
    ];
    const base: PairedReport = {
        manifest: { ...manifest(), engineSourceHash: "sha256:base" },
        queries: rows,
    };

    it("tolerates ranking-knob differences while refusing other retrieval mismatches", () => {
        const knobbed: PairedReport = {
            manifest: {
                ...manifest({
                    retrievalConditions: {
                        perQueryLimit: 40,
                        contextLines: 2,
                        rankTestDemote: 0.7,
                        rankFilename: true,
                        rankBm25k1: 0.9,
                        rankBm25b: 0.5,
                        rankCoverage: true,
                        rankStopwords: true,
                    },
                }),
                engineSourceHash: "sha256:variant",
            },
            queries: rows,
        };
        expect(() => pairReports(base, knobbed)).not.toThrow();
        expect(() => pairReports(base, {
            ...knobbed,
            manifest: manifest({ retrievalConditions: { perQueryLimit: 10, contextLines: 2 } }),
        })).toThrow(/retrieval params/);
    });

    it("surfaces both sides' ranking knobs in the comparison", () => {
        const paired = pairReports(base, base);
        expect(paired.rankingKnobs.baseline).toEqual({});
        const knobbed: PairedReport = {
            manifest: {
                ...manifest({
                    retrievalConditions: { perQueryLimit: 40, contextLines: 2, rankCoverage: true },
                }),
                engineSourceHash: "sha256:variant",
            },
            queries: rows,
        };
        const compared = pairReports(base, knobbed);
        expect(compared.rankingKnobs.baseline).toEqual({});
        expect(compared.rankingKnobs.variant).toEqual({ rankCoverage: true });
    });
});
