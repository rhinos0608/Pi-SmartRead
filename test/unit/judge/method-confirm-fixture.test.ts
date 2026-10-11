import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    CONFIRM_EXPECTED_ABSENCE,
    CONFIRM_EXPECTED_ANSWERABLE,
    CONFIRM_EXPECTED_QUERY_COUNT,
    CONFIRM_MANIFEST_SIDECAR_FILE,
    CONFIRM_PRIOR_QUERY_GROUP_COUNT,
    CONFIRM_REQUIRED_ARTIFACT_PATHS,
    __test__confirmManifestSidecar,
    __test__sealConfirmCorpusFromRoot,
    assignConfirmNeutralCandidateIds,
    confirmCandidateOrderKey,
    confirmNeutralCandidateId,
    isVerifiedConfirmCorpusRoster,
    isValidConfirmSourcePath,
    loadConfirmPriorQueryGroups,
    loadVerifiedConfirmCorpus,
    materializeConfirmPinnedRange,
    orderConfirmCandidates,
    parseConfirmAllocation,
    sealConfirmCorpusFromRoot,
    verifyConfirmFinalAcceptance,
    type ConfirmAbsenceAudit,
    type ConfirmCandidateDossier,
    type ConfirmCorpusRoster,
    type ConfirmDisjointnessRow,
    type ConfirmFixtureRow,
    type ConfirmQueryDossier,
    type ConfirmSource,
    type ConfirmSourceSnapshotRow,
} from "../../../scripts/eval/judge/method-confirm-fixture.js";
import {
    PILOT_MANIFEST_SIDECAR_FILE,
    PILOT_SOURCE_REF,
    loadFrozenPilotQueries,
    materializePinnedRange,
    neutralCandidateId,
    serializePilotJsonl,
    type PilotAdjudication,
    type PilotLabel,
    type PilotLabeler,
    type PilotLabelerAssessment,
} from "../../../scripts/eval/judge/method-pilot-fixture.js";
import { PLAN_DATA_DIR } from "../../../scripts/eval/judge/model-comparison-plan.js";
import { defaultPilotRoot } from "../../../scripts/eval/judge/method-pilot.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Every seal and load runs the 84-group prior disjointness check (frozen 44
 * + sealed 40-query pilot), which fails closed when either corpus is
 * unavailable. Success-path seal/load tests are gated on both fixtures
 * being present — the same gating pattern the pilot tests use.
 */
const FROZEN_CORPUS_AVAILABLE = existsSync(join(PLAN_DATA_DIR, "set-a.jsonl"))
    && existsSync(join(PLAN_DATA_DIR, "set-b.jsonl"));
const SEALED_PILOT_ROOT = defaultPilotRoot();
const SEALED_PILOT_AVAILABLE = existsSync(join(SEALED_PILOT_ROOT, PILOT_MANIFEST_SIDECAR_FILE))
    && existsSync(join(SEALED_PILOT_ROOT, "pilot-queries.jsonl"));
const priorIt = it.runIf(FROZEN_CORPUS_AVAILABLE && SEALED_PILOT_AVAILABLE);

/** Byte-equality proof against the pilot materializer needs the frozen pin's tree in this clone. */
function commitHasFile(file: string): boolean {
    try {
        execFileSync("git", ["-C", REPO_ROOT, "cat-file", "-e", `${PILOT_SOURCE_REF}:${file}`], { stdio: ["ignore", "ignore", "ignore"] });
        return true;
    } catch {
        return false;
    }
}
const FROZEN_PIN_AVAILABLE = commitHasFile("src/index.ts");
const FROZEN_PIN_GIT_DIR = FROZEN_PIN_AVAILABLE
    ? execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim()
    : "";
const frozenPinIt = it.runIf(FROZEN_PIN_AVAILABLE);

/* ──────────────────────────────────────────────────────────────────────
 * Tiny local git sources for materialization tests (two repos, one with
 * two pins — multi-source, multi-pin, offline).
 * ──────────────────────────────────────────────────────────────────── */

function numberedLines(count: number, prefix: string): string {
    return Array.from({ length: count }, (_, index) => `// ${prefix} ${String(index + 1).padStart(2, "0")}`).join("\n") + "\n";
}

