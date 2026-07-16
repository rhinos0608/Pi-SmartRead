/**
 * Shared per-file contextual enrichment footer used by the wrapped
 * builtin read tool (hook.ts).
 * Every channel is best-effort: failures append a warning line or are
 * skipped; this function never throws.
 *
 * Import-cycle safety: this module imports only leaf-domain modules
 * (context-graph, git-history, git-context, config, git-notes,
 * graphify-enricher, lsp-bridge, utils). It must NOT import hook.ts,
 * inspect.ts, search-tool.ts, or mcp-registry.ts.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { ContextGraph } from "./context-graph.js";
import { isRecentlyModified } from "./git-history.js";
import {
   findGitRoot,
   getFileCommitContext,
} from "./git-context.js";
import { loadGitContextConfig, type ResolvedGitContextConfig } from "./config.js";
import { scanBranchNotes } from "./git-notes.js";
import { getGraphifyEnricher } from "./graphify-enricher.js";
import { getLSPBridge } from "./lsp-bridge.js";
import { LruCache } from "./utils.js";
import { projectWorkspaceForFile } from "./workspace-scope.js";

// ── Shared ContextGraph cache (module-level) ──
// Build once per repo, reuse across reads. Prevents O(repo_files * read_calls) parsing.
const contextualGraphCache = new LruCache<ContextGraph>(3);

// ── Public interface ──────────────────────────────────────────────

export interface FileContextOptions {
  readonly fullPath: string;
  readonly cwd: string;
  readonly gitConfig?: ResolvedGitContextConfig;
  readonly gitRoot?: string | null;
}

/**
 * Build the enrichment footer lines for a file read or inspect.
 *
 * Returns `[]` when there is nothing to report — i.e. when the file
 * does not exist or no bullet was produced. The guard intentionally
 * uses `> 3` (the header is 3 lines: blank, `---`, `🔍 Context for …`)
 * so that an empty footer (header-only) is never emitted — this fixes
 * the old always-append bug in hook.ts.
 */
export async function buildFileContextLines(opts: FileContextOptions): Promise<string[]> {
  const { fullPath, cwd } = opts;
  if (!existsSync(fullPath)) return [];

  const relPath = path.relative(cwd, fullPath);
  const contextLines: string[] = ["", "---", `🔍 Context for ${relPath}:`];
  const projectRoot = projectWorkspaceForFile(fullPath);
  // Reading a loose file from a broad cwd such as $HOME must stay a plain
  // file read. Every enrichment channel below assumes a bounded project root
  // and can otherwise start repo scans, git probes, or language servers at
  // home-directory scope.
  if (!projectRoot) return [];
  const analysisRoot = projectRoot;

  // 1. Structural context via shared cached ContextGraph
  // A non-project cwd (notably $HOME) must never become an implicit repo.
  // For files inside a nested project, scope the graph to that project;
  // for loose files, skip structural indexing entirely.
  // Isolated in its own try/catch so a structural failure cannot suppress
  // later channels (git recency, recent commits, git notes, graphify, LSP).
  try {
    if (projectRoot) {
      let graph = contextualGraphCache.get(projectRoot);
      if (!graph) {
        graph = new ContextGraph(projectRoot);
        contextualGraphCache.set(projectRoot, graph);
      }
      await graph.buildContextGraph({
        forceRefresh: false,
        includeSymbols: true,
        includeCalls: false,
      });

      const neighbours = await graph.getFileNeighbours(fullPath, {
        includeSymbols: false,
        includeCalls: false,
      });

      const importedBy = neighbours
        .filter((n) => n.provenance.type === "imported_by")
        .map((n) => path.relative(projectRoot, n.path));
      const imports = neighbours
        .filter((n) => n.provenance.type === "imports")
        .map((n) => path.relative(projectRoot, n.path));

      if (importedBy.length > 0)
        contextLines.push(
          `• Imported by: ${importedBy.slice(0, 8).join(", ")}${importedBy.length > 8 ? "…" : ""}`,
        );
      if (imports.length > 0)
        contextLines.push(
          `• Imports: ${imports.slice(0, 8).join(", ")}${imports.length > 8 ? "…" : ""}`,
        );
    }
  } catch {
    // Structural context is best-effort; do not let it suppress later channels.
  }

  try {
    // 2. Git recency
    if (await isRecentlyModified(analysisRoot, fullPath)) {
      contextLines.push("• Recently modified (last day).");
    }

    // 2b. Recent commits + git notes
    try {
      const gitConfig = opts.gitConfig ?? loadGitContextConfig(analysisRoot);
      const gitRoot = opts.gitRoot !== undefined
        ? opts.gitRoot
        : (gitConfig.enabled ? await findGitRoot(analysisRoot) : null);
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

          // Git notes: scan branch notes for each recent commit
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
          } catch {
            // git notes are best-effort
          }
        }
      }
    } catch {
      // File commit context is best-effort
    }

    // 3. Graphify enrichment (uses graphify-out/graph.json when available).
    try {
      const enricher = getGraphifyEnricher(analysisRoot);
      if (enricher.isAvailable) {
        const related = enricher.getRelatedFilesForPath(fullPath);
        if (related.length > 0) {
          const grouped = new Map<string, string[]>();
          for (const r of related) {
            const relKey = r.relation;
            let list = grouped.get(relKey);
            if (!list) {
              list = [];
              grouped.set(relKey, list);
            }
            list.push(r.targetLabel);
          }
          for (const [relType, labels] of grouped) {
            const shown = labels.slice(0, 6).join(", ");
            contextLines.push(`• Graph: ${relType} ${shown}${labels.length > 6 ? "…" : ""}`);
          }
        }

        const community = enricher.getFileCommunity(fullPath);
        if (community !== undefined) {
          const communitySize = enricher.getCommunityFiles(community).length;
          contextLines.push(`• Community ${community} (${communitySize} files)`);
        }

        const centrality = enricher.getFileCentrality(fullPath);
        if (centrality > 0) {
          contextLines.push(`• Graph centrality: ${centrality} connections`);
        }
      }
    } catch {
      // Graphify enrichment is best-effort
    }

    // 4. LSP enrichment: document outline + type hints
    try {
      const bridge = await getLSPBridge();
      if (bridge && bridge.isAvailable()) {
        const symbols = await bridge.getDocumentSymbols(fullPath, analysisRoot);
        if (symbols.length > 0) {
          const topLevel = symbols.filter(
            (s) => !s.children || s.children.length === 0 || s.name === s.name,
          );
          const shown = topLevel.slice(0, 10).map(
            (s) => `${s.name}${s.children?.length ? ` (${s.children.length} members)` : ""}`,
          );
          contextLines.push(
            `• LSP symbols: ${shown.join(", ")}${topLevel.length > 10 ? "…" : ""}`,
          );
        }
      }
    } catch {
      // LSP enrichment is best-effort
    }
  } catch (err) {
    contextLines.push(`• Context unavailable: ${(err as Error).message}`);
  }

  // Only emit the footer when at least one bullet was produced.
  // Header is 3 lines: empty string, "---", and "🔍 Context for …".
  return contextLines.length > 3 ? contextLines : [];
}
