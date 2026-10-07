/**
 * @spences10/pi-lsp (MIT, 0.0.48) comparator adapter — benchmark harness only.
 *
 * Headless driving: pi-lsp's full `lsp_*` tool functions require a live Pi
 * ExtensionAPI host (register_lsp_tools(pi, manager)) plus an
 * ExtensionContext for project-trust prompts, so they cannot run outside a
 * Pi session. We drive the layer directly beneath them instead: LspClient
 * (dist/client.js), which is exactly what the tool handlers call through
 * with_file_state -> manager.resolve_file_state -> client.hover /
 * client.definition / client.references. The bypassed layers are server
 * lifecycle/trust prompting, workspace-root detection, and text formatting —
 * recorded as caveats on the adapter.
 *
 * The install lives under ~/.cache/pi-smartread-bench/tools/pi-lsp
 * (@spences10/pi-lsp 0.0.48, @spences10/pi-child-env 0.1.10, typebox 1.3.35).
 * The server binary is the same pinned typescript-language-server passed in
 * by the runner, so differences reflect the tool/client layer.
 *
 * Operation support: definition, references, hover. pi-lsp exposes per-file
 * document_symbols, not workspace/symbol, so workspaceSymbols is `unsupported`.
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { estimateTokens } from "../metrics.js";
import type { SampledPosition } from "../sample.js";
import type { Comparator, ComparatorCall } from "./types.js";

const PI_LSP_CLIENT = join(
  homedir(),
  ".cache",
  "pi-smartread-bench",
  "tools",
  "pi-lsp",
  "node_modules",
  "@spences10",
  "pi-lsp",
  "dist",
  "client.js",
);

interface PiLspPosition {
  line: number;
  character: number;
}

interface PiLspLocation {
  uri: string;
  range: { start: PiLspPosition; end: PiLspPosition };
}

interface PiLspHover {
  contents: unknown;
  range?: unknown;
}

interface PiLspClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  ensure_document_open(uri: string, text: string): Promise<void>;
  hover(uri: string, position: PiLspPosition): Promise<PiLspHover | null>;
  definition(uri: string, position: PiLspPosition): Promise<PiLspLocation[]>;
  references(
    uri: string,
    position: PiLspPosition,
    includeDeclaration: boolean,
  ): Promise<PiLspLocation[]>;
}

function uriToFile(uri: string): string | null {
  try {
    if (!uri.startsWith("file:")) return null;
    return realpathSync(new URL(uri));
  } catch {
    return null;
  }
}

function hoverToText(hover: PiLspHover | null): string {
  if (!hover) return "";
  const c = hover.contents;
  const chunks: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string") chunks.push(v);
    else if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.value === "string") chunks.push(o.value);
    }
  };
  if (Array.isArray(c)) {
    for (const e of c) push(e);
  } else {
    push(c);
  }
  return chunks.join("\n");
}

export function createPiLspComparator(tlsBin: string): Comparator {
  let client: PiLspClient | null = null;

  const toBench = (
    locs: PiLspLocation[],
  ): ComparatorCall["locations"] => {
    const out: ComparatorCall["locations"] = [];
    for (const l of locs) {
      const file = uriToFile(l.uri);
      if (!file) continue;
      out.push({
        file,
        start: { file, line: l.range.start.line, character: l.range.start.character },
        end: { file, line: l.range.end.line, character: l.range.end.character },
      });
    }
    return out;
  };

  const call = async (
    pos: SampledPosition,
    kind: "definition" | "references" | "hover",
  ): Promise<ComparatorCall> => {
    const t0 = Date.now();
    try {
      if (!client) throw new Error("pi-lsp client not open");
      const uri = pathToFileURL(pos.file).href;
      await client.ensure_document_open(uri, readFileSync(pos.file, "utf-8"));
      const position = { line: pos.line, character: pos.character };
      if (kind === "definition") {
        const locs = toBench(await client.definition(uri, position));
        const raw = JSON.stringify(locs);
        return {
          status: locs.length > 0 ? "ok" : "empty",
          ms: Date.now() - t0,
          tokens: estimateTokens(raw),
          raw,
          locations: locs,
        };
      }
      if (kind === "references") {
        const locs = toBench(await client.references(uri, position, true));
        const raw = JSON.stringify(locs);
        return {
          status: locs.length > 0 ? "ok" : "empty",
          ms: Date.now() - t0,
          tokens: estimateTokens(raw),
          raw,
          locations: locs,
        };
      }
      const text = hoverToText(await client.hover(uri, position));
      return {
        status: text.trim().length > 0 ? "ok" : "empty",
        ms: Date.now() - t0,
        tokens: estimateTokens(text),
        raw: text,
        locations: [],
        hoverText: text,
      };
    } catch (err) {
      const raw = `error: ${String((err as Error)?.message ?? err)}`;
      return { status: "error", ms: Date.now() - t0, tokens: estimateTokens(raw), raw, locations: [] };
    }
  };

  return {
    id: "pi-lsp",
    caveats: [
      "Drives pi-lsp LspClient directly (the exact client the lsp_* tools call); full tool registration needs a live Pi session and is not exercised.",
      "Bypasses server-manager trust prompts, workspace-root detection, and tool text formatting.",
      "workspaceSymbols unsupported (pi-lsp offers per-file document_symbols only).",
    ],
    open: async (root: string): Promise<void> => {
      const mod = (await import(pathToFileURL(PI_LSP_CLIENT).href)) as {
        LspClient: new (opts: {
          command: string;
          args: string[];
          root_uri: string;
          language_id_for_uri: (uri: string) => string | undefined;
        }) => PiLspClient;
      };
      client = new mod.LspClient({
        command: tlsBin,
        args: ["--stdio"],
        root_uri: pathToFileURL(root).href,
        language_id_for_uri: () => "typescript",
      });
      await client.start();
    },
    close: async (): Promise<void> => {
      try {
        await client?.stop();
      } catch {
        /* best effort */
      }
      client = null;
    },
    definition: (pos) => call(pos, "definition"),
    references: (pos) => call(pos, "references"),
    hover: (pos) => call(pos, "hover"),
  };
}