function runGit(dir: string, ...args: string[]): string {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function commit(dir: string, message: string): string {
    runGit(dir,
        "-c", "user.email=confirm-fixture@example.invalid",
        "-c", "user.name=confirm-fixture",
        "-c", "commit.gpgsign=false",
        "commit", "-m", message);
    return runGit(dir, "rev-parse", "HEAD").trim();
}

interface FixtureSources {
    aDir: string;
    aGitDir: string;
    aPin1: string;
    aPin2: string;
    bDir: string;
    bGitDir: string;
    bPin3: string;
    sources: ConfirmSource[];
}

function makeFixtureSources(): FixtureSources {
    const aDir = realpathSync(mkdtempSync(join(tmpdir(), "method-confirm-source-a-")));
    runGit(aDir, "init");
    mkdirSync(join(aDir, "src"), { recursive: true });
    mkdirSync(join(aDir, "docs"), { recursive: true });
    writeFileSync(join(aDir, "src", "example.ts"), numberedLines(40, "source line"));
    writeFileSync(
        join(aDir, "src", "big.ts"),
        Array.from({ length: 150 }, (_, index) => `// big line ${index + 1}`).join("\n") + "\n",
    );
    writeFileSync(
        join(aDir, "src", "long.ts"),
        Array.from({ length: 10 }, (_, index) => `// ${String(index + 1).padStart(2, "0")} ${"x".repeat(480)}`).join("\n") + "\n",
    );
    writeFileSync(
        join(aDir, "docs", "notes.md"),
        Array.from({ length: 30 }, (_, index) => `# note ${String(index + 1).padStart(2, "0")}`).join("\n") + "\n",
    );
    runGit(aDir, "add", ".");
    const aPin1 = commit(aDir, "fixture pin 1");
    const examplePath = join(aDir, "src", "example.ts");
    const lines = readFileSync(examplePath, "utf8").split("\n");
    lines[19] = "// source line 20 (revised)";
    writeFileSync(examplePath, lines.join("\n"));
    runGit(aDir, "add", ".");
    const aPin2 = commit(aDir, "fixture pin 2");
    const aGitDir = runGit(aDir, "rev-parse", "--absolute-git-dir").trim();

    const bDir = realpathSync(mkdtempSync(join(tmpdir(), "method-confirm-source-b-")));
    runGit(bDir, "init");
    mkdirSync(join(bDir, "src"), { recursive: true });
    mkdirSync(join(bDir, "lib"), { recursive: true });
    writeFileSync(join(bDir, "src", "example.ts"), numberedLines(40, "b-source line"));
    writeFileSync(join(bDir, "lib", "extra.ts"), numberedLines(20, "extra line"));
    runGit(bDir, "add", ".");
    const bPin3 = commit(bDir, "fixture pin 3");
    const bGitDir = runGit(bDir, "rev-parse", "--absolute-git-dir").trim();

    return {
        aDir, aGitDir, aPin1, aPin2,
        bDir, bGitDir, bPin3,
        sources: [
            { repo: "alpha", gitDir: aGitDir, pin: aPin1, license: "MIT" },
            { repo: "alpha", gitDir: aGitDir, pin: aPin2, license: "MIT" },
            { repo: "beta", gitDir: bGitDir, pin: bPin3, license: "Apache-2.0" },
        ],
    };
}

let fixture: FixtureSources;
const tempRoots: string[] = [];

beforeAll(() => {
    fixture = makeFixtureSources();
}, 45_000);

afterAll(() => {
    if (fixture) {
        rmSync(fixture.aDir, { recursive: true, force: true });
        rmSync(fixture.bDir, { recursive: true, force: true });
    }
    for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function materialize(
    source: { gitDir: string; pin: string },
    file: string,
    startLine: number,
    endLine: number,
    symbol: string | null = null,
): string {
    return materializeConfirmPinnedRange({ gitDir: source.gitDir, pin: source.pin, file, startLine, endLine, symbol });
}

/* ──────────────────────────────────────────────────────────────────────
 * Path rule (explicit lockfile/vendored/minified/generated exclusions)
 * ──────────────────────────────────────────────────────────────────── */

describe("confirm path rule: any tracked file except lockfiles, vendored, minified, generated", () => {
    it("accepts ordinary repository-relative paths of any top-level directory", () => {
        for (const file of [
            "src/index.ts",
            "test/unit/x.spec.ts",
            "docs/adr/design.md",
            "lib/extra.ts",
            "scripts/build.ts",
            "packages/core/src/a.ts",
            // Tracked declaration files are hand-authored public API.
            "index.d.ts",
            "index.d.cts",
            "packages/svelte/src/store/public.d.ts",
        ]) {
            expect(isValidConfirmSourcePath(file), file).toBe(true);
        }
    });

    it("refuses lockfiles, vendored trees, minified artifacts, and generated shapes", () => {
        for (const file of [
            "package-lock.json",
            "backend/yarn.lock",
            "Cargo.lock",
            "node_modules/lodash/index.js",
            "vendor/lib/util.js",
            "third_party/zlib/stream.c",
            "dist/app.min.js",
            "src/app.bundle.css",
            "__generated__/schema.ts",
            "api/types.gen.ts",
            "api/service.pb.go",
            "proto/gen/x_pb2.py",
            "src/app.js.map",
        ]) {
            expect(isValidConfirmSourcePath(file), file).toBe(false);
        }
    });

    it("refuses absolute paths, traversal, and empty segments", () => {
        for (const file of ["../escape.ts", "/abs/file.ts", "C:\\win\\file.ts", "src//x.ts", "src/./x.ts", "src/a/../b.ts", ""]) {
            expect(isValidConfirmSourcePath(file), file).toBe(false);
        }
    });
});

describe("confirm SOURCES registry: owner/name repo ids and the planner's allocation shape", () => {
    const pin = "a".repeat(40);
    const entry = { repo: "axios/axios", gitDir: "/abs/axios.git", pin, license: "LICENSE" };

    it("accepts owner/name repo ids in candidate keys and refuses traversal-like ids", () => {
        const base = { qid: "C-x-01", pin, file: "lib/core/Axios.js", startLine: 1, endLine: 2 };
        for (const repo of ["Pi-SmartRead", "axios/axios", "mrdoob/three.js", "facebook/docusaurus"]) {
            expect(() => confirmCandidateOrderKey({ ...base, repo }), repo).not.toThrow();
        }
        for (const repo of ["a/b/c", "/axios", "axios/", "axios//axios", "../axios", "axios/..", "a|b", "a:b", "a\\b", ".hidden"]) {
            expect(() => confirmCandidateOrderKey({ ...base, repo }), repo).toThrow(/invalid repo/);
        }
    });

    it("parses the planner's allocation.json shape and projects sources to the four sealed fields", () => {
        const allocation = {
            version: 1,
            createdAt: "2026-10-09T00:19:53Z",
            composition: { total: 400, answerable: 320, absence: 80 },
            sources: [{ ...entry, pinCommitTime: 1722528927, sizeFiles: 242 }],
            slices: [{ slice: "axios-01", repo: "axios/axios" }],
        };
        expect(parseConfirmAllocation(JSON.stringify(allocation))).toEqual([entry]);
        expect(parseConfirmAllocation(JSON.stringify({ sources: [entry] }))).toEqual([entry]);
    });

    it("still refuses unknown keys, bad metadata types, and duplicate (repo, pin) pairs", () => {
        expect(() => parseConfirmAllocation(JSON.stringify({ sources: [entry], extra: 1 }))).toThrow();
        expect(() => parseConfirmAllocation(JSON.stringify({ sources: [{ ...entry, notes: "x" }] }))).toThrow();
        expect(() => parseConfirmAllocation(JSON.stringify({ sources: [{ ...entry, sizeFiles: "242" }] }))).toThrow();
        expect(() => parseConfirmAllocation(JSON.stringify({ sources: [entry, { ...entry }] }))).toThrow();
        expect(() => parseConfirmAllocation(JSON.stringify({ sources: [{ ...entry, gitDir: "relative.git" }] }))).toThrow();
    });

    it("refuses tracked symlinks at materialization (git show would print the link target)", () => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "method-confirm-symlink-")));
        tempRoots.push(dir);
        runGit(dir, "init");
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "real.ts"), numberedLines(10, "real line"));
        symlinkSync("real.ts", join(dir, "src", "link.ts"));
        runGit(dir, "add", ".");
        const pin = commit(dir, "symlink pin");
        const gitDir = runGit(dir, "rev-parse", "--absolute-git-dir").trim();
        expect(materialize({ gitDir, pin }, "src/real.ts", 1, 2)).toContain("1|// real line 01");
        expect(() => materialize({ gitDir, pin }, "src/link.ts", 1, 1)).toThrow(/non-regular pinned file/);
        expect(() => materialize({ gitDir, pin }, "src/missing.ts", 1, 1)).toThrow(/git show failed for/);
    });
});

