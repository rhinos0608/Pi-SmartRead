/**
 * Serena (oraios/serena, GPL-3.0-or-later app / MIT SolidLSP) comparator
 * adapter — benchmark harness only.
 *
 * Pinned: serena-agent==1.7.0 in ~/.cache/pi-smartread-bench/tools/serena/.venv
 * (Serena-managed language server: typescript-language-server 5.1.3 +
 * typescript 5.9.3 — NOT the benchmark reference 6.0.0/5.9.2; recorded as
 * a caveat, not corrected). Driven headless over MCP stdio
 * (`serena start-mcp-server --project <root>`, newline-delimited JSON-RPC,
 * initialize + tools/call — verified empirically 2026-10-08).
 *
 * Operation support: definition via project-wide find_symbol (name lookup),
 * references via find_symbol + find_referencing_symbols per candidate
 * definition file (Serena-native two-step, no reference leakage).
 * hover and workspaceSymbols are `unsupported`.
 *
 * Serena output is line-granular by design (body_location lines, `> N:`
 * snippet markers; no columns). The adapter emits point locations
 * (line, char 0); the runner scores Serena with line-anchored secondaries
 * (defLine, refLineF1) alongside the standard metrics.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { estimateTokens, type BenchLocation } from "../metrics.js";
import type { SampledPosition } from "../sample.js";
import { pointLoc, type Comparator, type ComparatorCall } from "./types.js";

export const SERENA_BIN = join(
  homedir(),
  ".cache",
  "pi-smartread-bench",
  "tools",
  "serena",
  ".venv",
  "bin",
  "serena",
);

export const SERENA_PIN = {
  serenaAgent: "1.7.0",
  typescriptLanguageServer: "5.1.3",
  typescript: "5.9.3",
} as const;

/** Max definition candidates expanded for references (see doc §Position mapping). */
export const SERENA_REF_CANDIDATE_CAP = 3;

const PROTOCOL_VERSION = "2024-11-05";
const CALL_TIMEOUT_MS = 180000;

/** Minimal MCP stdio client: newline-delimited JSON-RPC (Serena framing). */
class SerenaStdioClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private buffer = "";
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  start(command: string, args: string[], env: NodeJS.ProcessEnv): void {
    this.proc = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr?.on("data", () => {
      /* server logs to stderr; ignore */
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) return;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue;
      }
      if (typeof msg.id !== "number") continue;
      const entry = this.pending.get(msg.id);
      if (!entry) continue;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(String(msg.error.message ?? "unknown error")));
      else entry.resolve(msg.result);
    }
  }

  request(method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    const proc = this.proc;
    if (!proc?.stdin) return Promise.reject(new Error("serena client not started"));
    const id = this.nextId;
    this.nextId += 1;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`serena request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin?.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  notify(method: string, params: unknown): void {
    this.proc?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async stop(): Promise<void> {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error("serena client stopped"));
    }
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    proc.stdin?.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve();
      }, 5000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function contentText(result: unknown): string {
  if (result !== null && typeof result === "object") {
    const o = result as { content?: Array<{ type?: string; text?: string }> };
    if (Array.isArray(o.content)) {
      return o.content
        .filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => String(c.text))
        .join("\n");
    }
  }
  return "";
}

function resultIsError(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === "object" &&
    (result as { isError?: boolean }).isError === true
  );
}

export function defaultCanonicalize(file: string): string | null {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

export interface SerenaCandidate {
  namePath: string;
  relativePath: string;
}

interface SerenaSymbolEntry {
  name_path?: unknown;
  relative_path?: unknown;
  body_location?: { start_line?: unknown };
}

function toCandidate(entry: SerenaSymbolEntry): SerenaCandidate | null {
  if (typeof entry.name_path !== "string" || typeof entry.relative_path !== "string") return null;
  return { namePath: entry.name_path, relativePath: entry.relative_path };
}

function toPointLoc(
  entry: SerenaSymbolEntry,
  root: string,
  canonicalize: (file: string) => string | null,
): BenchLocation | null {
  if (typeof entry.relative_path !== "string") return null;
  if (typeof entry.body_location?.start_line !== "number") return null;
  const file = canonicalize(join(root, entry.relative_path).replace(/\\/g, "/"));
  if (!file) return null;
  return pointLoc(file, entry.body_location.start_line, 0);
}

/**
 * Parse find_symbol output: JSON list of symbol entries (0-based lines,
 * no columns) into point locations plus definition candidates for step 2.
 */
export function parseSerenaFindSymbol(
  raw: string,
  root: string,
  canonicalize: (file: string) => string | null = defaultCanonicalize,
): { status: "ok" | "empty"; locations: BenchLocation[]; candidates: SerenaCandidate[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { status: "empty", locations: [], candidates: [] };
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const locations: BenchLocation[] = [];
  const candidates: SerenaCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of arr) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as SerenaSymbolEntry;
    const candidate = toCandidate(e);
    if (candidate) candidates.push(candidate);
    const loc = toPointLoc(e, root, canonicalize);
    if (!loc) continue;
    const key = `${loc.file}:${loc.start.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push(loc);
  }
  return { status: locations.length > 0 ? "ok" : "empty", locations, candidates };
}

