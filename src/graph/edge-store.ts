/**
 * EdgeStore: event-sourced graph mutation log.
 * Moved from context-graph.ts (re-exported there for compatibility).
 */
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { EdgeType, Provenance } from "../context-graph.js";

function canonicalMutationPath(root: string, value: string): string | null {
  // Split off a `:symbol` suffix, skipping a Windows drive-letter colon
  // (`C:\proj\...`) so absolute Windows paths resolve instead of `C`.
  let marker = -1;
  for (let i = value.indexOf(":"); i !== -1; i = value.indexOf(":", i + 1)) {
    if (i === 1 && /^[a-zA-Z]:[\\/]/.test(value)) continue;
    marker = i;
    break;
  }
  const filePart = marker > 0 ? value.slice(0, marker) : value;
  const suffix = marker > 0 ? value.slice(marker) : "";
  try {
    const realRoot = realpathSync(resolve(root));
    const realFile = realpathSync(resolve(root, filePart));
    const rel = relative(realRoot, realFile);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return realFile + suffix;
  } catch { return null; }
}

// ── EdgeStore: Event-sourced graph mutation log ────────────────────

/**
 * A single mutation event recorded by the EdgeStore.
 * Each event is an append-only log entry: { type, data, timestamp }.
 */
export interface MutationEvent {
  id?: string;
  /** Edge type: "breakage" | "co_change" */
  type: "breakage" | "co_change";
  data: {
    /** The file or symbol that was modified (e.g. "src/auth.ts:login"). */
    from: string;
    /** The file or symbol that broke or co-changed (e.g. "src/types.ts:User"). */
    to: string;
    /** Human-readable description (e.g. "type check failed in User interface"). */
    context?: string;
    /** Confidence score (0-1). Default 1.0 for observed breakage. */
    confidence?: number;
    /** Source of observation. Omitted means legacy/untrusted. */
    source?: "diagnostics" | "git_history" | "manual" | "same_transaction";
  };
  /** Unix timestamp in ms. */
  timestamp: number;
}

/**
 * Event-sourced store for graph mutations.
 *
 * Appends mutation events (breakage, co-change) to a JSONL log file.
 * On replay, produces Provenance edges that can feed into the ContextGraph's
 * neighbor expansion.
 *
 * File location: <root>/.pi-smartread/graph-mutations.jsonl
 *
 * This is the integration point for Smart-Edit's post-edit evidence pipeline.
 * Smart-Edit writes MutationEvents here; Pi-SmartRead replays them on graph
 * construction. Determinism within a retrieval call is preserved because
 * replay happens at graph build time, not during query.
 */
export class EdgeStore {
  private static readonly EDGE_LOG_RELPATH = ".pi-smartread/graph-mutations.jsonl";
  /** Max size of the mutation log file (1 MB) before tail-read is truncated. */
  private static readonly EDGE_LOG_MAX_BYTES = 1024 * 1024;
  /** Max context string length per event. */
  private static readonly EDGE_CONTEXT_MAX_CHARS = 500;
  /** Max lines to read from the tail of the log. */
  private static readonly EDGE_LOG_MAX_LINES = 5000;

  /**
   * Append a breakage event to the mutation log.
   *
   * @param root - Project root directory (used for log file location).
   * @param from - File/symbol that was modified (e.g. "src/auth.ts:login").
   * @param to - File/symbol that broke (e.g. "src/types.ts:User").
   * @param context - Optional human-readable description.
   * @param confidence - Confidence score (0-1). Default 1.0 for observed breakage.
   */
  static recordBreakage(
    root: string,
    from: string,
    to: string,
    context?: string,
    confidence?: number,
  ): boolean {
    const event: MutationEvent = {
      type: "breakage",
      data: {
        from,
        to,
        context: context ? context.slice(0, EdgeStore.EDGE_CONTEXT_MAX_CHARS) : undefined,
        confidence,
        source: "diagnostics",
      },
      timestamp: Date.now(),
    };
    return EdgeStore.append(root, event);
  }

  /**
   * Append a co-change event to the mutation log.
   *
   * @param root - Project root directory.
   * @param from - File that was edited.
   * @param to - File that co-changed in the same commit history.
   * @param context - Optional human-readable description (e.g. commit hash).
   * @param confidence - Confidence score (0-1). Default 0.7 for git history.
   */
  static recordCoChange(
    root: string,
    from: string,
    to: string,
    context?: string,
    confidence?: number,
  ): boolean {
    const event: MutationEvent = {
      type: "co_change",
      data: {
        from,
        to,
        context: context ? context.slice(0, EdgeStore.EDGE_CONTEXT_MAX_CHARS) : undefined,
        confidence: confidence ?? 0.7,
        source: "git_history",
      },
      timestamp: Date.now(),
    };
    return EdgeStore.append(root, event);
  }

