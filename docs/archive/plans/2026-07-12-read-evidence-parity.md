# Read/Inspect Evidence + Enrichment Parity Implementation Plan

> **Status:** Historical / superseded. Archived implementation plan, shipped (commit `0618026`). The `read` tool now emits a path-mode `details.workspaceEvidence` envelope and shares enrichment via `src/file-context.ts` / `src/path-evidence.ts`. See `docs/parity/**` and current source for the live contract.

> **For agentic workers:** Implement this plan task-by-task in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `read` tool emits the same strong `details.workspaceEvidence` envelope as `inspect` path mode (so smart-edit's `patch`/`edit` can consume an `evidenceRef` from a plain read), and both the read path and the inspect path mode share the same per-file contextual enrichment: git context (recent commits + trailers), structural/graph/LSP enrichment, and git notes when present.

**Architecture:** Extract the per-file enrichment footer from `hook.ts` into a new shared module `file-context.ts` (adding a new git-notes channel), and extract the path-mode envelope builder from `inspect.ts` into a new dependency-free module `path-evidence.ts`. `hook.ts` (the wrapped builtin read) consumes both: it appends the enrichment footer AND computes/publishes a path-mode evidence envelope. `inspect.ts` path mode consumes `file-context.ts` to gain the same enrichment. `index.ts` re-registers the wrapped read tool (it was de-registered in the v3 consolidation, commit 0cd26ab). The evidence resolver in `mcp-registry.ts` re-indexes `read` tool results in addition to `inspect` ones. smart-edit needs only description-string updates — its `patch` resolves evidence by `inspectionId` over RPC and is mode-agnostic.

**Tech Stack:** TypeScript (ESM, Node ≥20), vitest, `@rhinos0608/pi-workspace-protocol` v0.3.0 (schema v3), `@mariozechner/pi-coding-agent`.

## Global Constraints

- **NEVER run `git commit` or any git mutation** in either repo. Skip every "Commit" step convention; leave changes in the working tree.
- Repos: SmartRead = `/Users/rhinesharar/Pi-SmartRead/Pi-SmartRead` (flat layout, no `src/`), smart-edit = `/Users/rhinesharar/Pi-SmartEdit/Pi-Edit/extensions/smart-edit`.
- All enrichment and evidence emission must be **best-effort**: a failure appends a warning line or silently skips evidence — it must never make `read` or `inspect` fail.
- Evidence envelopes must satisfy `validateInspectionEnvelope` from `@rhinos0608/pi-workspace-protocol` (schema v3). Truncated output MUST NOT claim `full-file` coverage.
- Import-cycle rule: `hook.ts` must NOT import `inspect.ts` or `mcp-registry.ts` (existing cycle `search-tool.ts → hook.ts` makes that fragile). New shared modules (`file-context.ts`, `path-evidence.ts`) must not import `hook.ts`, `inspect.ts`, `search-tool.ts`, or `mcp-registry.ts`.
- Verification commands (run from the SmartRead dir): `npm run typecheck` and `npx vitest run <file>` per task; full `npm test` at the end. smart-edit: `npx tsc --noEmit`.
- Tool surface rule (project memory): do not add new sibling tools. `read` re-registration overrides the Pi builtin `read`; it is not a new tool name.

---

### Task 1: `path-evidence.ts` — extract the path-mode envelope builder

**Files:**
- Create: `path-evidence.ts`
- Modify: `inspect.ts` (path mode delegates to the new module; behavior unchanged)
- Test: `test/unit/path-evidence.test.ts` (new)

**Interfaces:**
- Consumes: `@rhinos0608/pi-workspace-protocol` helpers (`hashSessionFilePath`, `inspectionIdFor`, `resourceIdFor`, `canonicalizeWorkspaceRoot`, `PROTOCOL_SCHEMA_VERSION`).
- Produces (used by Tasks 3 and 4):
  ```ts
  export interface PathEvidenceInput {
    readonly path: string;          // relative or absolute
    readonly offset?: number;       // 1-based
    readonly limit?: number;
    readonly cwd: string;
    readonly sessionFilePath: string;
  }
  export interface PathEvidenceResult {
    readonly workspaceEvidence: WorkspaceEvidenceEnvelope; // mode: "path"
    readonly contentText: string;   // "N: line" numbered rendering
    readonly sliceText: string;     // raw (unnumbered) attested slice; full file content for full-file coverage
    readonly lineCount: number;
    readonly byteLength: number;
    readonly truncated: boolean;
  }
  export function computePathEvidence(input: PathEvidenceInput): PathEvidenceResult;
  ```
  **Strictness (differs from the old inline code):** if `offset` or `limit` is present it MUST be a positive integer (`Number.isInteger(v) && v >= 1`), otherwise `computePathEvidence` throws. The old inspect code silently treated `limit: 0`/negative/fractional as "through EOF", which would authorize lines the model never saw (review blocker). The inspect tool schema already enforces `minimum: 1`, so only programmatic callers observe the new throw.

- [ ] **Step 1: Write the failing test**

Create `test/unit/path-evidence.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { validateInspectionEnvelope } from "@rhinos0608/pi-workspace-protocol";
import { computePathEvidence } from "../../path-evidence.js";

describe("computePathEvidence", () => {
  let dir: string;
  const session = "/tmp/fake-session.jsonl";

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "path-evidence-")));
    writeFileSync(path.join(dir, "x.ts"), "line1\nline2\nline3\nline4\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("full read produces a valid full-file envelope", () => {
    const r = computePathEvidence({ path: "x.ts", cwd: dir, sessionFilePath: session });
    const v = validateInspectionEnvelope(r.workspaceEvidence);
    expect(v.ok).toBe(true);
    const res = r.workspaceEvidence.resources[0]!;
    expect(r.workspaceEvidence.mode).toBe("path");
    expect(res.coverage).toBe("full-file");
    expect(res.fresh).toBe(true);
    const expectedSha = createHash("sha256")
      .update("line1\nline2\nline3\nline4\n", "utf8").digest("hex");
    expect(res.fullFileSha256).toBe(expectedSha);
    expect(r.contentText.startsWith("1: line1")).toBe(true);
    expect(r.truncated).toBe(false);
  });

  it("offset/limit produces line-range coverage carrying fullFileSha256", () => {
    const r = computePathEvidence({ path: "x.ts", offset: 2, limit: 2, cwd: dir, sessionFilePath: session });
    const res = r.workspaceEvidence.resources[0]!;
    expect(res.coverage).toBe("line-range");
    expect(res.allowedRanges).toEqual([{ startLine: 2, endLine: 3 }]);
    expect(res.fullFileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.truncated).toBe(true);
    expect(r.contentText.startsWith("2: line2")).toBe(true);
    expect(r.sliceText).toBe("line2\nline3");
  });

  it("sliceText for a full read is the exact file content", () => {
    const r = computePathEvidence({ path: "x.ts", cwd: dir, sessionFilePath: session });
    expect(r.sliceText).toBe("line1\nline2\nline3\nline4\n");
  });

  it("rejects non-positive or fractional offset/limit", () => {
    expect(() => computePathEvidence({ path: "x.ts", limit: 0, cwd: dir, sessionFilePath: session })).toThrow(/positive integer/);
    expect(() => computePathEvidence({ path: "x.ts", limit: -3, cwd: dir, sessionFilePath: session })).toThrow(/positive integer/);
    expect(() => computePathEvidence({ path: "x.ts", offset: 1.5, cwd: dir, sessionFilePath: session })).toThrow(/positive integer/);
    expect(() => computePathEvidence({ path: "x.ts", offset: 0, cwd: dir, sessionFilePath: session })).toThrow(/positive integer/);
  });

  it("rejects missing files and empty session paths", () => {
    expect(() => computePathEvidence({ path: "nope.ts", cwd: dir, sessionFilePath: session })).toThrow(/not found/);
    expect(() => computePathEvidence({ path: "x.ts", cwd: dir, sessionFilePath: "" })).toThrow(/session/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/path-evidence.test.ts`
Expected: FAIL — `Cannot find module '../../path-evidence.js'`.

- [ ] **Step 3: Create `path-evidence.ts`**

Move the body of `computePathInspectDetails` from `inspect.ts:129-249` into the new module, **verbatim except** for the input/return type names. No imports from any SmartRead module other than the protocol package:

```ts
/**
 * Path-mode workspace-evidence builder — shared by the `inspect` tool's
 * path mode and the wrapped builtin `read` tool. Dependency-free by
 * design: importing this module must never pull in the search/symbol
 * engines (avoids the search-tool → hook import cycle).
 */
import { realpathSync, statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve as pathResolve } from "node:path";
import {
    PROTOCOL_SCHEMA_VERSION,
    hashSessionFilePath,
    inspectionIdFor,
    resourceIdFor,
    canonicalizeWorkspaceRoot,
    type WorkspaceEvidenceEnvelope,
    type InspectedResource,
} from "@rhinos0608/pi-workspace-protocol";

export interface PathEvidenceInput {
    readonly path: string;
    readonly offset?: number;
    readonly limit?: number;
    readonly cwd: string;
    readonly sessionFilePath: string;
}

export interface PathEvidenceResult {
    readonly workspaceEvidence: WorkspaceEvidenceEnvelope;
    readonly contentText: string;
    readonly lineCount: number;
    readonly byteLength: number;
    readonly truncated: boolean;
}

function sha256OfString(s: string): string {
    return createHash("sha256").update(s, "utf8").digest("hex");
}

function requirePositiveInt(v: number | undefined, name: string): void {
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
        throw new Error(`evidence: ${name} must be a positive integer (got ${v})`);
    }
}

export function computePathEvidence(input: PathEvidenceInput): PathEvidenceResult {
    if (typeof input.sessionFilePath !== "string" || input.sessionFilePath.length === 0) {
        throw new Error("evidence requires a real session file path (in-memory/ephemeral identity is rejected)");
    }
    requirePositiveInt(input.offset, "offset");
    requirePositiveInt(input.limit, "limit");
    // … body of computePathInspectDetails from inspect.ts, verbatim EXCEPT:
    //  - the hasRange branch drops the old lenient limit guard (offset/limit
    //    are validated positive ints above; a present limit is always honored:
    //    endLine = min(totalLines, startLine + limit - 1)).
    //  - additionally build `sliceText`: for full-file coverage it is the exact
    //    full file content string; for a range it is the joined slice
    //    (already computed as `slice` in the existing code).
    // canonicalize cwd + file (statSync/realpathSync, ENOENT → "file not found"),
    // read + sha256, full-file vs line-range resource, inspectionIdFor,
    // envelope { schemaVersion, inspectionId, sessionId, workspaceRoot,
    // canonicalWorkspaceRoot, createdAt, resources, mode: "path" },
    // numbered contentText rendering.
    // Return { workspaceEvidence: envelope, contentText, sliceText, lineCount, byteLength, truncated }.
}
```

(The worker copies the existing implementation lines exactly — they are already correct and tested via `inspect.test.ts` / `inspect-v3.test.ts`.)

- [ ] **Step 4: Rewrite `computePathInspectDetails` in `inspect.ts` as a thin wrapper**

```ts
import { computePathEvidence } from "./path-evidence.js";

function computePathInspectDetails(input: ComputeInspectDetailsInput): InspectDetails {
    if (typeof input.sessionFilePath !== "string" || input.sessionFilePath.length === 0) {
        throw new Error("inspect requires a real session file path (in-memory/ephemeral identity is rejected)");
    }
    const r = computePathEvidence({
        path: input.path!,
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        cwd: input.cwd,
        sessionFilePath: input.sessionFilePath,
    });
    return {
        tool: "inspect",
        mode: "path",
        workspaceEvidence: r.workspaceEvidence,
        contentText: r.contentText,
        lineCount: r.lineCount,
        byteLength: r.byteLength,
        truncated: r.truncated,
    };
}
```

Delete the now-unused local copies in `inspect.ts` (the moved body; keep `sha256OfString` there only if other modes still use it — query mode does, so keep it).

- [ ] **Step 5: Run tests to verify pass + no regression**

Run: `npx vitest run test/unit/path-evidence.test.ts test/unit/inspect.test.ts test/unit/inspect-v3.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

---

### Task 2: `file-context.ts` — shared enrichment footer with git notes

**Files:**
- Create: `file-context.ts`
- Modify: `hook.ts` (replace the inline enrichment block in `interceptContextualRead` with a call; delete moved code and now-unused imports)
- Test: `test/unit/file-context.test.ts` (new); existing `test/unit/hook.test.ts` must stay green.

**Interfaces:**
- Consumes: `ContextGraph`, `isRecentlyModified`, `getFileCommitContext`, `loadGitContextConfig`, `scanBranchNotes`, `getGraphifyEnricher`, `getLSPBridge`, `LruCache`.
- Produces (used by Tasks 3 and 4):
  ```ts
  export interface FileContextOptions {
    readonly fullPath: string;   // absolute path to the file
    readonly cwd: string;        // workspace root
    readonly gitConfig?: ReturnType<typeof loadGitContextConfig>; // optional session cache
    readonly gitRoot?: string | null;                              // optional session cache
  }
  export function buildFileContextLines(opts: FileContextOptions): Promise<string[]>;
  ```
  Returns `[]` when there is nothing to report; otherwise `["", "---", "🔍 Context for <rel>:", …bullets]` ready to `join("\n")` and append after content.

- [ ] **Step 1: Write the failing test**

Create `test/unit/file-context.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildFileContextLines } from "../../file-context.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("buildFileContextLines", () => {
  let repo: string;

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(path.join(tmpdir(), "file-context-")));
    git(repo, "init");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
    git(repo, "add", ".");
    // Commit message carries a trailer whose key is in the default
    // showTrailerKeys (["Constraint", "Directive", "Rejected"]).
    git(repo, "commit", "-m", "add a.ts", "-m", "Constraint: keep the public API frozen");
    git(repo, "notes", "--ref=refs/notes/pi-smartread", "add", "-m", "decision: keep a tiny", "HEAD");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("includes recent commits, configured trailers, and git notes for a tracked file", async () => {
    const lines = await buildFileContextLines({ fullPath: path.join(repo, "a.ts"), cwd: repo });
    const text = lines.join("\n");
    expect(text).toContain("🔍 Context for a.ts:");
    expect(text).toContain("Recent commits:");
    expect(text).toContain("add a.ts");
    expect(text).toContain("Constraint: keep the public API frozen");
    expect(text).toContain("Git notes:");
    expect(text).toContain("decision: keep a tiny");
  });

  it("returns [] when the file does not exist", async () => {
    const lines = await buildFileContextLines({ fullPath: path.join(repo, "missing.ts"), cwd: repo });
    expect(lines).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/file-context.test.ts`
Expected: FAIL — `Cannot find module '../../file-context.js'`.

- [ ] **Step 3: Create `file-context.ts`**

Move the enrichment body from `hook.ts` `interceptContextualRead` (currently hook.ts:~433-546: sections 1 ContextGraph, 2 git recency, 2b file commit context, 3 graphify, 4 LSP) plus the module-level `contextualGraphCache` (hook.ts:~52) into this module, and add the new git-notes channel:

```ts
/**
 * Shared per-file contextual enrichment footer — used by the wrapped
 * builtin read tool (hook.ts) and inspect path mode (inspect.ts).
 * Every channel is best-effort: failures append a warning line or are
 * skipped; this function never throws.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { ContextGraph } from "./context-graph.js";
import { isRecentlyModified } from "./git-history.js";
import { findGitRoot, getFileCommitContext } from "./git-context.js";
import { loadGitContextConfig } from "./config.js";
import { scanBranchNotes } from "./git-notes.js";
import { getGraphifyEnricher } from "./graphify-enricher.js";
import { getLSPBridge } from "./lsp-bridge.js";
import { LruCache } from "./utils.js";

const contextualGraphCache = new LruCache<ContextGraph>(3);

export interface FileContextOptions {
  readonly fullPath: string;
  readonly cwd: string;
  readonly gitConfig?: ReturnType<typeof loadGitContextConfig>;
  readonly gitRoot?: string | null;
}

export async function buildFileContextLines(opts: FileContextOptions): Promise<string[]> {
  const { fullPath, cwd } = opts;
  if (!existsSync(fullPath)) return [];
  const relPath = path.relative(cwd, fullPath);
  const contextLines: string[] = ["", "---", `🔍 Context for ${relPath}:`];

  try {
    // 1. Structural context via shared cached ContextGraph
    //    (verbatim from hook.ts: buildContextGraph + getFileNeighbours,
    //     "• Imported by: …" / "• Imports: …" lines)

    // 2. Git recency (verbatim from hook.ts)
    if (await isRecentlyModified(cwd, fullPath)) {
      contextLines.push("• Recently modified (last day).");
    }

    // 2b. Recent commits + git notes
    try {
      const gitConfig = opts.gitConfig ?? loadGitContextConfig(cwd);
      const gitRoot = opts.gitRoot !== undefined
        ? opts.gitRoot
        : (gitConfig.enabled ? await findGitRoot(cwd) : null);
      if (gitRoot && gitConfig.enabled) {
        const relToGitRoot = path.relative(gitRoot, fullPath);
        const commits = await getFileCommitContext(gitRoot, relToGitRoot, gitConfig.readEnrichmentCommits);
        if (commits.length > 0) {
          contextLines.push("• Recent commits:");
          for (const commit of commits) {
            contextLines.push(`  ${commit.hash} (${commit.relativeDate}) ${commit.subject}`);
            for (const trailer of commit.trailers) {
              if (gitConfig.showTrailerKeys.includes(trailer.key)) {
                contextLines.push(`    ${trailer.key}: ${trailer.value}`);
              }
            }
          }
          try {
            const notes = await scanBranchNotes(gitRoot, commits, gitConfig.notesRefs);
            if (notes.length > 0) {
              contextLines.push("• Git notes:");
              const maxChars = Math.max(0, gitConfig.tokenBudget.gitNotes) * 4;
              let used = 0;
              outer: for (const note of notes) {
                const ref = note.ref.replace(/^refs\/notes\//, "");
                const header = `  ${note.commitHash} (${note.relativeDate}) [${ref}]`;
                if (used + header.length > maxChars) break;
                contextLines.push(header);
                used += header.length;
                for (const line of note.content.split(/\r?\n/)) {
                  const trimmed = line.trim();
                  if (!trimmed) continue;
                  if (used + trimmed.length + 4 > maxChars) break outer;
                  contextLines.push(`    ${trimmed}`);
                  used += trimmed.length + 4;
                }
              }
            }
          } catch { /* git notes are best-effort */ }
        }
      }
    } catch { /* file commit context is best-effort */ }

    // 3. Graphify enrichment (verbatim from hook.ts: related files,
    //    community, centrality lines)

    // 4. LSP enrichment (verbatim from hook.ts: "• LSP symbols: …")
  } catch (err) {
    contextLines.push(`• Context unavailable: ${(err as Error).message}`);
  }

  // Only emit the footer when at least one bullet was produced.
  return contextLines.length > 3 ? contextLines : [];
}
```

Note: hook.ts's old guard was `contextLines.length > 2`, which always appended the header even with zero bullets. `> 3` fixes that; it is an intentional, tiny behavior improvement.

- [ ] **Step 4: Rewire `hook.ts`**

In `interceptContextualRead`, replace the whole enrichment block (the `const contextLines…` declaration through the end of the LSP try/catch) with:

```ts
import { buildFileContextLines } from "./file-context.js";
// …
const repoKeyForGit = computeRepoKey(cwd);
const contextLines = await buildFileContextLines({
   fullPath,
   cwd,
   ...(sessionGitCacheKey === repoKeyForGit && sessionGitCache
      ? { gitConfig: sessionGitCache.gitConfig, gitRoot: sessionGitCache.gitRoot }
      : {}),
});
```

and change the append condition at the bottom from `if (contextLines.length > 2)` to `if (contextLines.length > 0)`.

Delete from `hook.ts`: the module-level `contextualGraphCache`, and the now-unused imports (`ContextGraph`, `isRecentlyModified`, `getFileCommitContext`, `getGraphifyEnricher`, `getLSPBridge`) — keep any that are still used elsewhere in the file (`findGitRootAsync`, `buildStartupGitContext`, `autoPopulateEdgeStore`, `scanBranchNotes`, `formatBranchNotes`, `loadGitContextConfig` are still used by the startup hooks; check each with grep before removing).

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/unit/file-context.test.ts test/unit/hook.test.ts test/unit/hook-startup-safety.test.ts && npm run typecheck`
Expected: PASS. (Known: one hook.test.ts timing test is flaky per repo history — if it fails, re-run it in isolation before treating it as a regression.)