/* ──────────────────────────────────────────────────────────────────────
 * Multi-source pinned materialization (offline git)
 * ──────────────────────────────────────────────────────────────────── */

describe("multi-source pinned materialization (two repos, one with two pins)", () => {
    it("materializes with the frozen line-prefix and header convention at each pin", () => {
        const source = { gitDir: fixture.aGitDir, pin: fixture.aPin1 };
        expect(materialize(source, "src/example.ts", 3, 7)).toBe(
            "src/example.ts:3-7\n3|// source line 03\n4|// source line 04\n5|// source line 05\n6|// source line 06\n7|// source line 07",
        );
        expect(materialize(source, "src/example.ts", 3, 7, "blockNote")).toContain("src/example.ts:3-7 blockNote\n3|// source line 03");
    });

    it("reads each pin of the same repository independently and the second repository on its own pin", () => {
        const atPin1 = materialize({ gitDir: fixture.aGitDir, pin: fixture.aPin1 }, "src/example.ts", 18, 22);
        const atPin2 = materialize({ gitDir: fixture.aGitDir, pin: fixture.aPin2 }, "src/example.ts", 18, 22);
        expect(atPin1).toContain("20|// source line 20");
        expect(atPin2).toContain("20|// source line 20 (revised)");
        expect(atPin1).not.toBe(atPin2);
        expect(materialize({ gitDir: fixture.bGitDir, pin: fixture.bPin3 }, "src/example.ts", 1, 2))
            .toContain("1|// b-source line 01");
        expect(materialize({ gitDir: fixture.bGitDir, pin: fixture.bPin3 }, "lib/extra.ts", 1, 2))
            .toContain("1|// extra line 01");
    });

    it("fails closed for paths not tracked at the pin and for excluded or malformed inputs", () => {
        // repo beta never tracked docs/notes.md: git show fails at the pin.
        expect(() => materialize({ gitDir: fixture.bGitDir, pin: fixture.bPin3 }, "docs/notes.md", 1, 3))
            .toThrow(/git show failed for/);
        // Excluded shapes are refused before git runs.
        expect(() => materialize({ gitDir: fixture.aGitDir, pin: fixture.aPin1 }, "package-lock.json", 1, 3))
            .toThrow(/Refusing non-source eval path/);
        expect(() => materialize({ gitDir: fixture.aGitDir, pin: "HEAD" }, "src/example.ts", 1, 3))
            .toThrow(/Refusing non-SHA pin/);
        expect(() => materialize({ gitDir: "", pin: fixture.aPin1 }, "src/example.ts", 1, 3))
            .toThrow(/requires the source gitDir/);
    });

    it("enforces the shared 120-line rule and the 3,500-char excerpt cap", () => {
        const source = { gitDir: fixture.aGitDir, pin: fixture.aPin1 };
        expect(() => materialize(source, "src/example.ts", 1, 121)).toThrow(/Invalid pinned source range/);
        expect(() => materialize(source, "src/big.ts", 1, 121)).toThrow(/Invalid pinned source range/);
        expect(() => materialize(source, "src/example.ts", 35, 45)).toThrow(/Invalid pinned source range/);
        const long = materialize(source, "src/long.ts", 1, 10);
        expect(long.length).toBe(3500);
    });
});

