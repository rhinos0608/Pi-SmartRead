/**
 * RepositoryIntelligenceService implementation.
 *
 * Delivers bounded capabilities, relationships, impact, immutable capture,
 * cross-revision delta, and ranking.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  getSharedContextGraphAsync,
  getWorkspaceRevision,
} from "../mcp-registry.js";
import { expandBlastRadius } from "../inspect/impact-analysis.js";
import { filenameToLang, type SupportedLanguage } from "../languages.js";
import { getSupportedExtensions as getGrammarExtensions } from "../structural/grammar-loader.js";
import { findSrcFiles } from "../file-discovery.js";
import { computeSourceHash, type SourceEntry } from "../indexing/index-snapshot.js";
import { getFsScanCache } from "../workspace/fs-scan-cache.js";
import { computeSemanticDelta } from "./semantic-delta.js";
import type { SymbolTag } from "./lineage-symbols.js";
import type { Provenance } from "../context-graph.js";
import { getTagsBatch } from "../structural/tags.js";
import type { Tag } from "../structural/cache.js";
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

/** Entity IDs are always posix-style forward slashes, even on Windows. */
function toPosixRel(nativeRel: string): string {
  return nativeRel.split(sep).join("/");
}

/**
 * Read a workspace file, or null when it cannot be read. Null is
 * deliberately distinct from "" so snapshot/delta semantics never confuse
 * an unreadable file with an empty one.
 */
function readFileOrNull(root: string, relPath: string): string | null {
  try {
    return readFileSync(join(root, relPath), "utf-8");
  } catch {
    return null;
  }
}

/** Content-hash marker for unreadable files. Path-bound so two different
 * unreadable files never share a marker. The `unreadable:` prefix keeps
 * markers outside the 64-lowercase-hex space of real sha256 digests, so no
 * file content — including the literal text `unreadable:<path>` — can ever
 * collide with a marker. Exported for tests. */
export function unreadableContentHash(posixRel: string): string {
  return `unreadable:${sha256(posixRel)}`;
}

/** Clamp a maxEntities budget to a non-negative integer, optionally capped. Shared by compareSnapshots and rankWorkspace. */
function clampMaxEntities(raw: number, upperBound = Number.POSITIVE_INFINITY): number {
  return Math.min(upperBound, Math.max(0, Math.floor(raw)));
}

/** Truncate one delta change list to budget; null reason when untouched. */
function truncateChangeList<T>(items: readonly T[], maxEntities: number, noun: string): { items: readonly T[]; truncated: boolean; reason: string | null } {
  if (items.length <= maxEntities) return { items, truncated: false, reason: null };
  return {
    items: items.slice(0, maxEntities),
    truncated: true,
    reason: `${noun} truncated to ${maxEntities} of ${items.length} to fit maxEntities budget`,
  };
}

/** Apply maxEntities budget to all three delta change lists (order-preserving, identical to inline slices). */
function applyMaxEntitiesBudget(delta: SemanticDelta, maxEntities: number): SemanticDelta {
  const file = truncateChangeList(delta.fileChanges, maxEntities, "fileChanges");
  const symbol = truncateChangeList(delta.symbolChanges, maxEntities, "symbolChanges");
  const rel = truncateChangeList(delta.relationshipChanges, maxEntities, "relationshipChanges");
  if (!file.truncated && !symbol.truncated && !rel.truncated) return delta;
  const coverageReasons = [...delta.coverageReasons];
  if (file.reason) coverageReasons.push(file.reason);
  if (symbol.reason) coverageReasons.push(symbol.reason);
  if (rel.reason) coverageReasons.push(rel.reason);
  return {
    ...delta,
    fileChanges: file.items,
    symbolChanges: symbol.items,
    relationshipChanges: rel.items,
    truncated: true,
    assessment: "partial",
    coverageReasons,
  };
}

/** Mark a delta partial when either snapshot capture degraded (file-level fallback). */
function withDegradedAssessment(delta: SemanticDelta, degraded: boolean): SemanticDelta {
  if (!degraded) return delta;
  return {
    ...delta,
    assessment: "partial" as const,
    coverageReasons: [
      ...delta.coverageReasons,
      "snapshot symbol/provenance capture exhausted budget; delta is file-level with partial symbol and relationship coverage",
    ],
  };
}