---

### Task 3: read tool — evidence emission, publication, and re-registration

**Files:**
- Modify: `hook.ts` (`wrapBuiltinReadTool` gains an options param; `interceptContextualRead` computes/attaches/publishes evidence)
- Modify: `unified-read.ts` (forward options)
- Modify: `index.ts` (register the wrapped read; wire the resolver publish callback)
- Modify: `mcp-registry.ts` (`installInspectAndResolver` re-indexes `pi.tool_result.read` too)
- Test: `test/unit/read-evidence.test.ts` (new); extend `test/unit/workspace-evidence-resolver.test.ts` only if it already covers `installInspectAndResolver` (follow its existing pattern).

**Interfaces:**
- Consumes: `computePathEvidence` (Task 1), `sessionFileFromContext` from `inspect-tool.ts` (already exported).
- Produces:
  ```ts
  export interface WrapReadToolOptions {
    /** Publish envelope into the shared evidence resolver (best-effort). */
    readonly publishInspection?: (
      envelope: unknown, sessionFilePath: string, workspaceRoot: string,
    ) => void;
  }
  export function wrapBuiltinReadTool(opts?: WrapReadToolOptions): ToolDefinition;   // hook.ts
  export function createReadTool(opts?: WrapReadToolOptions): ToolDefinition;        // unified-read.ts
  ```
  Read results gain `details.workspaceEvidence` (schema v3, mode `"path"`) plus `details.displayContent` (existing).