frozenPinIt("byte-equals the pilot materializer for the Pi-SmartRead source at the frozen pin", () => {
    const cases: Array<{ startLine: number; endLine: number; symbol: string | null }> = [
        { startLine: 1, endLine: 12, symbol: null },
        { startLine: 5, endLine: 20, symbol: "componentProbe" },
    ];
    for (const range of cases) {
        const pilot = materializePinnedRange({
            repoDir: REPO_ROOT,
            file: "src/index.ts",
            startLine: range.startLine,
            endLine: range.endLine,
            symbol: range.symbol,
            testOnlyRefOverride: PILOT_SOURCE_REF,
        });
        const confirm = materializeConfirmPinnedRange({
            gitDir: FROZEN_PIN_GIT_DIR,
            pin: PILOT_SOURCE_REF,
            file: "src/index.ts",
            startLine: range.startLine,
            endLine: range.endLine,
            symbol: range.symbol,
        });
        expect(confirm).toBe(pilot);
    }
});

/* ──────────────────────────────────────────────────────────────────────
 * Neutral ids: repo+pin in the hash key, label-independent ordering
 * ──────────────────────────────────────────────────────────────────── */

describe("neutral candidate ids and label-independent ordering", () => {
    const alphaPin1 = { repo: "alpha", qid: "Q0001", file: "src/example.ts", startLine: 1, endLine: 5 };

    it("embeds repo+pin so cross-source candidates with identical qid/file/range never collide", () => {
        const atPin1 = { ...alphaPin1, pin: "a".repeat(40) };
        const atPin2 = { ...alphaPin1, pin: "b".repeat(40) };
        const [one, two] = assignConfirmNeutralCandidateIds([atPin1, atPin2]);
        expect(one!.cid).not.toBe(two!.cid);
        // The pilot's repo-free id would collide on exactly this input:
        expect(neutralCandidateId(atPin1)).toBe(neutralCandidateId(atPin2));
        expect(confirmCandidateOrderKey(atPin1)).toBe(`alpha|${"a".repeat(40)}|Q0001|src/example.ts|1-5`);
    });

    it("refuses duplicate full keys and orders deterministically regardless of input order", () => {
        const atPin1 = { ...alphaPin1, pin: "a".repeat(40) };
        expect(() => assignConfirmNeutralCandidateIds([atPin1, atPin1])).toThrow(/duplicate candidate key/);
        const entries = [
            { ...atPin1, qid: "Q0003", file: "docs/notes.md", startLine: 2, endLine: 6 },
            { ...atPin1, qid: "Q0001" },
            { ...atPin1, qid: "Q0002", startLine: 3, endLine: 8 },
        ];
        const canonical = orderConfirmCandidates(assignConfirmNeutralCandidateIds(entries)).map((entry) => entry.cid);
        const shuffled = [entries[1]!, entries[2]!, entries[0]!];
        expect(orderConfirmCandidates(assignConfirmNeutralCandidateIds(shuffled)).map((entry) => entry.cid)).toEqual(canonical);
        // Ordering never sees labels: only repo|pin|qid|file|range enter the key.
        expect(canonical).toEqual([...canonical].sort());
    });
});

/* ──────────────────────────────────────────────────────────────────────
 * Sealed SOURCES registry (allocation.json)
 * ──────────────────────────────────────────────────────────────────── */

