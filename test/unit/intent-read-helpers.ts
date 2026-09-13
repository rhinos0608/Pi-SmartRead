import { beforeEach, afterEach } from "vitest";
import type { EmbedRequest, EmbedResult } from "../../src/embedding.js";

type ReadMapValue =
  | string
  | Error
  | { content: Array<{ type: "text"; text: string }>; details?: any };

type ReadInput = { path: string; offset?: number; limit?: number };

// Unified stub embedder factory. Success/failure/wrong-count variants share
// one implementation so split intent-read suites stay in sync.
function buildEmbedder(
  mode: "ok" | "fail" | "short",
  vectors: number[][],
  errorMsg: string,
  count: number,
): (req: EmbedRequest) => Promise<EmbedResult> {
  if (mode === "fail") {
    return async () => {
      throw new Error(errorMsg);
    };
  }
  if (mode === "short") {
    return async () => ({ vectors: Array.from({ length: count }, () => [1, 0]) });
  }
  return async () => ({ vectors });
}

// Stub fetchEmbeddings: returns unit vectors for easy scoring
export function makeEmbedder(vectors: number[][]): (req: EmbedRequest) => Promise<EmbedResult> {
  return buildEmbedder("ok", vectors, "", 0);
}

// Stub fetchEmbeddings: always throws
export function makeFailingEmbedder(errorMsg: string): (req: EmbedRequest) => Promise<EmbedResult> {
  return buildEmbedder("fail", [], errorMsg, 0);
}

// Stub fetchEmbeddings: returns fewer vectors than requested
export function makeWrongCountEmbedder(count: number): (req: EmbedRequest) => Promise<EmbedResult> {
  return buildEmbedder("short", [], "", count);
}

// Stub readTool: returns text content by path
export function makeReadTool(
  map: Record<string, ReadMapValue>,
  inspect?: (input: ReadInput) => void,
) {
  return {
    execute: async (_id: string, input: ReadInput) => {
      inspect?.(input);
      const val = map[input.path];
      if (!val) throw new Error(`No stub for: ${input.path}`);
      if (val instanceof Error) throw val;
      if (typeof val === "object" && "content" in val) return val;
      return { content: [{ type: "text" as const, text: val }] };
    },
  };
}

// Shared intent-read invocation: tool.execute with standard ambient args.
export function runIntentRead(tool: any, params: any, cwd = "/", id = "id"): Promise<any> {
  return tool.execute(id, params, undefined, undefined, { cwd } as any);
}

// Shared per-file detail lookup by path.
export function fileByPath(details: any, path: string): any {
  return details.files.find((f: any) => f.path === path);
}

// Registers the embedding-config env setup used by every intent-read suite.
export function setupIntentReadEnv(): void {
  let origBaseUrl: string | undefined;
  let origModel: string | undefined;
  beforeEach(() => {
    origBaseUrl = process.env.PI_SMARTREAD_EMBEDDING_BASE_URL;
    origModel = process.env.PI_SMARTREAD_EMBEDDING_MODEL;
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    process.env.PI_SMARTREAD_EMBEDDING_MODEL = "nomic-embed-text";
  });
  afterEach(() => {
    if (origBaseUrl === undefined) delete process.env.PI_SMARTREAD_EMBEDDING_BASE_URL;
    else process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = origBaseUrl;
    if (origModel === undefined) delete process.env.PI_SMARTREAD_EMBEDDING_MODEL;
    else process.env.PI_SMARTREAD_EMBEDDING_MODEL = origModel;
  });
}