- [ ] **Step 1: Write the failing test**

Create `test/unit/read-evidence.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateInspectionEnvelope } from "@rhinos0608/pi-workspace-protocol";
import { createReadTool } from "../../unified-read.js";

function makeCtx(cwd: string, sessionFile: string | null) {
  return {
    cwd,
    sessionManager: sessionFile ? { getSessionFile: () => sessionFile } : undefined,
  } as any;
}

describe("read tool workspace evidence", () => {
  let dir: string;
  let session: string;

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "read-evidence-")));
    session = path.join(dir, "session.jsonl");
    writeFileSync(path.join(dir, "x.ts"), "line1\nline2\nline3\nline4\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("full read attaches a valid full-file envelope and publishes it", async () => {
    const publish = vi.fn();
    const tool = createReadTool({ publishInspection: publish });
    const res: any = await tool.execute("t1", { path: "x.ts" }, undefined, undefined, makeCtx(dir, session));
    const env = res.details.workspaceEvidence;
    expect(env).toBeDefined();
    expect(validateInspectionEnvelope(env).ok).toBe(true);
    expect(env.mode).toBe("path");
    expect(env.resources[0].coverage).toBe("full-file");
    expect(env.resources[0].fresh).toBe(true);
    expect(publish).toHaveBeenCalledWith(env, session, env.canonicalWorkspaceRoot);
  });

  it("offset/limit read attaches line-range coverage", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("t2", { path: "x.ts", offset: 2, limit: 2 }, undefined, undefined, makeCtx(dir, session));
    const env = res.details.workspaceEvidence;
    expect(env.resources[0].coverage).toBe("line-range");
    expect(env.resources[0].allowedRanges).toEqual([{ startLine: 2, endLine: 3 }]);
    expect(env.resources[0].fullFileSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("selector syntax path:2-3 attaches the same line-range coverage", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("t3", { path: "x.ts:2-3" }, undefined, undefined, makeCtx(dir, session));
    const env = res.details.workspaceEvidence;
    expect(env.resources[0].coverage).toBe("line-range");
    expect(env.resources[0].allowedRanges).toEqual([{ startLine: 2, endLine: 3 }]);
  });

  it("no session file → no evidence, read still succeeds", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("t4", { path: "x.ts" }, undefined, undefined, makeCtx(dir, null));
    expect(res.details?.workspaceEvidence).toBeUndefined();
    expect(res.content[0].text).toContain("line1");
  });

  it("publish failure never blocks the read", async () => {
    const tool = createReadTool({ publishInspection: () => { throw new Error("boom"); } });
    const res: any = await tool.execute("t5", { path: "x.ts" }, undefined, undefined, makeCtx(dir, session));
    expect(res.details.workspaceEvidence).toBeDefined();
  });

  it("builtin truncation clamps coverage to the shown lines, never full-file", async () => {
    // 3000 short lines > DEFAULT_MAX_LINES (2000) → builtin read truncates by lines.
    const big = Array.from({ length: 3000 }, (_, i) => `l${i + 1}`).join("\n");
    writeFileSync(path.join(dir, "big.ts"), big);
    const tool = createReadTool();
    const res: any = await tool.execute("t6", { path: "big.ts" }, undefined, undefined, makeCtx(dir, session));
    const trunc = res.details.truncation;
    expect(trunc.truncated).toBe(true);
    const env = res.details.workspaceEvidence;
    expect(env.resources[0].coverage).toBe("line-range");
    expect(env.resources[0].allowedRanges).toEqual([{ startLine: 1, endLine: trunc.outputLines }]);
  });

  it("first line exceeding the byte limit → no evidence (zero lines shown)", async () => {
    writeFileSync(path.join(dir, "wide.ts"), "x".repeat(60 * 1024));
    const tool = createReadTool();
    const res: any = await tool.execute("t7", { path: "wide.ts" }, undefined, undefined, makeCtx(dir, session));
    expect(res.details?.workspaceEvidence).toBeUndefined();
  });

  it("limit: 0 → no evidence (nothing shown, nothing authorized)", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("t8", { path: "x.ts", offset: 1, limit: 0 }, undefined, undefined, makeCtx(dir, session));
    expect(res.details?.workspaceEvidence).toBeUndefined();
  });

  it("raw mode emits no evidence", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("t9", { path: "x.ts:raw" }, undefined, undefined, makeCtx(dir, session));
    expect(res.details?.workspaceEvidence).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/read-evidence.test.ts`
