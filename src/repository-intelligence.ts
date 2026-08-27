/**
 * RepositoryIntelligenceService — Phase 1 implementation.
 *
 * Delivers bounded capabilities, relationships, impact, immutable capture,
 * and views. Ranking (Phase 3) and cross-revision delta (Phase 2) are stubbed.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getSharedContextGraphAsync,
  getWorkspaceRevision,
} from "./mcp-registry.js";
import { expandBlastRadius } from "./impact-analysis.js";
import { filenameToLang, type SupportedLanguage } from "./languages.js";
import { getSupportedExtensions as getGrammarExtensions } from "./grammar-loader.js";
import { findSrcFiles } from "./file-discovery.js";
import { computeSourceHash } from "./index-snapshot.js";
import type {
  RepositoryIntelligenceService,
  SnapshotRef,
  SnapshotId,
  ISO8601,
  CapabilityReport,
  ImpactCone,
  WorkspaceView,
  RelationshipEvidencePage,
  RankRequest,
  RankResult,
  SemanticDelta,
  ArtifactRef,
  ImpactConeRef,
} from "./repository-intelligence-types.js";

// ── Error type ──────────────────────────────────────────────────────

export class IntelligenceServiceNotImplementedError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(opts: { code: string; message: string; retryable: boolean }) {
    super(opts.message);
    this.name = "IntelligenceServiceNotImplementedError";
    this.code = opts.code;
    this.retryable = opts.retryable;
  }
}

// ── Language capability tables ──────────────────────────────────────

/** Languages with native call-graph support (tree-sitter grammars in callgraph.ts). */
const CALLGRAPH_LANGUAGES = new Set<SupportedLanguage>([
  "typescript", "tsx", "javascript", "python", "go", "rust",
]);

/** Languages with tag-index support (tree-sitter queries in tags module). */
const TAG_LANGUAGES = new Set<SupportedLanguage>([
  "typescript", "tsx", "javascript", "python", "go", "rust",
  "java", "c", "cpp", "ruby", "css", "bash",
]);

// ── Helpers ─────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function isoNow(): ISO8601 {
  return new Date().toISOString() as ISO8601;
}

function readFileSafe(root: string, relPath: string): string {
  try {
    return readFileSync(join(root, relPath), "utf-8");
  } catch {
    return "";
  }
}

// ── Snapshot → root registry ────────────────────────────────────────

/**
 * Internal registry mapping snapshotId → workspace root.
 * Allows getCapabilities/getRelationshipEvidence to resolve the root
 * from a snapshotId without it being in the interface contract.
 */
const snapshotRoots = new Map<string, string>();

// ── Capability computation ──────────────────────────────────────────

