/**
 * Kernel Phase 2: runQueryChannels fanout / degraded / abort semantics, plus
 * the minimal persistentIndexChannel projection used by query-retrieval.
 */
import { describe, expect, it } from "vitest";
import type {
  ChannelContext,
  ChannelName,
  RetrievalCandidate,
  RetrievalChannel,
} from "../../../src/retrieval/types.js";
import { persistentIndexChannel, runQueryChannels } from "../../../src/retrieval/runner.js";

function stubContext(overrides: Partial<ChannelContext> = {}): ChannelContext {
  return {
    query: "semanticNeedle",
    cwd: "/tmp",
    signal: undefined,
    ctx: undefined as never,
    discoveredFiles: [],
    seedFiles: [],
    maxResults: 10,
    limit: 10,
    depth: "standard",
    ...overrides,
  };
}

function candidate(file: string, rank: number): RetrievalCandidate {
  return { file, name: file, kind: "file", snippet: "", channel: "semantic", rawScore: 1, rank };
}

function stubChannel(
  name: ChannelName,
  outcome: RetrievalCandidate[] | Error,
): RetrievalChannel {
  return {
    name,
    async run() {
      if (outcome instanceof Error) throw outcome;
      return { channel: name, candidates: outcome };
    },
  };
}

describe("runQueryChannels", () => {
  it("concatenates fulfilled candidates in channel order", async () => {
    const channels = [
      stubChannel("structural", [candidate("b.ts", 1)]),
      stubChannel("symbol", [candidate("a.ts", 1), candidate("c.ts", 2)]),
    ];
    const result = await runQueryChannels(channels, stubContext());
    expect(result.candidates.map((c) => c.file)).toEqual(["b.ts", "a.ts", "c.ts"]);
    expect(result.degraded).toEqual([]);
  });

  it("surfaces per-channel results with metadata", async () => {
    const channels = [
      {
        name: "semantic",
        async run() {
          return { channel: "semantic", candidates: [candidate("a.ts", 1)], inspected: 1, scanned: 9, strategy: "bm25-preselect" };
        },
      } as RetrievalChannel,
    ];
    const result = await runQueryChannels(channels, stubContext());
    expect(result.results).toEqual([
      { channel: "semantic", candidates: [candidate("a.ts", 1)], inspected: 1, scanned: 9, strategy: "bm25-preselect" },
    ]);
  });

  it("records rejections as degraded and keeps fulfilled candidates", async () => {
    const channels = [
      stubChannel("structural", [candidate("a.ts", 1)]),
      stubChannel("symbol", new Error("boom")),
    ];
    const result = await runQueryChannels(channels, stubContext());
    expect(result.candidates.map((c) => c.file)).toEqual(["a.ts"]);
    expect(result.degraded).toEqual(["symbol channel failed: boom"]);
  });

  it("returns empty result for an empty channel list", async () => {
    await expect(runQueryChannels([], stubContext())).resolves.toEqual({
      candidates: [],
      degraded: [],
      results: [],
    });
  });

  it("rethrows instead of degrading when the signal aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const channels = [stubChannel("semantic", new Error("query offline"))];
    await expect(runQueryChannels(channels, stubContext({ signal: controller.signal }))).rejects.toThrow(
      "query offline",
    );
  });

  it("rethrows AbortError-named rejections even without a signal", async () => {
    const abort = Object.assign(new Error("Aborted"), { name: "AbortError" });
    const channels = [stubChannel("lsp", abort)];
    await expect(runQueryChannels(channels, stubContext())).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rethrows Operation aborted rejections even without a signal", async () => {
    const channels = [stubChannel("graph", new Error("Operation aborted"))];
    await expect(runQueryChannels(channels, stubContext())).rejects.toThrow("Operation aborted");
  });
});

describe("persistentIndexChannel", () => {
  it("projects index hits losslessly onto candidates with no discovery", async () => {
    const searched: Array<{ query: string; options: unknown }> = [];
    const channel = persistentIndexChannel(
      {
        root: "/root",
        async search(query: string, options: { topK: number; pathPrefix?: string }) {
          searched.push({ query, options });
          return [
            {
              filePath: "src/auth.ts",
              lineStart: 3,
              lineEnd: 7,
              symbolKind: "const",
              codeSnippet: "needle",
              score: 0.9,
            },
          ];
        },
      },
      { topK: 5, pathPrefix: "src" },
    );
    expect(channel.name).toBe("semantic");
    const result = await channel.run(stubContext({ query: "needle" }));
    expect(searched).toEqual([{ query: "needle", options: { topK: 5, pathPrefix: "src" } }]);
    expect(result.strategy).toBe("persistent-index");
    expect(result.candidates).toEqual([
      {
        file: "/root/src/auth.ts",
        line: 3,
        endLine: 7,
        name: "const",
        kind: "const",
        snippet: "needle",
        channel: "semantic",
        rawScore: 0.9,
        rank: 1,
      },
    ]);
  });
});
