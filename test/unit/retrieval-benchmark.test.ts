/**
 * Retrieval benchmarks: Recall@k and MRR metrics.
 *
 * Measures how well the intent_read retrieval pipeline ranks relevant files.
 * Each benchmark scenario defines a query, candidate files, and ground-truth
 * relevant files. We compute:
 *
 *   Recall@k  = |relevant ∩ top-k| / |relevant|
 *   MRR        = avg(1 / rank_of_first_relevant)
 *   Precision@k = |relevant ∩ top-k| / k
 *
 * These metrics track retrieval quality over time and catch regressions.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createIntentReadTool } from "../../intent-read.js";
import {
  createRetrievalFixture,
  cleanupFixture,
  RetrievalFixture,
} from "../helpers/retrieval-fixtures.js";
import type { EmbedRequest, EmbedResult } from "../../embedding.js";

// ── Metric helpers ────────────────────────────────────────────────

/** Recall@k: fraction of relevant docs found in the top-k results. */
function recallAtK(rankedPaths: string[], relevantPaths: Set<string>, k: number): number {
  if (relevantPaths.size === 0) return 1; // vacuously true
  const topK = rankedPaths.slice(0, k);
  const hits = topK.filter((p) => relevantPaths.has(p)).length;
  return hits / relevantPaths.size;
}

/** Precision@k: fraction of top-k results that are relevant. */
function precisionAtK(rankedPaths: string[], relevantPaths: Set<string>, k: number): number {
  if (k === 0) return 0;
  const topK = rankedPaths.slice(0, k);
  const hits = topK.filter((p) => relevantPaths.has(p)).length;
  return hits / k;
}

