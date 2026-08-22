/**
 * Tests for inspect diff internals (runGitDiff, renderDiffSection) and callDepth default direction.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    runGitDiff,
    renderDiffSection,
    executeFileInspect,
} from "../../src/inspect.js";

function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

describe("inspect diff internals", () => {
    let repoRoot: string;
    let nonRepoDir: string;

    beforeEach(() => {
        repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "inspect-diff-test-")));
        git(repoRoot, ["init"]);
        git(repoRoot, ["config", "user.name", "Test User"]);
        git(repoRoot, ["config", "user.email", "test@example.com"]);

        nonRepoDir = realpathSync(mkdtempSync(join(tmpdir(), "inspect-diff-nogit-")));
    });

    afterEach(() => {
        rmSync(repoRoot, { recursive: true, force: true });
        rmSync(nonRepoDir, { recursive: true, force: true });
    });

    describe("runGitDiff", () => {
        it("returns null for non-git directory", async () => {
            const result = await runGitDiff("unstaged", nonRepoDir);
            expect(result).toBeNull();
        });

        it("returns empty array for clean repo", async () => {
            writeFileSync(join(repoRoot, "test.ts"), "export const x = 1;\n");
            git(repoRoot, ["add", "."]);
            git(repoRoot, ["commit", "-m", "initial"]);
            const result = await runGitDiff("unstaged", repoRoot);
            expect(result).toEqual([]);
        });

        it("returns changes for unstaged modifications", async () => {
            writeFileSync(join(repoRoot, "test.ts"), "export const x = 1;\n");
            git(repoRoot, ["add", "."]);
            git(repoRoot, ["commit", "-m", "initial"]);
            writeFileSync(join(repoRoot, "test.ts"), "export const x = 1;\nexport const y = 2;\n");
            const result = await runGitDiff("unstaged", repoRoot);
            expect(result).not.toBeNull();
            const changes = result!;
            expect(changes.length).toBe(1);
            expect(changes[0]!.file).toBe("test.ts");
            expect(changes[0]!.addedLines.length).toBeGreaterThan(0);
        });

        it("returns changes for staged modifications", async () => {
            writeFileSync(join(repoRoot, "test.ts"), "export const x = 1;\n");
            git(repoRoot, ["add", "."]);
            git(repoRoot, ["commit", "-m", "initial"]);
            writeFileSync(join(repoRoot, "test.ts"), "export const x = 1;\nexport const y = 2;\n");
            git(repoRoot, ["add", "."]);
            const result = await runGitDiff("staged", repoRoot);
            expect(result).not.toBeNull();
            const changes = result!;
            expect(changes.length).toBe(1);
            expect(changes[0]!.file).toBe("test.ts");
        });

        it("returns changes for HEAD diff (last commit)", async () => {
            writeFileSync(join(repoRoot, "test.ts"), "export const x = 1;\n");
            git(repoRoot, ["add", "."]);
            git(repoRoot, ["commit", "-m", "initial"]);
            writeFileSync(join(repoRoot, "test.ts"), "export const x = 1;\nexport const y = 2;\n");
            git(repoRoot, ["add", "."]);
            git(repoRoot, ["commit", "-m", "second"]);
            const result = await runGitDiff("HEAD", repoRoot);
            expect(result).not.toBeNull();
            const changes = result!;
            expect(changes.length).toBe(1);
            expect(changes[0]!.file).toBe("test.ts");
        });
    });

    describe("renderDiffSection", () => {
        it("returns error section for non-git directory", async () => {
            const section = await renderDiffSection("unstaged", nonRepoDir);
            expect(section.text).toContain("Error");
            expect(section.text).toContain("git repository");
        });

        it("returns diff impact section with risk classification", async () => {
            writeFileSync(join(repoRoot, "test.ts"), "export const x = 1;\n");
            git(repoRoot, ["add", "."]);
            git(repoRoot, ["commit", "-m", "initial"]);
            writeFileSync(join(repoRoot, "test.ts"),
                "export const x = 1;\nexport const y = 2;\nexport const z = 3;\n",
            );
            const section = await renderDiffSection("unstaged", repoRoot);
            expect(section.text).toContain("Diff Impact");
            expect(section.text).not.toContain("Risk Summary");
            expect(section.text).not.toContain("HIGH");
            expect(section.text).not.toContain("CRITICAL");
        });

        it("does not emit churn-based HIGH risk for many added lines", async () => {
            writeFileSync(join(repoRoot, "test.ts"), "export const x = 1;\n");
            git(repoRoot, ["add", "."]);
            git(repoRoot, ["commit", "-m", "initial"]);
            const lines = ["export const x = 1;"];
            for (let i = 0; i < 11; i++) lines.push(`export const y${i} = ${i};`);
            writeFileSync(join(repoRoot, "test.ts"), lines.join("\n") + "\n");
            const section = await renderDiffSection("unstaged", repoRoot);
            expect(section.text).not.toContain("HIGH");
            expect(section.text).not.toContain("CRITICAL");
        });

        it("does not emit churn-based CRITICAL risk for many added lines", async () => {
            writeFileSync(join(repoRoot, "test.ts"), "export const x = 1;\n");
            git(repoRoot, ["add", "."]);
            git(repoRoot, ["commit", "-m", "initial"]);
            const lines = ["export const x = 1;"];
            for (let i = 0; i < 21; i++) lines.push(`export const y${i} = ${i};`);
            writeFileSync(join(repoRoot, "test.ts"), lines.join("\n") + "\n");
            const section = await renderDiffSection("unstaged", repoRoot);
            expect(section.text).not.toContain("CRITICAL");
            expect(section.text).not.toContain("HIGH");
        });

        it("returns no-changes section for clean repo", async () => {
            writeFileSync(join(repoRoot, "test.ts"), "export const x = 1;\n");
            git(repoRoot, ["add", "."]);
            git(repoRoot, ["commit", "-m", "initial"]);
            const section = await renderDiffSection("unstaged", repoRoot);
            expect(section.text).toContain("no changes found");
        });
    });
});

describe("inspect file mode callDepth default direction", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = realpathSync(mkdtempSync(join(tmpdir(), "inspect-calldepth-")));
    });

    afterEach(() => {
        rmSync(workdir, { recursive: true, force: true });
    });

    it("produces call graph section when callDepth=2 and no callDirection (defaults to both)", async () => {
        const file = join(workdir, "test.ts");
        writeFileSync(file,
            "export function alpha() {}\nexport function beta() { alpha(); }\n",
            "utf8",
        );
        const result = await executeFileInspect({
            path: "test.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/test.jsonl",
            callDepth: 2,
        });
        expect(result.mode).toBe("file");
        expect(result.contentText).toContain("Call Graph");
        expect(result.contentText).toContain("both");
        expect(result.lineCount).toBeGreaterThan(0);
    });

    it("does not include call graph when callDepth is omitted", async () => {
        const file = join(workdir, "test.ts");
        writeFileSync(file, "export function alpha() {}\n", "utf8");
        const result = await executeFileInspect({
            path: "test.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/test.jsonl",
        });
        expect(result.contentText).not.toContain("Call Graph");
    });
});