async function computeCapabilityReport(
  root: string,
): Promise<CapabilityReport> {
  const allFiles = await findSrcFiles(root);
  const grammarExts = new Set(getGrammarExtensions());

  // Group files by language
  const byLang = new Map<string, number>();
  for (const f of allFiles) {
    const lang = filenameToLang(f);
    const key = lang ?? "_unsupported";
    byLang.set(key, (byLang.get(key) ?? 0) + 1);
  }

  const byLanguage: CapabilityReport["byLanguage"] = [];

  for (const [langKey, fileCount] of byLang) {
    if (langKey === "_unsupported") {
      byLanguage.push({
        language: "unsupported",
        files: fileCount,
        tags: "UNAVAILABLE",
        structuralFacts: "UNAVAILABLE",
        callGraph: "UNAVAILABLE",
        lsp: "UNAVAILABLE",
        reasons: ["language not recognized by tree-sitter tag indexer"],
      });
      continue;
    }

    const lang = langKey as SupportedLanguage;
    const hasCallGraph = CALLGRAPH_LANGUAGES.has(lang);
    const hasTags = TAG_LANGUAGES.has(lang);

    // Structural facts: available when we have tags + grammar for AST
    const structuralFacts: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE" =
      hasTags ? (grammarExts.size > 0 ? "AVAILABLE" : "PARTIAL") : "UNAVAILABLE";

    const tags: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE" =
      hasTags ? "AVAILABLE" : "UNAVAILABLE";

    const callGraph: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE" =
      hasCallGraph ? "AVAILABLE" : "UNAVAILABLE";

    const reasons: string[] = [];
    if (!hasTags) reasons.push("no tree-sitter tag queries for this language");
    if (!hasCallGraph) reasons.push("call graph extraction not supported");

    byLanguage.push({
      language: lang,
      files: fileCount,
      tags,
      structuralFacts,
      callGraph,
      lsp: "UNAVAILABLE",
      reasons,
    });
  }

  const graphAssessment: CapabilityReport["graphAssessment"] =
    allFiles.length > 0 ? "complete" : "unavailable";

  const coverageReasons: string[] = [];
  if (allFiles.length === 0) {
    coverageReasons.push("no source files found in workspace");
  }
  const unsupportedFiles = byLanguage
    .filter((l) => l.language === "unsupported")
    .reduce((s, l) => s + l.files, 0);
  if (unsupportedFiles > 0) {
    coverageReasons.push(
      `${unsupportedFiles} file(s) use unsupported languages with no tag or call-graph analysis`,
    );
  }
  const noCallGraph = byLanguage.filter(
    (l) => l.language !== "unsupported" && l.callGraph === "UNAVAILABLE",
  );
  if (noCallGraph.length > 0) {
    coverageReasons.push(
      `call graph unavailable for: ${noCallGraph.map((l) => l.language).join(", ")}`,
    );
  }

  return {
    filesObserved: allFiles.length,
    byLanguage,
    graphAssessment,
    coverageReasons,
    omittedEdgeCount: 0,
  };
}

// ── Service ─────────────────────────────────────────────────────────

export function createRepositoryIntelligenceService(): RepositoryIntelligenceService {
  return new RepoIntelService();
}

class RepoIntelService implements RepositoryIntelligenceService {
  async getWorkspaceSnapshot(input: {
    root: string;
    expectedGraphRevision?: number;
    includeDiagnostics: boolean;
    pin?: { owner: string; leaseId: string; expiresAt: ISO8601 };
    budget: { maxMs: number; maxBytes: number };
  }): Promise<{ snapshot: SnapshotRef; capabilities: CapabilityReport }> {
    const deadline = Date.now() + input.budget.maxMs;

    // 1. Build the context graph (single entry point for all graph access)
    await getSharedContextGraphAsync(input.root);

    if (Date.now() >= deadline) {
      throw new IntelligenceServiceNotImplementedError({
        code: "BUDGET_EXCEEDED",
        message: "getWorkspaceSnapshot exceeded maxMs during graph build",
        retryable: true,
      });
    }

    // 2. Check revision if expected
    const currentRevision = getWorkspaceRevision();
    if (
      input.expectedGraphRevision !== undefined &&
      currentRevision !== input.expectedGraphRevision
    ) {
      throw new IntelligenceServiceNotImplementedError({
        code: "STALE_REVISION",
        message: `expected revision ${input.expectedGraphRevision}, current is ${currentRevision}`,
        retryable: true,
      });
    }

    // 3. Compute capabilities
    const capabilities = await computeCapabilityReport(input.root);

    if (Date.now() >= deadline) {
      throw new IntelligenceServiceNotImplementedError({
        code: "BUDGET_EXCEEDED",
        message: "getWorkspaceSnapshot exceeded maxMs during capability computation",
        retryable: true,
      });
    }

    // 4. Compute source hash
    const allFiles = await findSrcFiles(input.root);
    const sourceHash = computeSourceHash(allFiles);

    // 5. Snapshot ID: sha256(root + sourceHash)
    const snapshotId = sha256(`${input.root}:${sourceHash}`) as SnapshotId;

    // 6. Register root for later lookups by snapshotId
    snapshotRoots.set(snapshotId, input.root);

    // 7. Truncate capabilities if they exceed byte budget
    let finalCapabilities = capabilities;
    const capBytes = new TextEncoder().encode(JSON.stringify(capabilities)).byteLength;
    if (capBytes > input.budget.maxBytes) {
      const ratio = input.budget.maxBytes / capBytes;
      const maxLangEntries = Math.max(0, Math.floor(ratio * capabilities.byLanguage.length));
      finalCapabilities = {
        ...capabilities,
        byLanguage: capabilities.byLanguage.slice(0, maxLangEntries),
        coverageReasons: [
          ...capabilities.coverageReasons,
          `capability report truncated to fit ${input.budget.maxBytes} byte budget`,
        ],
      };
    }

    return {
      snapshot: {
        snapshotId,
        workspaceRootHash: sha256(input.root),
        sourceHash,
        graphRevision: currentRevision,
        createdAt: isoNow(),
        capabilityDigest: sha256(JSON.stringify(finalCapabilities)),
      },
      capabilities: finalCapabilities,
    };
  }