describe("sealed SOURCES registry (allocation.json)", () => {
    it("parses a multi-repo, multi-pin allocation with exact entry shapes", () => {
        const bytes = `${JSON.stringify({ sources: fixture.sources }, null, 2)}\n`;
        expect(parseConfirmAllocation(bytes)).toEqual(fixture.sources);
    });

    it("fails closed on foreign keys, duplicate (repo,pin), non-SHA pins, relative gitDirs, and blank licenses", () => {
        const good = fixture.sources[0]!;
        const rejected: unknown[] = [
            { sources: [...fixture.sources, { ...good, extra: true }] },
            { sources: [good, { ...good }] },
            { sources: [{ ...good, pin: "main" }] },
            { sources: [{ ...good, gitDir: "relative/repo.git" }] },
            { sources: [{ ...good, license: "   " }] },
            { sources: [] },
            { sources: [good], extra: [] },
        ];
        for (const value of rejected) {
            expect(() => parseConfirmAllocation(JSON.stringify(value))).toThrow(/must be \{sources/);
        }
        expect(() => parseConfirmAllocation("not json")).toThrow(/not valid JSON/);
    });
});

/* ──────────────────────────────────────────────────────────────────────
 * Final-acceptance rules under confirm validators (pilot semantics)
 * ──────────────────────────────────────────────────────────────────── */

describe("final acceptance keeps the pilot's label, adjudication, and absence rules", () => {
    const pin = "c".repeat(40);

    function acceptanceInputs(overrides: {
        answerableLabel?: PilotLabel;
        absenceLabel?: PilotLabel;
        absenceAudits?: ConfirmAbsenceAudit[];
    } = {}) {
        const queries: ConfirmQueryDossier[] = [
            { qid: "A1", query: "slate quorum probe alpha", repo: "alpha", pin, answerable: true, slice: "confirm", nearestOldQid: "q01", disjointnessNote: "distinct probe" },
            { qid: "B1", query: "phantom quorum probe beta", repo: "alpha", pin, answerable: false, slice: "confirm", nearestOldQid: "q01", disjointnessNote: "distinct absence probe" },
        ];
        const candidates: ConfirmCandidateDossier[] = [
            { qid: "A1", cid: "", repo: "alpha", pin, file: "src/a.ts", startLine: 1, endLine: 5, symbol: null },
            { qid: "B1", cid: "", repo: "alpha", pin, file: "src/b.ts", startLine: 2, endLine: 6, symbol: null },
        ].map((candidate) => ({ ...candidate, cid: confirmNeutralCandidateId(candidate) }));
        const labels: PilotLabel[] = [overrides.answerableLabel ?? "gold", overrides.absenceLabel ?? "hard_negative"];
        const assessments = candidates.flatMap((candidate, index) => (["A", "B"] as PilotLabeler[]).map((labeler) => ({
            cid: candidate.cid,
            labeler,
            label: labels[index]!,
            rationale: `verified from source at ${candidate.file}:${candidate.startLine}-${candidate.endLine}`,
            rangeValid: true,
            ambiguous: false,
        })));
        const adjudications: PilotAdjudication[] = candidates.map((candidate, index) => ({
            cid: candidate.cid,
            label: labels[index]!,
            rationale: `resolved from pinned source at ${candidate.file}:${candidate.startLine}-${candidate.endLine}`,
            reviewedAssessments: [{ labeler: "A", label: labels[index]! }, { labeler: "B", label: labels[index]! }],
        }));
        const absenceAudits: ConfirmAbsenceAudit[] = overrides.absenceAudits ?? [{
            qid: "B1",
            auditor: "auditor-1",
            verdict: "confirmed-absent",
            evidenceCommands: ["git grep -n 'quorum' -- src"],
            rationale: "bounded search of src/b.ts found no phantom quorum ledger",
        }];
        return { queries, candidates, assessments, adjudications, absenceAudits };
    }

    it("accepts an answerable query with gold and an absence query with 0 gold plus its audit", () => {
        const result = verifyConfirmFinalAcceptance(acceptanceInputs());
        expect(result.ok, result.failures.join("; ")).toBe(true);
    });

    it("refuses an answerable query with no gold candidate", () => {
        const result = verifyConfirmFinalAcceptance(acceptanceInputs({ answerableLabel: "hard_negative" }));
        expect(result.failures.some((failure) => failure.includes("answerable query A1 has no gold candidate"))).toBe(true);
    });

    it("refuses an absence query with a gold candidate and one with no absence audit", () => {
        const withGold = verifyConfirmFinalAcceptance(acceptanceInputs({ absenceLabel: "gold" }));
        expect(withGold.failures.some((failure) => failure.includes("absence query B1 has a gold candidate"))).toBe(true);
        const unaudited = verifyConfirmFinalAcceptance(acceptanceInputs({ absenceAudits: [] }));
        expect(unaudited.failures.some((failure) => failure.includes("absence query B1 has no absence audit"))).toBe(true);
    });
});

/* ──────────────────────────────────────────────────────────────────────
 * Honest 400-query corpus builders (materialized once)
 * ──────────────────────────────────────────────────────────────────── */

interface ConfirmFiles {
    "confirm-queries.jsonl": ConfirmQueryDossier[];
    "confirm-candidates.jsonl": ConfirmCandidateDossier[];
    "labels-a.jsonl": PilotLabelerAssessment[];
    "labels-b.jsonl": PilotLabelerAssessment[];
    "adjudications.jsonl": PilotAdjudication[];
    "confirm-absence-audits.jsonl": ConfirmAbsenceAudit[];
    "confirm-disjointness.jsonl": ConfirmDisjointnessRow[];
    "confirm-source-snapshots.jsonl": ConfirmSourceSnapshotRow[];
    "confirm-fixture.jsonl": ConfirmFixtureRow[];
}

/**
 * Synthetic probe wording with vocabulary disjoint from the frozen 44 and
 * the sealed pilot 40 (max token Jaccard stays far below 0.7), unique per
 * query number so within-corpus duplicate detection stays clean.
 */
function confirmProbeText(n: number, answerable: boolean): string {
    const topic = answerable ? "slate quorum dither pass" : "phantom quorum dither absence";
    return `${topic} probe ${n} across the narwhal relaying manifold`;
}

function gitDirOf(entry: { repo: string; pin: string }): string {
    const source = fixture.sources.find((candidate) => candidate.repo === entry.repo && candidate.pin === entry.pin);
    if (source === undefined) throw new Error(`unsealed fixture source ${entry.repo}@${entry.pin}`);
    return source.gitDir;
}

/**
 * Honest confirm corpus over the fixture sources with the sealed
 * composition: 400 queries (320 answerable + 80 absence) round-robin across
 * three sealed (repo, pin) sources — two pins of one repository plus a
 * second repository — one candidate per query (gold for answerable, hard
 * negative for absence), perfect labeler agreement with both classes, a
 * source-cited adjudication for every candidate (covers the agreed-audit
 * sample for any subset), one absence audit per absence query, mirrored
 * disjointness rows, pinned source snapshots in canonical order, and the
 * final fixture.
 */
function buildHonestConfirmFiles(): ConfirmFiles {
    const queries: ConfirmQueryDossier[] = [];
    const disjointness: ConfirmDisjointnessRow[] = [];
    const candidates: ConfirmCandidateDossier[] = [];
    for (let n = 1; n <= CONFIRM_EXPECTED_QUERY_COUNT; n++) {
        const qid = `Q${String(n).padStart(4, "0")}`;
        const answerable = n <= CONFIRM_EXPECTED_ANSWERABLE;
        const source = fixture.sources[n % fixture.sources.length]!;
        const query: ConfirmQueryDossier = {
            qid,
            query: confirmProbeText(n, answerable),
            repo: source.repo,
            pin: source.pin,
            answerable,
            slice: "confirm",
            nearestOldQid: "q01",
            disjointnessNote: "probe vocabulary is disjoint from every frozen and sealed-pilot prior query",
        };
        queries.push(query);
        disjointness.push({ qid, nearestOldQid: query.nearestOldQid, disjointnessNote: query.disjointnessNote });
        const file = source.repo === "alpha" && n % 3 === 1 ? "docs/notes.md" : "src/example.ts";
        const startLine = 1 + (n % 25);
        const entry: Omit<ConfirmCandidateDossier, "cid"> = {
            qid, repo: source.repo, pin: source.pin, file, startLine, endLine: startLine + 4, symbol: null,
        };
        candidates.push({ ...entry, cid: confirmNeutralCandidateId(entry) });
    }
    const canonical = orderConfirmCandidates(candidates);
    const labelOf = (candidate: ConfirmCandidateDossier): PilotLabel =>
        Number(candidate.qid.slice(1)) <= CONFIRM_EXPECTED_ANSWERABLE ? "gold" : "hard_negative";
    const assessment = (candidate: ConfirmCandidateDossier, labeler: PilotLabeler): PilotLabelerAssessment => ({
        cid: candidate.cid,
        labeler,
        label: labelOf(candidate),
        rationale: `verified from source at ${candidate.file}:${candidate.startLine}-${candidate.endLine}`,
        rangeValid: true,
        ambiguous: false,
    });
    const adjudication = (candidate: ConfirmCandidateDossier): PilotAdjudication => {
        const label = labelOf(candidate);
        return {
            cid: candidate.cid,
            label,
            rationale: `resolved from pinned source at ${candidate.file}:${candidate.startLine}-${candidate.endLine}`,
            reviewedAssessments: [{ labeler: "A", label }, { labeler: "B", label }],
        };
    };
    return {
        "confirm-queries.jsonl": queries,
        "confirm-candidates.jsonl": canonical,
        "labels-a.jsonl": canonical.map((candidate) => assessment(candidate, "A")),
        "labels-b.jsonl": canonical.map((candidate) => assessment(candidate, "B")),
        "adjudications.jsonl": canonical.map(adjudication),
        "confirm-absence-audits.jsonl": queries.filter((query) => !query.answerable).map((query) => ({
            qid: query.qid,
            auditor: "auditor-1",
            verdict: "confirmed-absent",
            evidenceCommands: ["git grep -n 'quorum' -- src docs"],
            rationale: `bounded search of src/example.ts and docs/notes.md found no ledger for ${query.qid}`,
        })),
        "confirm-disjointness.jsonl": disjointness,
        "confirm-source-snapshots.jsonl": canonical.map((candidate) => ({
            cid: candidate.cid,
            excerpt: materialize(
                { gitDir: gitDirOf(candidate), pin: candidate.pin },
                candidate.file,
                candidate.startLine,
                candidate.endLine,
                candidate.symbol,
            ),
        })),
        "confirm-fixture.jsonl": canonical.map((candidate) => ({
            cid: candidate.cid,
            qid: candidate.qid,
            repo: candidate.repo,
            pin: candidate.pin,
            file: candidate.file,
            startLine: candidate.startLine,
            endLine: candidate.endLine,
            label: labelOf(candidate),
        })),
    };
}

let honestFiles: ConfirmFiles;

beforeAll(() => {
    honestFiles = buildHonestConfirmFiles();
}, 45_000);

/** Drop one query (and every artifact row that references it or its candidate). */
function filesWithoutQuery(files: ConfirmFiles, qid: string): ConfirmFiles {
    const removedCids = new Set(
        files["confirm-candidates.jsonl"].filter((candidate) => candidate.qid === qid).map((candidate) => candidate.cid),
    );
    return {
        "confirm-queries.jsonl": files["confirm-queries.jsonl"].filter((query) => query.qid !== qid),
        "confirm-candidates.jsonl": files["confirm-candidates.jsonl"].filter((candidate) => candidate.qid !== qid),
        "labels-a.jsonl": files["labels-a.jsonl"].filter((row) => !removedCids.has(row.cid)),
        "labels-b.jsonl": files["labels-b.jsonl"].filter((row) => !removedCids.has(row.cid)),
        "adjudications.jsonl": files["adjudications.jsonl"].filter((row) => !removedCids.has(row.cid)),
        "confirm-absence-audits.jsonl": files["confirm-absence-audits.jsonl"].filter((row) => row.qid !== qid),
        "confirm-disjointness.jsonl": files["confirm-disjointness.jsonl"].filter((row) => row.qid !== qid),
        "confirm-source-snapshots.jsonl": files["confirm-source-snapshots.jsonl"].filter((row) => !removedCids.has(row.cid)),
        "confirm-fixture.jsonl": files["confirm-fixture.jsonl"].filter((row) => !removedCids.has(row.cid)),
    };
}

function allocationBytes(): string {
    return `${JSON.stringify({ sources: fixture.sources }, null, 2)}\n`;
}

function writeConfirmRoot(files: ConfirmFiles): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "method-confirm-seal-")));
    tempRoots.push(root);
    for (const [path, rows] of Object.entries(files)) {
        writeFileSync(join(root, path), path === "allocation.json" ? String(rows) : serializePilotJsonl(rows));
    }
    writeFileSync(join(root, "allocation.json"), allocationBytes());
    return root;
}

