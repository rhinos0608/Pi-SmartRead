/**
 * State-root fix regression — rootcause §3 cases E1/E2/E4.
 *
 * Drives the faithful entry points (read enrichment via
 * `buildFileContextLines`, session hooks) against throwaway fixtures and
 * asserts that no `.pi-smartread*` directory ever appears anywhere except
 * the canonical state root:
 *   E1  plain read at the true project root → state only at that root
 *   E2  nested `package.json` marker below the git root → never a state root
 *   E4  non-git dir with a marker → outermost marker is the root;
 *       no marker anywhere → nothing persisted at all
 *
 * Also covers the session-side derivations: diagnostics root and semantic
 * warm-up root (incl. `PI_SMARTREAD_ALLOWED_ROOT` clamping) route through
 * `resolveStateRoot`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildFileContextLines } from "../../../src/read/file-context.js";
import { projectWorkspaceForFile } from "../../../src/workspace/workspace-scope.js";
import { effectiveSemanticRoot } from "../../../src/indexing/semantic-index-registry.js";
import { registerSessionHooks, resetSessionState } from "../../../src/hook.js";

// Capture the warm-up root the session hook hands to the registry without
// running a real semantic index (network) in tests.
const warmupCalls = vi.hoisted(() => ({ roots: [] as string[] }));

vi.mock("../../../src/indexing/semantic-index-registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/indexing/semantic-index-registry.js")>();
  return {
    ...actual,
    getOrCreateSemanticIndex: ((root: string) => {
      warmupCalls.roots.push(root);
      return {
        initialize: () => Promise.resolve(),
        updateIndex: () => Promise.resolve(),
        dispose: () => {},
      };
    }) as typeof actual.getOrCreateSemanticIndex,
  };
});

// ── Helpers ───────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** Every `.pi-smartread*` directory under `base` (mirrors the audit repro). */
function snapshotState(base: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".pi-smartread")) out.push(full);
      else walk(full);
    }
  };
  walk(base);
  return out.sort();
}

function makeMockContext(cwd: string): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

function makeMockAPI(): {
  api: ExtensionAPI;
  handlers: Record<string, (...args: unknown[]) => unknown>;
} {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const api = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers[event] = handler;
    },
    registerTool: () => {},
  } as unknown as ExtensionAPI;
  return { api, handlers };
}

/** session_start + one before_agent_start to drain the startup map promise. */
async function startSession(cwd: string): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const { api, handlers } = makeMockAPI();
  registerSessionHooks(api);
  await handlers.session_start!({ type: "session_start", reason: "startup" }, makeMockContext(cwd));
  await handlers.before_agent_start!(
    { type: "before_agent_start", systemPrompt: "You are a helpful agent.", prompt: "hi" },
    makeMockContext(cwd),
  );
  return handlers;
}

// ── Fixtures ──────────────────────────────────────────────────────

let tmp: string;
let gitproj: string;
let nongitproj: string;
let plaindir: string;
let nestedCwd: string;

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "no-nested-state-")));

  // E1/E2: git project with a babel-style nested marker.
  gitproj = path.join(tmp, "gitproj");
  mkdirSync(path.join(gitproj, "src", "nested"), { recursive: true });
  mkdirSync(path.join(gitproj, "pkg", "test", "fixtures"), { recursive: true });
  writeFileSync(path.join(gitproj, "package.json"), '{"name":"gitproj-fixture"}\n');
  writeFileSync(path.join(gitproj, "src", "lib.ts"), "export const lib = 1;\n");
  writeFileSync(path.join(gitproj, "src", "nested", "deep.ts"), "export const deep = 1;\n");
  writeFileSync(
    path.join(gitproj, "pkg", "test", "fixtures", "package.json"),
    '{"name":"nested-marker-fixture"}\n',
  );
  writeFileSync(path.join(gitproj, "pkg", "test", "fixtures", "sample.ts"), "export const sample = 1;\n");
  git(gitproj, "init");
  git(gitproj, "config", "user.email", "t@example.com");
  git(gitproj, "config", "user.name", "t");
  git(gitproj, "add", ".");
  git(gitproj, "commit", "-m", "initial fixture");
  nestedCwd = path.join(gitproj, "pkg", "test", "fixtures");

  // E4a: non-git dir whose own marker is the outermost project root.
  nongitproj = path.join(tmp, "nongitproj");
  mkdirSync(path.join(nongitproj, "src"), { recursive: true });
  writeFileSync(path.join(nongitproj, "package.json"), '{"name":"nongitproj-fixture"}\n');
  writeFileSync(path.join(nongitproj, "src", "lib.ts"), "export const lib = 1;\n");

  // E4b: no marker anywhere → nothing may be persisted.
  plaindir = path.join(tmp, "plaindir");
  mkdirSync(plaindir, { recursive: true });
  writeFileSync(path.join(plaindir, "file.ts"), "export const plain = 1;\n");
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  resetSessionState();
  warmupCalls.roots.length = 0;
});

// ── E1/E2/E4: read enrichment ─────────────────────────────────────