  // ── Phase 2: structural delta (paths + content hashes) ────────

  async compareSnapshots(input: {
    before: SnapshotId;
    after: SnapshotId;
    budget: { maxMs: number; maxEntities: number };
  }): Promise<SemanticDelta> {
    const rootBefore = snapshotRoots.get(input.before);
    const rootAfter = snapshotRoots.get(input.after);

    if (!rootBefore || !rootAfter) {
      throw new IntelligenceServiceNotImplementedError({
        code: "INTERNAL",
        message: "snapshot not found; call getWorkspaceSnapshot first",
        retryable: true,
      });
    }

    const deadline = Date.now() + input.budget.maxMs;
    const maxEntities = Math.min(input.budget.maxEntities, 2000);

    // Scan both workspaces
    const filesBefore = await findSrcFiles(rootBefore);
    const filesAfter = await findSrcFiles(rootAfter);

    if (Date.now() >= deadline) {
      throw new IntelligenceServiceNotImplementedError({
        code: "BUDGET_EXCEEDED",
        message: "compareSnapshots exceeded budget during file scan",
        retryable: true,
      });
    }

    const setBefore = new Set(filesBefore);
    const setAfter = new Set(filesAfter);

    const added = filesAfter.filter((f) => !setBefore.has(f));
    const removed = filesBefore.filter((f) => !setAfter.has(f));

    // For common files, compare content hashes to detect modifications
    const common = filesBefore.filter((f) => setAfter.has(f));
    const modified: string[] = [];

    // Batch hash computation within budget
    const maxCommon = Math.min(common.length, maxEntities);
    for (let i = 0; i < maxCommon; i++) {
      if (Date.now() >= deadline) break;
      const relPath = common[i]!;
      const hashBefore = sha256(readFileSafe(rootBefore, relPath));
      const hashAfter = sha256(readFileSafe(rootAfter, relPath));
      if (hashBefore !== hashAfter) {
        modified.push(relPath);
      }
    }

    return {
      __phasePlaceholder: "SemanticDelta" as const,
      snapshotId: input.after,
      addedEntities: added,
      removedEntities: removed,
      changedEntities: modified,
    };
  }

  // ── Phase 3: relationship-count ranking ──────────────────────