Expected: FAIL — `workspaceEvidence` undefined / options param not accepted.

- [ ] **Step 3: Implement evidence emission in `hook.ts`**

Add imports (both are cycle-safe per Global Constraints — `path-evidence.ts` is dependency-free and `inspect-tool.ts` → `inspect.ts` is NOT imported):

```ts
import { computePathEvidence } from "./path-evidence.js";
```

Add a local session-file helper (do NOT import from `inspect-tool.ts`, which imports `inspect.ts` → `search-tool.ts` → `hook.ts`):

```ts
function sessionFileFromCtx(ctx: ExtensionContext): string | null {
   try {
      const sm = (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } }).sessionManager;
      if (!sm || typeof sm.getSessionFile !== "function") return null;
      const p = sm.getSessionFile();
      return typeof p === "string" && p.length > 0 ? p : null;
   } catch {
      return null;
   }
}
```

Change signatures:

```ts
export interface WrapReadToolOptions {
   readonly publishInspection?: (envelope: unknown, sessionFilePath: string, workspaceRoot: string) => void;
}
export function wrapBuiltinReadTool(opts?: WrapReadToolOptions): ToolDefinition { … }
```

Thread `opts` through to `interceptContextualRead` (add a trailing `opts?: WrapReadToolOptions` parameter). In `interceptContextualRead`, insert the evidence block right after the existing `if (!existsSync(fullPath)) return result;` guard and before enrichment. Note raw mode (`path:raw` selector) early-returns before this point and therefore never carries evidence — that is intentional (raw output is unanchored and unnumbered; the model should do a normal read/inspect before patching).

