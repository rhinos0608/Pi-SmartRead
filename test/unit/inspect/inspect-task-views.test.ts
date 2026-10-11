import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeTaskView } from "../../../src/inspect/inspect-task-views.js";
import { executeFileInspect } from "../../../src/inspect/inspect-file-core.js";
import type { ScopeResult } from "../../../src/inspect/inspect-bounded-scope.js";

const roots: string[] = [];
function makeScope(overrides: Partial<ScopeResult> = {}): ScopeResult {
    return {
        status: "complete",
        files: [],
        visitedDirs: 1,
        visitedEntries: 0,
        maxDepthReached: 0,
        emittedFiles: 0,
        admittedBytes: 0,
        omitted: [],
        wallMs: 0,
        deadlineMs: undefined,
        signalChecks: 0,
        aborted: false,
        ...overrides,
    };
}
async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "inspect-task-view-"));
    roots.push(root);
    return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("executeTaskView", () => {
    it("uses canonical requested subdirectory scope instead of cwd", async () => {
        const root = await fixture();
        const sub = join(root, "packages", "one");
        await mkdir(sub, { recursive: true });
        await writeFile(join(sub, "package.json"), '{"name":"one"}');
        const result = await executeTaskView({ view: "architecture", mode: "directory", path: sub, cwd: root });
        expect(result.canonicalScope).toBe(await realpath(sub));
        expect(result.text).not.toContain("packages/two");
        expect(result.sections.map((section) => section.relationKind)).toEqual(["service-boundaries"]);
        expect(result.text).not.toMatch(/Call Graph|Hotspots|Dead Code/);
    });

    it("rejects change-review without diff before doing work", async () => {
        await expect(executeTaskView({ view: "change-review", mode: "file", path: "/missing", cwd: "/missing" })).rejects.toThrow(/requires diff/);
    });

    it("builds only the requested file view section", async () => {
        const root = await fixture();
        const file = join(root, "a.ts");
        await writeFile(file, "import x from './x';\nexport function run() {}\n");
        const result = await executeTaskView({ view: "dependencies", mode: "file", path: file, cwd: root });
        expect(result.sections.map((section) => section.relationKind)).toEqual(["dependencies"]);
        expect(result.text).not.toMatch(/Repository Map|Signals|Community Clusters|Architectural Layers/);
    });

    it("rejects incompatible view/mode and filesystem target types", async () => {
        const root = await fixture();
        const file = join(root, "a.ts");
        await writeFile(file, "export {};\n");
        await expect(executeTaskView({ view: "dependencies", mode: "directory", path: root, cwd: root })).rejects.toThrow();
        await expect(executeTaskView({ view: "architecture", mode: "directory", path: file, cwd: root })).rejects.toThrow();
        await expect(executeTaskView({ view: "overview", mode: "script", path: file, cwd: root } as never)).rejects.toThrow(/script mode/);
        await expect(executeTaskView({ view: "overview", mode: "file", path: file, cwd: root, analysis: {} } as never)).rejects.toThrow(/combined with analysis/);
    });

    it("routes scan only admitted files and report symlink omissions", async () => {
        const root = await fixture();
        const target = await fixture();
        await writeFile(join(root, "route.ts"), "app.get('/ok', handler);\n");
        await writeFile(join(target, "route.ts"), "app.get('/outside', handler);\n");
        await symlink(target, join(root, "linked"));
        const result = await executeTaskView({ view: "routes", mode: "directory", path: root, cwd: root });
        expect(result.text).toContain("/ok");
        expect(result.text).not.toContain("/outside");
        expect(result.sections[0]?.omissions).toContain("linked: symlink-skipped; count: 1");
        expect(result.coverage).toBe("partial");
    });

    it("keeps legacy analysis output stable for the route section", async () => {
        const root = await fixture();
        const file = join(root, "route.ts");
        await writeFile(file, "app.get('/legacy', handler);\n");
        const result = await executeFileInspect({ path: file, cwd: root, sessionFilePath: join(root, "session.jsonl"), routes: true });
        const normalized = result.contentText.replaceAll(root, "<ROOT>").replace(/Last Change: today \([^)]*\)/, "Last Change: today (<TIME>)");
        expect(normalized).toMatchInlineSnapshot(`
          "## Structural Facts: route.ts

          External Dependents (0)
            (none)

          Dependencies (0)
            (none)

          Internal Call Sites (0)
            (none)

          Parent Module
            (top-level module)

          Children (0)
            (none)

          Base Classes / Interfaces
            (none)

          Overrides
            (none)

          Re-Exported By (0)
            (none)

          Signals
            Complexity: 0 (max 0 in a single function (regex))
            Public API: No
            External Reuse: No importing files found (Import scan found no dependents)
            Last Change: today (<TIME>)
            Tests: No tests found
            Deprecation: No markers found

          ## HTTP Routes (1 routes)

            GET     /legacy                        → handler  L1"
        `);
    });

    it("reports ignored hidden route files as omissions and partial coverage", async () => {
        const root = await fixture();
        await mkdir(join(root, ".hidden"));
        await writeFile(join(root, ".hidden", "route.ts"), "app.get('/hidden', handler);\n");
        const result = await executeTaskView({ view: "routes", mode: "directory", path: root, cwd: root });
        expect(result.text).not.toContain("/hidden");
        expect(result.sections[0]?.omissions).toContain(".hidden/route.ts: skipped-listed-directory (.hidden); count: 1");
        expect(result.sections[0]?.inspectedCount).toBe(1);
        expect(result.coverage).toBe("partial");
    });

    it("surfaces unreadable directories as counted omissions", async () => {
        const root = await fixture();
        const result = await executeTaskView({ view: "routes", mode: "directory", path: root, cwd: root }, {
            enumerateScope: async () => makeScope({ status: "partial", omitted: [{ path: "blocked", reason: "unreadable" }] }),
        });
        expect(result.sections[0]?.omissions).toContain("blocked: unreadable; count: 1");
        expect(result.coverage).toBe("partial");
    });

    it("marks directory overview partial when bounded enumeration hits a cap", async () => {
        const root = await fixture();
        const result = await executeTaskView({ view: "overview", mode: "directory", path: root, cwd: root }, {
            enumerateScope: async () => makeScope({ status: "partial", stopReason: "maxFiles 1 reached" }),
        });
        expect(result.coverage).toBe("partial");
        expect(result.sections[0]?.truncationReason).toBe("maxFiles 1 reached");
        expect(result.text).toContain("\n\nSource files inspected:");
    });

    it("surfaces injected read failures and incomplete enumeration as partial coverage", async () => {
        const root = await fixture();
        await writeFile(join(root, "route.ts"), "app.get('/ok', handler);\n");
        const result = await executeTaskView({ view: "routes", mode: "directory", path: root, cwd: root }, {
            readFile: async () => { throw new Error("read denied"); },
        });
        expect(result.sections[0]?.failures).toContain("route.ts: read denied");
        expect(result.sections[0]?.omissions).toContain("route.ts: read-failed (read denied); count: 1");
        expect(result.coverage).toBe("partial");
    });
});
