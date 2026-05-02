import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createIntentReadTool } from "../../intent-read.js";
import { SCENARIOS, createRetrievalFixture, cleanupFixture, RetrievalFixture } from "../helpers/retrieval-fixtures.js";
import type { EmbedRequest, EmbedResult } from "../../embedding.js";


// Stub fetchEmbeddings: returns unit vectors based on keywords to simulate perfect semantic match
async function mockFetchEmbeddings(req: EmbedRequest): Promise<EmbedResult> {
  const vectors: number[][] = [];
  const queryTokens = new Set(req.inputs[0]!.toLowerCase().split(/\s+/));
  
  for (const input of req.inputs) {
    const inputTokens = input.toLowerCase().split(/\s+/);
    let score = 0;
    for (const token of inputTokens) {
      if (queryTokens.has(token)) score += 1;
    }
    // Simple mock vector: [score, 0, 0, ...]
    vectors.push([score, 0, 0]);
  }
  return { vectors };
}

describe("Advanced Retrieval Baseline (Phase 0)", () => {
  let fixture: RetrievalFixture;

  beforeEach(() => {
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    process.env.PI_SMARTREAD_EMBEDDING_MODEL = "mock-embed";
  });

  afterEach(() => {
    if (fixture) cleanupFixture(fixture);
    delete process.env.PI_SMARTREAD_EMBEDDING_BASE_URL;
    delete process.env.PI_SMARTREAD_EMBEDDING_MODEL;
  });

  it("Scenario 1: Exact lexical match (Baseline)", async () => {
    fixture = createRetrievalFixture("lexical", SCENARIOS.lexicalMatch);
    const tool = createIntentReadTool(undefined, mockFetchEmbeddings);

    const result = await tool.execute(
      "id",
      { query: "authenticating", directory: fixture.root },
      undefined,
      undefined,
      { cwd: fixture.root } as any
    );

    const text = (result.content[0] as any).text as string;
    // Current behavior should find auth.ts because of lexical match
    expect(text).toContain("auth.ts");
    expect(text).not.toContain("db.ts");
  });

  it("Scenario 3: Import neighbor match (Baseline)", async () => {
    fixture = createRetrievalFixture("import", SCENARIOS.importNeighbor);
    const tool = createIntentReadTool(undefined, mockFetchEmbeddings);

    // Query for "console", which is in app.ts body
    const result = await tool.execute(
      "id",
      { query: "console", files: [{ path: "app.ts" }], topK: 2 },
      undefined,
      undefined,
      { cwd: fixture.root } as any
    );

    const text = (result.content[0] as any).text as string;
    const details = result.details as any;

    expect(text).toContain("app.ts");
    // Current intent_read SHOULD already support direct relative import augmentation
    expect(details.graphAugmentation.addedPaths).toContain(fixture.root + "/config.ts");
  });

  it("Scenario 4: Symbol cross-file match (Baseline - MISSING)", async () => {
    fixture = createRetrievalFixture("symbol", SCENARIOS.symbolCrossFile);
    const tool = createIntentReadTool(undefined, mockFetchEmbeddings);

    // Querying for "UserService"
    const result = await tool.execute(
      "id",
      { query: "UserService", files: [{ path: "service.ts" }], topK: 5 },
      undefined,
      undefined,
      { cwd: fixture.root } as any
    );

    const details = result.details as any;
    // CURRENT BEHAVIOR: does NOT find repo.ts because it's only a class reference, 
    // not necessarily a relative import (though in this scenario it is also an import).
    
    // In this specific scenario, UserService imports Repository from ./repo.
    // So it should be found IF current logic catches relative imports well.
    expect(details.graphAugmentation.addedPaths).toContain(fixture.root + "/repo.ts");
  });
});