function clonedFiles(): ConfirmFiles {
    return structuredClone(honestFiles);
}

/* ──────────────────────────────────────────────────────────────────────
 * Composition refusal (sealed 400 = 320 + 80)
 * ──────────────────────────────────────────────────────────────────── */

describe("sealed composition (400 = 320 answerable + 80 absence)", () => {
    it("exposes a production seal entry that accepts no ref or pin overrides", () => {
        // Pins and gitDirs come only from the root's sealed allocation.json;
        // the function signature carries nothing else.
        expect(sealConfirmCorpusFromRoot.length).toBe(1);
        expect(__test__sealConfirmCorpusFromRoot.length).toBe(1);
    });

    priorIt("refuses a 399-query corpus at the production seal without writing a manifest", () => {
        const root = writeConfirmRoot(filesWithoutQuery(clonedFiles(), "Q0400"));
        expect(() => sealConfirmCorpusFromRoot(root)).toThrow(
            "confirm corpus composition must be exactly 400 queries = 320 answerable + 80 absence; found 399 queries = 320 answerable + 79 absence",
        );
        expect(existsSync(join(root, CONFIRM_MANIFEST_SIDECAR_FILE))).toBe(false);
    });
});

/* ──────────────────────────────────────────────────────────────────────
 * Prior-overlap refusal (all 84 prior groups) + within-corpus duplicates
 * ──────────────────────────────────────────────────────────────────── */

