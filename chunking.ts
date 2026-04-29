export interface ChunkResult {
  text: string;
  chunkIndex: number;
  startChar: number;
  endChar: number;
  estimatedTokens: number;
  wasHardSplit: boolean;
}

export interface ChunkOptions {
  chunkSizeChars?: number;
  chunkOverlapChars?: number;
  maxChunksPerFile?: number;
  minChunkChars?: number;
}

const DEFAULT_CHUNK_SIZE_CHARS = 4096;
const DEFAULT_CHUNK_OVERLAP_CHARS = 512;
const DEFAULT_MAX_CHUNKS_PER_FILE = 12;
const DEFAULT_MIN_CHUNK_CHARS = 200;
const CHARS_PER_TOKEN = 4;

/**
 * Splits text into chunks by preference: double newline > single newline >
 * whitespace > hard split. Walks backward from target position to find a
 * boundary. Chunks may overlap by `chunkOverlapChars` characters.
 */
export function chunkText(
  text: string,
  options?: ChunkOptions,
): ChunkResult[] {
  const chunkSizeChars = options?.chunkSizeChars ?? DEFAULT_CHUNK_SIZE_CHARS;
  const chunkOverlapChars = options?.chunkOverlapChars ?? DEFAULT_CHUNK_OVERLAP_CHARS;
  const maxChunksPerFile = options?.maxChunksPerFile ?? DEFAULT_MAX_CHUNKS_PER_FILE;
  const minChunkChars = options?.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS;

  if (!text || text.length === 0 || /^\s*$/.test(text)) return [];

  const results: ChunkResult[] = [];
  let offset = 0;

  while (offset < text.length && results.length < maxChunksPerFile) {
    const remaining = text.length - offset;
    let targetEnd = offset + chunkSizeChars;

    if (remaining <= chunkSizeChars) {
      // Last chunk
      const chunk = text.slice(offset);
      results.push({
        text: chunk,
        chunkIndex: results.length,
        startChar: offset,
        endChar: text.length,
        estimatedTokens: Math.ceil(chunk.length / CHARS_PER_TOKEN),
        wasHardSplit: false,
      });
      break;
    }

    // Walk backward from targetEnd to find a boundary
    let splitPos = targetEnd;
    let wasHardSplit = true;

    // Try double newline first
    let bestPos = -1;
    for (let i = targetEnd - 1; i >= offset + 1; i--) {
      if (text[i] === '\n' && text[i - 1] === '\n') {
        bestPos = i + 1;
        break;
      }
    }
    if (bestPos >= 0) {
      splitPos = bestPos;
      wasHardSplit = false;
    } else {
      // Try single newline
      bestPos = -1;
      for (let i = targetEnd - 1; i >= offset + 1; i--) {
        if (text[i] === '\n') {
          bestPos = i + 1;
          break;
        }
      }
      if (bestPos >= 0) {
        splitPos = bestPos;
        wasHardSplit = false;
      } else {
        // Try whitespace
        bestPos = -1;
        for (let i = targetEnd - 1; i >= offset + 1; i--) {
          if (/\s/.test(text[i])) {
            bestPos = i + 1;
            break;
          }
        }
        if (bestPos >= 0) {
          splitPos = bestPos;
          wasHardSplit = false;
        }
        // else: hard split at targetEnd
      }
    }

    const chunk = text.slice(offset, splitPos);
    const endChar = splitPos;

    if (chunk.length >= minChunkChars || results.length === 0) {
      results.push({
        text: chunk,
        chunkIndex: results.length,
        startChar: offset,
        endChar,
        estimatedTokens: Math.ceil(chunk.length / CHARS_PER_TOKEN),
        wasHardSplit,
      });
    }

    // Advance with overlap
    const nextOffset = Math.max(offset + 1, splitPos - chunkOverlapChars);
    if (nextOffset <= offset) break; // safety: avoid infinite loop
    offset = nextOffset;
  }

  // Recompute chunk indices
  for (let i = 0; i < results.length; i++) {
    results[i].chunkIndex = i;
  }

  return results;
}