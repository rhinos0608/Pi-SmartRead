/**
 * Holdout v3 -> v2 manifest converter tests.
 *
 * Every fixture here is SYNTHETIC and built in a temp dir: the real sealed
 * holdout is never read, converted, or rewritten by this suite (the
 * orchestrator runs the converter on it after validation passes).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
    frozenSplitIds,
    loadFrozenManifest,
} from "../../../scripts/eval/external/grep/frozen-manifest.js";
import {
    RETRIEVAL_HOLDOUT_SEED,
    convertHoldoutV3ToV2,
    writeConvertedManifest,
} from "../../../scripts/holdout-v2/convert-manifest.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CONVERTER_PATH = resolve(REPO_ROOT, "scripts/holdout-v2/convert-manifest.ts");

const ENTRY_IDS = ["case-a", "case-b", "case-c"];
const RESERVE_IDS = ["reserve-x", "reserve-y"];
const EXCLUDED_ID = "case-excluded";

const tempDirs: string[] = [];

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "holdout-v2-convert-"));
    tempDirs.push(dir);
    return dir;
}

afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function hex(text: string | Buffer): string {
    return createHash("sha256").update(text).digest("hex");
}

function makeEntry(id: string): Record<string, unknown> {
    return {
        id,
        repo: id.startsWith("case-a") || id.startsWith("case-b") ? "repo-one" : "repo-two",
        baseCommit: hex(id).slice(0, 40),
        dataset: id === "case-b" ? "multi-swe-bench" : "swe-bench-multilingual",
        language: id === "case-c" ? "js" : "ts",
        goldFiles: [`src/${id}.ts`],
        issueKey: `ACME-${id}`,
        querySha256: hex(`query:${id}`),
        goldSha256: hex(`gold:${id}`),
    };
}

/**
 * Synthetic v3 manifest. `prepare` mutates the body BEFORE the self-sha is
 * computed, so shape violations can be tested independently of integrity;
 * mutations AFTER construction simulate a tampered file (self-sha mismatch).
 */
function makeV3(
    prepare?: (body: Record<string, unknown>) => void,
): Record<string, unknown> {
    const body: Record<string, unknown> = {
        version: 3,
        seed: RETRIEVAL_HOLDOUT_SEED,
        requestedSize: ENTRY_IDS.length,
        createdAt: "2026-10-09T00:00:00.000Z",
        datasets: [
            { name: "SWE-bench/SWE-bench_Multilingual", revision: "synthetic-rev", license: "synthetic-license" },
        ],
        blacklist: { instanceIds: 1, issueKeys: 0, repos: 1, sourceFiles: ["synthetic.json"] },
        entries: ENTRY_IDS.map(makeEntry),
        reserve: RESERVE_IDS.map(makeEntry),
        exclusions: [
            { instanceId: EXCLUDED_ID, stage: "census", reason: "synthetic-exclusion" },
        ],
    };
    prepare?.(body);
    const sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    return { ...body, sha256 };
}

