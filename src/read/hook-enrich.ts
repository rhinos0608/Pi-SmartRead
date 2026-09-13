/**
 * Hook read enrichment (Seam: selector normalize + evidence assembly + text enrich).
 *
 * Pure dispatch/enrich helpers extracted from hook.ts interceptContextualRead.
 * Lifecycle, session cache, outline dispatch, and tool wiring stay in hook.ts.
 *
 * Contract:
 * - Direct path resolution stays unrestricted: callers resolve targetPath
 *   against ctx.cwd with path.resolve. This module never imports
 *   workspace-boundary gating.
 * - Read shape preserved: normalized offset/limit passthrough, raw bypass,
 *   displayStartLine fallback chain, outline eligibility decided by caller.
 * - Evidence preserved: binding root is ctx.cwd, TOCTOU revalidation via
 *   attestPathRead, zero shown lines skip evidence.
 * - Enrich preserved: displayContent snapshot, hashline anchors (skip when
 *   already anchored), contextFooter separate from appended text.
 */
import {
   prefixLinesWithAnchors,
   selectorToOffsetLimit,
   splitPathAndSelector,
} from "../utils.js";
import {
   attestPathRead,
   publishEvidence,
   resolveAttestedRange,
} from "../evidence/read-evidence.js";

export interface NormalizedReadParams {
   readonly targetPath: string;
   readonly selector: string | undefined;
   readonly selectorOffset: number | undefined;
   readonly selectorLimit: number | undefined;
   readonly rawMode: boolean;
   readonly normalizedParams: Record<string, unknown>;
   readonly displayStartLine: number;
}

/**
 * Split path:selector, fold selector into offset/limit, strip the embedded
 * selector key. Pure — no filesystem or workspace-boundary access.
 */
export function normalizeReadParams(params: Record<string, unknown>): NormalizedReadParams {
   const filePath = params.path as string;
   const embeddedSelector = typeof params.__smartReadSelector === "string"
      ? params.__smartReadSelector
      : undefined;
   const { path: targetPath, selector: pathSelector } = splitPathAndSelector(filePath);
   const selector = embeddedSelector ?? pathSelector;
   const selectorArgs = selectorToOffsetLimit(selector);
   const rawMode = selectorArgs.raw === true;
   const normalizedParams: Record<string, unknown> = { ...params, path: targetPath };
   delete normalizedParams.__smartReadSelector;
   if (selectorArgs.offset !== undefined) normalizedParams.offset = selectorArgs.offset;
   if (selectorArgs.limit !== undefined) normalizedParams.limit = selectorArgs.limit;

   const displayStartLine = selectorArgs.offset
      ?? (typeof params.offset === "number" ? params.offset : undefined)
      ?? 1;

   return {
      targetPath,
      selector,
      selectorOffset: selectorArgs.offset,
      selectorLimit: selectorArgs.limit,
      rawMode,
      normalizedParams,
      displayStartLine,
   };
}

export interface PathEvidenceResult {
   readonly content: { type: string; text: string }[];
   details: Record<string, unknown>;
}

export interface AttachPathEvidenceArgs {
   readonly result: PathEvidenceResult;
   /** Absolute target path, already resolved against ctx.cwd by caller. */
   readonly fullPath: string;
   /** Binding root: always ctx.cwd, never a params.directory-derived cwd. */
   readonly cwd: string;
   readonly sessionFilePath: string | null;
   readonly builtinText: string | undefined;
   readonly isImageResult: boolean;
   readonly normalizedParams: Record<string, unknown>;
   readonly displayStartLine: number;
   readonly publishInspection?: (envelope: unknown, sessionFilePath: string, workspaceRoot: string) => void;
}

/**
 * Attest a path read and attach/publish the workspace evidence envelope.
 * Best-effort: returns false (no evidence) on image results, missing session,
 * zero shown lines, or attestation mismatch — never throws.
 */
export function attachPathEvidence(args: AttachPathEvidenceArgs): boolean {
   const {
      result,
      fullPath,
      cwd,
      sessionFilePath,
      builtinText,
      isImageResult,
      normalizedParams,
      displayStartLine,
      publishInspection,
   } = args;
   if (!sessionFilePath || isImageResult || typeof builtinText !== "string") return false;
   try {
      const truncation = (result.details as Record<string, unknown> | undefined)?.truncation as
         | { truncated?: boolean; outputLines?: number; firstLineExceedsLimit?: boolean; content?: string }
         | undefined;
      const range = resolveAttestedRange({
         normalizedOffset: typeof normalizedParams.offset === "number" ? normalizedParams.offset : undefined,
         normalizedLimit: typeof normalizedParams.limit === "number" ? normalizedParams.limit : undefined,
         displayStartLine,
         truncation,
      });
      if ("zeroLines" in range) return false;
      const attested = attestPathRead({
         fullPath,
         cwd,
         sessionFilePath,
         builtinText,
         truncation,
         evidenceOffset: range.evidenceOffset,
         evidenceLimit: range.evidenceLimit,
         displayStartLine,
      });
      if (!attested) return false;
      if (!result.details || typeof result.details !== "object") result.details = {};
      (result.details as Record<string, unknown>).workspaceEvidence = attested.workspaceEvidence;
      publishEvidence(
         publishInspection,
         attested.workspaceEvidence,
         sessionFilePath,
         attested.canonicalWorkspaceRoot,
      );
      return true;
   } catch {
      return false;
   }
}

export interface TextEnrichmentResult {
   readonly content: { type: string; text: string }[];
   details?: Record<string, unknown>;
}

/**
 * Snapshot displayContent, embed hashline anchors (skip when already
 * anchored), stash contextFooter separately, append footer to text output.
 * Requires ensureHashlineReady() before calling (done by hook.ts).
 */
export function applyTextEnrichment(
   result: TextEnrichmentResult,
   displayStartLine: number,
   contextLines: string[],
): void {
   const textContent = result.content.find(
      (c: { type: string }) => c.type === "text",
   ) as { type: "text"; text: string } | undefined;
   if (!textContent) return;
   const originalText = textContent.text;
   if (result.details && typeof result.details === "object") {
      (result.details as Record<string, unknown>).displayContent = {
         text: originalText,
         startLine: displayStartLine,
      };
   }
   // Only apply anchoring when content doesn't already have anchors.
   // Detect both legacy "42|" and hashline "42ab|" prefixes.
   const firstFewLines = textContent.text.split("\n", 5).join("\n");
   const alreadyAnchored = /^\d+[a-z]{0,2}\|/m.test(firstFewLines);
   if (!alreadyAnchored) {
      textContent.text = prefixLinesWithAnchors(textContent.text, displayStartLine);
   }

   // Preserve footer separately for internal batch reads. Batch packing must
   // keep source text separate from enrichment so evidence, cache, and line
   // numbering continue to describe only rendered file content.
   if (result.details && typeof result.details === "object" && contextLines.length > 0) {
      (result.details as Record<string, unknown>).contextFooter = contextLines.join("\n");
   }

   // Append contextual annotations to direct single-file output.
   if (contextLines.length > 0) {
      textContent.text += contextLines.join("\n");
   }
}
