import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
    checkScopeAdmission,
    DEFAULT_SCOPE_LIMITS,
    enumerateBoundedScope,
} from "../../../src/inspect/inspect-bounded-scope.js";

const owned: string[] = [];
afterEach(() => {
    for (const dir of owned.splice(0)) {
        try {
            chmodSync(dir, 0o700);
            chmodSync(join(dir, "locked"), 0o700);
        } catch {
            /* best effort: locked fixtures may already be gone */
        }
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            /* best effort cleanup of test-owned scratch only */
        }
    }
});

function freshRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "bounded-scope-"));
    owned.push(dir);
    return dir;
}

function writeTree(root: string, files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
        const full = join(root, rel);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, content);
    }
}

describe("inspect bounded source-scope enumerator", () => {
    it("completes a small tree with full resource accounting", async () => {
        const root = freshRoot();
        writeTree(root, { "a.ts": "x".repeat(10), "sub/b.ts": "y".repeat(20) });
        const result = await enumerateBoundedScope(root, { limits: DEFAULT_SCOPE_LIMITS });
        expect(result.status).toBe("complete");
        expect(result.emittedFiles).toBe(2);
        expect(result.admittedBytes).toBe(30);
        expect(result.visitedDirs).toBeGreaterThanOrEqual(2);
        expect(result.omitted).toEqual([]);
        expect(result.signalChecks).toBeGreaterThan(0);
        expect(result.wallMs).toBeGreaterThanOrEqual(0);
        // Deterministic ordering policy: admitted list sorted lexicographically.
        const paths = result.files.map((f) => f.path);
        expect(paths).toEqual([...paths].sort());
    });

    it("directory-only flood stops at maxDirs with partial status and reason", async () => {
        const root = freshRoot();
        for (let i = 0; i < 10; i++) {
            mkdirSync(join(root, `d${i}`), { recursive: true });
            writeFileSync(join(root, `d${i}`, "f.ts"), "z");
        }
        const result = await enumerateBoundedScope(root, {
            limits: { ...DEFAULT_SCOPE_LIMITS, maxDirs: 3 },
        });
        expect(result.status).toBe("partial");
        expect(result.visitedDirs).toBeLessThanOrEqual(3);
        expect(result.stopReason).toMatch(/maxDirs/);
        expect(result.omitted.length).toBeGreaterThan(0);
    });

    it("entry flood stops at maxEntries with partial status and reason", async () => {
        const root = freshRoot();
        const files: Record<string, string> = {};
        for (let i = 0; i < 50; i++) files[`f${i}.ts`] = "q";
        writeTree(root, files);
        const result = await enumerateBoundedScope(root, {
            limits: { ...DEFAULT_SCOPE_LIMITS, maxEntries: 10 },
        });
        expect(result.status).toBe("partial");
        expect(result.visitedEntries).toBeLessThanOrEqual(10);
        expect(result.stopReason).toMatch(/maxEntries/);
    });

    it("depth cap and symlink loops never hang and are recorded, never followed", async () => {
        const root = freshRoot();
        writeTree(root, { "l0/l1/l2/l3/deep.ts": "deep" });
        // Symlink loop: sub/cycle -> root.
        symlinkSync(root, join(root, "l0", "cycle"), "dir");
        // Dangling external-style link.
        symlinkSync(join(root, "does-not-exist"), join(root, "dangling"));
        const result = await enumerateBoundedScope(root, {
            limits: { ...DEFAULT_SCOPE_LIMITS, maxDepth: 2 },
        });
        expect(result.status).toBe("partial");
        expect(result.files.some((f) => f.path.includes("deep.ts"))).toBe(false);
        const reasons = result.omitted.map((o) => o.reason);
        expect(reasons).toContain("symlink-skipped");
        expect(reasons).toContain("depth-exceeded");
    });

    it("byte and file caps refuse before consume with explicit reasons", async () => {
        const root = freshRoot();
        writeTree(root, { "big.ts": "b".repeat(1000), "small.ts": "s" });
        const result = await enumerateBoundedScope(root, {
            limits: { ...DEFAULT_SCOPE_LIMITS, maxTotalBytes: 10 },
        });
        expect(result.status).toBe("partial");
        expect(result.stopReason).toMatch(/maxTotalBytes/);
        expect(result.admittedBytes).toBeLessThanOrEqual(10);

        const fileCap = await enumerateBoundedScope(root, {
            limits: { ...DEFAULT_SCOPE_LIMITS, maxFiles: 1 },
        });
        expect(fileCap.status).toBe("partial");
        expect(fileCap.emittedFiles).toBe(1);
        expect(fileCap.stopReason).toMatch(/maxFiles/);
    });

    it("pre-aborted signal refuses without work and reports cancellation", async () => {
        const root = freshRoot();
        writeTree(root, { "a.ts": "x" });
        const controller = new AbortController();
        controller.abort();
        const result = await enumerateBoundedScope(root, {
            limits: DEFAULT_SCOPE_LIMITS,
            signal: controller.signal,
        });
        expect(result.status).toBe("unknown");
        expect(result.emittedFiles).toBe(0);
        expect(result.stopReason).toMatch(/abort/i);
        expect(result.signalChecks).toBeGreaterThan(0);
    });

    it("deadline expiry yields partial with reason, never false complete", async () => {
        const root = freshRoot();
        const files: Record<string, string> = {};
        for (let i = 0; i < 200; i++) files[`d${i % 10}/f${i}.ts`] = "w".repeat(100);
        writeTree(root, files);
        const result = await enumerateBoundedScope(root, {
            limits: DEFAULT_SCOPE_LIMITS,
            deadlineMs: 0,
        });
        expect(result.status).not.toBe("complete");
        expect(result.stopReason).toMatch(/deadline/i);
    });

    it("missing root yields unknown with reason, never complete", async () => {
        const result = await enumerateBoundedScope(join(tmpdir(), "bounded-scope-nope-404"), {
            limits: DEFAULT_SCOPE_LIMITS,
        });
        expect(result.status).toBe("unknown");
        expect(result.emittedFiles).toBe(0);
        expect((result.stopReason ?? "").length).toBeGreaterThan(0);
    });

    it("unreadable entry is recorded as omitted, traversal continues", async () => {
        if (process.geteuid?.() === 0) {
            // Root bypasses permission bits; the error path cannot trigger.
            return;
        }
        const root = freshRoot();
        writeTree(root, { "ok.ts": "fine", "locked/inner.ts": "hidden" });
        chmodSync(join(root, "locked"), 0o000);
        let result;
        try {
            result = await enumerateBoundedScope(root, { limits: DEFAULT_SCOPE_LIMITS });
        } finally {
            chmodSync(join(root, "locked"), 0o700);
        }
        expect(result.files.some((f) => f.path.endsWith("ok.ts"))).toBe(true);
        expect(result.omitted.some((o) => o.reason === "unreadable")).toBe(true);
        expect(result.status).toBe("partial");
    });

    it("admission check runs on counts before consume", () => {
        const over = checkScopeAdmission(
            { files: 500, bytes: 999_999_999 },
            { ...DEFAULT_SCOPE_LIMITS, maxFiles: 100, maxTotalBytes: 1000 },
        );
        expect(over.admitted).toBe(false);
        expect(over.reasons.length).toBeGreaterThan(0);
        const under = checkScopeAdmission(
            { files: 2, bytes: 10 },
            DEFAULT_SCOPE_LIMITS,
        );
        expect(under.admitted).toBe(true);
        expect(under.reasons).toEqual([]);
    });
});
