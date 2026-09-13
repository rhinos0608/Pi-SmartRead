export interface Provenance {
  from: string;
  to: string;
  type: string;
  confidence: number;
}

export interface RelationshipEvidencePage {
  edges: Array<{
    from: string;
    to: string;
    relationshipType: string;
    confidence: number;
  }>;
  nextCursor?: string;
  assessment: "complete" | "partial";
}

export interface GetRelationshipEvidenceOptions {
  from?: string;
  to?: string;
  relationshipTypes?: string[];
  limit: number;
  cursor?: string;
}

const MAX_LIMIT = 500;

function encodeCursor(index: number): string {
  return Buffer.from(String(index), "utf-8").toString("base64url");
}

function decodeCursor(cursor: string): number {
  return parseInt(Buffer.from(cursor, "base64url").toString("utf-8"), 10);
}

export function getRelationshipEvidence(
  edges: Provenance[],
  options: GetRelationshipEvidenceOptions
): RelationshipEvidencePage {
  const limit = Math.min(Math.max(1, options.limit), MAX_LIMIT);

  // Filter
  let filtered = edges;
  if (options.from !== undefined) {
    filtered = filtered.filter((e) => e.from === options.from);
  }
  if (options.to !== undefined) {
    filtered = filtered.filter((e) => e.to === options.to);
  }
  if (options.relationshipTypes && options.relationshipTypes.length > 0) {
    const typeSet = new Set(options.relationshipTypes);
    filtered = filtered.filter((e) => typeSet.has(e.type));
  }

  // Sort: relationshipType, then from, then to
  const sorted = [...filtered].sort((a, b) => {
    const cmp = a.type.localeCompare(b.type);
    if (cmp !== 0) return cmp;
    const cmpFrom = a.from.localeCompare(b.from);
    if (cmpFrom !== 0) return cmpFrom;
    return a.to.localeCompare(b.to);
  });

  // Cursor
  let startIndex = 0;
  if (options.cursor !== undefined) {
    startIndex = decodeCursor(options.cursor);
    if (startIndex < 0 || startIndex >= sorted.length) {
      startIndex = sorted.length;
    }
  }

  const page = sorted
    .slice(startIndex, startIndex + limit)
    .map((e) => ({
      from: e.from,
      to: e.to,
      relationshipType: e.type,
      confidence: e.confidence,
    }));

  const nextIndex = startIndex + limit;
  const hasMore = nextIndex < sorted.length;

  return {
    edges: page,
    nextCursor: hasMore ? encodeCursor(nextIndex) : undefined,
    assessment: "complete",
  };
}
