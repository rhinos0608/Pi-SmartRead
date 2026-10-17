/**
 * TEB root-cleanliness preflight tests (temp git repos only; no
 * network): before a pinned checkout is copied into a session scratch
 * dir, `git status --porcelain --ignored` must be EMPTY, and the
 * scratch copy must carry no `.pi-smartread*` entries. Fail closed:
 * refusals list the offending paths and never delete them.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type PiSpawnFn } from "../../../scripts/eval/teb/launch.js";
import {
    checkCheckoutCleanliness,
    findStateEntries,
    parseTebRunArgs,
    runTebCli,
} from "../../../scripts/eval/teb/run.js";
import { type TebTask } from "../../../scripts/eval/teb/schema.js";

function git(dir: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function commitAll(dir: string): string {
    git(dir, "add", "-A");
    git(dir, "-c", "user.email=teb@test", "-c", "user.name=teb", "commit", "-m", "update", "--quiet");
    return git(dir, "rev-parse", "HEAD");
}

/** Real git checkout at dir/name with one committed file; returns its HEAD sha. */
function makeCleanRepo(dir: string, name = "fake__repo"): { repo: string; sha: string } {
    const repo = join(dir, name);
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "--quiet");
    writeFileSync(join(repo, "a.ts"), "const x = 1;\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.email=teb@test", "-c", "user.name=teb", "commit", "-m", "init", "--quiet");
    return { repo, sha: git(repo, "rev-parse", "HEAD") };
}

/** Minimal pilot task pinned to a real checkout sha (shape per teb-run.test.ts). */
function definitionTask(sha: string): TebTask {
    return {
        id: "teb-pilot-definition-001",
        split: "pilot",
        repo: "fake__repo",
        commit: sha,
        subpath: "src",
        family: "definition",
        prompt: "Where is symbol `foo`, as spelled at src/a.ts:3:7, defined?",
        useSite: { path: "src/a.ts", line: 3, character: 7 },
        anchorKind: "use",
        scope: "",
        answerType: "single-location",
        gold: { kind: "single-location", location: { path: "src/b.ts", line: 42, character: 9 } },
        opportunity: { tools: ["LSP"], rationale: "Exact jump in one call." },
        negativeControl: false,
        derivation: "probe v1",
        agreement: "agree",
        labelers: ["alice", "bob"],
        adjudication: "agree",
    };
}

/** Immediate clean exit with no output: enough to prove spawn happened. */
const fakeSpawn: PiSpawnFn = () => ({
    stdout: (async function* () {})(),
    stderr: null,
    pid: undefined,
    on: (event: string, listener: (...args: never[]) => void) => {
        if (event === "exit") queueMicrotask(() => (listener as () => void)());
    },
    kill: () => true,
});

interface SessionRow {
    taskId: string;
    commitVerified: boolean;
    error: string | null;
    infraFailure: { kind: string; detail: string } | null;
}

/** Run one pilot task against TEB_REPOS_DIR=<dir>/repos with a counting fake pi. */
async function runPilot(
    dir: string,
    sha: string,
): Promise<{ spawned: number; sessions: SessionRow[]; runDir: string }> {
    const repos = join(dir, "repos");
    process.env["TEB_REPOS_DIR"] = repos;
    try {
        const tasksFile = join(dir, "tasks.jsonl");
        writeFileSync(tasksFile, `${JSON.stringify(definitionTask(sha))}\n`);
        let spawned = 0;
        const spawnFn: PiSpawnFn = (opts) => {
            spawned += 1;
            return fakeSpawn(opts);
        };
        const { runDir } = await runTebCli(
            parseTebRunArgs([
                "--tasks", tasksFile, "--split", "pilot",
                "--out", join(dir, "out"), "--replicates", "1",
            ]),
            { spawnFn, extensionPath: join(dir, "index.ts"), piVersion: "test" },
        );
        const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")) as {
            sessions: SessionRow[];
        };
        expect(manifest.sessions).toHaveLength(1);
        return { spawned, sessions: manifest.sessions, runDir };
    } finally {
        delete process.env["TEB_REPOS_DIR"];
    }
}

