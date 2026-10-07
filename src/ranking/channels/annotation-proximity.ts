import { readFileSync } from "node:fs";

export interface ChannelCandidate {
  file: string;
  line?: number;
  endLine?: number;
  name: string;
  kind: string;
  snippet: string;
  rawScore: number;
}

export interface ChannelResult {
  channel: string;
  candidates: ChannelCandidate[];
  unavailable?: { reason: string };
  metadata?: Record<string, unknown>;
}

const MAX_CANDIDATES = 500;
const ANNOTATION_PATTERN = /\b(TODO|FIXME|HACK|XXX|BUG|OPTIMIZE|REVIEW)\b/;

interface AnnotationHit {
  line: number;
  tag: string;
  snippet: string;
}

/**
 * Collect annotation markers from file content.
 * Returns line-level hits for the strongest (first) annotation per line.
 */
function collectAnnotations(content: string): AnnotationHit[] {
  const hits: AnnotationHit[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = ANNOTATION_PATTERN.exec(lines[i]!);
    if (match) {
      hits.push({
        line: i + 1,
        tag: match[1]!,
        snippet: lines[i]!.trim().slice(0, 200),
      });
    }
  }
  return hits;
}

/**
 * Rank files by proximity to user annotations (TODO/FIXME/HACK etc.).
 * More annotations = higher score. Unavailable when no annotations found.
 */
export function rankAnnotationProximity(
  candidateFiles: string[],
): ChannelResult {
  const scored: ChannelCandidate[] = [];

  for (const file of candidateFiles) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      // Skip unreadable files silently
      continue;
    }

    const hits = collectAnnotations(content);
    if (hits.length === 0) continue;

    // Score: log-scaled annotation count, capped at 1.0
    const rawScore = Math.min(1.0, Math.log2(hits.length + 1) / 4);

    // Report the first annotation as representative
    const first = hits[0]!;
    scored.push({
      file,
      line: first.line,
      name: first.tag,
      kind: "annotation",
      snippet: first.snippet,
      rawScore,
    });
  }

  // Sort by rawScore descending, then alphabetically for determinism
  scored.sort((a, b) => b.rawScore - a.rawScore || a.file.localeCompare(b.file));

  if (scored.length === 0) {
    return {
      channel: "annotation-proximity",
      candidates: [],
      unavailable: { reason: "no annotations found" },
    };
  }

  return {
    channel: "annotation-proximity",
    candidates: scored.slice(0, MAX_CANDIDATES),
    metadata: {
      totalAnnotated: scored.length,
      annotationPattern: ANNOTATION_PATTERN.source,
    },
  };
}