  async rankWorkspace(input: RankRequest): Promise<RankResult> {
    const root = snapshotRoots.get(input.snapshotId);
    if (!root) {
      throw new IntelligenceServiceNotImplementedError({
        code: "INTERNAL",
        message: "snapshot not found; call getWorkspaceSnapshot first",
        retryable: true,
      });
    }

    const maxEntities = Math.min(input.maxEntities, 2000);
    const files = await findSrcFiles(root);

    // Count relationships per entity from the context graph
    const relCount = new Map<string, number>();
    for (const f of files) {
      relCount.set(f, 0);
    }

    try {
      const graph = await getSharedContextGraphAsync(root);
      const edges = graph.getProvenanceEdges();
      for (const edge of edges) {
        if (relCount.has(edge.from)) relCount.set(edge.from, (relCount.get(edge.from) ?? 0) + 1);
        if (relCount.has(edge.to)) relCount.set(edge.to, (relCount.get(edge.to) ?? 0) + 1);
      }
    } catch {
      // Graph unavailable — fall back to file-order ranking
    }

    // Sort by relationship count descending, stable sort for ties
    const ranked = [...relCount.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, maxEntities)
      .map(([path]) => path);

    return {
      __phasePlaceholder: "RankResult" as const,
      snapshotId: input.snapshotId,
      rankedEntityIds: ranked,
    };
  }

  // ── Views ─────────────────────────────────────────────────────

  async renderWorkspaceView(input: {
    snapshotId: SnapshotId;
    rankedEntityIds: string[];
    cone?: ImpactConeRef;
    format: "OUTLINE" | "EVIDENCE" | "DIFF";
    hardBudget: { maxBytes: number; maxLines: number };
  }): Promise<WorkspaceView> {
    const maxBytes = input.hardBudget.maxBytes;
    const maxLines = input.hardBudget.maxLines;

    const entities: WorkspaceView["entities"] = [];
    let totalBytes = 0;
    let totalLines = 0;
    let omittedEntityCount = 0;
    let truncated = false;

    for (const entityId of input.rankedEntityIds) {
      let renderedText: string;
      switch (input.format) {
        case "OUTLINE":
          renderedText = entityId;
          break;
        case "EVIDENCE":
          renderedText = `[EVIDENCE] ${entityId}`;
          break;
        case "DIFF":
          renderedText = `[DIFF] ${entityId}`;
          break;
      }

      const textBytes = new TextEncoder().encode(renderedText).byteLength;
      const textLines = renderedText.split("\n").length;

      if (
        totalBytes + textBytes > maxBytes ||
        totalLines + textLines > maxLines
      ) {
        truncated = true;
        omittedEntityCount++;
        continue;
      }

      entities.push({
        entityId,
        path: entityId,
        renderedText,
        evidenceRefs: [] as ArtifactRef[],
      });
      totalBytes += textBytes;
      totalLines += textLines;
    }

    return {
      schemaVersion: 1,
      snapshotId: input.snapshotId,
      format: input.format,
      entities,
      assessment: truncated ? "partial" : "complete",
      omittedEntityCount,
      truncated,
      byteLength: totalBytes,
    };
  }

  // ── Impact cone ───────────────────────────────────────────────