describe("convertHoldoutV3ToV2 round-trip", () => {
    it("is accepted by the real loadFrozenManifest and returns v3-order ids", () => {
        const { v2, report } = convertHoldoutV3ToV2(JSON.stringify(makeV3(), null, 2));
        expect(v2.version).toBe(2);
        expect(v2.dev).toEqual([]);
        expect(v2.holdout.map((h) => h.id)).toEqual(ENTRY_IDS);
        expect(report.entryCount).toBe(ENTRY_IDS.length);
        expect(report.reserveCount).toBe(RESERVE_IDS.length);
        expect(report.droppedV3EntryFields).toEqual([
            "issueKey",
            "querySha256",
            "goldSha256",
        ]);

        const outPath = join(tempDir(), "converted.json");
        writeConvertedManifest(v2, outPath);
        const loaded = loadFrozenManifest(outPath);
        expect(loaded.version).toBe(2);
        const { ids, holdoutWarning } = frozenSplitIds(loaded, "holdout", { openHoldout: true });
        expect(ids).toEqual(ENTRY_IDS);
        expect(holdoutWarning).toContain("single-use");
        expect(frozenSplitIds(loaded, "dev", { openHoldout: true }).ids).toEqual([]);
        expect(() => frozenSplitIds(loaded, "holdout", { openHoldout: false })).toThrow(
            /refuses-holdout/,
        );
    });

    it("maps entry fields field-for-field (v3 order preserved, no sort)", () => {
        const v3 = makeV3();
        const sourceEntries = v3.entries as Array<Record<string, unknown>>;
        const { v2 } = convertHoldoutV3ToV2(JSON.stringify(v3));
        for (const [i, entry] of sourceEntries.entries()) {
            const mapped = v2.holdout[i];
            expect(mapped).toBeDefined();
            expect(mapped!.id).toBe(entry.id);
            expect(mapped!.repo).toBe(entry.repo);
            expect(mapped!.baseCommit).toBe(entry.baseCommit);
            expect(mapped!.dataset).toBe(entry.dataset);
            expect(mapped!.language).toBe(entry.language);
            expect(mapped!.goldFiles).toEqual(entry.goldFiles);
        }
        expect(v2.holdout[1]!.dataset).toBe("multi-swe-bench");
        expect(v2.holdout[2]!.language).toBe("js");
        expect(v2.seed).toBe(RETRIEVAL_HOLDOUT_SEED);
        expect(v2.datasets).toEqual([
            { name: "SWE-bench/SWE-bench_Multilingual", revision: "synthetic-rev", license: "synthetic-license" },
        ]);
        expect(v2.exclusions[0]!.instanceId).toBe(EXCLUDED_ID);
    });

    it("records source-file, internal, and converter sha256 in the v2 free-text note", () => {
        const text = JSON.stringify(makeV3(), null, 2);
        const { v2, report } = convertHoldoutV3ToV2(text);
        expect(report.sourceFileSha256).toBe(hex(text));
        expect(report.v3InternalSha256).toBe(makeV3().sha256);
        expect(report.converterSha256).toBe(hex(readFileSync(CONVERTER_PATH)));
        expect(v2.holdoutRepoNote).toContain(report.sourceFileSha256);
        expect(v2.holdoutRepoNote).toContain(report.v3InternalSha256);
        expect(v2.holdoutRepoNote).toContain(report.converterSha256);
        expect(v2.holdoutRepoNote).toContain("reserve=2 excluded");
        // The note must not leak ids either.
        for (const id of [...ENTRY_IDS, ...RESERVE_IDS, EXCLUDED_ID]) {
            expect(v2.holdoutRepoNote).not.toContain(id);
        }
    });
});

describe("convertHoldoutV3ToV2 fails closed", () => {
    it("rejects a self-sha mismatch (tampered entry)", () => {
        const tampered = makeV3();
        const entries = tampered.entries as Array<Record<string, unknown>>;
        entries[0]!.baseCommit = "deadbeef".repeat(5);
        expect(() => convertHoldoutV3ToV2(JSON.stringify(tampered))).toThrow(/integrity mismatch/);
    });

    it("rejects the wrong version", () => {
        const wrong = makeV3((body) => {
            body.version = 2;
        });
        expect(() => convertHoldoutV3ToV2(JSON.stringify(wrong))).toThrow(/version mismatch/);
    });

    it("rejects a wrong seed", () => {
        const wrong = makeV3((body) => {
            body.seed = "some-other-seed";
        });
        expect(() => convertHoldoutV3ToV2(JSON.stringify(wrong))).toThrow(/seed mismatch/);
    });

    it("rejects a missing run.ts-required entry field (internally consistent)", () => {
        const missing = makeV3((body) => {
            const entries = body.entries as Array<Record<string, unknown>>;
            delete entries[0]!.baseCommit;
        });
        expect(() => convertHoldoutV3ToV2(JSON.stringify(missing))).toThrow(/baseCommit/);
    });

    it("rejects an unknown entry field instead of guessing a mapping", () => {
        const unknownField = makeV3((body) => {
            const entries = body.entries as Array<Record<string, unknown>>;
            entries[0]!.unexpected = "x";
        });
        expect(() => convertHoldoutV3ToV2(JSON.stringify(unknownField))).toThrow(
            /no v2 counterpart; refusing to guess/,
        );
    });

    it("rejects a missing field in a reserve entry too", () => {
        const missing = makeV3((body) => {
            const reserve = body.reserve as Array<Record<string, unknown>>;
            delete reserve[0]!.dataset;
        });
        expect(() => convertHoldoutV3ToV2(JSON.stringify(missing))).toThrow(/dataset/);
    });

    it("rejects unparseable input", () => {
        expect(() => convertHoldoutV3ToV2("{not json")).toThrow(/unparseable/);
    });

    it("rejects an invalid language label", () => {
        const bad = makeV3((body) => {
            const entries = body.entries as Array<Record<string, unknown>>;
            entries[0]!.language = "python";
        });
        expect(() => convertHoldoutV3ToV2(JSON.stringify(bad))).toThrow(/language/);
    });

    it("rejects an unknown top-level key even when the self-sha is valid", () => {
        const extra = makeV3((body) => {
            body.selectionPolicy = "stratified";
        });
        expect(() => convertHoldoutV3ToV2(JSON.stringify(extra))).toThrow(/unknown top-level key selectionPolicy/);
    });

    it("rejects a blacklist missing a schema field", () => {
        const bad = makeV3((body) => {
            delete (body.blacklist as Record<string, unknown>).sourceFiles;
        });
        expect(() => convertHoldoutV3ToV2(JSON.stringify(bad))).toThrow(/missing blacklist key sourceFiles/);
    });

    it("rejects a blacklist with a non-integer count", () => {
        const bad = makeV3((body) => {
            (body.blacklist as Record<string, unknown>).repos = "1";
        });
        expect(() => convertHoldoutV3ToV2(JSON.stringify(bad))).toThrow(/blacklist.repos/);
    });
});