describe("disjointness against all 84 prior query groups", () => {
    it("binds the prior set to exactly 84 unique groups (frozen 44 + sealed pilot 40)", () => {
        expect(CONFIRM_PRIOR_QUERY_GROUP_COUNT).toBe(84);
        if (!(FROZEN_CORPUS_AVAILABLE && SEALED_PILOT_AVAILABLE)) return;
        const prior = loadConfirmPriorQueryGroups();
        expect(prior).toHaveLength(84);
        expect(new Set(prior.map((group) => group.qid)).size).toBe(84);
        expect(prior.filter((group) => group.origin === "frozen")).toHaveLength(44);
        expect(prior.filter((group) => group.origin === "pilot")).toHaveLength(40);
    });

    priorIt("refuses an exact duplicate of a frozen query at the production seal", () => {
        const frozen = loadFrozenPilotQueries();
        const target = frozen.find((query) => query.qid === "q01") ?? frozen[0]!;
        const files = clonedFiles();
        files["confirm-queries.jsonl"] = files["confirm-queries.jsonl"].map((query, index) =>
            index === 0 ? { ...query, query: target.query } : query);
        const root = writeConfirmRoot(files);
        expect(() => sealConfirmCorpusFromRoot(root))
            .toThrow(`query Q0001 exactly duplicates prior frozen query ${target.qid}`);
        expect(existsSync(join(root, CONFIRM_MANIFEST_SIDECAR_FILE))).toBe(false);
    });

    priorIt("refuses an exact duplicate of a sealed pilot query at the production seal", () => {
        const pilotQuery = loadConfirmPriorQueryGroups().find((group) => group.origin === "pilot")!;
        const files = clonedFiles();
        files["confirm-queries.jsonl"] = files["confirm-queries.jsonl"].map((query, index) =>
            index === 0 ? { ...query, query: pilotQuery.query } : query);
        const root = writeConfirmRoot(files);
        expect(() => sealConfirmCorpusFromRoot(root))
            .toThrow(`query Q0001 exactly duplicates prior pilot query ${pilotQuery.qid}`);
        expect(existsSync(join(root, CONFIRM_MANIFEST_SIDECAR_FILE))).toBe(false);
    });

    priorIt("refuses a near-paraphrase of a frozen query at token Jaccard >= 0.7", () => {
        const frozen = loadFrozenPilotQueries();
        const target = frozen.find((query) => query.qid === "q01") ?? frozen[0]!;
        const files = clonedFiles();
        files["confirm-queries.jsonl"] = files["confirm-queries.jsonl"].map((query, index) =>
            index === 0 ? { ...query, query: `${target.query} plus extra` } : query);
        const root = writeConfirmRoot(files);
        expect(() => sealConfirmCorpusFromRoot(root))
            .toThrow(`query Q0001 is a near-paraphrase of prior frozen query ${target.qid}`);
    });

    priorIt("refuses duplicate query text within the confirm corpus (exact and normalized)", () => {
        const exact = clonedFiles();
        exact["confirm-queries.jsonl"] = exact["confirm-queries.jsonl"].map((query, index) =>
            index === 1 ? { ...query, query: exact["confirm-queries.jsonl"][0]!.query } : query);
        const exactRoot = writeConfirmRoot(exact);
        expect(() => sealConfirmCorpusFromRoot(exactRoot))
            .toThrow("confirm corpus contains duplicate query text (exact or normalized) for queries Q0001 and Q0002");

        const normalized = clonedFiles();
        normalized["confirm-queries.jsonl"] = normalized["confirm-queries.jsonl"].map((query, index) =>
            index === 1 ? { ...query, query: normalized["confirm-queries.jsonl"][0]!.query.toUpperCase() } : query);
        const normalizedRoot = writeConfirmRoot(normalized);
        expect(() => sealConfirmCorpusFromRoot(normalizedRoot))
            .toThrow("confirm corpus contains duplicate query text (exact or normalized) for queries Q0001 and Q0002");
    });
});

/* ──────────────────────────────────────────────────────────────────────
 * Excerpt re-materialization tamper
 * ──────────────────────────────────────────────────────────────────── */

describe("excerpt provenance (re-materialization at the sealed source)", () => {
    priorIt("refuses a sealed excerpt that differs from re-materialization, without writing a manifest", () => {
        const files = clonedFiles();
        const [first] = files["confirm-source-snapshots.jsonl"];
        files["confirm-source-snapshots.jsonl"] = [
            { cid: first!.cid, excerpt: `${first!.excerpt}tampered` },
            ...files["confirm-source-snapshots.jsonl"].slice(1),
        ];
        const root = writeConfirmRoot(files);
        expect(() => sealConfirmCorpusFromRoot(root)).toThrow(/excerpt provenance mismatch for candidate/);
        expect(existsSync(join(root, CONFIRM_MANIFEST_SIDECAR_FILE))).toBe(false);
    });
});