const REF_MARKER = /^\s*(?:\.\.\.\s+)?>\s+(\d+)\s*:/;

function markerLines(snippet: string): number[] {
  const out: number[] = [];
  for (const line of snippet.split(/\r?\n/)) {
    const m = REF_MARKER.exec(line);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

/**
 * Parse find_referencing_symbols output: per-file groups whose
 * content_around_reference snippets mark the referencing line with
 * `> N:` (0-based). Emits one point location (line N, char 0) per marker.
 */
export function parseSerenaReferences(
  raw: string,
  root: string,
  canonicalize: (file: string) => string | null = defaultCanonicalize,
): { status: "ok" | "empty"; locations: BenchLocation[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { status: "empty", locations: [] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "empty", locations: [] };
  }
  const locations: BenchLocation[] = [];
  const seen = new Set<string>();
  for (const [rel, groups] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof groups !== "object" || groups === null) continue;
    const file = canonicalize(join(root, rel).replace(/\\/g, "/"));
    if (!file) continue;
    const symbols = Object.values(groups as Record<string, unknown>).flatMap((g) =>
      Array.isArray(g) ? g : [],
    );
    for (const s of symbols) {
      const snippet = (s as { content_around_reference?: unknown })?.content_around_reference;
      if (typeof snippet !== "string") continue;
      for (const n of markerLines(snippet)) {
        const key = `${file}:${n}`;
        if (seen.has(key)) continue;
        seen.add(key);
        locations.push(pointLoc(file, n, 0));
      }
    }
  }
  return { status: locations.length > 0 ? "ok" : "empty", locations };
}

/** File+line key for Serena-fair line-anchored scoring (no columns by design). */
export function lineKey(loc: BenchLocation): string {
  return `${loc.file}:${loc.start.line}`;
}

export function createSerenaComparator(): Comparator {
  const mcp = new SerenaStdioClient();
  let root = "";

  const toolCall = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ status: "ok-tool" | "error"; raw: string; ms: number }> => {
    const t0 = Date.now();
    try {
      const result = await mcp.request("tools/call", { name, arguments: args });
      const raw = resultIsError(result) ? `error: ${contentText(result)}` : contentText(result);
      return { status: resultIsError(result) ? "error" : "ok-tool", raw, ms: Date.now() - t0 };
    } catch (err) {
      const raw = `error: ${String((err as Error)?.message ?? err)}`;
      return { status: "error", raw, ms: Date.now() - t0 };
    }
  };

  const failed = (raw: string, ms: number): ComparatorCall => ({
    status: "error",
    ms,
    tokens: estimateTokens(raw),
    raw,
    locations: [],
  });

  return {
    id: "serena",
    caveats: [
      "Serena manages its own language server (TLS 5.1.3 + TS 5.9.3), not the benchmark reference (TLS 6.0.0 + TS 5.9.2); deltas mix tool-layer and server-version effects.",
      "definition resolves by SYMBOL NAME project-wide (find_symbol), not by position; the sampled position contributes only its identifier text.",
      "references is a Serena-native two-step (find_symbol, then find_referencing_symbols for the first 3 definition candidates); unioned, truncation recorded in raw.",
      "All locations are line-granular by design (no columns); score with line-anchored secondaries (defLine, refLineF1), not exact metrics.",
      "hover/workspaceSymbols unsupported (no position-hover or workspace-symbol MCP tool; find_symbol doubles as symbol search but is scored once as definition).",
      "Activation writes .serena/ into the corpus root; removed on close (guarded by .serena/project.yml marker).",
    ],
    open: async (r: string): Promise<void> => {
      root = r;
      mcp.start(SERENA_BIN, ["start-mcp-server", "--project", root], { ...process.env });
      await mcp.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "pi-smartread-bench", version: "1.0.0" },
      });
      mcp.notify("notifications/initialized", {});
    },
    close: async (): Promise<void> => {
      await mcp.stop();
      // Remove Serena's working state from the pinned corpus checkout.
      try {
        if (root.length > 0 && existsSync(join(root, ".serena", "project.yml"))) {
          rmSync(join(root, ".serena"), { recursive: true, force: true });
        }
      } catch {
        /* best effort cleanup */
      }
      root = "";
    },
    definition: async (pos: SampledPosition): Promise<ComparatorCall> => {
      const r = await toolCall("find_symbol", { name_path_pattern: pos.name, include_body: false });
      if (r.status === "error") return failed(r.raw, r.ms);
      const parsed = parseSerenaFindSymbol(r.raw, root);
      return {
        status: parsed.status,
        ms: r.ms,
        tokens: estimateTokens(r.raw),
        raw: r.raw,
        locations: parsed.locations,
      };
    },
    references: async (pos: SampledPosition): Promise<ComparatorCall> => {
      const t0 = Date.now();
      const found = await toolCall("find_symbol", {
        name_path_pattern: pos.name,
        include_body: false,
      });
      if (found.status === "error") return failed(found.raw, found.ms);
      const candidates = parseSerenaFindSymbol(found.raw, root).candidates;
      if (candidates.length === 0) {
        const raw = "empty: find_symbol returned no definition candidates";
        return { status: "empty", ms: Date.now() - t0, tokens: estimateTokens(raw), raw, locations: [] };
      }
      const picked = candidates.slice(0, SERENA_REF_CANDIDATE_CAP);
      const seen = new Set<string>();
      const locations: BenchLocation[] = [];
      const raws: string[] = [];
      let errors = 0;
      for (const c of picked) {
        const r = await toolCall("find_referencing_symbols", {
          name_path: c.namePath,
          relative_path: c.relativePath,
        });
        if (r.status === "error") {
          errors += 1;
          raws.push(`[${c.namePath} @ ${c.relativePath}] ${r.raw}`);
          continue;
        }
        raws.push(`[${c.namePath} @ ${c.relativePath}] ${r.raw}`);
        for (const l of parseSerenaReferences(r.raw, root).locations) {
          const key = `${l.file}:${l.start.line}`;
          if (seen.has(key)) continue;
          seen.add(key);
          locations.push(l);
        }
      }
      if (candidates.length > picked.length) {
        raws.push(`[candidates truncated: ${picked.length}/${candidates.length} expanded]`);
      }
      const raw = raws.join("\n");
      if (locations.length === 0 && errors === picked.length) return failed(raw, Date.now() - t0);
      return {
        status: locations.length > 0 ? "ok" : "empty",
        ms: Date.now() - t0,
        tokens: estimateTokens(raw),
        raw,
        locations,
      };
    },
    hover: async (): Promise<ComparatorCall> => {
      const raw = "unsupported: Serena has no position-hover equivalent";
      return { status: "unsupported", ms: 0, tokens: estimateTokens(raw), raw, locations: [] };
    },
  };
}