Three review-blocker rules are encoded here:
1. **Binding root:** evidence resolves `targetPath` against `ctx.cwd` — the same root the delegated builtin read used (`createReadToolDefinition(ctx.cwd)`), NOT the `params.directory`-derived `cwd` used for enrichment.
2. **Revalidation (TOCTOU):** the builtin read and `computePathEvidence` read the file at different instants. The envelope is only attached when the attested slice (`evidence.sliceText`) is byte-identical to the text the model was actually shown (`truncation.content` when truncated, otherwise the builtin's output text). On mismatch — file changed between the two reads — evidence is silently skipped.
3. **Zero shown lines:** `firstLineExceedsLimit` (or any invalid offset/limit, which makes `computePathEvidence` throw) → no evidence.

```ts
   // Workspace evidence: read is a targeted path read — emit the same
   // strong path-mode envelope inspect produces so patch can accept an
   // evidenceRef from a plain read. Best-effort: never blocks the read.
   const isImageResult = result.content.some((c: { type: string }) => c.type === "image");
   const sessionFilePath = sessionFileFromCtx(ctx);
   const builtinText = (result.content.find((c: { type: string }) => c.type === "text") as
      | { type: "text"; text: string }
      | undefined)?.text;
   if (sessionFilePath && !isImageResult && typeof builtinText === "string") {
      try {
         const truncation = (result.details as Record<string, unknown> | undefined)?.truncation as
            | { truncated?: boolean; outputLines?: number; firstLineExceedsLimit?: boolean; content?: string }
            | undefined;
         if (truncation?.firstLineExceedsLimit) throw new Error("zero lines shown");
         let evidenceOffset = typeof normalizedParams.offset === "number" ? normalizedParams.offset : undefined;
         let evidenceLimit = typeof normalizedParams.limit === "number" ? normalizedParams.limit : undefined;
         if (truncation?.truncated && typeof truncation.outputLines === "number") {
            // Truncated output must not claim full-file coverage: clamp the
            // evidence range to the lines the model actually saw.
            evidenceOffset = displayStartLine;
            evidenceLimit = truncation.outputLines;
         }
         const evidence = computePathEvidence({
            path: targetPath,
            ...(evidenceOffset !== undefined ? { offset: evidenceOffset } : {}),
            ...(evidenceLimit !== undefined ? { limit: evidenceLimit } : {}),
            cwd: ctx.cwd,
            sessionFilePath,
         });
         // Revalidate: only attest content the model actually saw. The
         // builtin read and computePathEvidence hit the disk at different
         // instants — if the file changed in between, skip evidence.
         const shownText = truncation?.truncated && typeof truncation.content === "string"
            ? truncation.content
            : builtinText;
         if (shownText !== evidence.sliceText) throw new Error("shown/attested content mismatch");
         if (!result.details || typeof result.details !== "object") result.details = {};
         (result.details as Record<string, unknown>).workspaceEvidence = evidence.workspaceEvidence;
         try {
            opts?.publishInspection?.(
               evidence.workspaceEvidence,
               sessionFilePath,
               evidence.workspaceEvidence.canonicalWorkspaceRoot,
            );
         } catch { /* publish is best-effort */ }
      } catch { /* evidence is best-effort */ }
   }
```

**Caveat the implementer must verify empirically:** for an untruncated read the builtin's output text is the exact selected content (`allLines.slice(startLine).join("\n")` or the user-limited slice — see `node_modules/@mariozechner/pi-coding-agent/dist/core/tools/read.js:148-200`), so `builtinText === evidence.sliceText` holds; for a `limit`ed read the builtin slices `startLine..startLine+limit` while `computePathEvidence` slices the same inclusive range — if the read-evidence tests reveal an off-by-one or trailing-newline discrepancy between the two renderings, fix the `sliceText` construction in `path-evidence.ts` (NOT the comparison) until the Task 1 and Task 3 tests both pass.

- [ ] **Step 4: Forward options in `unified-read.ts` and register in `index.ts`**

`unified-read.ts`:

```ts
import { wrapBuiltinReadTool, type WrapReadToolOptions } from "./hook.js";

export function createReadTool(opts?: WrapReadToolOptions): ToolDefinition {
  return wrapBuiltinReadTool(opts);
}
```

`index.ts` — after the ToolRegistry registration loop (step "3. Core tools"), add:

```ts
import { createReadTool } from "./unified-read.js";
import { getSharedEvidenceResolver } from "./mcp-registry.js";
// …
  // 3.5 Read: override the builtin read with the enriched, evidence-emitting
  // wrapper. Publishes envelopes into the shared resolver so patch can
  // resolve an evidenceRef produced by a plain read.
  pi.registerTool(createReadTool({
    publishInspection: (envelope, sessionFilePath, workspaceRoot) => {
      getSharedEvidenceResolver().publishInspection(envelope as any, sessionFilePath, workspaceRoot);
    },
  }));
```

(`index.ts` already imports from `./mcp-registry.js` — extend that import.)

Update the now-stale assertion in `test/unit/index.test.ts` (currently asserts read is NOT registered, ~lines 32-39): change `expect(names).not.toContain("read");` to `expect(names).toContain("read");` and update the adjacent comment to say the wrapped read is registered again for evidence + enrichment (read_files/search/repo_map/symbol remain consolidated into inspect — keep those `not.toContain` assertions).

Also update the read tool description in `wrapBuiltinReadTool` (the current one references removed tools `read_files`/`search`/`symbol`/`repo_map`):

```ts
description: "Read the contents of a file at a known path, including images, with optional line windows, e.g. { path: \"src/auth.ts\", offset: 40, limit: 80 } or { path: \"src/auth.ts:120-180\" }. Appends contextual enrichment (imports, git history, git notes, graph, LSP) and returns a details.workspaceEvidence envelope (schemaVersion 3) that authorizes patch — same strength as inspect path mode. Use inspect { query } / { symbol } / { action: \"map\" } when the path is unknown.",
```

- [ ] **Step 5: Re-index read results in `mcp-registry.ts`**

In `installInspectAndResolver`, extract the `pi.tool_result.inspect` handler into a named function and subscribe it to both channels:

```ts
    const reindex = (raw: unknown) => {
        try {
            if (!raw || typeof raw !== "object") return;
            const ev = raw as { details?: { workspaceEvidence?: unknown }; sessionFilePath?: unknown; workspaceRoot?: unknown };
            if (!ev.details || typeof ev.details.workspaceEvidence !== "object") return;
            const sessionFilePath = typeof ev.sessionFilePath === "string" ? ev.sessionFilePath : null;
            const workspaceRoot = typeof ev.workspaceRoot === "string" ? ev.workspaceRoot : null;
            if (!sessionFilePath || !workspaceRoot) return;
            resolver.publishInspection(ev.details.workspaceEvidence as any, sessionFilePath, workspaceRoot);
        } catch {
            /* ignore re-index errors silently */
        }
    };
    const offInspect = bus.on("pi.tool_result.inspect", reindex);
    const offRead = bus.on("pi.tool_result.read", reindex);
    const offRpc = await resolver.install();
    return () => {
        offInspect();
        offRead();
        offRpc();
        resolver.dispose();
    };
```

- [ ] **Step 6: Write the re-index test**

Existing `test/unit/workspace-evidence-resolver.test.ts` unit-tests only `createEvidenceResolver`; `installInspectAndResolver` re-indexing is untested. Create `test/unit/read-reindex.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installInspectAndResolver, getSharedEvidenceResolver } from "../../mcp-registry.js";
import { computePathEvidence } from "../../path-evidence.js";

function makeFakeBus() {
  const handlers = new Map<string, Array<(d: unknown) => void>>();
  return {
    emit(channel: string, data: unknown) {
      for (const h of handlers.get(channel) ?? []) h(data);
    },
    on(channel: string, handler: (d: unknown) => void) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
      return () => {
        const cur = handlers.get(channel) ?? [];
        handlers.set(channel, cur.filter((h) => h !== handler));
      };
    },
  };
}

describe("read tool_result re-indexing", () => {
  it("re-indexes envelopes from pi.tool_result.read and stops after disposal", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "read-reindex-")));
    const session = path.join(dir, "session.jsonl");
    writeFileSync(path.join(dir, "x.ts"), "a\nb\n");
    const bus = makeFakeBus();
    const dispose = await installInspectAndResolver(bus);
    const { workspaceEvidence } = computePathEvidence({ path: "x.ts", cwd: dir, sessionFilePath: session });

    bus.emit("pi.tool_result.read", {
      details: { workspaceEvidence },
      sessionFilePath: session,
      workspaceRoot: workspaceEvidence.canonicalWorkspaceRoot,
    });
    expect(getSharedEvidenceResolver().getEnvelope(workspaceEvidence.inspectionId)).not.toBeNull();

    dispose(); // clears the resolver cache and unsubscribes both channels
    bus.emit("pi.tool_result.read", {
      details: { workspaceEvidence },
      sessionFilePath: session,
      workspaceRoot: workspaceEvidence.canonicalWorkspaceRoot,
    });
    expect(getSharedEvidenceResolver().getEnvelope(workspaceEvidence.inspectionId)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
```

Note: `getSharedEvidenceResolver` is a module singleton — keep this in its own test file so cache state cannot leak into other suites. If `dispose()` recreates or permanently disables the shared resolver in a way that breaks the second assertion, adapt the assertion to whatever `dispose` actually guarantees (worker: read `workspace-evidence-resolver.ts` `dispose()` — it clears the cache and unsubscribes; the singleton instance remains).

- [ ] **Step 7: Run tests**

Run: `npx vitest run test/unit/read-evidence.test.ts test/unit/read-reindex.test.ts test/unit/hook.test.ts test/unit/workspace-evidence-resolver.test.ts test/unit/index.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

---

### Task 4: inspect path mode — enrichment parity

**Files:**
- Modify: `inspect.ts` (path mode gains the enrichment footer in the async path)
- Modify: `inspect-tool.ts` (route path mode through `executeInspectDetails` so enrichment applies)
- Test: `test/unit/inspect-enrichment.test.ts` (new)

**Interfaces:**
- Consumes: `buildFileContextLines` (Task 2), `computePathInspectDetails` (Task 1 wrapper).
- Produces: `executeInspectDetails` path mode `contentText` = numbered lines + enrichment footer. `computeInspectDetails` (sync) stays footer-free — documented as envelope-only; the envelope itself is unchanged by enrichment.

- [ ] **Step 1: Write the failing test**

Create `test/unit/inspect-enrichment.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { executeInspectDetails } from "../../inspect.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("inspect path mode enrichment", () => {
  let repo: string;
  const session = "/tmp/fake-session.jsonl";

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(path.join(tmpdir(), "inspect-enrich-")));
    git(repo, "init");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "add a.ts");
    git(repo, "notes", "--ref=refs/notes/pi-smartread", "add", "-m", "decision: keep a tiny", "HEAD");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("appends git context and notes to path-mode content", async () => {
    const details = await executeInspectDetails({ path: "a.ts", cwd: repo, sessionFilePath: session });
    expect(details.mode).toBe("path");
    expect(details.contentText).toContain("1: export const a = 1;");
    expect(details.contentText).toContain("🔍 Context for a.ts:");
    expect(details.contentText).toContain("Recent commits:");
    expect(details.contentText).toContain("Git notes:");
    expect(details.contentText).toContain("decision: keep a tiny");
  });

  it("keeps the envelope identical to the unenriched read", async () => {
    const details = await executeInspectDetails({ path: "a.ts", cwd: repo, sessionFilePath: session });
    expect(details.workspaceEvidence.resources[0].coverage).toBe("full-file");
    // lineCount/byteLength describe the file resource, not the footer
    expect(details.lineCount).toBe(2);
  });
});
```

(`"export const a = 1;\n"` splits into 2 lines by the existing `split("\n")` convention — keep the assertion consistent with `computePathEvidence`'s behavior; if the Task 1 tests show 2, use 2.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/inspect-enrichment.test.ts`
Expected: FAIL — no `🔍 Context` footer in `contentText`.

