/**
 * Shared contract for external LSP comparator adapters (benchmark harness only).
 *
 * Comparators run against the SAME pinned typescript-language-server as the
 * reference so differences reflect the tool layer, not the server. Only
 * operations a comparator natively supports are scored; anything else is
 * reported as `unsupported`, never as a wrong answer (D16/D17).
 */
import type { BenchLocation } from "../metrics.js";
import type { SampledPosition } from "../sample.js";

export type ComparatorId = "pi-lsp" | "mcp-language-server";

export type ComparatorOp = "definition" | "references" | "hover" | "workspaceSymbols";

/** One scored call: envelope-compatible status plus audit material. */
export interface ComparatorCall {
  /** ok | empty | unsupported | unavailable | error | timeout */
  status: string;
  ms: number;
  /** estimateTokens over the raw text the tool layer returned. */
  tokens: number;
  /** Verbatim tool output (may be truncated by the caller for report size). */
  raw: string;
  /** Locations parsed from the raw output (empty when none/unparseable). */
  locations: BenchLocation[];
  /** Hover payload text (hover op only). */
  hoverText?: string;
}

export interface Comparator {
  id: ComparatorId;
  /** Human-readable pin + license + headless-driving notes. */
  caveats: string[];
  open(root: string): Promise<void>;
  close(): Promise<void>;
  definition(pos: SampledPosition): Promise<ComparatorCall>;
  references(pos: SampledPosition): Promise<ComparatorCall>;
  hover(pos: SampledPosition): Promise<ComparatorCall>;
}

/** Start-anchored key: same file + same start (tolerates end-column drift). */
export function startKey(loc: BenchLocation): string {
  return `${loc.file}:${loc.start.line}:${loc.start.character}`;
}

/** Point location (used when a tool reports only a start position). */
export function pointLoc(
  file: string,
  line: number,
  character: number,
): BenchLocation {
  return {
    file,
    start: { file, line, character },
    end: { file, line, character },
  };
}
