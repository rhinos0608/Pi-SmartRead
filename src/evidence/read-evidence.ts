/**
 * Read evidence attestation (Seam 3).
 *
 * Pure attestation helpers extracted from hook.ts. Lifecycle, dispatch,
 * enrichment, anchors, and microagents stay in hook.ts.
 *
 * Contract:
 * - Fail closed on mismatch (return null) but never fail the read (never throw).
 * - Preserve truncated-range clamping, zero-line rejection, canonical roots.
 * - No cross-root gate: an out-of-workspace target with valid evidence attests.
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  computePathEvidence,
  computeStructuralOutlineEvidence,
} from "./path-evidence.js";

export interface ShownMatchesAttestedArgs {
  readonly builtinText: string;
  readonly truncationContent: string | undefined;
  readonly sliceText: string;
  readonly totalLines: number;
  readonly evidenceOffset: number | undefined;
  readonly evidenceLimit: number | undefined;
}

/**
 * The builtin read appends a continuation note ONLY for user-limited,
 * non-truncated reads that stop before EOF (see pi-coding-agent
 * dist/core/tools/read.js). Rather than stripping note-shaped suffixes
 * (which could eat genuine file content), reconstruct the exact expected
 * note from the evidence-read state and accept only exact matches.
 * Any other shape → mismatch → the caller skips evidence (fail safe).
 */
export function shownMatchesAttested(args: ShownMatchesAttestedArgs): boolean {
  const { builtinText, truncationContent, sliceText, totalLines, evidenceOffset, evidenceLimit } = args;
  if (typeof truncationContent === "string") return truncationContent === sliceText;
  if (builtinText === sliceText) return true;
  if (evidenceLimit === undefined) return false;
  const startLine = evidenceOffset ?? 1;
  const endLine = Math.min(totalLines, startLine + evidenceLimit - 1);
  const remaining = totalLines - endLine;
  if (remaining <= 0) return false;
  const note = `\n\n[${remaining} more lines in file. Use offset=${endLine + 1} to continue.]`;
  return builtinText === sliceText + note;
}

/**
 * Extract the canonical session file path from context.
 * Lives here (not imported from inspect-tool.ts) to avoid the
 * import cycle (search-tool.ts → hook.ts → … → inspect-tool.ts → inspect.ts).
 */
export function sessionFileFromCtx(ctx: ExtensionContext): string | null {
  try {
    const sm = (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } }).sessionManager;
    if (!sm || typeof sm.getSessionFile !== "function") return null;
    const p = sm.getSessionFile();
    return typeof p === "string" && p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

export interface TruncationState {
  readonly truncated?: boolean;
  readonly outputLines?: number;
  readonly firstLineExceedsLimit?: boolean;
  readonly content?: string;
}

export interface AttestedRangeInput {
  readonly normalizedOffset: number | undefined;
  readonly normalizedLimit: number | undefined;
  readonly displayStartLine: number;
  readonly truncation: TruncationState | undefined;
}

export type AttestedRange = { readonly zeroLines: true } | { readonly evidenceOffset: number | undefined; readonly evidenceLimit: number | undefined };

/**
 * Resolve the evidence range for a path read.
 * - Zero shown lines (firstLineExceedsLimit) → { zeroLines: true }.
 * - Truncated output → clamp to the lines the model actually saw.
 * - Otherwise pass the explicit offset/limit through untouched.
 */
export function resolveAttestedRange(input: AttestedRangeInput): AttestedRange {
  const { normalizedOffset, normalizedLimit, displayStartLine, truncation } = input;
  if (truncation?.firstLineExceedsLimit) return { zeroLines: true };
  if (truncation?.truncated && typeof truncation.outputLines === "number") {
    return { evidenceOffset: displayStartLine, evidenceLimit: truncation.outputLines };
  }
  return { evidenceOffset: normalizedOffset, evidenceLimit: normalizedLimit };
}