- [ ] **Step 3: Implement enrichment in `inspect.ts`**

```ts
import { buildFileContextLines } from "./file-context.js";
```

In `executeInspectDetails`, change the path branch:

```ts
    if (mode === "path") {
        if (typeof input.path !== "string" || input.path.length === 0) {
            throw new Error("inspect path mode requires a non-empty `path` argument");
        }
        const base = computePathInspectDetails(input);
        return enrichPathInspectDetails(base, input);
    }
```

Add at the end of the path-mode section:

```ts
/**
 * Parity with the wrapped read tool: append the shared enrichment footer
 * (imports, git history, git notes, graph, LSP) to path-mode content.
 * Best-effort — enrichment failures return the base details unchanged.
 * The evidence envelope is never affected by enrichment.
 */
async function enrichPathInspectDetails(
    base: InspectDetails,
    input: ComputeInspectDetailsInput,
): Promise<InspectDetails> {
    try {
        const cwd = realpathSync(input.cwd);
        const canonicalPath = base.workspaceEvidence.resources[0]?.canonicalPath;
        if (!canonicalPath) return base;
        const contextLines = await buildFileContextLines({ fullPath: canonicalPath, cwd });
        if (contextLines.length === 0) return base;
        return { ...base, contentText: base.contentText + contextLines.join("\n") };
    } catch {
        return base;
    }
}
```

