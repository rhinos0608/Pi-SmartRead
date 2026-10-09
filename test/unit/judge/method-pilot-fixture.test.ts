import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    FROZEN_FIXTURE_DIGEST,
    FROZEN_QUERY_GROUP_COUNT,
    LABEL_GATE_BINARY_AGREEMENT_MIN,
    NEAR_PARAPHRASE_JACCARD_THRESHOLD,
    PILOT_AUDIT_SAMPLE_SEED,
    PILOT_EXPECTED_ABSENCE,
    PILOT_EXPECTED_ANSWERABLE,
    PILOT_EXPECTED_QUERY_COUNT,
    PILOT_EXCERPT_CHAR_CAP,
    PILOT_MANIFEST_SIDECAR_FILE,
    PILOT_MANIFEST_SIDECAR_PATH,
    PILOT_ORDER_RULE,
    PILOT_REQUIRED_ARTIFACT_PATHS,
    PILOT_SOURCE_REF,
    __test__brandPilotCorpusRoster,
    __test__buildPilotManifest,
    __test__pilotManifestSidecar,
    __test__sealPilotCorpusFromRoot,
    __test__sealPilotManifest,
    __test__serializePilotManifest,
    __test__verifyPilotManifest,
    applyAuthorCidMap,
    assemblePilotDossiers,
    assignNeutralCandidateIds,
    buildAuthorCidMap,
    candidateOrderHash,
    evaluateLabelQualityGates,
    evaluateQueryDisjointness,
    isPilotAbsenceAudit,
    isPilotAdjudication,
    isPilotAuthorCandidateEntry,
    isPilotAuthorCidMapRow,
    isPilotAuthorProposal,
    isPilotCandidateDossier,
    isPilotDisjointnessRow,
    isPilotLabelerAssessment,
    isPilotManifest,
    isPilotQueryDossier,
    isValidPilotLineRange,
    isVerifiedPilotCorpusRoster,
    isValidPilotSourcePath,
    loadFrozenPilotQueries,
    loadVerifiedPilotCorpus,
    materializePinnedRange,
    neutralCandidateId,
    orderCandidates,
    rationaleCitesSourceRange,
    sealPilotCorpusFromRoot,
    selectAgreedAuditSample,
    serializePilotAuthorCidMap,
    serializePilotJsonl,
    tokenSetJaccard,
    normalizeQueryText,
    queryTokenSet,
    verifyFinalAcceptance,
    type PilotAbsenceAudit,
    type PilotAdjudication,
    type PilotAuthorCidMapRow,
    type PilotCandidateDossier,
    type PilotCorpusRoster,
    type PilotDisjointnessRow,
    type PilotFixtureRow,
    type PilotFrozenQuery,
    type PilotLabel,
    type PilotLabeler,
    type PilotLabelerAssessment,
    type PilotQueryDossier,
    type PilotRangeRequest,
    type PilotSourceSnapshotRow,
} from "../../../scripts/eval/judge/method-pilot-fixture.js";
import { PLAN_DATA_DIR } from "../../../scripts/eval/judge/model-comparison-plan.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Every seal and load runs the frozen-44 disjointness check, which fails
 * closed when the frozen corpus files are unreadable. Tests whose success
 * path needs a seal or a load are therefore gated on the fixture being on
 * disk — the same fixture-gating pattern the model-comparison tests use.
 */
const FROZEN_CORPUS_AVAILABLE = existsSync(join(PLAN_DATA_DIR, "set-a.jsonl"))
    && existsSync(join(PLAN_DATA_DIR, "set-b.jsonl"));

const frozenCorpusIt = it.runIf(FROZEN_CORPUS_AVAILABLE);

/* ──────────────────────────────────────────────────────────────────────
 * Tiny local git repo for materialization tests (no network, no real pin).
 * ──────────────────────────────────────────────────────────────────── */

function numberedLines(count: number, prefix: string): string {
    return Array.from({ length: count }, (_, index) => `// ${prefix} ${String(index + 1).padStart(2, "0")}`).join("\n") + "\n";
}

interface FixtureRepo {
    dir: string;
    ref: string;
}

function makeFixtureRepo(): FixtureRepo {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "method-pilot-fixture-")));
    const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    git("init");
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "src", "example.ts"), numberedLines(40, "source line"));
    writeFileSync(join(dir, "test", "example.test.ts"), numberedLines(10, "test line"));
    writeFileSync(
        join(dir, "src", "big.ts"),
        Array.from({ length: 150 }, (_, index) => `// big line ${index + 1}`).join("\n") + "\n",
    );
    writeFileSync(
        join(dir, "src", "long.ts"),
        Array.from({ length: 10 }, (_, index) => `// ${String(index + 1).padStart(2, "0")} ${"x".repeat(480)}`).join("\n") + "\n",
    );
    git("add", ".");
    git(
        "-c", "user.email=pilot-fixture@example.invalid",
        "-c", "user.name=pilot-fixture",
        "-c", "commit.gpgsign=false",
        "commit", "-m", "pilot fixture",
    );
    return { dir, ref: git("rev-parse", "HEAD").trim() };
}

let fixtureRepo: FixtureRepo;

beforeAll(() => {
    fixtureRepo = makeFixtureRepo();
});

afterAll(() => {
    if (fixtureRepo) rmSync(fixtureRepo.dir, { recursive: true, force: true });
});

type SourceRangeFn = (file: string, startLine: number, endLine: number, symbol: string | null) => string;

/**
 * Extract the frozen `sourceRange` convention straight out of run.ts and run
 * it against the fixture repo, so the byte-equality assertion can never drift
 * away from the real source of truth (run.ts does not export it, and its
 * top-level CLI code makes it unimportable).
 */
function frozenRunTsSourceRange(): SourceRangeFn {
    const runTs = readFileSync(join(REPO_ROOT, "scripts/eval/judge/run.ts"), "utf8").replace(/\r\n/g, "\n");
    const start = runTs.indexOf("function sourceRange(");
    const end = runTs.indexOf("\nfunction createJudge(");
    if (start < 0 || end <= start) throw new Error("frozen sourceRange not found in run.ts");
    const typed = runTs.slice(start, end);
    const js = typed.replace(
        "function sourceRange(file: string, startLine: number, endLine: number, symbol: string | null): string",
        "function sourceRange(file, startLine, endLine, symbol)",
    );
    expect(js).toContain("slice(0, 3500)");
    if (js.includes(": string") || js.includes(": number")) {
        throw new Error("unexpected type annotation inside run.ts sourceRange");
    }
    const factory = new Function("execFileSync", "isAbsolute", "SOURCE_REF", "ROOT", `return (${js});`);
    return factory(execFileSync, isAbsolute, fixtureRepo.ref, fixtureRepo.dir) as SourceRangeFn;
}

/* ──────────────────────────────────────────────────────────────────────
 * Corpus builders for acceptance tests
 * ──────────────────────────────────────────────────────────────────── */

function makeQuery(over: Partial<PilotQueryDossier> = {}): PilotQueryDossier {
    return {
        qid: "p001",
        query: "how does the judge batch cache get invalidated",
        answerable: true,
        slice: "judge",
        nearestOldQid: "q01",
        disjointnessNote: "different subsystem and behavior",
        ...over,
    };
}

function makeCandidate(over: Partial<PilotCandidateDossier> = {}): PilotCandidateDossier {
    const base = {
        qid: "p001",
        file: "src/judge/cache.ts",
        startLine: 1,
        endLine: 5,
        symbol: null as string | null,
        ...over,
    };
    const { cid, ...key } = base;
    return { ...key, cid: cid ?? neutralCandidateId(key) };
}

function makeAssessment(
    candidate: PilotCandidateDossier,
    labeler: PilotLabeler,
    label: PilotLabel,
    over: Partial<PilotLabelerAssessment> = {},
): PilotLabelerAssessment {
    return {
        cid: candidate.cid,
        labeler,
        label,
        rationale: `verified from source at ${candidate.file}:${candidate.startLine}-${candidate.endLine}`,
        rangeValid: true,
        ambiguous: false,
        ...over,
    };
}

function makeAdjudication(
    candidate: PilotCandidateDossier,
    label: PilotLabel,
    aLabel: PilotLabel,
    bLabel: PilotLabel,
    over: Partial<PilotAdjudication> = {},
): PilotAdjudication {
    return {
        cid: candidate.cid,
        label,
        rationale: `resolved from pinned source at ${candidate.file}:${candidate.startLine}-${candidate.endLine}`,
        reviewedAssessments: [
            { labeler: "A", label: aLabel },
            { labeler: "B", label: bLabel },
        ],
        ...over,
    };
}

function makeAbsenceAudit(qid: string, over: Partial<PilotAbsenceAudit> = {}): PilotAbsenceAudit {
    return {
        qid,
        auditor: "auditor-1",
        verdict: "confirmed-absent",
        evidenceCommands: ["git grep -n 'cache warmer' -- src/graph src/search"],
        rationale: "bounded search of src/graph and src/search found no persistent cache warmer",
        ...over,
    };
}

interface Corpus {
    queries: PilotQueryDossier[];
    candidates: PilotCandidateDossier[];
    assessments: PilotLabelerAssessment[];
    adjudications: PilotAdjudication[];
    absenceAudits: PilotAbsenceAudit[];
}

const BASE_LABELS: PilotLabel[] = ["gold", "gold", "hard_negative", "easy_negative", "hard_negative", "easy_negative"];

function baseCorpus(): Corpus {
    const queries = [
        makeQuery(),
        makeQuery({ qid: "p002", query: "is there a persistent graph cache warmer", answerable: false, slice: "graph" }),
    ];
    const candidates = [
        makeCandidate({ qid: "p001", file: "src/judge/cache.ts", startLine: 1, endLine: 5 }),
        makeCandidate({ qid: "p001", file: "src/judge/batch.ts", startLine: 10, endLine: 20 }),
        makeCandidate({ qid: "p001", file: "src/judge/caller.ts", startLine: 1, endLine: 8 }),
        makeCandidate({ qid: "p001", file: "test/judge/cache.test.ts", startLine: 2, endLine: 9, symbol: "cacheSuite" }),
        makeCandidate({ qid: "p002", file: "src/graph/warm.ts", startLine: 3, endLine: 12 }),
        makeCandidate({ qid: "p002", file: "src/search/grep.ts", startLine: 5, endLine: 15 }),
    ];
    const assessments = candidates.flatMap((candidate, index) => [
        makeAssessment(candidate, "A", BASE_LABELS[index]!),
        makeAssessment(candidate, "B", BASE_LABELS[index]!),
    ]);
    return { queries, candidates, assessments, adjudications: [], absenceAudits: [makeAbsenceAudit("p002")] };
}

/** baseCorpus plus the agreed-audit adjudication — a corpus that passes final acceptance. */
function acceptedCorpus(): Corpus {
    const corpus = baseCorpus();
    const sample = selectAgreedAuditSample(corpus.candidates.map((candidate) => candidate.cid));
    const auditedIndex = corpus.candidates.findIndex((candidate) => candidate.cid === sample[0]);
    const audited = corpus.candidates[auditedIndex]!;
    const label = BASE_LABELS[auditedIndex]!;
    corpus.adjudications.push(makeAdjudication(audited, label, label, label));
    return corpus;
}

/* ──────────────────────────────────────────────────────────────────────
 * 1. Schemas + fail-closed validators
 * ──────────────────────────────────────────────────────────────────── */