/* ──────────────────────────────────────────────────────────────────────
 * Honest corpus: seals and loads
 * ──────────────────────────────────────────────────────────────────── */

describe("an honest multi-source corpus seals and loads", () => {
    priorIt("seals and loads a verified, branded, runtime-frozen roster across two pins of two repos", () => {
        const root = writeConfirmRoot(clonedFiles());
        const sealed = sealConfirmCorpusFromRoot(root);
        expect(sealed.manifest.version).toBe(1);
        expect(sealed.manifest.sources).toEqual([
            { repo: "alpha", pin: fixture.aPin1 },
            { repo: "alpha", pin: fixture.aPin2 },
            { repo: "beta", pin: fixture.bPin3 },
        ].sort((left, right) =>
            left.repo !== right.repo ? (left.repo < right.repo ? -1 : 1) : left.pin < right.pin ? -1 : 1));
        expect(sealed.manifest.artifacts.map((entry) => entry.path).sort())
            .toEqual([...CONFIRM_REQUIRED_ARTIFACT_PATHS].sort());
        expect(sealed.manifest.artifacts.some((entry) => entry.path === "allocation.json")).toBe(true);
        expect(sealed.manifest.ordering.cids).toHaveLength(CONFIRM_EXPECTED_QUERY_COUNT);
        expect(sealed.sidecar).toBe(__test__confirmManifestSidecar(sealed.manifestBytes));
        expect(readFileSync(sealed.manifestPath, "utf8")).toBe(sealed.manifestBytes);
        expect(readFileSync(sealed.sidecarPath, "utf8")).toBe(sealed.sidecar);

        const roster = loadVerifiedConfirmCorpus(root);
        expect(isVerifiedConfirmCorpusRoster(roster)).toBe(true);
        expect(roster.queries).toHaveLength(CONFIRM_EXPECTED_QUERY_COUNT);
        expect(roster.queries.filter((query) => query.answerable)).toHaveLength(CONFIRM_EXPECTED_ANSWERABLE);
        expect(roster.queries.filter((query) => !query.answerable)).toHaveLength(CONFIRM_EXPECTED_ABSENCE);
        expect(roster.candidates).toHaveLength(CONFIRM_EXPECTED_QUERY_COUNT);
        expect(roster.sources.map((source) => `${source.repo}@${source.pin}`)).toEqual([
            `alpha@${fixture.aPin1}`,
            `alpha@${fixture.aPin2}`,
            `beta@${fixture.bPin3}`,
        ]);
        // Every query and candidate carries its source; all three sealed
        // (repo, pin) combinations are exercised.
        expect(new Set(roster.queries.map((query) => `${query.repo}:${query.pin}`)).size).toBe(3);
        expect(roster.candidates.every((candidate) => /^[0-9a-f]{40}$/.test(candidate.pin))).toBe(true);
        const answerableQids = new Set(roster.queries.filter((query) => query.answerable).map((query) => query.qid));
        expect(roster.candidates.every((candidate) =>
            (answerableQids.has(candidate.qid) ? candidate.label === "gold" : candidate.label !== "gold"))).toBe(true);
        expect(roster.candidates.map((candidate) => candidate.cid))
            .toEqual(orderConfirmCandidates(honestFiles["confirm-candidates.jsonl"]).map((candidate) => candidate.cid));
        expect(roster.manifestSha256)
            .toBe(createHash("sha256").update(sealed.manifestBytes, "utf8").digest("hex"));
        expect(Object.isFrozen(roster)).toBe(true);
        expect(Object.isFrozen(roster.queries)).toBe(true);
        expect(Object.isFrozen(roster.queries[0])).toBe(true);
        expect(Object.isFrozen(roster.candidates)).toBe(true);
        expect(Object.isFrozen(roster.candidates[0])).toBe(true);
        expect(Object.isFrozen(roster.sources)).toBe(true);

        // Post-seal artifact tamper is refused at load by exact-byte digests.
        const labelsAPath = join(root, "labels-a.jsonl");
        writeFileSync(labelsAPath, `${readFileSync(labelsAPath, "utf8")} `);
        expect(() => loadVerifiedConfirmCorpus(root)).toThrow("confirm artifact digest mismatch: labels-a.jsonl");
    });

    priorIt("rejects tampered manifest bytes against the sidecar at load", () => {
        const root = writeConfirmRoot(clonedFiles());
        sealConfirmCorpusFromRoot(root);
        const manifestPath = join(root, CONFIRM_MANIFEST_SIDECAR_FILE);
        writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace("{", "{ "));
        expect(() => loadVerifiedConfirmCorpus(root)).toThrow(/sidecar mismatch/);
    });

    priorIt("re-enforces composition at load even when the __test__ seal seam bypasses it", () => {
        const root = writeConfirmRoot(filesWithoutQuery(clonedFiles(), "Q0400"));
        const sealed = __test__sealConfirmCorpusFromRoot(root);
        expect(existsSync(sealed.manifestPath)).toBe(true);
        expect(() => loadVerifiedConfirmCorpus(root))
            .toThrow("found 399 queries = 320 answerable + 79 absence");
    });

    it("refuses a hand-constructed structural roster at the brand check", () => {
        const fake: ConfirmCorpusRoster = { queries: [], candidates: [], sources: [], manifestSha256: "0".repeat(64) };
        expect(isVerifiedConfirmCorpusRoster(fake)).toBe(false);
        expect(isVerifiedConfirmCorpusRoster(null)).toBe(false);
        expect(isVerifiedConfirmCorpusRoster(undefined)).toBe(false);
        expect(isVerifiedConfirmCorpusRoster({})).toBe(false);
    });
});
