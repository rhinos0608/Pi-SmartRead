import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCertifiedGraderContext, GraderContextLoadError } from "../../../scripts/eval/inspect-cohort/context-loader.js";
import { gradeInspectTask } from "../../../scripts/eval/inspect-cohort/grade.js";
import type { InspectTask } from "../../../scripts/eval/inspect-cohort/schema.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const SHA = "c".repeat(64);
const task: InspectTask = {
    id: "insp-pilot-P1-001", split: "pilot", repo: "owner__name", commit: "a".repeat(40),
    subpath: "packages/core", family: "P1", prompt: "List routes.", scope: "src",
    answerType: "route-set", gold: { kind: "route-set", routes: [{ method: "GET", path: "/ok", file: "src/a.ts", line: 1 }], minRecall: 1, minPrecision: 1 },
    candidateUniverse: { id: "u1", sha256: SHA, count: 1 }, decoys: ["comment"], negativeControl: false,
    derivation: "independent fixture", agreement: "agree", labelers: ["one", "two"], adjudication: "agree",
    snapshot: { head: "b".repeat(40), clean: true },
};
const dirs: string[] = [];
async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), "inspect-loader-")); dirs.push(root);
    const checkout = path.join(root, "repo"); await mkdir(path.join(checkout, "packages/core/src"), { recursive: true });
    const source = Buffer.from("app.get('/ok', handler);\n"); await writeFile(path.join(checkout, "packages/core/src/a.ts"), source);
    execFileSync("git", ["init", "-q"], { cwd: checkout });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", "."], { cwd: checkout });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd: checkout });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
    const fixtureTask = { ...task, commit: head, snapshot: { head, clean: true } };
    const manifest = { version: 1, repo: task.repo, commit: head, head, clean: true, tasks: { [task.id]: {
        binding: { repo: task.repo, commit: head, subpath: task.subpath, scope: task.scope, snapshotHead: head, snapshotClean: true },
        universe: { id: "u1", sha256: SHA, count: 1, files: ["src/a.ts"] }, sourceLines: { "src/a.ts": 1 }, trackedFiles: ["src/a.ts"],
        certifiedRoutes: [{ method: "GET", path: "/ok", file: "src/a.ts", line: 1 }], certifiedRelations: [], certifiedEdges: [], completeness: { complete: true },
    } }, sourceDigests: { "packages/core/src/a.ts": hash(source) }, goldSha256: { pilot: hash("gold fixture") } };
    const manifestPath = path.join(root, "manifest.json"), goldPath = path.join(root, "gold.jsonl");
    const bytes = JSON.stringify(manifest); await writeFile(manifestPath, bytes); await chmod(manifestPath, 0o600);
    await writeFile(goldPath, "gold fixture"); await chmod(goldPath, 0o600);
    return { checkout, manifestPath, goldPath, manifestHash: hash(bytes), fixtureTask };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const load = (f: Awaited<ReturnType<typeof fixture>>, pin = f.manifestHash) => loadCertifiedGraderContext({ task: f.fixtureTask, checkoutPath: f.checkout, manifestPath: f.manifestPath, expectedManifestSha256: pin, goldPath: f.goldPath });

describe("loadCertifiedGraderContext", () => {
    it("verifies pinned snapshot, manifest/gold provenance and source digests", async () => {
        const f = await fixture(), context = await load(f);
        expect(context.tasks[f.fixtureTask.id]?.manifestRef).toBe(f.manifestHash);
        expect(context.tasks[f.fixtureTask.id]?.certifiedRoutes).toHaveLength(1);
    });
    it("fails closed when manifest provenance digest differs", async () => {
        const f = await fixture();
        await expect(load(f, SHA)).rejects.toMatchObject({ code: "manifest-digest-mismatch" });
    });
    it("fails closed when a cited source digest differs", async () => {
        const f = await fixture();
        const manifest = JSON.parse(await readFile(f.manifestPath, "utf8")); manifest.sourceDigests["packages/core/src/a.ts"] = SHA;
        const bytes = JSON.stringify(manifest); await writeFile(f.manifestPath, bytes); await chmod(f.manifestPath, 0o600);
        await expect(load({ ...f, manifestHash: hash(bytes) })).rejects.toMatchObject({ code: "source-digest-mismatch" });
    });
    it.each([
        ["missing binding", (entry: Record<string, unknown>) => { delete entry.binding; }],
        ["wrong trackedFiles type", (entry: Record<string, unknown>) => { entry.trackedFiles = "src/a.ts"; }],
        ["unknown context field", (entry: Record<string, unknown>) => { entry.unexpected = true; }],
    ])("fails with a typed error for malformed task context: %s", async (_label, mutate) => {
        const f = await fixture();
        const manifest = JSON.parse(await readFile(f.manifestPath, "utf8"));
        mutate(manifest.tasks[f.fixtureTask.id]);
        const bytes = JSON.stringify(manifest); await writeFile(f.manifestPath, bytes); await chmod(f.manifestPath, 0o600);
        await expect(load({ ...f, manifestHash: hash(bytes) })).rejects.toMatchObject({ code: "task-context-malformed" });
    });
    it("grades cannot-establish with boundary citation as unknown through the certified loader", async () => {
        const f = await fixture();
        const unknownTask = { ...f.fixtureTask, id: "insp-pilot-P4-001", family: "P4" as const, answerType: "conclusion" as const,
            gold: { kind: "conclusion" as const, verdict: "cannot-establish" as const, reason: "decorator routing is outside supported syntax", scope: "src", path: [] } };
        const manifest = JSON.parse(await readFile(f.manifestPath, "utf8"));
        manifest.tasks = { [unknownTask.id]: { ...manifest.tasks[f.fixtureTask.id], certifiedRoutes: [], requestedEndpoints: { from: "src/a.ts", to: "src/b.ts" } } };
        const bytes = JSON.stringify(manifest); await writeFile(f.manifestPath, bytes); await chmod(f.manifestPath, 0o600);
        const context = await loadCertifiedGraderContext({ task: unknownTask, checkoutPath: f.checkout, manifestPath: f.manifestPath, expectedManifestSha256: hash(bytes), goldPath: f.goldPath });
        const result = gradeInspectTask(unknownTask, { verdict: "cannot-establish", reason: "decorator routing is outside supported syntax", scope: "src", path: [] }, context);
        expect(result.status).toBe("graded");
        expect(result.pass).toBe(true);
        expect(result.predicted).toBe("unknown");
    });
    it("rejects missing source digest entries and unclean snapshots", async () => {
        const f = await fixture();
        const manifest = JSON.parse(await readFile(f.manifestPath, "utf8")); manifest.clean = false;
        let bytes = JSON.stringify(manifest); await writeFile(f.manifestPath, bytes); await chmod(f.manifestPath, 0o600);
        await expect(load({ ...f, manifestHash: hash(bytes) })).rejects.toMatchObject({ code: "unclean-snapshot" });
        manifest.clean = true; delete manifest.sourceDigests["packages/core/src/a.ts"];
        bytes = JSON.stringify(manifest); await writeFile(f.manifestPath, bytes); await chmod(f.manifestPath, 0o600);
        await expect(load({ ...f, manifestHash: hash(bytes) })).rejects.toBeInstanceOf(GraderContextLoadError);
    });
});
