import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  preselectSemanticFiles,
  runSemanticChannel,
} from "../../../src/search/deep-search-semantic.js";

let root: string;

function mockContext() {
  return { cwd: root } as any;
}

beforeEach(() => {
  // Simulate "no embedding configured": delete vars entirely (empty string
  // fails URL validation upstream instead of degrading to BM25-only).
  vi.stubEnv("PI_SMARTREAD_EMBEDDING_BASE_URL", undefined as never);
  vi.stubEnv("PI_SMARTREAD_EMBEDDING_MODEL", undefined as never);
  vi.stubEnv("EMBEDDING_BASE_URL", undefined as never);
  vi.stubEnv("EMBEDDING_MODEL", undefined as never);
  root = mkdtempSync(join(tmpdir(), "deep-search-semantic-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("preselectSemanticFiles", () => {
  it("selects by relevance over the full corpus, not alphabetical position", () => {
    const files = Array.from({ length: 40 }, (_, i) => `/root/a${String(i).padStart(2, "0")}.ts`);
    const target = "/root/z-target.ts";
    const all = [...files, target];
    const bodies = new Map<string, string>();
    for (const file of files) bodies.set(file, "export const filler = 'unrelated plumbing';\n");
    bodies.set(target, "export function zebraStripeNeedle() { return 'zebraStripeNeedle'; }\n");
    const selected = preselectSemanticFiles(all, "zebraStripeNeedle", 15, (path) => bodies.get(path) ?? null);
    expect(selected).toHaveLength(30);
    expect(selected).toContain(target);
    // Documents the old bug: a naive alphabetical slice drops the target.
    expect(all.slice(0, 30)).not.toContain(target);
  });

  it("scores large files by bounded prefix without reading them whole", () => {
    const dir = mkdtempSync(join(tmpdir(), "preselect-big-"));
    try {
      const big = join(dir, "big.ts");
      writeFileSync(big, `const zebraStripeNeedle = 1;\n${"// filler\n".repeat(20000)}`, "utf-8");
      const files = Array.from({ length: 40 }, (_, i) => join(dir, `a${String(i).padStart(2, "0")}.ts`));
      for (const file of files) writeFileSync(file, "export const filler = 'unrelated plumbing';\n", "utf-8");
      const selected = preselectSemanticFiles([...files, big], "zebraStripeNeedle", 15);
      expect(selected).toContain(big);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the full list when it fits the budget", () => {
    const files = ["/root/b.ts", "/root/a.ts"];
    expect(preselectSemanticFiles(files, "anything", 15)).toEqual(files);
  });
});

describe("semantic coverage reporting", () => {
  it("reports bm25-preselect inspected/scanned counts in details and summary", async () => {
    const { executeDeepSearch } = await import("../../../src/search/deep-search.js");
    writeFileSync(join(root, "auth.ts"), "export function zebraStripeNeedle() { return 1; }\n", "utf-8");
    const result = await executeDeepSearch({ query: "zebraStripeNeedle", scope: "code" }, undefined, mockContext());
    const details = result.details as any;
    expect(details.semanticStrategy).toBe("bm25-preselect");
    expect(details.semanticScanned).toBe(details.filesInspected);
    expect(details.semanticInspected).toBeLessThanOrEqual(details.semanticScanned);
    expect(result.content[0]!.text).toContain("Semantic channel: bm25-preselect, embeddings ranked");
  });
});

describe("retrieval-kernel phase parity", () => {
  it("routes through kernel adapters with identical channelsUsed + semantic shape", async () => {
    const { executeDeepSearch } = await import("../../../src/search/deep-search.js");
    writeFileSync(join(root, "auth.ts"), "export function zebraStripeNeedle() { return 1; }\n", "utf-8");
    const result = await executeDeepSearch({ query: "zebraStripeNeedle", scope: "code" }, undefined, mockContext());
    const details = result.details as any;
    // Phase parity: kernel routing must not change observable shape.
    expect(details.channelsUsed).toContain("semantic");
    expect(details.semanticStrategy).toBe("bm25-preselect");
    expect(details.semanticScanned).toBe(details.filesInspected);
    expect(details.semanticInspected).toBeLessThanOrEqual(details.semanticScanned);
    expect(typeof details.filesInspected).toBe("number");
    expect(typeof details.discoveryTotal).toBe("number");
    expect(details.discoveryTotal).toBeGreaterThanOrEqual(details.filesInspected);
    expect(result.content[0]!.text).toContain("Semantic channel: bm25-preselect, embeddings ranked");
  });
});

describe("runSemanticChannel", () => {
  it("finds a relevant file that sorts last alphabetically", async () => {
    const junkPaths: string[] = [];
    for (let i = 0; i < 35; i++) {
      const name = `a${String(i).padStart(2, "0")}.ts`;
      mkdirSync(join(root), { recursive: true });
      writeFileSync(join(root, name), "export const filler = 'unrelated plumbing';\n", "utf-8");
      junkPaths.push(join(root, name));
    }
    const targetName = "z-target.ts";
    writeFileSync(
      join(root, targetName),
      "export function zebraStripeNeedle() { return 'zebraStripeNeedle'; }\n",
      "utf-8",
    );
    const files = [...junkPaths, join(root, targetName)].sort((a, b) => a.localeCompare(b));
    // Sanity: target sorts after the old 2*limit alphabetical window.
    expect(files.slice(0, 30)).not.toContain(join(root, targetName));

    const outcome = await runSemanticChannel("zebraStripeNeedle", root, files, 15, undefined, mockContext());
    expect(outcome.strategy).toBe("bm25-preselect");
    expect(outcome.scanned).toBe(files.length);
    expect(outcome.inspected).toBeLessThanOrEqual(30);
    expect(outcome.candidates.map((c) => c.file)).toContain(targetName);
  });
});