/** Count snapshot-time relationships per entity file. */
function countRelationshipsByFile(files: readonly string[], edges: readonly { from: string; to: string }[]): Map<string, number> {
  const relCount = new Map<string, number>();
  for (const f of files) {
    relCount.set(f, 0);
  }
  for (const edge of edges) {
    if (relCount.has(edge.from)) relCount.set(edge.from, (relCount.get(edge.from) ?? 0) + 1);
    if (relCount.has(edge.to)) relCount.set(edge.to, (relCount.get(edge.to) ?? 0) + 1);
  }
  return relCount;
}

/** Sort by relationship count descending (path tiebreak), then cap to budget. */
function topRankedByRelationships(relCount: ReadonlyMap<string, number>, maxEntities: number): Array<[string, number]> {
  return [...relCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxEntities);
}

/** Assessment + reasons for rankWorkspace based on capture-degraded flag. */
function buildRankAssessment(degraded: boolean): Pick<RankResult, "assessment" | "coverageReasons"> {
  if (degraded) {
    return {
      assessment: "partial",
      coverageReasons: ["snapshot symbol/provenance capture exhausted budget; ranking is based on partial relationship data"],
    };
  }
  return { assessment: "complete", coverageReasons: [] };
}

// ── Snapshot data registry ──────────────────────────────────────────

/**
 * Immutable per-snapshot data captured at snapshot time.
 * CompareSnapshots diffs this stored data, not live filesystem.
 */
interface CapturedSnapshot {
  root: string;
  fileEntries: SourceEntry[];
  unreadablePaths: string[];
  /** Per-file definition symbols for symbol-level lineage. Empty when tag capture degraded. */
  symbols: SymbolTag[];
  /** Provenance edges (posix-relative paths) for relationship-change detection. */
  edges: Provenance[];
  /** True when symbol/provenance capture exhausted budget; delta degrades to file-level. */
  captureDegraded: boolean;
}

function unreadableCoverageReason(unreadablePaths: string[]): string {
  const shown = unreadablePaths.slice(0, 5).join(", ");
  const suffix = unreadablePaths.length > 5 ? ` and ${unreadablePaths.length - 5} more` : "";
  return `${unreadablePaths.length} file(s) unreadable at snapshot time, hashed as unreadable markers (not empty): ${shown}${suffix}`;
}

/** Group snapshot provenance edges by source file for file-lineage inputs. */
function edgesForFile(
  edges: Provenance[],
  path: string,
): Array<{ to: string; type: string }> {
  const out: Array<{ to: string; type: string }> = [];
  for (const e of edges) {
    if (e.from === path) out.push({ to: e.to, type: e.type });
  }
  return out;
}

const MAX_SNAPSHOTS = 50;
const snapshotData = new Map<string, CapturedSnapshot>();

/** Chunk size for bounded tag extraction during snapshot capture. */
const SYMBOL_CAPTURE_CHUNK = 10;
/** Max body tokens stored per symbol (file-agnostic name parts first). */
const SYMBOL_BODY_TOKEN_CAP = 128;

/** Split an identifier into lowercase parts on camel/underscore boundaries. */
function symbolNameParts(name: string): string[] {
  return name.split(/(?=[A-Z])|_+|\W+/).map((s) => s.toLowerCase()).filter(Boolean);
}

/**
 * Convert tree-sitter def tags into SymbolTag lineage inputs.
 * Identity is file-agnostic (name-derived signature hash) so a symbol that
 * moves between files still matches; body hash binds the symbol to its
 * file's content hash so in-place edits surface as modified. File-content
 * tokens back the scoring fallback when hashes differ.
 * NOTE: Tag carries only a single def `line` (no endLine range), so body hash/tokens stay whole-file — any unrelated edit to the file flips every symbol's hash (move+unrelated-edit test pins current behavior).
 */