export interface PathAttestationInput {
  /** Absolute target path (already resolved against ctx.cwd by the caller). */
  readonly fullPath: string;
  /** Binding root: always ctx.cwd, never a params.directory-derived cwd. */
  readonly cwd: string;
  readonly sessionFilePath: string;
  readonly builtinText: string;
  readonly truncation: TruncationState | undefined;
  readonly evidenceOffset: number | undefined;
  readonly evidenceLimit: number | undefined;
  readonly displayStartLine?: number;
}

export interface PathAttestationResult {
  readonly workspaceEvidence: import("@rhinos0608/pi-workspace-protocol").WorkspaceEvidenceEnvelope;
  readonly canonicalWorkspaceRoot: string;
  readonly sliceText: string;
  readonly totalLines: number;
}

/**
 * Attest a single path read. Returns the envelope on success, null on any
 * mismatch or failure. Never throws — callers must keep the read succeeding
 * with or without evidence.
 */
export function attestPathRead(input: PathAttestationInput): PathAttestationResult | null {
  try {
    const evidence = computePathEvidence({
      path: input.fullPath,
      ...(input.evidenceOffset !== undefined ? { offset: input.evidenceOffset } : {}),
      ...(input.evidenceLimit !== undefined ? { limit: input.evidenceLimit } : {}),
      cwd: input.cwd,
      sessionFilePath: input.sessionFilePath,
    });
    // Revalidate: only attest content the model actually saw. The
    // builtin read and computePathEvidence hit the disk at different
    // instants — if the file changed in between, skip evidence.
    const matches = shownMatchesAttested({
      builtinText: input.builtinText,
      truncationContent:
        input.truncation?.truncated && typeof input.truncation.content === "string" ? input.truncation.content : undefined,
      sliceText: evidence.sliceText,
      totalLines: evidence.totalLines,
      evidenceOffset: input.evidenceOffset,
      evidenceLimit: input.evidenceLimit,
    });
    if (!matches) return null;
    return {
      workspaceEvidence: evidence.workspaceEvidence,
      canonicalWorkspaceRoot: evidence.workspaceEvidence.canonicalWorkspaceRoot,
      sliceText: evidence.sliceText,
      totalLines: evidence.totalLines,
    };
  } catch {
    return null;
  }
}

export interface StructuralOutlineAttestationInput {
  readonly path: string;
  readonly cwd: string;
  readonly sessionFilePath: string;
  /** Full file content already read by the caller (avoids a second disk read). */
  readonly fullContent: string;
  /** 1-based declaration lines actually shown in the rendered outline. */
  readonly declarationLines: readonly number[];
}

export interface StructuralOutlineAttestationResult {
  readonly workspaceEvidence: import("@rhinos0608/pi-workspace-protocol").WorkspaceEvidenceEnvelope;
  readonly fullFileSha256: string;
}

/**
 * Attest a structural AST outline: only the rendered declaration lines are
 * authorized, never full-file. Returns null on empty input or any failure.
 * Never throws.
 */
export function attestStructuralOutline(
  input: StructuralOutlineAttestationInput,
): StructuralOutlineAttestationResult | null {
  try {
    if (input.declarationLines.length === 0) return null;
    return computeStructuralOutlineEvidence({
      path: input.path,
      cwd: input.cwd,
      sessionFilePath: input.sessionFilePath,
      fullContent: input.fullContent,
      declarationLines: input.declarationLines,
    });
  } catch {
    return null;
  }
}

export type PublishInspection = (envelope: unknown, sessionFilePath: string, workspaceRoot: string) => void;

/** Best-effort evidence publish. Never throws. */
export function publishEvidence(
  publish: PublishInspection | undefined,
  envelope: unknown,
  sessionFilePath: string,
  workspaceRoot: string,
): void {
  try {
    publish?.(envelope, sessionFilePath, workspaceRoot);
  } catch {
    /* publish is best-effort */
  }
}