describe("read enrichment persists only at the canonical state root", () => {
  it("E1: a read at the true project root creates state only at the git root", async () => {
    const lines = await buildFileContextLines({ fullPath: path.join(gitproj, "src", "lib.ts"), cwd: gitproj });
    expect(Array.isArray(lines)).toBe(true);

    const state = snapshotState(gitproj);
    // Non-vacuous: the read did persist state — at the canonical root…
    expect(state.length).toBeGreaterThan(0);
    // …and every .pi-smartread* dir sits directly at that root.
    for (const dir of state) expect(path.dirname(dir)).toBe(gitproj);
  });

  it("E2: a nested package.json marker below the git root never becomes a state root", async () => {
    const sample = path.join(gitproj, "pkg", "test", "fixtures", "sample.ts");
    // Root derivation: the nested marker loses to the repo's .git above it.
    expect(projectWorkspaceForFile(sample)).toBe(gitproj);

    const before = snapshotState(tmp);
    await buildFileContextLines({ fullPath: sample, cwd: gitproj });
    const created = snapshotState(tmp).filter((dir) => !before.includes(dir));

    expect(created.every((dir) => path.dirname(dir) === gitproj)).toBe(true);
    // Nothing anywhere below pkg/, before or after the read.
    expect(snapshotState(path.join(gitproj, "pkg"))).toEqual([]);
  });

  it("E4: a non-git dir with a marker roots at the outermost marker", async () => {
    const lib = path.join(nongitproj, "src", "lib.ts");
    expect(projectWorkspaceForFile(lib)).toBe(nongitproj);

    const before = snapshotState(tmp);
    await buildFileContextLines({ fullPath: lib, cwd: nongitproj });
    const created = snapshotState(tmp).filter((dir) => !before.includes(dir));

    expect(created.length).toBeGreaterThan(0);
    expect(created.every((dir) => path.dirname(dir) === nongitproj)).toBe(true);
    // src/ below the marker must stay state-free.
    expect(snapshotState(path.join(nongitproj, "src"))).toEqual([]);
  });

  it("E4: a dir with no marker anywhere persists nothing", async () => {
    expect(projectWorkspaceForFile(path.join(plaindir, "file.ts"))).toBeNull();

    const before = snapshotState(tmp);
    const lines = await buildFileContextLines({ fullPath: path.join(plaindir, "file.ts"), cwd: plaindir });
    expect(lines).toEqual([]);
    expect(snapshotState(tmp)).toEqual(before);
  });
});

// ── Session derivations: warm-up + diagnostics roots ──────────────

describe("session roots route through resolveStateRoot", () => {
  it("semantic warm-up targets the canonical root from a nested-marker cwd", async () => {
    const savedBaseUrl = process.env.PI_SMARTREAD_EMBEDDING_BASE_URL;
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://127.0.0.1:9/v1";
    writeFileSync(path.join(gitproj, "pi-smartread.config.json"), '{"model":"test-embedding-model"}\n');
    try {
      await startSession(nestedCwd);

      expect(warmupCalls.roots).toContain(gitproj);
      expect(warmupCalls.roots.some((root) => root.includes("fixtures"))).toBe(false);
      // No nested state may have appeared while starting the session.
      expect(snapshotState(path.join(gitproj, "pkg"))).toEqual([]);
    } finally {
      if (savedBaseUrl === undefined) delete process.env.PI_SMARTREAD_EMBEDDING_BASE_URL;
      else process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = savedBaseUrl;
      resetSessionState();
      rmSync(path.join(gitproj, "pi-smartread.config.json"), { force: true });
    }
  });

  it("effectiveSemanticRoot defaults to the canonical state root and keeps allowed-root clamping", () => {
    // Default (no explicit project root): nested marker → git top level.
    expect(effectiveSemanticRoot(nestedCwd)).toBe(gitproj);
    // No canonical state root at all → no automatic semantic indexing.
    expect(effectiveSemanticRoot(plaindir)).toBeNull();

    const savedAllowed = process.env.PI_SMARTREAD_ALLOWED_ROOT;
    try {
      // Allowed root inside the project clamps the index root.
      process.env.PI_SMARTREAD_ALLOWED_ROOT = path.join(gitproj, "pkg");
      expect(effectiveSemanticRoot(path.join(gitproj, "src"))).toBe(path.join(gitproj, "pkg"));

      // Disjoint allowed root → null (unchanged pre-existing semantics).
      process.env.PI_SMARTREAD_ALLOWED_ROOT = nongitproj;
      expect(effectiveSemanticRoot(path.join(gitproj, "src"))).toBeNull();
    } finally {
      if (savedAllowed === undefined) delete process.env.PI_SMARTREAD_ALLOWED_ROOT;
      else process.env.PI_SMARTREAD_ALLOWED_ROOT = savedAllowed;
    }
  });

  it("session diagnostics persist only at the canonical state root", async () => {
    process.env.PI_SMARTREAD_DIAGNOSTICS = "1";
    try {
      await startSession(nestedCwd);

      expect(existsSync(path.join(gitproj, ".pi-smartread", `diagnostics-${process.pid}.ndjson`))).toBe(true);
      expect(existsSync(path.join(nestedCwd, ".pi-smartread"))).toBe(false);
      expect(snapshotState(path.join(gitproj, "pkg"))).toEqual([]);
    } finally {
      delete process.env.PI_SMARTREAD_DIAGNOSTICS;
      resetSessionState(); // also stops the diagnostics timer
    }
  });
});