function tagsToSymbolTags(tags: Tag[], contents: Map<string, string>): SymbolTag[] {
  const out: SymbolTag[] = [];
  const tokensCache = new Map<string, string[]>();
  for (const tag of tags) {
    if (tag.kind !== "def") continue;
    const lang = filenameToLang(tag.relFname) ?? "unknown";
    const content = contents.get(tag.relFname) ?? "";
    let fileTokens = tokensCache.get(tag.relFname);
    if (!fileTokens) {
      fileTokens = content.split(/\W+/).filter(Boolean).slice(0, SYMBOL_BODY_TOKEN_CAP).map((t) => t.toLowerCase());
      tokensCache.set(tag.relFname, fileTokens);
    }
    out.push({
      id: `${tag.relFname}::${tag.name}:${tag.line}`,
      language: lang,
      kind: "def",
      qualifiedName: tag.name,
      signature: tag.name,
      signatureHash: sha256(`sig:${lang}:${tag.name}`),
      bodyHash: sha256(`${sha256(content)}:${lang}:${tag.name}`),
      bodyTokens: [...symbolNameParts(tag.name), ...fileTokens],
      parentQualifiedName: null,
      relationships: [],
    });
  }
  return out;
}

function pushLanguageEntry(
  byLanguage: CapabilityReport["byLanguage"],
  langKey: string,
  fileCount: number,
  grammarExts: Set<string>,
): void {
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
    return;
  }
  const lang = langKey as SupportedLanguage;
  const hasCallGraph = CALLGRAPH_LANGUAGES.has(lang);
  const hasTags = TAG_LANGUAGES.has(lang);
  // Structural facts: available when we have tags + grammar for AST
  const structuralFacts: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE" =
    hasTags ? (grammarExts.size > 0 ? "AVAILABLE" : "PARTIAL") : "UNAVAILABLE";
  const reasons: string[] = [];
  if (!hasTags) reasons.push("no tree-sitter tag queries for this language");
  if (!hasCallGraph) reasons.push("call graph extraction not supported");
  byLanguage.push({
    language: lang,
    files: fileCount,
    tags: hasTags ? "AVAILABLE" : "UNAVAILABLE",
    structuralFacts,
    callGraph: hasCallGraph ? "AVAILABLE" : "UNAVAILABLE",
    lsp: "UNAVAILABLE",
    reasons,
  });
}

function buildCoverageReasons(
  allFiles: string[],
  byLanguage: CapabilityReport["byLanguage"],
): string[] {
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
  return coverageReasons;
}

// ── Capability computation ──────────────────────────────────────────

async function computeCapabilityReport(
  fileEntries: SourceEntry[],
): Promise<CapabilityReport> {
  const allFiles = fileEntries.map((e) => e.path);
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
    pushLanguageEntry(byLanguage, langKey, fileCount, grammarExts);
  }

  const hasPartial = byLanguage.some(
    (l) => l.callGraph === "UNAVAILABLE" || l.tags === "UNAVAILABLE" || l.structuralFacts === "UNAVAILABLE",
  );
  const graphAssessment: CapabilityReport["graphAssessment"] =
    allFiles.length === 0 ? "unavailable" : hasPartial ? "partial" : "complete";

  const coverageReasons = buildCoverageReasons(allFiles, byLanguage);

  return {
    filesObserved: allFiles.length,
    byLanguage,
    graphAssessment,
    coverageReasons,
    omittedEdgeCount: 0,
  };
}

interface CollectedFiles {
  allFiles: string[];
  fileEntries: SourceEntry[];
  unreadablePaths: string[];
  fileContents: Map<string, string>;
}

async function collectFileEntries(root: string, deadline: number): Promise<CollectedFiles> {
  // Invalidate file-discovery cache so snapshot captures actual filesystem state
  const scanCache = getFsScanCache();
  scanCache.invalidatePath(root);
  const allFiles = await findSrcFiles(root);
  const fileEntries: SourceEntry[] = [];
  const unreadablePaths: string[] = [];
  const fileContents = new Map<string, string>();
  for (const absPath of allFiles) {
    if (Date.now() >= deadline) break;
    const nativeRel = relative(root, absPath);
    const posixRel = toPosixRel(nativeRel);
    const content = readFileOrNull(root, nativeRel);
    if (content === null) unreadablePaths.push(posixRel);
    else fileContents.set(posixRel, content);
    fileEntries.push({
      path: posixRel,
      contentHash: content === null ? unreadableContentHash(posixRel) : sha256(content),
    });
  }
  return { allFiles, fileEntries, unreadablePaths, fileContents };
}