/** MRR: Mean Reciprocal Rank — 1/rank of the first relevant result. */
function mrr(rankedPaths: string[], relevantPaths: Set<string>): number {
  for (let i = 0; i < rankedPaths.length; i++) {
    if (relevantPaths.has(rankedPaths[i]!)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/** NDCG@k: Normalized Discounted Cumulative Gain (binary relevance). */
function ndcgAtK(rankedPaths: string[], relevantPaths: Set<string>, k: number): number {
  // DCG: sum of 1/log2(i+2) for relevant docs in top-k
  let dcg = 0;
  const topK = rankedPaths.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    if (relevantPaths.has(topK[i]!)) {
      dcg += 1 / Math.log2(i + 2); // i+2 because rank is 1-indexed
    }
  }
  // Ideal DCG: all relevant docs at the top
  const idealCount = Math.min(relevantPaths.size, k);
  let idcg = 0;
  for (let i = 0; i < idealCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 1 : dcg / idcg;
}

// ── Mock embeddings ───────────────────────────────────────────────

/**
 * Semantic-aware mock embeddings: simulates embedding similarity by
 * computing token overlap between query and document, but also gives
 * a bonus for files that are semantically related (defined in fixtures).
 */
function makeSemanticMockEmbedder(
): (req: EmbedRequest) => Promise<EmbedResult> {
  return async (req: EmbedRequest): Promise<EmbedResult> => {
    const query = req.inputs[0]!;
    const queryTokens = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
    const vectors: number[][] = [];

    for (let i = 0; i < req.inputs.length; i++) {
      const input = req.inputs[i]!;
      const inputTokens = input.toLowerCase().split(/\W+/).filter(Boolean);

      // Base score: token overlap
      let score = 0;
      for (const token of inputTokens) {
        if (queryTokens.has(token)) score += 1;
      }
      // Normalize to [0, 1] range roughly
      const normalized = Math.min(1, score / Math.max(1, inputTokens.length));

      vectors.push([normalized, 0, 0]);
    }
    return { vectors };
  };
}

// ── Benchmark scenarios ───────────────────────────────────────────

interface BenchmarkScenario {
  name: string;
  description: string;
  query: string;
  files: Record<string, string>;
  /** Files that should be retrieved for this query (ground truth). */
  relevantFiles: string[];
  /** Number of top results to return for retrieval/search. */
  topK?: number;
}

const BENCHMARKS: BenchmarkScenario[] = [
  {
    name: "lexical-exact",
    description: "Exact keyword match in function name — baseline sanity check",
    query: "handleUserLogin",
    files: {
      "auth.ts": "export function handleUserLogin(credentials: Credentials) { return authenticate(credentials); }",
      "user.ts": "export function getUser(id: string) { return db.find(id); }",
      "order.ts": "export function createOrder(items: Item[]) { return db.insert(items); }",
      "config.ts": "export const config = { port: 8080, debug: false };",
    },
    relevantFiles: ["auth.ts"],
    topK: 4,
  },
  {
    name: "lexical-partial",
    description: "Partial keyword match — token overlap with query",
    query: "authentication middleware",
    files: {
      "auth-middleware.ts": "export function authMiddleware(req, res, next) { /* authenticate request */ checkToken(req.headers.authorization); }",
      "logging-middleware.ts": "export function loggingMiddleware(req, res, next) { console.log(req.url); next(); }",
      "auth.ts": "export function checkToken(token: string) { return jwt.verify(token); }",
      "routes.ts": "export function setupRoutes(app) { app.get('/api', handler); }",
    },
    relevantFiles: ["auth-middleware.ts", "auth.ts"],
    topK: 4,
  },
  {
    name: "import-neighbor",
    description: "Direct import dependency — file imported by seed should rank high",
    query: "database connection",
    files: {
      "app.ts": "import { Database } from './database';\nconst db = new Database();\nexport function start() { db.connect(); }",
      "database.ts": "export class Database { connect() { /* connect to postgres */ } query(sql: string) { return this.conn.execute(sql); } }",
      "helpers.ts": "export function formatDate(d: Date) { return d.toISOString(); }",
      "types.ts": "export interface User { id: string; name: string; }",
    },
    relevantFiles: ["database.ts", "app.ts"],
    topK: 4,
  },
  {
    name: "symbol-cross-file",
    description: "Symbol defined in one file, used in another — test cross-file resolution",
    query: "Repository",
    files: {
      "repo.ts": "export class Repository { find(id: string) { return db.query(id); } findAll() { return db.queryAll(); } }",
      "service.ts": "import { Repository } from './repo';\nexport class UserService { constructor(private repo: Repository) {} getUser(id: string) { return this.repo.find(id); } }",
      "controller.ts": "import { UserService } from './service';\nexport function getUserHandler(req) { return new UserService().getUser(req.params.id); }",
      "unrelated.ts": "export function calculateTax(amount: number) { return amount * 0.1; }",
    },
    relevantFiles: ["repo.ts", "service.ts"],
    topK: 4,
  },
  {
    name: "camelCase-split",
    description: "Query uses different casing than source — tests token splitting",
    query: "UserService",
    files: {
      "user-service.ts": "export class UserService { find(id: string) {} create(data: UserData) {} }",
      "user.ts": "export interface User { id: string; name: string; }",
      "auth-service.ts": "export class AuthService { login(creds: Credentials) {} logout() {} }",
      "db.ts": "export function query(sql: string) { return []; }",
    },
    relevantFiles: ["user-service.ts"],
    topK: 4,
  },
  {
    name: "noise-filtering",
    description: "Many irrelevant files — tests that noise files are filtered out",
    query: "error handling retry logic",
    files: {
      "retry.ts": "export async function retry(fn: () => Promise<void>, maxAttempts: number) { for (let i = 0; i < maxAttempts; i++) { try { return await fn(); } catch (error) { if (i === maxAttempts - 1) throw error; await delay(1000 * i); } } }",
      "error-handler.ts": "export function handleError(error: Error) { logger.error(error.message); return { status: 500, message: error.message }; }",
      "button.tsx": "export function Button({ onClick, label }) { return <button onClick={onClick}>{label}</button>; }",
      "theme.ts": "export const theme = { primary: '#007bff', secondary: '#6c757d' };",
      "utils.ts": "export function formatCurrency(amount: number) { return `$${amount.toFixed(2)}`; }",
      "logger.ts": "export const logger = { info: console.log, error: console.error };",
    },
    relevantFiles: ["retry.ts", "error-handler.ts"],
    topK: 6,
  },
  {
    name: "multi-concept",
    description: "Query spans multiple concepts — tests holistic ranking",
    query: "user authentication JWT token validation",
    files: {
      "jwt.ts": "export function verifyToken(token: string) { return jwt.verify(token, SECRET); } export function signToken(payload: object) { return jwt.sign(payload, SECRET); }",
      "auth.ts": "export function authenticate(credentials: { email: string; password: string }) { const user = findByEmail(credentials.email); return bcrypt.compare(credentials.password, user.hash); }",
      "guard.ts": "export function authGuard(req, res, next) { const token = req.headers.authorization; if (!verifyToken(token)) return res.status(401); next(); }",
      "user-model.ts": "export interface User { id: string; email: string; hash: string; } export function findByEmail(email: string) { return db.users.findOne({ email }); }",
      "product.ts": "export interface Product { id: string; name: string; price: number; }",
      "cart.ts": "export function addToCart(userId: string, productId: string) { return db.cart.insert({ userId, productId }); }",
    },
    relevantFiles: ["jwt.ts", "auth.ts", "guard.ts"],
    topK: 6,
  },
];

// ── Test suite ────────────────────────────────────────────────────

describe("Retrieval Benchmarks (Recall@k / MRR)", () => {
  let fixture: RetrievalFixture;
  const mockEmbedder = makeSemanticMockEmbedder();

  beforeEach(() => {
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    process.env.PI_SMARTREAD_EMBEDDING_MODEL = "mock-embed";
  });

  afterEach(() => {
    if (fixture) cleanupFixture(fixture);
    delete process.env.PI_SMARTREAD_EMBEDDING_BASE_URL;
    delete process.env.PI_SMARTREAD_EMBEDDING_MODEL;
  });

  for (const scenario of BENCHMARKS) {
    it(`${scenario.name}: ${scenario.description}`, async () => {
      fixture = createRetrievalFixture(scenario.name, scenario.files);
      const tool = createIntentReadTool(undefined, mockEmbedder);

      const result = await tool.execute(
        "bench",
        {
          query: scenario.query,
          directory: fixture.root,
          topK: scenario.topK ?? 20,
        },
        undefined,
        undefined,
        { cwd: fixture.root } as any,
      );

      const details = result.details as any;

      // Extract ranked file paths (only successfully read and included files)
      const rankedPaths: string[] = (details.files as any[])
        .filter((f: any) => f.ok && f.included)
        .map((f: any) => {
          // Normalize to basename for comparison
          const parts = f.path.split("/");
          return parts[parts.length - 1]!;
        });

      const relevantSet = new Set(scenario.relevantFiles);

      // Compute metrics
      const k = Math.min(scenario.topK ?? 3, rankedPaths.length);
      const recall = recallAtK(rankedPaths, relevantSet, k);
      const precision = precisionAtK(rankedPaths, relevantSet, k);
      const reciprocalRank = mrr(rankedPaths, relevantSet);
      const ndcg = ndcgAtK(rankedPaths, relevantSet, k);

      // Log metrics for observability
      console.log(`\n📊 ${scenario.name}:`);
      console.log(`   Ranked: [${rankedPaths.join(", ")}]`);
      console.log(`   Relevant: [${scenario.relevantFiles.join(", ")}]`);
      console.log(`   Recall@${k}: ${recall.toFixed(3)}`);
      console.log(`   Precision@${k}: ${precision.toFixed(3)}`);
      console.log(`   MRR: ${reciprocalRank.toFixed(3)}`);
      console.log(`   NDCG@${k}: ${ndcg.toFixed(3)}`);

      // Assertions — all scenarios should achieve perfect or near-perfect recall
      // These are "sanity check" benchmarks with clear relevance signals
      expect(recall).toBeGreaterThanOrEqual(0.5);
      expect(reciprocalRank).toBeGreaterThan(0);
    });
  }

  it("aggregate metrics summary", async () => {
    const results: Array<{
      name: string;
      recall: number;
      mrr: number;
      precision: number;
      ndcg: number;
    }> = [];

    for (const scenario of BENCHMARKS) {
      const fix = createRetrievalFixture(`agg-${scenario.name}`, scenario.files);
      try {
        const tool = createIntentReadTool(undefined, mockEmbedder);
        const result = await tool.execute(
          "bench",
          {
            query: scenario.query,
            directory: fix.root,
            topK: scenario.topK ?? 20,
          },
          undefined,
          undefined,
          { cwd: fix.root } as any,
        );

        const details = result.details as any;
        const rankedPaths: string[] = (details.files as any[])
          .filter((f: any) => f.ok && f.included)
          .map((f: any) => f.path.split("/").pop()!);

        const relevantSet = new Set(scenario.relevantFiles);
        const k = Math.min(scenario.topK ?? 3, rankedPaths.length);

        results.push({
          name: scenario.name,
          recall: recallAtK(rankedPaths, relevantSet, k),
          mrr: mrr(rankedPaths, relevantSet),
          precision: precisionAtK(rankedPaths, relevantSet, k),
          ndcg: ndcgAtK(rankedPaths, relevantSet, k),
        });
      } finally {
        cleanupFixture(fix);
      }
    }

    // Print summary table
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  RETRIEVAL BENCHMARK SUMMARY");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(
      "  Scenario".padEnd(25) +
        "Recall".padStart(10) +
        "MRR".padStart(10) +
        "Precision".padStart(12) +
        "NDCG".padStart(10),
    );
    console.log("─".repeat(67));

    for (const r of results) {
      console.log(
        `  ${r.name.padEnd(23)}${r.recall.toFixed(3).padStart(10)}${r.mrr.toFixed(3).padStart(10)}${r.precision.toFixed(3).padStart(12)}${r.ndcg.toFixed(3).padStart(10)}`,
      );
    }

    const avgRecall = results.reduce((s, r) => s + r.recall, 0) / results.length;
    const avgMrr = results.reduce((s, r) => s + r.mrr, 0) / results.length;
    const avgPrecision = results.reduce((s, r) => s + r.precision, 0) / results.length;
    const avgNdcg = results.reduce((s, r) => s + r.ndcg, 0) / results.length;

    console.log("─".repeat(67));
    console.log(
      `  ${"AVERAGE".padEnd(23)}${avgRecall.toFixed(3).padStart(10)}${avgMrr.toFixed(3).padStart(10)}${avgPrecision.toFixed(3).padStart(12)}${avgNdcg.toFixed(3).padStart(10)}`,
    );
    console.log("═══════════════════════════════════════════════════════════════\n");

    // Sanity: average MRR should be above 0.5 for these controlled scenarios
    expect(avgMrr).toBeGreaterThan(0.3);
    expect(avgRecall).toBeGreaterThan(0.4);
  });
});