Update the module doc comment for `computeInspectDetails` to note it is the envelope-only sync variant (no enrichment footer).

- [ ] **Step 4: Route path mode through the async engine in `inspect-tool.ts`**

Replace the `const details = mode === "path" ? computeInspectDetails({…}) : await executeInspectDetails({…});` ternary with a single call:

```ts
            const details = await executeInspectDetails({
                path: params.path,
                query: params.query,
                symbol: params.symbol,
                action: params.action,
                offset: params.offset,
                limit: params.limit,
                depth: params.depth,
                directory: params.directory,
                cwd: ctx.cwd,
                sessionFilePath,
                signal,
            });
```

Remove the now-unused `computeInspectDetails` and `resolveMode` imports if nothing else in the file uses them (`resolveMode` is currently called just above — delete that call too; `executeInspectDetails` performs the same validation and throws the same errors).

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/unit/inspect-enrichment.test.ts test/unit/inspect.test.ts test/unit/inspect-v3.test.ts && npm run typecheck`
Expected: PASS. If an existing inspect test asserts exact path-mode `contentText` with no footer, the footer may legitimately break it — in a bare fixture dir with no git repo/imports the footer is empty (returns `[]`), so most fixtures are unaffected; adjust only assertions that run inside a real git repo, using `toContain` on the numbered lines instead of exact equality.

---

### Task 5: guidance + smart-edit description parity

**Files:**
- Modify: `tool-guidance.ts` (SmartRead)
- Modify: `/Users/rhinesharar/Pi-SmartEdit/Pi-Edit/extensions/smart-edit/src/patch.ts` (two description strings)
- Test: `test/unit/tool-guidance.test.ts` if it exists (adjust assertions); smart-edit typecheck.

**Interfaces:**
- Consumes: nothing new. Produces: prompt/description text only — no runtime behavior change.

- [ ] **Step 1: Update `TOOL_GUIDE_LINES` in `tool-guidance.ts`**

```ts
const TOOL_GUIDE_LINES = [
  "Use read for known paths and inspect for discovery — both return details.workspaceEvidence that authorizes patch:",
  "- read { path }: exact file with contextual enrichment (imports, git history, git notes, graph, LSP) + strong evidence.",
  "- inspect { path }: exact file by path; add offset/limit for large files. Same enrichment + strong evidence.",
  '- inspect { query }: rank files/matches by intent; add depth: "deep" for broad questions with semantic + graph evidence.',
  "- inspect { symbol }: known symbol names — find, outline, declaration, references, implementations.",
  '- inspect { action: "map" }: quick repository structure orientation.',
  "Prefer narrow params. After code changes, re-run reads/inspects that informed decisions.",
];
```

- [ ] **Step 2: Update smart-edit patch descriptions**

In `src/patch.ts`, `PATCH_PARAMS_DOC.description` (~line 356): replace `an \`evidenceRef\` from a prior \`inspect\` call` with `an \`evidenceRef\` from a prior \`inspect\` or \`read\` call`. In the `evidenceRef` property description (~line 377): replace `a prior \`inspect\` tool result` with `a prior \`inspect\` or \`read\` tool result`.