interface CapturedSignals {
  symbols: SymbolTag[];
  edges: Provenance[];
  captureDegraded: boolean;
}

async function captureSymbolsAndEdges(
  root: string,
  allFiles: string[],
  fileContents: Map<string, string>,
  snapshotGraph: { getProvenanceEdges(): Array<{ from: string; to: string }> },
  deadline: number,
): Promise<CapturedSignals> {
  // On exhaustion degrade to file-level delta with a coverageReasons entry
  // instead of throwing: snapshot stays usable for fileChanges.
  let captureDegraded = Date.now() >= deadline;
  const collectedTags: Tag[] = [];
  const edges: Provenance[] = [];
  if (!captureDegraded) {
    const tagFiles = allFiles.filter((absPath) => {
      const lang = filenameToLang(toPosixRel(relative(root, absPath)));
      return lang !== undefined && TAG_LANGUAGES.has(lang);
    });
    for (let i = 0; i < tagFiles.length; i += SYMBOL_CAPTURE_CHUNK) {
      if (Date.now() >= deadline) {
        captureDegraded = true;
        break;
      }
      const chunk = tagFiles.slice(i, i + SYMBOL_CAPTURE_CHUNK);
      const chunkTags = await getTagsBatch(
        chunk.map((absPath) => ({
          fname: absPath,
          relFname: toPosixRel(relative(root, absPath)),
        })),
        null,
        false,
      );
      collectedTags.push(...chunkTags);
    }
    try {
      const rawEdges = snapshotGraph.getProvenanceEdges();
      for (const e of rawEdges) {
        if (Date.now() >= deadline) {
          captureDegraded = true;
          break;
        }
        edges.push({
          from: toPosixRel(relative(root, e.from)),
          to: toPosixRel(relative(root, e.to)),
          type: "imports",
          confidence: 1.0,
        });
      }
    } catch {
      captureDegraded = true;
    }
  }
  return { symbols: tagsToSymbolTags(collectedTags, fileContents), edges, captureDegraded };
}