describe("schemas and fail-closed validators", () => {
    it("accepts a complete query dossier and rejects missing or foreign keys", () => {
        expect(isPilotQueryDossier(makeQuery())).toBe(true);
        const { disjointnessNote: _omitted, ...withoutNote } = makeQuery();
        expect(isPilotQueryDossier(withoutNote)).toBe(false);
        expect(isPilotQueryDossier({ ...makeQuery(), label: "gold" })).toBe(false);
        expect(isPilotQueryDossier({ ...makeQuery(), answerable: "yes" })).toBe(false);
        expect(isPilotQueryDossier({ ...makeQuery(), qid: "" })).toBe(false);
        // A note must contain non-whitespace content — `" "` is not an audit note.
        expect(isPilotQueryDossier(makeQuery({ disjointnessNote: "" }))).toBe(false);
        expect(isPilotQueryDossier(makeQuery({ disjointnessNote: "   " }))).toBe(false);
        expect(isPilotQueryDossier(makeQuery({ disjointnessNote: "\t\n" }))).toBe(false);
        expect(isPilotQueryDossier(makeQuery({ disjointnessNote: "  a note with padding  " }))).toBe(true);
    });

    it("accepts a disjointness row only when the audit note is non-blank", () => {
        expect(isPilotDisjointnessRow({ qid: "p001", nearestOldQid: "q01", disjointnessNote: "differs by subsystem" })).toBe(true);
        expect(isPilotDisjointnessRow({ qid: "p001", nearestOldQid: "q01", disjointnessNote: "" })).toBe(false);
        expect(isPilotDisjointnessRow({ qid: "p001", nearestOldQid: "q01", disjointnessNote: "  \t " })).toBe(false);
        expect(isPilotDisjointnessRow({ qid: "p001", nearestOldQid: "q01" })).toBe(false);
    });

    it("accepts a label-free candidate dossier and rejects any label field", () => {
        const candidate = makeCandidate();
        expect(isPilotCandidateDossier(candidate)).toBe(true);
        expect(isPilotCandidateDossier({ ...candidate, label: "gold" })).toBe(false);
        expect(isPilotCandidateDossier({ ...candidate, why: "looks relevant" })).toBe(false);
        expect(isPilotCandidateDossier({ ...candidate, startLine: 0 })).toBe(false);
        expect(isPilotCandidateDossier({ ...candidate, startLine: 5, endLine: 4 })).toBe(false);
        expect(isPilotCandidateDossier({ ...candidate, endLine: candidate.startLine + 120 })).toBe(false);
        expect(isPilotCandidateDossier({ ...candidate, file: "../secrets.ts" })).toBe(false);
        expect(isPilotCandidateDossier({ ...candidate, file: "/etc/passwd" })).toBe(false);
        expect(isPilotCandidateDossier({ ...candidate, file: "lib/util.ts" })).toBe(false);
        expect(isPilotCandidateDossier({ ...candidate, symbol: 42 })).toBe(false);
    });

    it("validates author proposals, assessments, and adjudications fail-closed", () => {
        expect(isPilotAuthorProposal({ cid: "c1", label: "gold", why: "implements the step" })).toBe(true);
        expect(isPilotAuthorProposal({ cid: "c1", label: "silver", why: "..." })).toBe(false);
        expect(isPilotAuthorProposal({ cid: "c1", label: "gold", why: "...", rationale: "foreign" })).toBe(false);

        const candidate = makeCandidate();
        expect(isPilotLabelerAssessment(makeAssessment(candidate, "A", "gold"))).toBe(true);
        expect(isPilotLabelerAssessment({ ...makeAssessment(candidate, "A", "gold"), labeler: "C" })).toBe(false);
        expect(isPilotLabelerAssessment({ ...makeAssessment(candidate, "A", "gold"), score: 0.9 })).toBe(false);
        expect(isPilotLabelerAssessment({ ...makeAssessment(candidate, "A", "gold"), rationale: "" })).toBe(false);
        expect(isPilotLabelerAssessment({ ...makeAssessment(candidate, "A", "gold"), label: "maybe" })).toBe(false);

        expect(isPilotAdjudication(makeAdjudication(candidate, "gold", "gold", "gold"))).toBe(true);
        expect(isPilotAdjudication({ ...makeAdjudication(candidate, "gold", "gold", "gold"), reviewedAssessments: [{ labeler: "A", label: "gold" }] })).toBe(false);
        expect(isPilotAdjudication({
            ...makeAdjudication(candidate, "gold", "gold", "gold"),
            reviewedAssessments: [{ labeler: "A", label: "gold" }, { labeler: "A", label: "gold" }],
        })).toBe(false);
        expect(isPilotAdjudication({
            ...makeAdjudication(candidate, "gold", "gold", "gold"),
            reviewedAssessments: [{ labeler: "A", label: "gold", why: "foreign" }, { labeler: "B", label: "gold" }],
        })).toBe(false);
    });

    it("checks source-range citations against the candidate dossier", () => {
        const candidate = makeCandidate({ file: "src/judge/cache.ts", startLine: 1, endLine: 5 });
        expect(rationaleCitesSourceRange("see src/judge/cache.ts:1-5", candidate)).toBe(true);
        expect(rationaleCitesSourceRange("see src/judge/cache.ts:1-6", candidate)).toBe(false);
        expect(rationaleCitesSourceRange("looks right", candidate)).toBe(false);
        // Delimiter-exact: no prefix, substring, or foreign-path acceptance.
        expect(rationaleCitesSourceRange("see src/judge/cache.ts:1-50", candidate)).toBe(false);
        expect(rationaleCitesSourceRange("see src/judge/cache.ts:2-5", candidate)).toBe(false);
        expect(rationaleCitesSourceRange("see lib/src/judge/cache.ts:1-5", candidate)).toBe(false);
        expect(rationaleCitesSourceRange("see (src/judge/cache.ts:1-5).", candidate)).toBe(true);
        const oneOne = makeCandidate({ file: "src/index.ts", startLine: 1, endLine: 1 });
        expect(rationaleCitesSourceRange("cites src/index.ts:1-1", oneOne)).toBe(true);
        expect(rationaleCitesSourceRange("cites src/index.ts:1-10", oneOne)).toBe(false);
    });

    it("enforces the repository path and 1-based ≤120-line range guards", () => {
        expect(isValidPilotSourcePath("src/a/b.ts")).toBe(true);
        expect(isValidPilotSourcePath("test/a/b.test.ts")).toBe(true);
        expect(isValidPilotSourcePath("scripts/x.ts")).toBe(false);
        expect(isValidPilotSourcePath("src/../etc/passwd")).toBe(false);
        expect(isValidPilotLineRange(1, 120)).toBe(true);
        expect(isValidPilotLineRange(1, 121)).toBe(false);
        expect(isValidPilotLineRange(0, 5)).toBe(false);
        expect(isValidPilotLineRange(7, 6)).toBe(false);
    });
});

/* ──────────────────────────────────────────────────────────────────────
 * 2. Pinned materialization — byte-equality with run.ts sourceRange
 * ──────────────────────────────────────────────────────────────────── */

describe("pinned materialization (run.ts sourceRange convention)", () => {
    it("produces byte-identical output to the frozen run.ts sourceRange on samples", () => {
        const reference = frozenRunTsSourceRange();
        const samples = [
            { file: "src/example.ts", startLine: 1, endLine: 1, symbol: null },
            { file: "src/example.ts", startLine: 3, endLine: 6, symbol: "sampleSymbol" },
            { file: "src/example.ts", startLine: 40, endLine: 40, symbol: null },
            { file: "src/example.ts", startLine: 41, endLine: 41, symbol: null },
            { file: "test/example.test.ts", startLine: 1, endLine: 10, symbol: "theSymbol" },
            { file: "src/big.ts", startLine: 120, endLine: 121, symbol: null },
            { file: "src/long.ts", startLine: 1, endLine: 10, symbol: null },
        ];
        for (const sample of samples) {
            const mine = materializePinnedRange({ repoDir: fixtureRepo.dir, testOnlyRefOverride: fixtureRepo.ref, ...sample });
            const frozen = reference(sample.file, sample.startLine, sample.endLine, sample.symbol);
            expect(mine).toBe(frozen);
        }
    });

    it("anchors the excerpt format with an explicit expected string", () => {
        const excerpt = materializePinnedRange({
            repoDir: fixtureRepo.dir,
            testOnlyRefOverride: fixtureRepo.ref,
            file: "src/example.ts",
            startLine: 3,
            endLine: 6,
            symbol: "sampleSymbol",
        });
        expect(excerpt).toBe(
            "src/example.ts:3-6 sampleSymbol\n" +
            "3|// source line 03\n" +
            "4|// source line 04\n" +
            "5|// source line 05\n" +
            "6|// source line 06",
        );
    });

    it("caps formatted excerpts at 3,500 characters", () => {
        const excerpt = materializePinnedRange({
            repoDir: fixtureRepo.dir,
            testOnlyRefOverride: fixtureRepo.ref,
            file: "src/long.ts",
            startLine: 1,
            endLine: 10,
            symbol: null,
        });
        expect(excerpt).toHaveLength(PILOT_EXCERPT_CHAR_CAP);
    });

    it("rejects traversal, absolute, non-repository, and out-of-bounds ranges", () => {
        const request = { repoDir: fixtureRepo.dir, testOnlyRefOverride: fixtureRepo.ref, symbol: null };
        expect(() => materializePinnedRange({ ...request, file: "../outside.ts", startLine: 1, endLine: 1 }))
            .toThrow(/Refusing non-repository eval path/);
        expect(() => materializePinnedRange({ ...request, file: "/etc/passwd", startLine: 1, endLine: 1 }))
            .toThrow(/Refusing non-repository eval path/);
        expect(() => materializePinnedRange({ ...request, file: "scripts/eval/x.ts", startLine: 1, endLine: 1 }))
            .toThrow(/Refusing non-repository eval path/);
        expect(() => materializePinnedRange({ ...request, file: "src/example.ts", startLine: 0, endLine: 5 }))
            .toThrow(/Invalid pinned source range/);
        expect(() => materializePinnedRange({ ...request, file: "src/example.ts", startLine: 6, endLine: 5 }))
            .toThrow(/Invalid pinned source range/);
        expect(() => materializePinnedRange({ ...request, file: "src/big.ts", startLine: 2, endLine: 122 }))
            .toThrow(/Invalid pinned source range/);
        expect(() => materializePinnedRange({ ...request, file: "src/example.ts", startLine: 1, endLine: 9999 }))
            .toThrow(/Invalid pinned source range/);
    });

    it("fails closed for an unknown ref or an uncommitted file", () => {
        const request = { repoDir: fixtureRepo.dir, symbol: null };
        expect(() => materializePinnedRange({ ...request, testOnlyRefOverride: "0".repeat(40), file: "src/example.ts", startLine: 1, endLine: 2 }))
            .toThrow(/git show failed/);
        expect(() => materializePinnedRange({ ...request, testOnlyRefOverride: fixtureRepo.ref, file: "src/missing.ts", startLine: 1, endLine: 2 }))
            .toThrow(/git show failed/);
    });

    it("defaults to the frozen pilot pin", () => {
        expect(PILOT_SOURCE_REF).toBe("18f6463caa78e6657b1af6c7eb86b711bc2364f8");
    });

    it("materializes from the frozen pin when no test-only override is supplied", () => {
        expect(() => materializePinnedRange({
            repoDir: fixtureRepo.dir,
            file: "src/example.ts",
            startLine: 1,
            endLine: 2,
            symbol: null,
        })).toThrow(new RegExp(`git show failed for ${PILOT_SOURCE_REF}:src/example.ts`));
    });

    it("refuses an ad-hoc ref override outside the explicitly named test-only seam", () => {
        const rogue = { repoDir: fixtureRepo.dir, ref: "HEAD", file: "src/example.ts", startLine: 1, endLine: 2, symbol: null };
        expect(() => materializePinnedRange(rogue as PilotRangeRequest)).toThrow(/testOnlyRefOverride/);
    });
});

/* ──────────────────────────────────────────────────────────────────────
 * 3. Disjointness checks
 * ──────────────────────────────────────────────────────────────────── */