  async getImpactCone(input: {
    snapshotId: SnapshotId;
    seeds: string[];
    direction: "CALLERS" | "CALLEES" | "BOTH";
    maxDepth: number;
    maxEntities: number;
  }): Promise<ImpactCone> {
    const maxDepth = Math.min(Math.max(0, input.maxDepth), 8);
    const maxSeeds = Math.min(input.seeds.length, 64);
    const seeds = input.seeds.slice(0, maxSeeds);
    const maxEntities = Math.min(input.maxEntities, 2000);

    if (seeds.length === 0) {
      return {
        schemaVersion: 1,
        snapshotId: input.snapshotId,
        seeds,
        direction: input.direction,
        maxDepth,
        entities: [],
        assessment: "complete",
        truncated: false,
        coverageReasons: [],
      };
    }

    // Look up workspace root from snapshot registry
    const root = snapshotRoots.get(input.snapshotId);
    if (!root) {
      return {
        schemaVersion: 1,
        snapshotId: input.snapshotId,
        seeds,
        direction: input.direction,
        maxDepth,
        entities: [],
        assessment: "unavailable",
        truncated: false,
        coverageReasons: ["snapshot not found; call getWorkspaceSnapshot first"],
      };
    }

    // Get the shared graph for traversal
    const graph = await getSharedContextGraphAsync(root);

    const allEntities = new Map<
      string,
      { entityId: string; distance: number; evidenceRefs: ArtifactRef[] }
    >();
    const coverageReasons: string[] = [];
    let assessment: "complete" | "partial" | "unavailable" = "complete";

    for (const seed of seeds) {
      if (allEntities.size >= maxEntities) break;

      // Add seed itself
      if (!allEntities.has(seed)) {
        allEntities.set(seed, { entityId: seed, distance: 0, evidenceRefs: [] });
      }

      // expandBlastRadius uses BFS through the context graph
      try {
        const blastResult = await expandBlastRadius(seed, graph, maxDepth, root);
        for (const [filePath, info] of blastResult) {
          if (allEntities.size >= maxEntities) break;
          if (!allEntities.has(filePath)) {
            allEntities.set(filePath, {
              entityId: filePath,
              distance: info.depth,
              evidenceRefs: [],
            });
          }
        }
      } catch {
        assessment = "partial";
        coverageReasons.push(`expansion failed for seed: ${seed}`);
      }
    }

    const entities = [...allEntities.values()].slice(0, maxEntities);
    const truncated = allEntities.size > maxEntities;

    return {
      schemaVersion: 1,
      snapshotId: input.snapshotId,
      seeds,
      direction: input.direction,
      maxDepth,
      entities,
      assessment,
      truncated,
      coverageReasons,
    };
  }

  // ── Relationship evidence ─────────────────────────────────────

  async getRelationshipEvidence(input: {
    snapshotId: SnapshotId;
    from?: string;
    to?: string;
    relationshipTypes?: string[];
    limit: number;
    cursor?: string;
  }): Promise<RelationshipEvidencePage> {
    const limit = Math.min(Math.max(1, input.limit), 500);

    // Look up root
    const root = snapshotRoots.get(input.snapshotId);
    if (!root) {
      return {
        schemaVersion: 1,
        snapshotId: input.snapshotId,
        edges: [],
        assessment: "partial",
      };
    }

    const graph = await getSharedContextGraphAsync(root);

    // Get all import edges from provenance
    const rawEdges = graph.getProvenanceEdges();

    // Filter by from/to if specified
    let filtered = rawEdges;
    if (input.from) {
      filtered = filtered.filter(
        (e) => e.from === input.from || e.from.endsWith(`/${input.from}`),
      );
    }
    if (input.to) {
      filtered = filtered.filter(
        (e) => e.to === input.to || e.to.endsWith(`/${input.to}`),
      );
    }

    // Map to RelationshipEvidencePage edges
    const edges: RelationshipEvidencePage["edges"] = filtered.map((e) => ({
      from: e.from,
      to: e.to,
      relationshipType: "imports",
      confidence: 1.0,
      provenanceRefs: [] as ArtifactRef[],
    }));

    // Enforce limit
    const limited = edges.slice(0, limit);
    const hasMore = edges.length > limit;

    return {
      schemaVersion: 1,
      snapshotId: input.snapshotId,
      edges: limited,
      assessment: hasMore ? "partial" : "complete",
      ...(hasMore ? { nextCursor: `edge:${limit}` } : {}),
    };
  }

  // ── Capabilities ──────────────────────────────────────────────

  async getCapabilities(input: {
    snapshotId: SnapshotId;
  }): Promise<CapabilityReport> {
    const root = snapshotRoots.get(input.snapshotId);
    if (!root) {
      return {
        filesObserved: 0,
        byLanguage: [],
        graphAssessment: "unavailable",
        coverageReasons: [
          "snapshot not found; call getWorkspaceSnapshot first",
        ],
        omittedEdgeCount: 0,
      };
    }
    return computeCapabilityReport(root);
  }
}