function truncateCapabilities(capabilities: CapabilityReport, maxBytes: number): CapabilityReport {
  const capBytes = new TextEncoder().encode(JSON.stringify(capabilities)).byteLength;
  if (capBytes <= maxBytes) return capabilities;
  const ratio = maxBytes / capBytes;
  const maxLangEntries = Math.max(0, Math.floor(ratio * capabilities.byLanguage.length));
  return {
    ...capabilities,
    byLanguage: capabilities.byLanguage.slice(0, maxLangEntries),
    coverageReasons: [
      ...capabilities.coverageReasons,
      `capability report truncated to fit ${maxBytes} byte budget`,
    ],
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
    const snapshotGraph = await getSharedContextGraphAsync(input.root);

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

    // 3. Source files with content hashes + 3b. symbols/edges (both bounded;
    // exhaustion degrades to file-level instead of throwing).
    const { allFiles, fileEntries, unreadablePaths, fileContents } = await collectFileEntries(
      input.root,
      deadline,
    );
    const { symbols, edges, captureDegraded } = await captureSymbolsAndEdges(
      input.root,
      allFiles,
      fileContents,
      snapshotGraph,
      deadline,
    );

    // 4. Compute capabilities from captured files
    const capabilities = await computeCapabilityReport(fileEntries);
    if (unreadablePaths.length > 0) {
      capabilities.coverageReasons.push(unreadableCoverageReason(unreadablePaths));
    }

    if (Date.now() >= deadline) {
      throw new IntelligenceServiceNotImplementedError({
        code: "BUDGET_EXCEEDED",
        message: "getWorkspaceSnapshot exceeded maxMs during capability computation",
        retryable: true,
      });
    }
    const sourceHash = computeSourceHash(fileEntries);

    // 5. Snapshot ID: sha256(root + sourceHash)
    const snapshotId = sha256(`${input.root}:${sourceHash}`) as SnapshotId;

    // 6. Register immutable snapshot data for later lookups (bounded eviction)
    snapshotData.set(snapshotId, { root: input.root, fileEntries, unreadablePaths, symbols, edges, captureDegraded });
    if (snapshotData.size > MAX_SNAPSHOTS) {
      const oldest = snapshotData.keys().next().value;
      if (oldest) snapshotData.delete(oldest);
    }

    // 7. Truncate capabilities if they exceed byte budget
    const finalCapabilities = truncateCapabilities(capabilities, input.budget.maxBytes);

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
    const snapBefore = snapshotData.get(input.before);
    const snapAfter = snapshotData.get(input.after);

    if (!snapBefore || !snapAfter) {
      throw new IntelligenceServiceNotImplementedError({
        code: "INTERNAL",
        message: "snapshot not found; call getWorkspaceSnapshot first",
        retryable: true,
      });
    }

    // Honor maxMs: snapshots are immutable so delta compute is sync; throw BUDGET_EXCEEDED on exceed (same convention as getWorkspaceSnapshot).
    const deadline = Date.now() + input.budget.maxMs;
    if (Date.now() >= deadline) {
      throw new IntelligenceServiceNotImplementedError({
        code: "BUDGET_EXCEEDED",
        message: "compareSnapshots exceeded maxMs budget",
        retryable: true,
      });
    }

    const beforeFiles = snapBefore.fileEntries.map((e) => ({
      path: e.path,
      contentHash: e.contentHash,
      edges: edgesForFile(snapBefore.edges, e.path),
    }));
    const afterFiles = snapAfter.fileEntries.map((e) => ({
      path: e.path,
      contentHash: e.contentHash,
      edges: edgesForFile(snapAfter.edges, e.path),
    }));
    const delta = computeSemanticDelta(beforeFiles, afterFiles, {
      beforeSnapshotId: input.before,
      afterSnapshotId: input.after,
      beforeSymbols: snapBefore.symbols,
      afterSymbols: snapAfter.symbols,
      beforeEdges: snapBefore.edges,
      afterEdges: snapAfter.edges,
    });
    if (Date.now() >= deadline) {
      throw new IntelligenceServiceNotImplementedError({
        code: "BUDGET_EXCEEDED",
        message: "compareSnapshots exceeded maxMs budget",
        retryable: true,
      });
    }
    // Honor maxEntities via SemanticDelta's own truncation stage (real fields: truncated + coverageReasons).
    const maxEntities = clampMaxEntities(input.budget.maxEntities);
    const bounded = applyMaxEntitiesBudget(delta, maxEntities);
    return withDegradedAssessment(bounded, snapBefore.captureDegraded || snapAfter.captureDegraded);
  }

  // ── Phase 3: relationship-count ranking ──────────────────────

  async rankWorkspace(input: RankRequest): Promise<RankResult> {
    const snapshot = snapshotData.get(input.snapshotId);
    if (!snapshot) {
      throw new IntelligenceServiceNotImplementedError({
        code: "INTERNAL",
        message: "snapshot not found; call getWorkspaceSnapshot first",
        retryable: true,
      });
    }
    const maxEntities = clampMaxEntities(input.maxEntities, 2000);
    // Count relationships per entity from snapshot-time edges. CapturedSnapshot.edges
    // is always populated at capture, so ranking never consults the live graph.
    const relCount = countRelationshipsByFile(
      snapshot.fileEntries.map((e) => e.path),
      snapshot.edges,
    );
    // Sort by relationship count descending, stable sort for ties
    const ranked = topRankedByRelationships(relCount, maxEntities);
    const { assessment, coverageReasons } = buildRankAssessment(snapshot.captureDegraded);
    return {
      snapshotId: input.snapshotId,
      rankedEntityIds: ranked.map(([path]) => path),
      rankedScores: ranked.map(([, score]) => score),
      assessment,
      coverageReasons,
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
    const root = snapshotData.get(input.snapshotId)?.root;
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
    const root = snapshotData.get(input.snapshotId)?.root;
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
    const snapshot = snapshotData.get(input.snapshotId);
    if (!snapshot) {
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
    const report = await computeCapabilityReport(snapshot.fileEntries);
    if (snapshot.unreadablePaths.length > 0) {
      report.coverageReasons.push(unreadableCoverageReason(snapshot.unreadablePaths));
    }
    return report;
  }
}