describe("disjointness checks against the frozen queries", () => {
    const frozen: PilotFrozenQuery[] = [
        { qid: "q01", query: "How does the grep cascade deduplicate search results?" },
        { qid: "q02", query: "Where are workspace evidence blocks published?" },
        { qid: "q03", query: "a b c d e f g" },
    ];

    it("documents the tokenization and the near-paraphrase threshold", () => {
        expect(normalizeQueryText("How does the Grep-Cascade work?")).toBe("how does the grep cascade work");
        expect([...queryTokenSet("How HOW how")]).toEqual(["how"]);
        expect(NEAR_PARAPHRASE_JACCARD_THRESHOLD).toBe(0.7);
        expect(tokenSetJaccard(queryTokenSet("a b c d e f g"), queryTokenSet("a b c d e f g h i j"))).toBe(0.7);
    });

    it("flags exact and normalized duplicates of a frozen query", () => {
        const exact = evaluateQueryDisjointness(
            [makeQuery({ qid: "p101", query: "How does the grep cascade deduplicate search results?", nearestOldQid: "q01" })],
            frozen,
        )[0]!;
        expect(exact.flagged).toBe(true);
        expect(exact.exactDuplicateOf).toBe("q01");
        expect(exact.normalizedDuplicateOf).toBe("q01");
        expect(exact.computedNearestOldQid).toBe("q01");
        expect(exact.maxTokenJaccard).toBe(1);
        expect(exact.flagReasons).toContain("exact_duplicate");

        const normalized = evaluateQueryDisjointness(
            [makeQuery({ qid: "p102", query: "how does the grep cascade deduplicate search results", nearestOldQid: "q01" })],
            frozen,
        )[0]!;
        expect(normalized.exactDuplicateOf).toBeNull();
        expect(normalized.normalizedDuplicateOf).toBe("q01");
        expect(normalized.flagReasons).toContain("normalized_duplicate");
    });

    it("flags a boundary near-paraphrase at the threshold, not a genuinely distinct query", () => {
        const near = evaluateQueryDisjointness(
            [makeQuery({ qid: "p103", query: "a b c d e f g h i j", nearestOldQid: "q03" })],
            frozen,
        )[0]!;
        expect(near.flagged).toBe(true);
        expect(near.flagReasons).toEqual(["near_paraphrase_jaccard"]);
        expect(near.maxTokenJaccard).toBe(0.7);

        const distinct = evaluateQueryDisjointness(
            [makeQuery({ qid: "p104", query: "what is the ledger cap amendment flow", nearestOldQid: "q01" })],
            frozen,
        )[0]!;
        expect(distinct.flagged).toBe(false);
        expect(distinct.flagReasons).toEqual([]);
        expect(distinct.maxTokenJaccard).toBeLessThan(NEAR_PARAPHRASE_JACCARD_THRESHOLD);
        expect(distinct.computedNearestOldQid).not.toBeNull();
    });

    it("flags qid collisions and unknown declared nearest queries", () => {
        const collision = evaluateQueryDisjointness(
            [makeQuery({ qid: "q01", nearestOldQid: "q01" })],
            frozen,
        )[0]!;
        expect(collision.qidCollisionWith).toBe("q01");
        expect(collision.flagReasons).toContain("qid_collision");

        const unknownNearest = evaluateQueryDisjointness(
            [makeQuery({ qid: "p105", nearestOldQid: "q99" })],
            frozen,
        )[0]!;
        expect(unknownNearest.flagReasons).toContain("nearest_old_qid_unknown");
        expect(unknownNearest.flagged).toBe(true);
    });

    it("refuses an empty frozen set and duplicate input qids", () => {
        expect(() => evaluateQueryDisjointness([makeQuery()], [])).toThrow(/frozen query set/);
        expect(() => evaluateQueryDisjointness([makeQuery(), makeQuery()], frozen)).toThrow(/duplicate pilot qid/);
    });
});

/* ──────────────────────────────────────────────────────────────────────
 * Frozen 44-query loader
 * ──────────────────────────────────────────────────────────────────── */

