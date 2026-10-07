/**
 * Kernel Phase 1 parity: adapters must return exactly what the underlying
 * channel functions return. Any divergence is a behavior change.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelContext } from "../../../src/retrieval/types.js";
import {
  allChannels,
  graphChannel,
  grepChannel,
  lspChannel,
  semanticChannel,
  structuralChannel,
  symbolChannel,
} from "../../../src/retrieval/channels.js";
import { runSearchChannel } from "../../../src/search/deep-search-structural.js";
import { runSymbolChannel } from "../../../src/search/deep-search-symbol.js";
import { runSemanticChannel } from "../../../src/search/deep-search-semantic.js";
import { runGraphChannel } from "../../../src/search/deep-search-graph.js";
import { runLSPChannel } from "../../../src/search/deep-search-lsp.js";

let root: string;

function mockContext() {
  return { cwd: root } as any;
}

function channelContext(): ChannelContext {
  return {
    query: "requireAuth",
    cwd: root,
    signal: undefined,
    ctx: mockContext(),
    discoveredFiles: [join(root, "auth.ts"), join(root, "api.ts")].sort((a, b) =>
      a.localeCompare(b),
    ),
    seedFiles: ["auth.ts"],
    maxResults: 45,
    limit: 15,
    depth: "standard",
  };
}

beforeEach(() => {
  vi.stubEnv("PI_SMARTREAD_EMBEDDING_BASE_URL", undefined as never);
  vi.stubEnv("PI_SMARTREAD_EMBEDDING_MODEL", undefined as never);
  vi.stubEnv("EMBEDDING_BASE_URL", undefined as never);
  vi.stubEnv("EMBEDDING_MODEL", undefined as never);
  root = mkdtempSync(join(tmpdir(), "retrieval-channels-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(root, "auth.ts"),
    `export function authenticateToken(token: string): boolean {\n  return token.length > 0;\n}\n\nexport function requireAuth(header: string): boolean {\n  return authenticateToken(header.replace("Bearer ", ""));\n}\n`,
    "utf-8",
  );
  writeFileSync(
    join(root, "api.ts"),
    `import { requireAuth } from "./auth";\n\nexport function handleRequest(header: string): string {\n  return requireAuth(header) ? "ok" : "denied";\n}\n`,
    "utf-8",
  );
  mkdirSync(join(root, ".git"), { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("retrieval channel adapters", () => {
  it("exposes all six channels with unique phase order", () => {
    expect(allChannels.map((c) => c.name)).toEqual([
      "structural",
      "structural",
      "symbol",
      "semantic",
      "lsp",
      "graph",
    ]);
  });

  it("structural adapter matches runSearchChannel(code)", async () => {
    const ctx = channelContext();
    const [adapted, direct] = await Promise.all([
      structuralChannel.run(ctx),
      runSearchChannel(ctx.query, ctx.cwd, "code", ctx.maxResults, ctx.signal, ctx.ctx),
    ]);
    expect(adapted).toEqual({ channel: "structural", candidates: direct });
  });

  it("grep adapter matches runSearchChannel(grep)", async () => {
    const ctx = channelContext();
    const [adapted, direct] = await Promise.all([
      grepChannel.run(ctx),
      runSearchChannel(ctx.query, ctx.cwd, "grep", ctx.maxResults, ctx.signal, ctx.ctx),
    ]);
    expect(adapted).toEqual({ channel: "structural", candidates: direct });
  });

  it("symbol adapter matches runSymbolChannel", async () => {
    const ctx = channelContext();
    const [adapted, direct] = await Promise.all([
      symbolChannel.run(ctx),
      runSymbolChannel(ctx.query, ctx.cwd, ctx.maxResults, ctx.signal, ctx.ctx),
    ]);
    expect(adapted).toEqual({ channel: "symbol", candidates: direct });
  });

  it("semantic adapter matches runSemanticChannel outcome", async () => {
    const ctx = channelContext();
    const adapted = await semanticChannel.run(ctx);
    const direct = await runSemanticChannel(
      ctx.query,
      ctx.cwd,
      ctx.discoveredFiles,
      ctx.limit,
      ctx.signal,
      ctx.ctx,
    );
    expect(adapted).toEqual({
      channel: "semantic",
      candidates: direct.candidates,
      inspected: direct.inspected,
      scanned: direct.scanned,
      strategy: direct.strategy,
    });
  });

  it("graph adapter matches runGraphChannel with seeds", async () => {
    const ctx = channelContext();
    const { MAX_GRAPH_CANDIDATES } = await import(
      "../../../src/search/deep-search-graph.js"
    );
    const [adapted, direct] = await Promise.all([
      graphChannel.run(ctx),
      runGraphChannel(
        ctx.cwd,
        ctx.seedFiles,
        ctx.discoveredFiles,
        Math.min(MAX_GRAPH_CANDIDATES, ctx.maxResults),
        ctx.signal,
      ),
    ]);
    expect(adapted).toEqual({ channel: "graph", candidates: direct });
  });

  it("lsp adapter matches runLSPChannel", async () => {
    const ctx = channelContext();
    const [adapted, direct] = await Promise.all([
      lspChannel.run(ctx),
      runLSPChannel(ctx.query, ctx.cwd, ctx.depth, ctx.maxResults, ctx.signal),
    ]);
    expect(adapted).toEqual({ channel: "lsp", candidates: direct });
  });
});