describe("writeConvertedManifest", () => {
    it("refuses to overwrite and writes mode 0600", () => {
        const { v2 } = convertHoldoutV3ToV2(JSON.stringify(makeV3()));
        const outPath = join(tempDir(), "converted.json");
        const written = writeConvertedManifest(v2, outPath);
        expect(written.outPath).toBe(outPath);
        expect(written.fileSha256).toBe(hex(readFileSync(outPath)));
        expect(statSync(outPath).mode & 0o777).toBe(0o600);
        expect(() => writeConvertedManifest(v2, outPath)).toThrow(/refusing to overwrite/);
    });
});

describe("excludes reserves (prereg allows no reserve substitution)", () => {
    it("carries only the selected entries into the v2 holdout", () => {
        const { v2, report } = convertHoldoutV3ToV2(JSON.stringify(makeV3()));
        const serialized = JSON.stringify(v2);
        for (const id of RESERVE_IDS) {
            expect(serialized).not.toContain(id);
        }
        expect(v2.holdout).toHaveLength(ENTRY_IDS.length);
        expect(v2.holdout.map((h) => h.id)).toEqual(ENTRY_IDS);
        expect(report.reserveCount).toBe(RESERVE_IDS.length);
        expect(report.perRepo).toEqual([
            { repo: "repo-one", count: 2 },
            { repo: "repo-two", count: 1 },
        ]);
    });
});

describe("CLI", () => {
    function runCli(inPath: string, outPath: string): string {
        return execFileSync(
            process.execPath,
            ["--import", "tsx", CONVERTER_PATH, "--in", inPath, "--out", outPath],
            { cwd: REPO_ROOT, encoding: "utf8" },
        );
    }

    it("converts, prints only the allowed lines, and refuses a second run", () => {
        const dir = tempDir();
        const inPath = join(dir, "v3.json");
        const outPath = join(dir, "converted.json");
        writeFileSync(inPath, JSON.stringify(makeV3(), null, 2), { mode: 0o600 });

        const stdout = runCli(inPath, outPath);
        const lines = stdout.trim().split("\n");
        expect(lines).toHaveLength(4);
        expect(lines[0]).toBe(`out: ${outPath}`);
        expect(lines[1]).toMatch(/^sha256: [0-9a-f]{64}$/);
        expect(lines[2]).toBe(`entries: ${ENTRY_IDS.length}`);
        expect(lines[3]).toBe("per-repo: repo-one=2 repo-two=1");
        // Never instance ids, issue keys, gold, or patches on stdout.
        for (const id of [...ENTRY_IDS, ...RESERVE_IDS, EXCLUDED_ID]) {
            expect(stdout).not.toContain(id);
        }
        expect(stdout).not.toContain("ACME-");
        expect(stdout).not.toContain("src/");
        expect(existsSync(outPath)).toBe(true);
        expect(statSync(outPath).mode & 0o777).toBe(0o600);
        expect(loadFrozenManifest(outPath).holdout).toHaveLength(ENTRY_IDS.length);

        expect(() => runCli(inPath, outPath)).toThrow();
        expect(loadFrozenManifest(outPath).holdout).toHaveLength(ENTRY_IDS.length);
    });
});