describe("checkCheckoutCleanliness (pre-copy preflight)", () => {
    it("passes on a clean committed checkout", () => {
        const root = mkdtempSync(join(tmpdir(), "teb-clean-"));
        const { repo } = makeCleanRepo(root);
        expect(checkCheckoutCleanliness(repo)).toEqual({ clean: true, paths: [], error: null });
    });

    it("refuses a stray .pi-smartread/ dir with the offending path listed", () => {
        const root = mkdtempSync(join(tmpdir(), "teb-dirty-"));
        const { repo } = makeCleanRepo(root);
        mkdirSync(join(repo, ".pi-smartread"));
        writeFileSync(join(repo, ".pi-smartread", "index.json"), "{}\n");
        const result = checkCheckoutCleanliness(repo);
        expect(result.clean).toBe(false);
        expect(result.error).toBeNull();
        expect(result.paths.join("\n")).toContain(".pi-smartread");
    });

    it("refuses an ignored file with the offending path listed", () => {
        const root = mkdtempSync(join(tmpdir(), "teb-ignored-"));
        const { repo } = makeCleanRepo(root);
        writeFileSync(join(repo, ".gitignore"), "*.log\n");
        commitAll(repo);
        expect(checkCheckoutCleanliness(repo).clean).toBe(true);
        writeFileSync(join(repo, "stray.log"), "noise\n");
        const result = checkCheckoutCleanliness(repo);
        expect(result.clean).toBe(false);
        expect(result.paths.join("\n")).toContain("stray.log");
    });

    it("fails closed when the checkout is not a git repo", () => {
        const plain = mkdtempSync(join(tmpdir(), "teb-nogit-"));
        const result = checkCheckoutCleanliness(plain);
        expect(result.clean).toBe(false);
        expect(result.paths).toEqual([]);
        expect(result.error).toContain("git status --porcelain --ignored");
    });
});

describe("findStateEntries (post-copy verify)", () => {
    it("finds .pi-smartread* files and dirs at any depth, sorted", () => {
        const root = mkdtempSync(join(tmpdir(), "teb-state-"));
        mkdirSync(join(root, "src", "lsp", ".pi-smartread"), { recursive: true });
        mkdirSync(join(root, ".pi-smartread.tags.cache"), { recursive: true });
        writeFileSync(join(root, "src", "lsp", ".pi-smartread", "x.json"), "{}\n");
        writeFileSync(join(root, ".pi-smartread.tags.cache", "tags.json"), "[]\n");
        writeFileSync(join(root, "src", "lsp", "a.ts"), "const x = 1;\n");
        expect(findStateEntries(root)).toEqual([
            join(root, ".pi-smartread.tags.cache"),
            join(root, "src", "lsp", ".pi-smartread"),
        ]);
    });

    it("returns nothing for a tree without SmartRead state", () => {
        const root = mkdtempSync(join(tmpdir(), "teb-nostate-"));
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "a.ts"), "const x = 1;\n");
        expect(findStateEntries(root)).toEqual([]);
    });
});

describe("pre-session root-cleanliness gate in runTebCli (fail closed)", () => {
    it("runs a clean checkout: clean passes", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-gate-clean-"));
        const { sha } = makeCleanRepo(join(dir, "repos"));
        const { spawned, sessions } = await runPilot(dir, sha);
        expect(spawned).toBe(1);
        expect(sessions[0]?.commitVerified).toBe(true);
        expect(sessions[0]?.error).toBeNull();
    });

    it("refuses a stray .pi-smartread/ checkout before spawning, listing the paths, without deleting them", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-gate-stray-"));
        const { repo, sha } = makeCleanRepo(join(dir, "repos"));
        mkdirSync(join(repo, ".pi-smartread"));
        writeFileSync(join(repo, ".pi-smartread", "index.json"), "{}\n");
        const { spawned, sessions, runDir } = await runPilot(dir, sha);
        expect(spawned).toBe(0);
        expect(sessions[0]?.commitVerified).toBe(false);
        expect(sessions[0]?.error).toContain(".pi-smartread");
        // No auto-delete: the offending entries remain in the checkout.
        expect(existsSync(join(repo, ".pi-smartread", "index.json"))).toBe(true);
        // Refusal artifact carries the offending paths too.
        const artifact = join(runDir, "teb-pilot-definition-001", "baseline-r0", "error.txt");
        expect(readFileSync(artifact, "utf8")).toContain(".pi-smartread");
    });

    it("refuses a checkout with an ignored file before spawning, listing it", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-gate-ignored-"));
        const { repo } = makeCleanRepo(join(dir, "repos"));
        writeFileSync(join(repo, ".gitignore"), "*.log\n");
        const sha = commitAll(repo);
        writeFileSync(join(repo, "stray.log"), "noise\n");
        const { spawned, sessions } = await runPilot(dir, sha);
        expect(spawned).toBe(0);
        expect(sessions[0]?.commitVerified).toBe(false);
        expect(sessions[0]?.error).toContain("stray.log");
        expect(existsSync(join(repo, "stray.log"))).toBe(true);
    });

    it("refuses after cpSync when the checkout tracks .pi-smartread state", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-gate-tracked-"));
        const { repo } = makeCleanRepo(join(dir, "repos"));
        mkdirSync(join(repo, ".pi-smartread"));
        writeFileSync(join(repo, ".pi-smartread", "index.json"), "{}\n");
        const sha = commitAll(repo);
        // Committed state is invisible to the porcelain preflight, so
        // only the post-copy .pi-smartread* verify can refuse it.
        expect(checkCheckoutCleanliness(repo).clean).toBe(true);
        const { spawned, sessions } = await runPilot(dir, sha);
        expect(spawned).toBe(0);
        expect(sessions[0]?.error).toContain("scratch copy contains .pi-smartread*");
    });
});