describe("loadFrozenPilotQueries", () => {
    function writeFrozenSet(dir: string, set: "a" | "b", groups: Array<{ qid: string; query: string }>): void {
        const lines: string[] = [];
        for (const group of groups) {
            for (let row = 0; row < 2; row++) {
                lines.push(JSON.stringify({
                    qid: group.qid,
                    query: group.query,
                    file: "src/judge/questions.ts",
                    startLine: 1,
                    endLine: 5,
                    symbol: null,
                    label: "gold",
                }));
            }
        }
        writeFileSync(join(dir, `set-${set}.jsonl`), lines.join("\n") + "\n");
    }

    function tempDataDir(): string {
        return realpathSync(mkdtempSync(join(tmpdir(), "method-pilot-queries-")));
    }

    const groupsA = Array.from({ length: 22 }, (_, index) => ({ qid: `A${index}`, query: `old query a${index}` }));
    const groupsB = Array.from({ length: 22 }, (_, index) => ({ qid: `B${index}`, query: `old query b${index}` }));

    it("pins the frozen fixture digest to its preregistered value", () => {
        expect(FROZEN_FIXTURE_DIGEST)
            .toBe("2e9fa4117b7003e50581ec1c32d2b17c9c211b655bd9a9002a47961f2b871f9b");
    });

    it("refuses an alternate 44-group fixture pair whose bytes are not the frozen corpus", () => {
        const dir = tempDataDir();
        try {
            writeFrozenSet(dir, "a", groupsA);
            writeFrozenSet(dir, "b", groupsB);
            // Structure (44 groups, unique qids, one text per qid) is satisfied;
            // only the digest check can refuse the alternate corpus.
            expect(() => loadFrozenPilotQueries(dir)).toThrow(/do not match the preregistered digest/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    frozenCorpusIt("loads the real frozen fixture — 44 unique groups pass structure and digest", () => {
        const queries = loadFrozenPilotQueries();
        expect(queries).toHaveLength(FROZEN_QUERY_GROUP_COUNT);
        expect(new Set(queries.map((entry) => entry.qid)).size).toBe(FROZEN_QUERY_GROUP_COUNT);
    });

    frozenCorpusIt("refuses a tampered copy of the real fixture that keeps 44 consistent groups", () => {
        const dir = tempDataDir();
        try {
            for (const set of ["a", "b"] as const) {
                writeFileSync(join(dir, `set-${set}.jsonl`), readFileSync(join(PLAN_DATA_DIR, `set-${set}.jsonl`), "utf8"));
            }
            const path = join(dir, "set-a.jsonl");
            const lines = readFileSync(path, "utf8").trim().split("\n");
            const first = JSON.parse(lines[0]!) as Record<string, unknown>;
            // Reword every row of the first group so the structural checks
            // (44 groups, one consistent text per qid) still pass — only the
            // digest can refuse, which is exactly the reviewer's attack shape.
            for (let index = 0; index < lines.length; index++) {
                const row = JSON.parse(lines[index]!) as Record<string, unknown>;
                if (row.qid === first.qid) {
                    row.query = `${String(row.query)} (tampered)`;
                    lines[index] = JSON.stringify(row);
                }
            }
            writeFileSync(path, lines.join("\n") + "\n");
            expect(() => loadFrozenPilotQueries(dir)).toThrow(/do not match the preregistered digest/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("fails closed on a corpus that is not 44 groups", () => {
        const dir = tempDataDir();
        try {
            writeFrozenSet(dir, "a", groupsA.slice(0, 21));
            writeFrozenSet(dir, "b", groupsB);
            expect(() => loadFrozenPilotQueries(dir)).toThrow(/must contain 44 query groups, found 43/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("fails closed on cross-set qid collisions", () => {
        const dir = tempDataDir();
        try {
            writeFrozenSet(dir, "a", groupsA);
            writeFrozenSet(dir, "b", [...groupsB.slice(0, 21), { qid: "A0", query: "colliding query" }]);
            expect(() => loadFrozenPilotQueries(dir)).toThrow(/collides across sets/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("fails closed on inconsistent query text within one qid", () => {
        const dir = tempDataDir();
        try {
            writeFrozenSet(dir, "a", groupsA);
            writeFrozenSet(dir, "b", groupsB);
            const path = join(dir, "set-a.jsonl");
            const lines = readFileSync(path, "utf8").trim().split("\n");
            const first = JSON.parse(lines[0]!) as Record<string, unknown>;
            lines[1] = JSON.stringify({ ...first, query: "a different query for the same qid" });
            writeFileSync(path, lines.join("\n") + "\n");
            expect(() => loadFrozenPilotQueries(dir)).toThrow(/Inconsistent query text/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

/* ──────────────────────────────────────────────────────────────────────
 * 4. Label-quality gates
 * ──────────────────────────────────────────────────────────────────── */

describe("label-quality gates", () => {
    function gateAssessments(rows: Array<[PilotLabel, PilotLabel]>): PilotLabelerAssessment[] {
        return rows.flatMap(([a, b], index) => ([
            { cid: `g${index}`, labeler: "A" as const, label: a, rationale: "r", rangeValid: true, ambiguous: false },
            { cid: `g${index}`, labeler: "B" as const, label: b, rationale: "r", rangeValid: true, ambiguous: false },
        ]));
    }

    it("passes when every frozen gate is met (binary .90, κ .75, three-class .85, both classes)", () => {
        const result = evaluateLabelQualityGates(gateAssessments([
            ["gold", "gold"], ["gold", "gold"], ["gold", "gold"], ["gold", "gold"], ["gold", "gold"],
            ["hard_negative", "hard_negative"], ["hard_negative", "hard_negative"], ["hard_negative", "hard_negative"],
            ["easy_negative", "easy_negative"],
            ["gold", "hard_negative"],
        ]));
        expect(result.pairedCandidateCount).toBe(10);
        expect(result.binaryAgreement).toBe(LABEL_GATE_BINARY_AGREEMENT_MIN);
        expect(result.threeClassAgreement).toBe(0.9);
        expect(result.binaryKappa).toBeCloseTo(0.8, 5);
        expect(result.labelerHasBothClasses).toEqual({ A: true, B: true });
        expect(result.passed).toBe(true);
        expect(result.failures).toEqual([]);
    });

    it("fails the binary agreement gate below .90", () => {
        const result = evaluateLabelQualityGates(gateAssessments([
            ["gold", "gold"], ["gold", "gold"], ["gold", "gold"], ["gold", "gold"],
            ["hard_negative", "hard_negative"], ["hard_negative", "hard_negative"],
            ["hard_negative", "hard_negative"], ["hard_negative", "hard_negative"],
            ["gold", "hard_negative"], ["gold", "hard_negative"],
        ]));
        expect(result.failures.join("\n")).toMatch(/^binary agreement 0\.8000 < required 0\.9000$/m);
        expect(result.passed).toBe(false);
    });

    it("fails the κ gate even when binary agreement exactly meets .90", () => {
        const result = evaluateLabelQualityGates(gateAssessments([
            ["gold", "gold"], ["gold", "gold"], ["gold", "gold"], ["gold", "gold"],
            ["gold", "gold"], ["gold", "gold"], ["gold", "gold"], ["gold", "gold"],
            ["easy_negative", "easy_negative"],
            ["gold", "easy_negative"],
        ]));
        expect(result.binaryAgreement).toBe(0.9);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).toMatch(/^binary Cohen's kappa 0\.\d{4} < required 0\.7500$/);
    });

    it("fails the three-class gate when negatives disagree while binary agreement is perfect", () => {
        const result = evaluateLabelQualityGates(gateAssessments([
            ["gold", "gold"], ["gold", "gold"], ["gold", "gold"], ["gold", "gold"],
            ["gold", "gold"], ["gold", "gold"],
            ["hard_negative", "hard_negative"],
            ["hard_negative", "easy_negative"],
            ["easy_negative", "easy_negative"],
            ["hard_negative", "easy_negative"],
        ]));
        expect(result.binaryAgreement).toBe(1);
        expect(result.binaryKappa).toBeCloseTo(1, 5);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).toMatch(/^three-class agreement 0\.8000 < required 0\.8500$/);
    });

    it("requires each labeler to submit both positive and negative labels", () => {
        const result = evaluateLabelQualityGates(gateAssessments(Array.from({ length: 10 }, () => ["gold", "gold"] as [PilotLabel, PilotLabel])));
        expect(result.failures.join("\n")).toContain("labeler A must submit both positive and negative labels");
        expect(result.failures.join("\n")).toContain("labeler B must submit both positive and negative labels");
        expect(result.failures.join("\n")).toContain("binary Cohen's kappa undefined (degenerate shared marginals)");
        expect(result.passed).toBe(false);
    });

    it("throws fail-closed on unpaired or empty assessment sets", () => {
        const duplicateA = [
            { cid: "g0", labeler: "A" as const, label: "gold" as const, rationale: "r", rangeValid: true, ambiguous: false },
            { cid: "g0", labeler: "A" as const, label: "gold" as const, rationale: "r", rangeValid: true, ambiguous: false },
        ];
        expect(() => evaluateLabelQualityGates(duplicateA)).toThrow(/exactly one A and one B/);
        expect(() => evaluateLabelQualityGates([])).toThrow(/at least one paired candidate/);
    });
});

/* ──────────────────────────────────────────────────────────────────────
 * 6. Neutral ids + label-independent ordering
 * ──────────────────────────────────────────────────────────────────── */

describe("neutral ids and label-independent ordering", () => {
    const entries = [
        { qid: "p001", file: "src/judge/cache.ts", startLine: 1, endLine: 5 },
        { qid: "p001", file: "src/judge/batch.ts", startLine: 10, endLine: 20 },
        { qid: "p002", file: "test/graph/warm.test.ts", startLine: 2, endLine: 9 },
        { qid: "p002", file: "src/search/grep.ts", startLine: 100, endLine: 120 },
    ];

    it("derives stable neutral content-derived ids", () => {
        const assigned = assignNeutralCandidateIds(entries);
        for (const entry of assigned) expect(entry.cid).toMatch(/^c[0-9a-f]{12}$/);
        expect(assigned.map((entry) => entry.cid)).toEqual(assignNeutralCandidateIds(entries).map((entry) => entry.cid));
        const changed = assignNeutralCandidateIds([{ ...entries[0]!, startLine: 6, endLine: 7 }]);
        expect(changed[0]!.cid).not.toBe(assigned[0]!.cid);
        expect(() => assignNeutralCandidateIds([entries[0]!, entries[0]!])).toThrow(/unique range/);
    });

    it("orders by sha256(qid|file|range) regardless of input arrangement", () => {
        const assigned = assignNeutralCandidateIds(entries);
        const canonical = orderCandidates(assigned).map((entry) => entry.cid);
        const expected = [...assigned]
            .sort((left, right) => {
                const leftHash = candidateOrderHash(left);
                const rightHash = candidateOrderHash(right);
                if (leftHash !== rightHash) return leftHash < rightHash ? -1 : 1;
                return left.cid < right.cid ? -1 : left.cid > right.cid ? 1 : 0;
            })
            .map((entry) => entry.cid);
        expect(canonical).toEqual(expected);
        expect(orderCandidates([...assigned].reverse()).map((entry) => entry.cid)).toEqual(canonical);
        expect(orderCandidates([...assigned].reverse())).toEqual(orderCandidates(assigned));
    });

    it("never lets a gold-first hand arrangement survive as the sealed order", () => {
        const assigned = assignNeutralCandidateIds(entries);
        // A hypothetical label-aware author order (e.g. by known golds first)
        // is rewritten to the content-hash order by the only sanctioned sorter.
        const handOrder = [assigned[2]!, assigned[0]!, assigned[3]!, assigned[1]!];
        expect(orderCandidates(handOrder).map((entry) => entry.cid)).not.toEqual(handOrder.map((entry) => entry.cid));
        expect(orderCandidates(handOrder).map((entry) => entry.cid)).toEqual(orderCandidates(assigned).map((entry) => entry.cid));
    });

    it("rejects duplicate cids in ordering input", () => {
        const assigned = assignNeutralCandidateIds(entries);
        expect(() => orderCandidates([assigned[0]!, { ...assigned[1]!, cid: assigned[0]!.cid }])).toThrow(/duplicate candidate cid/);
    });
});

describe("author cid mapping to neutral ids", () => {
    const entries = [
        { qid: "p001", authorCid: "p001-c02", file: "src/judge/batch.ts", startLine: 10, endLine: 20, symbol: null },
        { qid: "p001", authorCid: "p001-c01", file: "src/judge/cache.ts", startLine: 1, endLine: 5, symbol: "cacheImpl" },
        { qid: "p002", authorCid: "p002-c01", file: "src/graph/warm.ts", startLine: 3, endLine: 12, symbol: null },
    ];

    it("maps <qid>-cNN author ids to neutral content-derived ids deterministically", () => {
        const rows = buildAuthorCidMap(entries);
        expect(rows.map((row) => row.authorCid)).toEqual(["p001-c01", "p001-c02", "p002-c01"]);
        expect(buildAuthorCidMap([...entries].reverse())).toEqual(rows);
        for (const row of rows) expect(row.cid).toMatch(/^c[0-9a-f]{12}$/);
        expect(rows[0]!.cid).toBe(neutralCandidateId({ qid: "p001", file: "src/judge/cache.ts", startLine: 1, endLine: 5 }));
        expect(rows[0]!.cid).not.toBe(rows[1]!.cid);
    });

    it("keeps labels and author ordering out of the mapping", () => {
        const rows = buildAuthorCidMap(entries);
        expect(isPilotAuthorCidMapRow(rows[0])).toBe(true);
        expect(isPilotAuthorCidMapRow({ ...rows[0]!, label: "gold" })).toBe(false);
        expect(JSON.stringify(rows)).not.toContain("label");
        expect(buildAuthorCidMap([entries[2]!, entries[0]!, entries[1]!])).toEqual(rows);
    });

    it("fails closed on malformed author ids, duplicates, and empty input", () => {
        expect(() => buildAuthorCidMap([])).toThrow(/at least one entry/);
        expect(isPilotAuthorCandidateEntry({ ...entries[0]!, authorCid: "p001-cX" })).toBe(false);
        expect(() => buildAuthorCidMap([{ ...entries[0]!, authorCid: "p001-cxx" }])).toThrow(
            /invalid author candidate entry at index 0/,
        );
        expect(() => buildAuthorCidMap([{ ...entries[0]!, authorCid: "p999-c01" }])).toThrow(
            /invalid author candidate entry at index 0/,
        );
        expect(() => buildAuthorCidMap([entries[0]!, entries[0]!])).toThrow(/duplicate author cid p001-c02/);
        expect(() => buildAuthorCidMap([entries[0]!, { ...entries[0]!, authorCid: "p001-c09" }])).toThrow(
            /duplicate neutral cid/,
        );
        expect(() => buildAuthorCidMap([{ ...entries[0]!, file: "lib/util.ts" }])).toThrow(
            /invalid author candidate entry at index 0/,
        );
    });

    it("translates author proposals to neutral ids and rejects unknown or duplicate author cids", () => {
        const rows = buildAuthorCidMap(entries);
        const applied = applyAuthorCidMap([{ cid: "p001-c01", label: "gold", why: "implements the step" }], rows);
        expect(applied).toEqual([
            { cid: rows.find((row) => row.authorCid === "p001-c01")!.cid, label: "gold", why: "implements the step" },
        ]);
        expect(() => applyAuthorCidMap([{ cid: "p001-c99", label: "gold", why: "…" }], rows)).toThrow(
            /unknown author cid p001-c99/,
        );
        const proposal = { cid: "p001-c01", label: "gold" as const, why: "…" };
        expect(() => applyAuthorCidMap([proposal, proposal], rows)).toThrow(/duplicate author proposal cid p001-c01/);
    });

    it("serializes the mapping as canonical JSONL for the sealed artifact", () => {
        const rows = buildAuthorCidMap(entries);
        const bytes = serializePilotAuthorCidMap(rows);
        expect(bytes.endsWith("\n")).toBe(true);
        expect(bytes.trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual(rows);
        expect(serializePilotAuthorCidMap([])).toBe("");
    });
});

/* ──────────────────────────────────────────────────────────────────────
 * 5. Audit selection + final acceptance
 * ──────────────────────────────────────────────────────────────────── */

describe("deterministic 10% agreed-sample audit selection", () => {
    it("selects ceil(10%) by seeded hash, independent of input order", () => {
        const cids = Array.from({ length: 12 }, (_, index) => `c${String(index).padStart(12, "0")}`);
        const expectedRanking = [...cids].sort((left, right) => {
            const leftHash = createHash("sha256").update(`${PILOT_AUDIT_SAMPLE_SEED}\n${left}`, "utf8").digest("hex");
            const rightHash = createHash("sha256").update(`${PILOT_AUDIT_SAMPLE_SEED}\n${right}`, "utf8").digest("hex");
            if (leftHash !== rightHash) return leftHash < rightHash ? -1 : 1;
            return left < right ? -1 : 1;
        });
        const sample = selectAgreedAuditSample(cids);
        expect(sample).toEqual(expectedRanking.slice(0, Math.ceil(12 * 0.1)));
        expect(sample).toHaveLength(2);
        expect(selectAgreedAuditSample([...cids].reverse())).toEqual(sample);
        expect(selectAgreedAuditSample(cids, "other-seed")).not.toBe(selectAgreedAuditSample(cids));
    });

    it("rounds up to at least one audited candidate and handles the empty set", () => {
        expect(selectAgreedAuditSample([])).toEqual([]);
        expect(selectAgreedAuditSample(["c1"])).toEqual(["c1"]);
        expect(selectAgreedAuditSample(Array.from({ length: 5 }, (_, i) => `c${i}`))).toHaveLength(1);
        expect(selectAgreedAuditSample(Array.from({ length: 11 }, (_, i) => `c${i}`))).toHaveLength(2);
        expect(() => selectAgreedAuditSample(["c1", "c1"])).toThrow(/duplicate cid/);
    });
});

describe("final acceptance", () => {
    it("accepts a fully adjudicated corpus and derives final labels", () => {
        const corpus = baseCorpus();
        const sample = selectAgreedAuditSample(corpus.candidates.map((candidate) => candidate.cid));
        expect(sample).toHaveLength(1);
        const auditedIndex = corpus.candidates.findIndex((candidate) => candidate.cid === sample[0]);
        const audited = corpus.candidates[auditedIndex]!;
        corpus.adjudications.push(makeAdjudication(audited, BASE_LABELS[auditedIndex]!, BASE_LABELS[auditedIndex]!, BASE_LABELS[auditedIndex]!));
        const result = verifyFinalAcceptance(corpus);
        expect(result.failures).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.auditSampleCids).toEqual(sample);
        expect(Object.keys(result.finalLabels)).toHaveLength(corpus.candidates.length);
        expect(result.finalLabels[corpus.candidates[0]!.cid]).toBe("gold");
        expect(result.finalLabels[corpus.candidates[5]!.cid]).toBe("easy_negative");
        expect(verifyFinalAcceptance(corpus).auditSampleCids).toEqual(sample);
    });

    it("rejects an unadjudicated disagreement", () => {
        const corpus = baseCorpus();
        const target = corpus.candidates[2]!;
        const bAssessment = corpus.assessments.find((a) => a.cid === target.cid && a.labeler === "B")!;
        bAssessment.label = "easy_negative";
        const result = verifyFinalAcceptance(corpus);
        expect(result.ok).toBe(false);
        expect(result.failures.join("\n")).toContain(`unresolved disagreement for candidate ${target.cid}`);
    });

    it("rejects an adjudication whose rationale lacks the source citation", () => {
        const corpus = baseCorpus();
        const target = corpus.candidates[2]!;
        const aLabel = corpus.assessments.find((a) => a.cid === target.cid && a.labeler === "A")!.label;
        const bAssessment = corpus.assessments.find((a) => a.cid === target.cid && a.labeler === "B")!;
        bAssessment.label = "easy_negative";
        corpus.adjudications.push(makeAdjudication(target, aLabel, aLabel, bAssessment.label, { rationale: "just feels right" }));
        const result = verifyFinalAcceptance(corpus);
        expect(result.ok).toBe(false);
        expect(result.failures.join("\n")).toContain(`adjudication for candidate ${target.cid} missing source citation`);
    });

    it("rejects an adjudication that misstates a submitted assessment", () => {
        const corpus = baseCorpus();
        const target = corpus.candidates[2]!;
        const bAssessment = corpus.assessments.find((a) => a.cid === target.cid && a.labeler === "B")!;
        bAssessment.label = "easy_negative";
        corpus.adjudications.push(makeAdjudication(target, "gold", "hard_negative", "gold"));
        const result = verifyFinalAcceptance(corpus);
        expect(result.failures.join("\n")).toContain(`adjudication for candidate ${target.cid} misstates labeler B's assessment`);
    });

    it("rejects an unresolved ambiguity flag", () => {
        const corpus = baseCorpus();
        const target = corpus.candidates[4]!;
        corpus.assessments.find((a) => a.cid === target.cid && a.labeler === "A")!.ambiguous = true;
        const result = verifyFinalAcceptance(corpus);
        expect(result.failures.join("\n")).toContain(`unresolved ambiguity for candidate ${target.cid}`);
    });

    it("rejects an unresolved invalid-range flag", () => {
        const corpus = baseCorpus();
        const target = corpus.candidates[5]!;
        corpus.assessments.find((a) => a.cid === target.cid && a.labeler === "B")!.rangeValid = false;
        const result = verifyFinalAcceptance(corpus);
        expect(result.failures.join("\n")).toContain(`unresolved invalid range for candidate ${target.cid}`);
    });

    it("rejects a candidate missing one labeler's assessment", () => {
        const corpus = baseCorpus();
        const target = corpus.candidates[3]!;
        corpus.assessments = corpus.assessments.filter((a) => !(a.cid === target.cid && a.labeler === "B"));
        const result = verifyFinalAcceptance(corpus);
        expect(result.failures.join("\n")).toContain(`candidate ${target.cid} has no assessment from labeler B`);
    });

    it("rejects an assessment without a source citation", () => {
        const corpus = baseCorpus();
        const target = corpus.candidates[0]!;
        const assessment = corpus.assessments.find((a) => a.cid === target.cid && a.labeler === "A")!;
        assessment.rationale = "looks relevant to me";
        const result = verifyFinalAcceptance(corpus);
        expect(result.failures.join("\n")).toContain(`assessment from labeler A missing source citation for candidate ${target.cid}`);
    });

    it("rejects an answerable query with no final gold candidate", () => {
        const corpus = baseCorpus();
        for (const candidate of corpus.candidates.filter((c) => c.qid === "p001")) {
            for (const assessment of corpus.assessments.filter((a) => a.cid === candidate.cid)) assessment.label = "hard_negative";
        }
        const result = verifyFinalAcceptance(corpus);
        expect(result.failures.join("\n")).toContain("answerable query p001 has no gold candidate");
    });

    it("rejects an absence query carrying a gold candidate", () => {
        const corpus = baseCorpus();
        const absentTarget = corpus.candidates[4]!;
        for (const assessment of corpus.assessments.filter((a) => a.cid === absentTarget.cid)) assessment.label = "gold";
        const result = verifyFinalAcceptance(corpus);
        expect(result.failures.join("\n")).toContain("absence query p002 has a gold candidate");
    });

    it("rejects an agreed audit-sample candidate with no recorded audit adjudication", () => {
        const corpus = baseCorpus();
        const result = verifyFinalAcceptance(corpus);
        expect(result.auditSampleCids).toHaveLength(1);
        expect(result.failures.join("\n")).toContain(`audit sample candidate ${result.auditSampleCids[0]} has no adjudication`);
    });

    it("rejects candidates that do not carry neutral content-derived ids", () => {
        const corpus = baseCorpus();
        const target = corpus.candidates[0]!;
        for (const assessment of corpus.assessments) if (assessment.cid === target.cid) assessment.cid = "u0";
        target.cid = "u0";
        const result = verifyFinalAcceptance(corpus);
        expect(result.failures.join("\n")).toContain("candidate u0 does not use its neutral content-derived id");
    });

    it("rejects foreign cids and unknown query references", () => {
        const corpus = baseCorpus();
        corpus.assessments.push(makeAssessment(makeCandidate({ file: "src/judge/ghost.ts" }), "A", "gold"));
        corpus.candidates.push(makeCandidate({ qid: "p999", file: "src/judge/ghost.ts", startLine: 7, endLine: 11 }));
        const result = verifyFinalAcceptance(corpus);
        expect(result.failures.join("\n")).toContain("assessment for unknown candidate");
        expect(result.failures.join("\n")).toContain("references unknown qid p999");
    });

    it("rejects duplicate adjudications for the same candidate", () => {
        const corpus = baseCorpus();
        const target = corpus.candidates[2]!;
        const bAssessment = corpus.assessments.find(
            (assessment) => assessment.cid === target.cid && assessment.labeler === "B",
        )!;
        bAssessment.label = "easy_negative";
        corpus.adjudications.push(
            makeAdjudication(target, "gold", "hard_negative", "easy_negative"),
            makeAdjudication(target, "easy_negative", "hard_negative", "easy_negative"),
        );
        const result = verifyFinalAcceptance(corpus);
        expect(result.ok).toBe(false);
        expect(result.failures).toContain(`duplicate adjudication for candidate ${target.cid}`);
        // The first adjudication stays authoritative — a duplicate never overwrites it.
        expect(result.finalLabels[target.cid]).toBe("gold");
    });

    it("requires exactly one validated absence audit for every absence query", () => {
        const corpus = acceptedCorpus();
        expect(verifyFinalAcceptance(corpus).ok).toBe(true);

        corpus.absenceAudits = [];
        let result = verifyFinalAcceptance(corpus);
        expect(result.ok).toBe(false);
        expect(result.failures).toContain("absence query p002 has no absence audit");

        corpus.absenceAudits = [makeAbsenceAudit("p002")];
        result = verifyFinalAcceptance(corpus);
        expect(result.ok).toBe(true);

        corpus.absenceAudits = [makeAbsenceAudit("p002"), makeAbsenceAudit("p002", { auditor: "auditor-2" })];
        result = verifyFinalAcceptance(corpus);
        expect(result.ok).toBe(false);
        expect(result.failures).toContain("duplicate absence audit for query p002");
    });

    it("rejects absence audits for answerable or unknown queries", () => {
        const corpus = acceptedCorpus();
        corpus.absenceAudits = [makeAbsenceAudit("p001")];
        let result = verifyFinalAcceptance(corpus);
        expect(result.ok).toBe(false);
        expect(result.failures).toContain("absence audit for answerable query p001");

        corpus.absenceAudits = [makeAbsenceAudit("p001"), makeAbsenceAudit("p999")];
        result = verifyFinalAcceptance(corpus);
        expect(result.failures).toContain("absence audit for unknown query p999");
    });

    it("validates absence-audit records fail-closed", () => {
        expect(isPilotAbsenceAudit(makeAbsenceAudit("p002"))).toBe(true);
        expect(isPilotAbsenceAudit({ ...makeAbsenceAudit("p002"), verdict: "absent" })).toBe(false);
        expect(isPilotAbsenceAudit({ ...makeAbsenceAudit("p002"), extra: "foreign" })).toBe(false);
        expect(isPilotAbsenceAudit({ ...makeAbsenceAudit("p002"), auditor: "" })).toBe(false);
        expect(isPilotAbsenceAudit({ ...makeAbsenceAudit("p002"), evidenceCommands: [] })).toBe(false);
        expect(isPilotAbsenceAudit({ ...makeAbsenceAudit("p002"), evidenceCommands: [""] })).toBe(false);
        expect(isPilotAbsenceAudit({ ...makeAbsenceAudit("p002"), rationale: "nothing found anywhere" })).toBe(false);
        expect(
            isPilotAbsenceAudit({ ...makeAbsenceAudit("p002"), rationale: "searched ../secrets and scripts/eval only" }),
        ).toBe(false);
    });
});

/* ──────────────────────────────────────────────────────────────────────
 * 7. Manifest builder + verifier
 * ──────────────────────────────────────────────────────────────────── */

describe("manifest builder and verifier (test-only low-level seam)", () => {
    // Placeholder artifact bytes are intentional at this seam: the low-level
    // builder only proves exact-byte hashing, provenance, and ordering.
    // Corpus validation is owned by sealPilotCorpusFromRoot, which rejects
    // placeholder artifacts (see "seal from validated data" below).
    function manifestFixture() {
        const candidates = orderCandidates([
            makeCandidate({ qid: "p001", file: "src/example.ts", startLine: 1, endLine: 5 }),
            makeCandidate({ qid: "p001", file: "test/example.test.ts", startLine: 2, endLine: 9, symbol: "cacheSuite" }),
            makeCandidate({ qid: "p002", file: "src/example.ts", startLine: 10, endLine: 20 }),
            makeCandidate({ qid: "p002", file: "src/big.ts", startLine: 100, endLine: 120 }),
        ]);
        const excerpts = candidates.map((candidate) => ({
            cid: candidate.cid,
            excerpt: materializePinnedRange({
                repoDir: fixtureRepo.dir,
                testOnlyRefOverride: fixtureRepo.ref,
                file: candidate.file,
                startLine: candidate.startLine,
                endLine: candidate.endLine,
                symbol: candidate.symbol,
            }),
        }));
        const artifacts = PILOT_REQUIRED_ARTIFACT_PATHS.map((path) => ({ path, content: `{"artifact":"${path}"}\n` }));
        return {
            candidates,
            excerpts,
            artifacts,
            repoDir: fixtureRepo.dir,
            sourceRef: fixtureRepo.ref,
            testOnlyAllowNonFrozenRef: true,
        };
    }

    it("seals and verifies exact bytes through the test-only low-level seam", () => {
        const input = manifestFixture();
        const sealed = __test__sealPilotManifest(input);
        expect(sealed.manifest.sourceRef).toBe(fixtureRepo.ref);
        expect(sealed.manifest.testOnlyRefOverride).toBe(true);
        expect(sealed.manifest.ordering.rule).toBe(PILOT_ORDER_RULE);
        expect(sealed.manifest.ordering.cids).toEqual(input.candidates.map((entry) => entry.cid));
        expect(sealed.manifest.excerpts.count).toBe(input.candidates.length);
        expect(sealed.sidecar).toBe(__test__pilotManifestSidecar(sealed.manifestBytes));
        expect(sealed.sidecar).toMatch(new RegExp(`^[0-9a-f]{64}  ${PILOT_MANIFEST_SIDECAR_FILE}\\n$`));
        const result = __test__verifyPilotManifest({
            manifestBytes: sealed.manifestBytes,
            sidecar: sealed.sidecar,
            ...input,
        });
        expect(result).toEqual({ ok: true, failures: [] });
    });

    it("sorts artifacts deterministically regardless of input order", () => {
        const input = manifestFixture();
        const reversed = { ...input, artifacts: [...input.artifacts].reverse() };
        const manifest = __test__buildPilotManifest(reversed);
        expect(manifest.artifacts.map((entry) => entry.path)).toEqual([...PILOT_REQUIRED_ARTIFACT_PATHS].sort());
        expect(__test__serializePilotManifest(manifest)).toBe(__test__serializePilotManifest(__test__buildPilotManifest(input)));
    });

    it("refuses any modified artifact byte", () => {
        const input = manifestFixture();
        const sealed = __test__sealPilotManifest(input);
        const tampered = input.artifacts.map((artifact) =>
            artifact.path === "pilot-queries.jsonl" ? { ...artifact, content: `${artifact.content} ` } : artifact,
        );
        const result = __test__verifyPilotManifest({
            manifestBytes: sealed.manifestBytes,
            sidecar: sealed.sidecar,
            ...input,
            artifacts: tampered,
        });
        expect(result.ok).toBe(false);
        expect(result.failures).toEqual(["artifact digest mismatch: pilot-queries.jsonl"]);
    });

    it("refuses missing or unexpected artifacts at seal time", () => {
        const input = manifestFixture();
        const missing = { ...input, artifacts: input.artifacts.filter((artifact) => artifact.path !== "labels-a.jsonl") };
        expect(() => __test__sealPilotManifest(missing))
            .toThrow(/exact artifact set; missing: \[labels-a\.jsonl\]; unexpected: \[\]/);
        const extra = { ...input, artifacts: [...input.artifacts, { path: "notes.txt", content: "x\n" }] };
        expect(() => __test__sealPilotManifest(extra))
            .toThrow(/exact artifact set; missing: \[\]; unexpected: \[notes\.txt\]/);
        const verified = __test__verifyPilotManifest({
            manifestBytes: __test__sealPilotManifest(input).manifestBytes,
            sidecar: __test__sealPilotManifest(input).sidecar,
            ...missing,
        });
        expect(verified.ok).toBe(false);
        expect(verified.failures.join("\n")).toContain("manifest input invalid");
        expect(verified.failures.join("\n")).toContain("missing: [labels-a.jsonl]");
    });

    it("refuses a tampered artifact set claimed inside the manifest bytes", () => {
        const input = manifestFixture();
        const sealed = __test__sealPilotManifest(input);
        const tamperedBytes = __test__serializePilotManifest({
            ...sealed.manifest,
            artifacts: [
                ...sealed.manifest.artifacts.filter((entry) => entry.path !== "labels-a.jsonl"),
                { path: "notes.txt", sha256: "0".repeat(64), byteLength: 3 },
            ],
        });
        const result = __test__verifyPilotManifest({
            manifestBytes: tamperedBytes,
            sidecar: __test__pilotManifestSidecar(tamperedBytes),
            ...input,
        });
        expect(result.ok).toBe(false);
        expect(result.failures).toContain("artifact missing from manifest: labels-a.jsonl");
        expect(result.failures).toContain("sealed artifact not provided: notes.txt");
    });

    it("refuses a modified excerpt byte via re-materialized provenance", () => {
        const input = manifestFixture();
        const sealed = __test__sealPilotManifest(input);
        const tamperedExcerpts = input.excerpts.map((excerpt, index) =>
            index === 0 ? { ...excerpt, excerpt: `${excerpt.excerpt}!` } : excerpt,
        );
        const result = __test__verifyPilotManifest({
            manifestBytes: sealed.manifestBytes,
            sidecar: sealed.sidecar,
            ...input,
            excerpts: tamperedExcerpts,
        });
        expect(result.ok).toBe(false);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).toMatch(/^manifest input invalid: excerpt provenance mismatch for candidate /);
    });

    it("refuses to seal hand-written excerpts that were not materialized at the recorded ref", () => {
        const input = manifestFixture();
        const forged = {
            ...input,
            excerpts: input.excerpts.map((excerpt, index) =>
                index === 0 ? { ...excerpt, excerpt: "forged excerpt" } : excerpt,
            ),
        };
        expect(() => __test__sealPilotManifest(forged)).toThrow(/excerpt provenance mismatch for candidate/);
    });

    it("refuses a tampered excerpt digest claim in the manifest bytes", () => {
        const input = manifestFixture();
        const sealed = __test__sealPilotManifest(input);
        const tamperedBytes = __test__serializePilotManifest({
            ...sealed.manifest,
            excerpts: { count: sealed.manifest.excerpts.count, digest: "0".repeat(64) },
        });
        const result = __test__verifyPilotManifest({
            manifestBytes: tamperedBytes,
            sidecar: __test__pilotManifestSidecar(tamperedBytes),
            ...input,
        });
        expect(result).toEqual({ ok: false, failures: ["excerpt digest mismatch"] });
    });

    it("refuses tampered manifest bytes via the sidecar", () => {
        const input = manifestFixture();
        const sealed = __test__sealPilotManifest(input);
        const tamperedBytes = sealed.manifestBytes.replace("{", "{ ");
        const result = __test__verifyPilotManifest({
            manifestBytes: tamperedBytes,
            sidecar: sealed.sidecar,
            ...input,
        });
        expect(result).toEqual({ ok: false, failures: ["manifest sidecar mismatch (manifest bytes modified or unsealed)"] });
    });

    it("refuses a tampered source pin even with a validly resealed sidecar", () => {
        const input = manifestFixture();
        const sealed = __test__sealPilotManifest(input);
        const tamperedBytes = __test__serializePilotManifest({ ...sealed.manifest, sourceRef: "0".repeat(40) });
        const result = __test__verifyPilotManifest({
            manifestBytes: tamperedBytes,
            sidecar: __test__pilotManifestSidecar(tamperedBytes),
            ...input,
        });
        expect(result.failures).toEqual(["source ref mismatch: 0000000000000000000000000000000000000000"]);
    });

    it("refuses unparseable, unshaped, and unsealed manifests", () => {
        const input = manifestFixture();
        expect(__test__verifyPilotManifest({ manifestBytes: "{oops", sidecar: "", ...input }))
            .toEqual({ ok: false, failures: ["manifest json invalid"] });
        const sealed = __test__sealPilotManifest(input);
        const wrongVersion = __test__serializePilotManifest({ ...sealed.manifest, version: 2 });
        expect(__test__verifyPilotManifest({ manifestBytes: wrongVersion, sidecar: sealed.sidecar, ...input }))
            .toEqual({ ok: false, failures: ["manifest shape invalid"] });
        expect(isPilotManifest(JSON.parse(sealed.manifestBytes))).toBe(true);
        const noSidecar = __test__verifyPilotManifest({ manifestBytes: sealed.manifestBytes, sidecar: "", ...input });
        expect(noSidecar.ok).toBe(false);
        expect(noSidecar.failures[0]).toContain("sidecar mismatch");
    });

    it("refuses gold-first candidate arrangements and non-canonical excerpt order at seal time", () => {
        const input = manifestFixture();
        expect(() => __test__buildPilotManifest({ ...input, candidates: [...input.candidates].reverse() }))
            .toThrow(/canonical label-independent order/);
        expect(() => __test__buildPilotManifest({ ...input, excerpts: [...input.excerpts].reverse() }))
            .toThrow(/excerpts must exactly match candidate neutral ids in canonical label-independent order/);
        const unsortedVerify = __test__verifyPilotManifest({
            manifestBytes: __test__sealPilotManifest(input).manifestBytes,
            sidecar: __test__sealPilotManifest(input).sidecar,
            ...input,
            candidates: [...input.candidates].reverse(),
        });
        expect(unsortedVerify.ok).toBe(false);
        expect(unsortedVerify.failures.join("\n")).toContain("manifest input invalid");
    });

    it("refuses non-neutral ids, unsafe artifact paths, and empty inputs at seal time", () => {
        const input = manifestFixture();
        expect(() => __test__buildPilotManifest({ ...input, candidates: [{ ...input.candidates[0]!, cid: "u0" }, ...input.candidates.slice(1)] }))
            .toThrow(/neutral content-derived id/);
        expect(() => __test__buildPilotManifest({ ...input, artifacts: [{ path: "../escape.jsonl", content: "x" }] }))
            .toThrow(/unsafe artifact path/);
        expect(() => __test__buildPilotManifest({ ...input, artifacts: [] })).toThrow(/exact artifact set; missing: \[/);
        expect(() => __test__buildPilotManifest({ ...input, candidates: [] })).toThrow(/at least one candidate/);
    });

    it("refuses a reordered candidate ordering claim in the manifest", () => {
        const input = manifestFixture();
        const sealed = __test__sealPilotManifest(input);
        const reorderedCids = [...sealed.manifest.ordering.cids].reverse();
        const tamperedBytes = __test__serializePilotManifest({
            ...sealed.manifest,
            ordering: { ...sealed.manifest.ordering, cids: reorderedCids },
        });
        const result = __test__verifyPilotManifest({
            manifestBytes: tamperedBytes,
            sidecar: __test__pilotManifestSidecar(tamperedBytes),
            ...input,
        });
        expect(result.ok).toBe(false);
        expect(result.failures).toEqual(["candidate ordering mismatch"]);
    });

    it("refuses a non-frozen source ref unless the test-only flag is set and records the ref actually used", () => {
        const input = manifestFixture();
        // A non-frozen ref without the test-only flag is refused at seal time.
        expect(() => __test__sealPilotManifest({ ...input, sourceRef: "0".repeat(40), testOnlyAllowNonFrozenRef: false }))
            .toThrow(new RegExp(`frozen pin ${PILOT_SOURCE_REF}`));

        // Produce a second fixture commit whose src/example.ts bytes differ.
        writeFileSync(join(fixtureRepo.dir, "src", "example.ts"), numberedLines(40, "changed line"));
        const git = (...args: string[]) =>
            execFileSync("git", args, { cwd: fixtureRepo.dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        git("add", ".");
        git(
            "-c", "user.email=pilot-fixture@example.invalid", "-c", "user.name=pilot-fixture",
            "-c", "commit.gpgsign=false", "commit", "-m", "changed source for ref-provenance test",
        );
        const changedRef = git("rev-parse", "HEAD").trim();
        expect(changedRef).not.toBe(fixtureRepo.ref);

        const excerptsAtChangedRef = input.candidates.map((candidate) => ({
            cid: candidate.cid,
            excerpt: materializePinnedRange({
                repoDir: fixtureRepo.dir,
                testOnlyRefOverride: changedRef,
                file: candidate.file,
                startLine: candidate.startLine,
                endLine: candidate.endLine,
                symbol: candidate.symbol,
            }),
        }));
        const changedIndex = input.candidates.findIndex((candidate) => candidate.file === "src/example.ts");
        expect(changedIndex).toBeGreaterThanOrEqual(0);
        expect(excerptsAtChangedRef[changedIndex]!.excerpt).not.toBe(input.excerpts[changedIndex]!.excerpt);

        // Excerpts from the first ref cannot be sealed under the changed ref.
        expect(() => __test__sealPilotManifest({ ...input, sourceRef: changedRef, testOnlyAllowNonFrozenRef: true }))
            .toThrow(/excerpt provenance mismatch for candidate/);

        // With the flag set, the ref actually used is recorded and verified.
        const sealed = __test__sealPilotManifest({
            ...input,
            sourceRef: changedRef,
            testOnlyAllowNonFrozenRef: true,
            excerpts: excerptsAtChangedRef,
        });
        expect(sealed.manifest.sourceRef).toBe(changedRef);
        expect(sealed.manifest.testOnlyRefOverride).toBe(true);
        expect(__test__verifyPilotManifest({
            manifestBytes: sealed.manifestBytes,
            sidecar: sealed.sidecar,
            ...input,
            sourceRef: changedRef,
            testOnlyAllowNonFrozenRef: true,
            excerpts: excerptsAtChangedRef,
        })).toEqual({ ok: true, failures: [] });

        // A verification that does not record the test-only flag refuses the non-frozen ref.
        const unflagged = __test__verifyPilotManifest({
            manifestBytes: sealed.manifestBytes,
            sidecar: sealed.sidecar,
            ...input,
            sourceRef: changedRef,
            testOnlyAllowNonFrozenRef: false,
            excerpts: excerptsAtChangedRef,
        });
        expect(unflagged.ok).toBe(false);
        expect(unflagged.failures.join("\n")).toContain("manifest input invalid");
        expect(unflagged.failures.join("\n")).toContain(PILOT_SOURCE_REF);
    });
});

/* ──────────────────────────────────────────────────────────────────────
 * Seal from validated data: the production root-based entry point
 * ──────────────────────────────────────────────────────────────────── */

type HonestPilotFiles = {
    "pilot-queries.jsonl": PilotQueryDossier[];
    "pilot-candidates.jsonl": PilotCandidateDossier[];
    "labels-a.jsonl": PilotLabelerAssessment[];
    "labels-b.jsonl": PilotLabelerAssessment[];
    "adjudications.jsonl": PilotAdjudication[];
    "pilot-absence-audits.jsonl": PilotAbsenceAudit[];
    "pilot-disjointness.jsonl": PilotDisjointnessRow[];
    "pilot-author-cid-map.jsonl": PilotAuthorCidMapRow[];
    "pilot-source-snapshots.jsonl": PilotSourceSnapshotRow[];
    "pilot-fixture.jsonl": PilotFixtureRow[];
};

/** Answerable qids of the honest 40-query corpus: p001 plus p003–p033 (32 total). */
const HONEST_ANSWERABLE_QIDS = [
    "p001",
    ...Array.from({ length: 31 }, (_, index) => `p${String(index + 3).padStart(3, "0")}`),
];

/** Absence qids of the honest 40-query corpus: p002 plus p034–p040 (8 total). */
const HONEST_ABSENCE_QIDS = [
    "p002",
    ...Array.from({ length: 7 }, (_, index) => `p${String(index + 34).padStart(3, "0")}`),
];

/**
 * Synthetic probe wording: deliberately vocabulary-disjoint from the frozen
 * 44 queries (max token Jaccard stays far below the 0.7 threshold), so the
 * honest corpus passes the frozen-44 disjointness check at seal and load.
 */
function syntheticProbeQuery(qid: string, answerable: boolean): string {
    const topic = answerable ? "bufstream rotation cadence" : "phantom ledger warmup absence";
    return `${topic} probe ${Number(qid.slice(1))} in the flux harnway pipeline`;
}

/**
 * An honest synthetic corpus over the tiny fixture git repo with the frozen
 * A1.2 composition: 40 queries (32 answerable + 8 absence), one candidate
 * per query, perfect labeler agreement with both classes present, a
 * source-cited adjudication for every candidate (covers the agreed-audit
 * sample for any subset), one absence audit per absence query, disjointness
 * rows, a label-free author-cid map, pinned source snapshots, and the final
 * fixture — assembled through the production pre-labeling helper.
 */
function honestPilotFiles(): HonestPilotFiles {
    const queries: PilotQueryDossier[] = [
        makeQuery({ qid: "p001", query: "how does the judge batch cache get invalidated", nearestOldQid: "q01", disjointnessNote: "different subsystem and invalidation lifecycle than the frozen query" }),
        makeQuery({ qid: "p002", query: "is there a persistent graph cache warmer", answerable: false, slice: "graph", nearestOldQid: "q02", disjointnessNote: "absence question about a warmer the frozen corpus never asks about" }),
        ...HONEST_ANSWERABLE_QIDS.filter((qid) => qid !== "p001").map((qid) => makeQuery({
            qid,
            query: syntheticProbeQuery(qid, true),
            nearestOldQid: "q03",
            disjointnessNote: "probe wording and subsystem are disjoint from every frozen query",
        })),
        ...HONEST_ABSENCE_QIDS.filter((qid) => qid !== "p002").map((qid) => makeQuery({
            qid,
            query: syntheticProbeQuery(qid, false),
            answerable: false,
            slice: "graph",
            nearestOldQid: "q04",
            disjointnessNote: "absence probe about behavior the frozen corpus never asks about",
        })),
    ];
    const answerableQids = new Set(HONEST_ANSWERABLE_QIDS);
    const authorEntries = queries.map((query, index) => ({
        qid: query.qid,
        authorCid: `${query.qid}-c01`,
        file: index === 0 ? "src/example.ts" : "src/big.ts",
        startLine: index === 0 ? 1 : index + 1,
        endLine: index === 0 ? 5 : index + 5,
        symbol: null as string | null,
    }));
    const assembly = assemblePilotDossiers({
        queryRows: queries,
        authorCandidateRows: authorEntries,
        repoDir: fixtureRepo.dir,
        testOnlyRefOverride: fixtureRepo.ref,
    });
    const finalLabels = new Map<string, PilotLabel>();
    for (const candidate of assembly.candidates) {
        finalLabels.set(candidate.cid, answerableQids.has(candidate.qid) ? "gold" : "hard_negative");
    }
    const labelsA = assembly.candidates.map((candidate) => makeAssessment(candidate, "A", finalLabels.get(candidate.cid)!));
    const labelsB = assembly.candidates.map((candidate) => makeAssessment(candidate, "B", finalLabels.get(candidate.cid)!));
    const adjudications = assembly.candidates.map((candidate) => {
        const label = finalLabels.get(candidate.cid)!;
        return makeAdjudication(candidate, label, label, label);
    });
    return {
        "pilot-queries.jsonl": queries,
        "pilot-candidates.jsonl": [...assembly.candidates],
        "labels-a.jsonl": labelsA,
        "labels-b.jsonl": labelsB,
        "adjudications.jsonl": adjudications,
        "pilot-absence-audits.jsonl": HONEST_ABSENCE_QIDS.map((qid) => makeAbsenceAudit(qid)),
        "pilot-disjointness.jsonl": queries.map((query) => ({
            qid: query.qid,
            nearestOldQid: query.nearestOldQid,
            disjointnessNote: query.disjointnessNote,
        })),
        "pilot-author-cid-map.jsonl": [...assembly.authorCidMap],
        "pilot-source-snapshots.jsonl": [...assembly.sourceSnapshots],
        "pilot-fixture.jsonl": assembly.candidates.map((candidate) => ({
            cid: candidate.cid,
            qid: candidate.qid,
            file: candidate.file,
            startLine: candidate.startLine,
            endLine: candidate.endLine,
            label: finalLabels.get(candidate.cid)!,
        })),
    };
}

/**
 * Drop one absence query (and every artifact that references it or its
 * candidate) from an otherwise fully consistent honest corpus, so the only
 * check that can fail afterwards is the frozen composition (40 = 32 + 8).
 */
function honestFilesWithout(files: HonestPilotFiles, qid: string): HonestPilotFiles {
    const removedCids = new Set(
        files["pilot-candidates.jsonl"].filter((candidate) => candidate.qid === qid).map((candidate) => candidate.cid),
    );
    return {
        "pilot-queries.jsonl": files["pilot-queries.jsonl"].filter((query) => query.qid !== qid),
        "pilot-candidates.jsonl": files["pilot-candidates.jsonl"].filter((candidate) => candidate.qid !== qid),
        "labels-a.jsonl": files["labels-a.jsonl"].filter((row) => !removedCids.has(row.cid)),
        "labels-b.jsonl": files["labels-b.jsonl"].filter((row) => !removedCids.has(row.cid)),
        "adjudications.jsonl": files["adjudications.jsonl"].filter((row) => !removedCids.has(row.cid)),
        "pilot-absence-audits.jsonl": files["pilot-absence-audits.jsonl"].filter((row) => row.qid !== qid),
        "pilot-disjointness.jsonl": files["pilot-disjointness.jsonl"].filter((row) => row.qid !== qid),
        "pilot-author-cid-map.jsonl": files["pilot-author-cid-map.jsonl"].filter((row) => !removedCids.has(row.cid)),
        "pilot-source-snapshots.jsonl": files["pilot-source-snapshots.jsonl"].filter((row) => !removedCids.has(row.cid)),
        "pilot-fixture.jsonl": files["pilot-fixture.jsonl"].filter((row) => !removedCids.has(row.cid)),
    };
}

function writePilotRoot(files: Record<string, readonly unknown[] | string>): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "method-pilot-seal-")));
    for (const [path, rows] of Object.entries(files)) {
        writeFileSync(join(root, path), typeof rows === "string" ? rows : serializePilotJsonl(rows));
    }
    return root;
}

/** Options for the `__test__sealPilotCorpusFromRoot` seam: local fixture ref; composition bypassed. */
function testSealOptions(): { repoDir: string; testOnlyRefOverride: string } {
    return { repoDir: fixtureRepo.dir, testOnlyRefOverride: fixtureRepo.ref };
}

describe("seal from validated data (production root entry point)", () => {
    it("rejects placeholder-artifact contents instead of sealing them", () => {
        const files: Record<string, string> = Object.fromEntries(
            PILOT_REQUIRED_ARTIFACT_PATHS.map((path) => [path, `{"artifact":"${path}"}\n`]),
        );
        const root = writePilotRoot(files);
        try {
            expect(() => sealPilotCorpusFromRoot(root, { repoDir: fixtureRepo.dir }))
                .toThrow(/invalid query dossier at index 0 in pilot-queries\.jsonl/);
            expect(existsSync(join(root, PILOT_MANIFEST_SIDECAR_FILE))).toBe(false);
            expect(existsSync(join(root, PILOT_MANIFEST_SIDECAR_PATH))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects a label-bearing author-cid map row", () => {
        const files = honestPilotFiles();
        files["pilot-author-cid-map.jsonl"] = files["pilot-author-cid-map.jsonl"]
            .map((row) => ({ ...row, label: "gold" as const }));
        const root = writePilotRoot(files);
        try {
            expect(() => sealPilotCorpusFromRoot(root, { repoDir: fixtureRepo.dir }))
                .toThrow(/invalid author cid map row at index 0 in pilot-author-cid-map\.jsonl/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects a final-fixture label that differs from the adjudicated/agreed label", () => {
        const files = honestPilotFiles();
        const [first, ...rest] = files["pilot-fixture.jsonl"];
        const flipped: PilotLabel = first!.label === "gold" ? "hard_negative" : "gold";
        files["pilot-fixture.jsonl"] = [{ ...first!, label: flipped }, ...rest];
        const root = writePilotRoot(files);
        try {
            expect(() => sealPilotCorpusFromRoot(root, { repoDir: fixtureRepo.dir }))
                .toThrow(/pilot fixture label mismatch for candidate/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects an absence query with no absence audit", () => {
        const files = honestPilotFiles();
        files["pilot-absence-audits.jsonl"] = [];
        const root = writePilotRoot(files);
        try {
            expect(() => sealPilotCorpusFromRoot(root, { repoDir: fixtureRepo.dir }))
                .toThrow(/absence query p002 has no absence audit/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    frozenCorpusIt("the public seal cannot use another ref — the frozen pin is the only production ref", () => {
        const root = writePilotRoot(honestPilotFiles());
        try {
            // Type level: SealPilotCorpusOptions has no testOnlyRefOverride, so a
            // caller cannot express a seal-ref override on the public entry point
            // (typecheck fails if that option ever returns).
            expect(() => sealPilotCorpusFromRoot(root, {
                repoDir: fixtureRepo.dir,
                // @ts-expect-error — the public seal has no test-only ref override
                testOnlyRefOverride: fixtureRepo.ref,
            })).toThrow(new RegExp(`git show failed for ${PILOT_SOURCE_REF}`));
            // Runtime: a smuggled extra field is ignored — the seal still
            // materializes at PILOT_SOURCE_REF (absent from the fixture repo),
            // so nothing is written.
            expect(existsSync(join(root, PILOT_MANIFEST_SIDECAR_FILE))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects an author-cid map that does not cover every candidate", () => {
        const files = honestPilotFiles();
        files["pilot-author-cid-map.jsonl"] = files["pilot-author-cid-map.jsonl"].slice(1);
        const root = writePilotRoot(files);
        try {
            expect(() => sealPilotCorpusFromRoot(root, { repoDir: fixtureRepo.dir }))
                .toThrow(/has no author cid map row/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects a disjointness row that does not match its query dossier", () => {
        const files = honestPilotFiles();
        files["pilot-disjointness.jsonl"] = files["pilot-disjointness.jsonl"].map((row, index) =>
            index === 0 ? { ...row, disjointnessNote: "a note that is not in the query dossier" } : row);
        const root = writePilotRoot(files);
        try {
            expect(() => sealPilotCorpusFromRoot(root, { repoDir: fixtureRepo.dir }))
                .toThrow(/disjointness row for query p001 does not match its query dossier/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects labeler B rows sealed under labels-a.jsonl", () => {
        const files = honestPilotFiles();
        files["labels-a.jsonl"] = files["labels-b.jsonl"];
        const root = writePilotRoot(files);
        try {
            expect(() => sealPilotCorpusFromRoot(root, { repoDir: fixtureRepo.dir }))
                .toThrow(/labels-a\.jsonl row at index 0 is from labeler B/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("seal from validated data: an honest corpus seals and verifies on load", () => {
    frozenCorpusIt("seals an honest synthetic corpus and loads a verified, branded read-only roster", () => {
        const files = honestPilotFiles();
        const root = writePilotRoot(files);
        try {
            const sealed = __test__sealPilotCorpusFromRoot(root, testSealOptions());
            expect(sealed.manifest.sourceRef).toBe(fixtureRepo.ref);
            expect(sealed.manifest.testOnlyRefOverride).toBe(true);
            expect(sealed.sidecar).toBe(__test__pilotManifestSidecar(sealed.manifestBytes));
            expect(readFileSync(sealed.manifestPath, "utf8")).toBe(sealed.manifestBytes);
            expect(readFileSync(sealed.sidecarPath, "utf8")).toBe(sealed.sidecar);

            const roster = loadVerifiedPilotCorpus(root);
            expect(roster.sourceRef).toBe(fixtureRepo.ref);
            expect(roster.queries).toHaveLength(PILOT_EXPECTED_QUERY_COUNT);
            expect(roster.queries.slice(0, 2)).toEqual([
                { qid: "p001", answerable: true },
                { qid: "p002", answerable: false },
            ]);
            expect(roster.queries.filter((query) => query.answerable)).toHaveLength(PILOT_EXPECTED_ANSWERABLE);
            expect(roster.queries.filter((query) => !query.answerable)).toHaveLength(PILOT_EXPECTED_ABSENCE);
            expect(roster.candidates.map((candidate) => candidate.cid))
                .toEqual(files["pilot-candidates.jsonl"].map((candidate) => candidate.cid));
            expect(roster.candidates).toHaveLength(PILOT_EXPECTED_QUERY_COUNT);
            const gold = roster.candidates.find((candidate) => candidate.file === "src/example.ts" && candidate.startLine === 1);
            expect(gold?.label).toBe("gold");
            expect(roster.candidates.filter((candidate) => candidate.qid === "p002")
                .every((candidate) => candidate.label !== "gold")).toBe(true);
            expect(roster.manifestSha256).toBe(createHash("sha256").update(sealed.manifestBytes, "utf8").digest("hex"));
            expect(Object.isFrozen(roster)).toBe(true);
            expect(Object.isFrozen(roster.queries)).toBe(true);
            expect(Object.isFrozen(roster.candidates)).toBe(true);
            expect(Object.isFrozen(roster.candidates[0])).toBe(true);
            // Honest corpus brands and passes: a load-produced roster carries the
            // runtime brand checked by isVerifiedPilotCorpusRoster.
            expect(isVerifiedPilotCorpusRoster(roster)).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    frozenCorpusIt("re-verifies the sealed root and rejects any modified artifact byte at load", () => {
        const root = writePilotRoot(honestPilotFiles());
        try {
            __test__sealPilotCorpusFromRoot(root, testSealOptions());
            const labelsAPath = join(root, "labels-a.jsonl");
            writeFileSync(labelsAPath, `${readFileSync(labelsAPath, "utf8")} `);
            expect(() => loadVerifiedPilotCorpus(root))
                .toThrow(/pilot artifact digest mismatch: labels-a\.jsonl/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    frozenCorpusIt("rejects tampered manifest bytes against the sidecar at load", () => {
        const root = writePilotRoot(honestPilotFiles());
        try {
            __test__sealPilotCorpusFromRoot(root, testSealOptions());
            const manifestPath = join(root, PILOT_MANIFEST_SIDECAR_FILE);
            writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace("{", "{ "));
            expect(() => loadVerifiedPilotCorpus(root)).toThrow(/sidecar mismatch/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("assemblePilotDossiers (pre-labeling assembly, never seals)", () => {
    const queries = [makeQuery()];
    const authorEntries = [
        { qid: "p001", authorCid: "p001-c02", file: "src/example.ts", startLine: 6, endLine: 10, symbol: null },
        { qid: "p001", authorCid: "p001-c01", file: "src/example.ts", startLine: 1, endLine: 5, symbol: null },
    ];

    it("stamps neutral ids in canonical order with the author map and pinned snapshots", () => {
        const assembly = assemblePilotDossiers({
            queryRows: queries,
            authorCandidateRows: authorEntries,
            repoDir: fixtureRepo.dir,
            testOnlyRefOverride: fixtureRepo.ref,
        });
        // Assembly output is data only: no manifest bytes, no seal products.
        expect(Object.keys(assembly).sort()).toEqual(["authorCidMap", "candidates", "queries", "sourceSnapshots"]);
        expect(assembly.candidates.map((candidate) => candidate.cid))
            .toEqual(orderCandidates(assembly.candidates).map((candidate) => candidate.cid));
        expect(assembly.candidates.every((candidate) => /^c[0-9a-f]{12}$/.test(candidate.cid))).toBe(true);
        expect(assembly.authorCidMap).toEqual(buildAuthorCidMap(authorEntries));
        expect(assembly.authorCidMap.map((row) => row.authorCid)).toEqual(["p001-c01", "p001-c02"]);
        assembly.sourceSnapshots.forEach((snapshot, index) => {
            const candidate = assembly.candidates[index]!;
            expect(snapshot.cid).toBe(candidate.cid);
            expect(snapshot.excerpt).toContain(`${candidate.file}:${candidate.startLine}-${candidate.endLine}`);
        });
    });

    it("fails closed on invalid rows, duplicate and unknown query references", () => {
        const base = { queryRows: queries, authorCandidateRows: authorEntries, repoDir: fixtureRepo.dir, testOnlyRefOverride: fixtureRepo.ref };
        expect(() => assemblePilotDossiers({ ...base, queryRows: [{ artifact: "x" }] }))
            .toThrow(/invalid query dossier at index 0/);
        expect(() => assemblePilotDossiers({ ...base, queryRows: [queries[0], queries[0]] }))
            .toThrow(/duplicate query qid p001/);
        expect(() => assemblePilotDossiers({ ...base, queryRows: [] }))
            .toThrow(/requires at least one query dossier/);
        expect(() => assemblePilotDossiers({ ...base, authorCandidateRows: [{ artifact: "x" }] }))
            .toThrow(/invalid author candidate entry at index 0/);
        expect(() => assemblePilotDossiers({
            ...base,
            authorCandidateRows: [{ ...authorEntries[0], qid: "p999", authorCid: "p999-c02" }],
        })).toThrow(/references unknown qid p999/);
        const firstAuthorCid = authorEntries[0]!.authorCid;
        expect(() => assemblePilotDossiers({
            ...base,
            authorCandidateRows: [authorEntries[0], { ...authorEntries[1], authorCid: firstAuthorCid }],
        })).toThrow(/duplicate author cid/);
    });
});

describe("frozen composition, production-seal disjointness, and the roster brand (A1 contract)", () => {
    it("refuses a 39-query corpus at the production seal", () => {
        const root = writePilotRoot(honestFilesWithout(honestPilotFiles(), "p040"));
        try {
            expect(() => sealPilotCorpusFromRoot(root, { repoDir: fixtureRepo.dir }))
                .toThrow(/exactly 40 queries = 32 answerable \+ 8 absence; found 39 queries = 32 answerable \+ 7 absence/);
            expect(existsSync(join(root, PILOT_MANIFEST_SIDECAR_FILE))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses a 41-query corpus at the production seal", () => {
        const files = honestPilotFiles();
        const extra = makeQuery({
            qid: "p041",
            query: syntheticProbeQuery("p041", true),
            nearestOldQid: "q03",
            disjointnessNote: "probe wording and subsystem are disjoint from every frozen query",
        });
        const root = writePilotRoot({
            ...files,
            "pilot-queries.jsonl": [...files["pilot-queries.jsonl"], extra],
            "pilot-disjointness.jsonl": [
                ...files["pilot-disjointness.jsonl"],
                { qid: extra.qid, nearestOldQid: extra.nearestOldQid, disjointnessNote: extra.disjointnessNote },
            ],
        });
        try {
            expect(() => sealPilotCorpusFromRoot(root, { repoDir: fixtureRepo.dir }))
                .toThrow(/exactly 40 queries = 32 answerable \+ 8 absence; found 41 queries = 33 answerable \+ 8 absence/);
            expect(existsSync(join(root, PILOT_MANIFEST_SIDECAR_FILE))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses a hand-constructed structural roster at the brand check; only the test seam brands", () => {
        const fake: PilotCorpusRoster = {
            queries: [{ qid: "p001", answerable: true }],
            candidates: [{ cid: "c000000000000", qid: "p001", file: "src/a.ts", startLine: 1, endLine: 5, label: "gold" }],
            sourceRef: PILOT_SOURCE_REF,
            manifestSha256: "0".repeat(64),
        };
        expect(isVerifiedPilotCorpusRoster(fake)).toBe(false);
        expect(isVerifiedPilotCorpusRoster(null)).toBe(false);
        expect(isVerifiedPilotCorpusRoster(undefined)).toBe(false);
        expect(isVerifiedPilotCorpusRoster({})).toBe(false);
        expect(__test__brandPilotCorpusRoster(fake)).toBe(fake);
        expect(isVerifiedPilotCorpusRoster(fake)).toBe(true);
    });

    frozenCorpusIt("refuses a query duplicating frozen q01 at the production seal", () => {
        const frozenQ01 = loadFrozenPilotQueries().find((entry) => entry.qid === "q01");
        expect(frozenQ01).toBeDefined();
        const files = honestPilotFiles();
        files["pilot-queries.jsonl"] = files["pilot-queries.jsonl"].map((query, index) =>
            index === 0 ? { ...query, query: frozenQ01!.query } : query,
        );
        const root = writePilotRoot(files);
        try {
            expect(() => sealPilotCorpusFromRoot(root, { repoDir: fixtureRepo.dir }))
                .toThrow(/query p001 exactly duplicates frozen query q01/);
            expect(existsSync(join(root, PILOT_MANIFEST_SIDECAR_FILE))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    frozenCorpusIt("load enforces composition even though the __test__ seal seam bypasses it", () => {
        const root = writePilotRoot(honestFilesWithout(honestPilotFiles(), "p040"));
        try {
            const sealed = __test__sealPilotCorpusFromRoot(root, testSealOptions());
            expect(sealed.manifest.testOnlyRefOverride).toBe(true);
            expect(() => loadVerifiedPilotCorpus(root))
                .toThrow(/exactly 40 queries = 32 answerable \+ 8 absence; found 39 queries = 32 answerable \+ 7 absence/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("disjointness audit-note enforcement (schema + seal)", () => {
    it("refuses a whitespace-only disjointness note where an audit note is required", () => {
        const files = honestPilotFiles();
        files["pilot-queries.jsonl"] = files["pilot-queries.jsonl"].map((query) =>
            query.qid === "p001" ? { ...query, nearestOldQid: "qZZ", disjointnessNote: "   " } : query);
        const root = writePilotRoot(files);
        try {
            // The dossier schema refuses the blank note before any seal stage runs.
            expect(() => sealPilotCorpusFromRoot(root, { repoDir: fixtureRepo.dir }))
                .toThrow(/invalid query dossier at index 0 in pilot-queries\.jsonl/);
            expect(existsSync(join(root, PILOT_MANIFEST_SIDECAR_FILE))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    frozenCorpusIt("treats an unknown nearest-old qid as advisory when a real audit note is present", () => {
        const files = honestPilotFiles();
        files["pilot-queries.jsonl"] = files["pilot-queries.jsonl"].map((query) =>
            query.qid === "p001" ? { ...query, nearestOldQid: "qZZ" } : query);
        files["pilot-disjointness.jsonl"] = files["pilot-disjointness.jsonl"].map((row) =>
            row.qid === "p001" ? { ...row, nearestOldQid: "qZZ" } : row);
        const root = writePilotRoot(files);
        try {
            const sealed = __test__sealPilotCorpusFromRoot(root, testSealOptions());
            expect(sealed.manifest.sourceRef).toBe(fixtureRepo.ref);
            expect(existsSync(join(root, PILOT_MANIFEST_SIDECAR_FILE))).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