  /**
   * Read all mutation events from the log, optionally filtered by recency.
   *
   * @param root - Project root directory.
   * @param maxAgeMs - Only return events newer than this (ms from now). Default: 30 days.
   * @returns Sorted array of mutation events (newest first).
   */
  static readEdges(root: string, maxAgeMs = 30 * 24 * 60 * 60 * 1000): MutationEvent[] {
    const logPath = EdgeStore.getLogPath(root);
    if (!existsSync(logPath)) return [];

    const now = Date.now();
    const events: MutationEvent[] = [];

    try {
      // Tail-read: read last EDGE_LOG_MAX_BYTES from end of file
      const text = EdgeStore.tailRead(logPath, EdgeStore.EDGE_LOG_MAX_BYTES);
      if (text === null) return [];

      let lineCount = 0;
      for (const line of text.split("\n")) {
        if (lineCount >= EdgeStore.EDGE_LOG_MAX_LINES) break;
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = EdgeStore.validateEvent(JSON.parse(trimmed), root);
          if (event && now - event.timestamp <= maxAgeMs) {
            events.push(event);
            lineCount++;
          }
        } catch {
          // Skip malformed lines silently
        }
      }
    } catch {
      return [];
    }

    // Sort newest first
    events.sort((a, b) => b.timestamp - a.timestamp);
    return events;
  }

  /**
   * Convert MutationEvents to Provenance edges for ContextGraph neighbor expansion.
   * Deduplicates by (from, to, type) keeping the highest confidence.
   */
  static toProvenances(events: MutationEvent[], root: string): Provenance[] {
    const best = new Map<string, Provenance>();

    for (const ev of events) {
      // Resolve relative paths against root
      const fromPath = canonicalMutationPath(root, ev.data.from);
      const toPath = canonicalMutationPath(root, ev.data.to);
      if (!fromPath || !toPath) continue;

      const key = ev.id ?? `${fromPath}||${toPath}||${ev.type}`;

      const edgeType: EdgeType = ev.type === "breakage" ? "breakage" : "co_change";
      const existing = best.get(key);
      const confidence = ev.data.confidence ?? (ev.type === "breakage" ? 1.0 : 0.7);

      if (!existing || existing.confidence < confidence) {
        best.set(key, {
          from: fromPath,
          to: toPath,
          type: edgeType,
          confidence,
          source: ev.data.source,
          impactEligible: ev.data.source === "diagnostics",
        });
      }
    }

    return [...best.values()];
  }

  private static getLogPath(root: string): string {
    return `${resolve(root)}/${EdgeStore.EDGE_LOG_RELPATH}`;
  }

  /**
   * Tail-read: read the last `maxBytes` bytes from a file.
   * Returns null if the file cannot be read.
   */
  private static tailRead(filePath: string, maxBytes: number): string | null {
    try {
      const fd = openSync(filePath, "r");
      const stat = statSync(filePath);
      const readSize = Math.min(stat.size, maxBytes);
      const startPos = Math.max(0, stat.size - readSize);
      const buffer = Buffer.alloc(readSize);
      readSync(fd, buffer, 0, readSize, startPos);
      closeSync(fd);
      return buffer.toString("utf-8");
    } catch {
      return null;
    }
  }

  private static validateEvent(value: unknown, root: string): MutationEvent | null {
    if (!value || typeof value !== "object") return null;
    const v = value as Record<string, unknown>;
    if (v.type !== "breakage" && v.type !== "co_change") return null;
    if (!Number.isFinite(v.timestamp) || (v.timestamp as number) < 0 || (v.timestamp as number) > Date.now() + 86_400_000) return null;
    if (!v.data || typeof v.data !== "object") return null;
    const d = v.data as Record<string, unknown>;
    if (typeof d.from !== "string" || typeof d.to !== "string" || d.from.length === 0 || d.to.length === 0 || d.from.length > 1000 || d.to.length > 1000) return null;
    if (d.context !== undefined && (typeof d.context !== "string" || d.context.length > EdgeStore.EDGE_CONTEXT_MAX_CHARS)) return null;
    if (d.confidence !== undefined && (!Number.isFinite(d.confidence) || (d.confidence as number) < 0 || (d.confidence as number) > 1)) return null;
    const sources = ["diagnostics", "git_history", "manual", "same_transaction"];
    if (d.source !== undefined && (typeof d.source !== "string" || !sources.includes(d.source))) return null;
    const from = canonicalMutationPath(root, d.from);
    const to = canonicalMutationPath(root, d.to);
    if (!from || !to) return null;
    const id = typeof v.id === "string" && v.id.length <= 200 ? v.id : createHash("sha256").update(JSON.stringify([v.type, from, to, d.context ?? "", d.confidence ?? null, d.source ?? "legacy", v.timestamp])).digest("hex");
    return { id, type: v.type, data: { from, to, ...(typeof d.context === "string" ? { context: d.context } : {}), ...(typeof d.confidence === "number" ? { confidence: d.confidence } : {}), ...(typeof d.source === "string" ? { source: d.source as MutationEvent["data"]["source"] } : {}) }, timestamp: v.timestamp as number };
  }

  private static append(root: string, event: MutationEvent): boolean {
    const valid = EdgeStore.validateEvent(event, root);
    if (!valid) return false;
    const logPath = EdgeStore.getLogPath(root);
    const dir = dirname(logPath);

    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Directory may already exist
    }

    const line = JSON.stringify(valid) + "\n";
    try {
      appendFileSync(logPath, line, "utf-8");
      return true;
    } catch {
      // Report persistence failure to the caller (graph_mutate returns an error).
      return false;
    }
  }
}