- [ ] **Step 3: Verify**

Run in SmartRead: `grep -rn "read_files\|repo_map" tool-guidance.ts` → no hits; `npx vitest run test/unit/tool-guidance.test.ts` if present, else skip.
Run in smart-edit: `npx tsc --noEmit`
Expected: clean.

---

### Task 6 (parent, not a worker task): full verification

- [ ] `cd /Users/rhinesharar/Pi-SmartRead/Pi-SmartRead && npm run typecheck && npm test` — all green (modulo the known pre-existing flaky hook.test.ts timing test; verify it passes in isolation).
- [ ] `cd /Users/rhinesharar/Pi-SmartEdit/Pi-Edit/extensions/smart-edit && npx tsc --noEmit` — clean.
- [ ] Reviewer pass on the combined diff (`git diff` in both repos).
- [ ] **No commits.**

## Execution notes

- Task order: 1 → 2 → (3 ∥ 4) → 5. Tasks 3 and 4 touch disjoint files (`hook.ts`/`unified-read.ts`/`index.ts`/`mcp-registry.ts` vs `inspect.ts`/`inspect-tool.ts`) and may run in parallel; both depend on Tasks 1–2. Task 5 is independent of 3/4 but trivially small — fold into whichever worker finishes first or run standalone.
- Risks: (a) ESM import cycles — mitigated by the dependency-free `path-evidence.ts` and by hook.ts using a local `sessionFileFromCtx` instead of importing `inspect-tool.ts`; (b) truncated builtin reads claiming full-file coverage — mitigated by clamping evidence to `details.truncation.outputLines` AND by the shown-vs-attested `sliceText` byte-comparison (which also closes the read/re-read TOCTOU window and the invalid-limit hole); (c) enrichment latency on large repos in inspect path mode — bounded by the shared LruCache'd ContextGraph and best-effort try/catch, same profile the read path always had; (d) raw-mode reads intentionally carry no evidence.
- Review status: plan reviewed 2026-07-12 (reviewer subagent); all five blockers addressed — TOCTOU revalidation via sliceText comparison, ctx.cwd binding for evidence, strict positive-int offset/limit validation, raw-mode documented + tested, index.test.ts assertion update folded into Task 3.
