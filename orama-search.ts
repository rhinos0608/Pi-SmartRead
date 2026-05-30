/**
 * Orama code-search integration for Pi-SmartRead.
 *
 * Provides full-text (BM25), vector, and hybrid search over code chunks
 * with a custom tokenizer that splits camelCase/PascalCase/underscore identifiers.
 */

import { create, insertMultiple, search, save, load } from '@orama/orama';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodeChunk {
  filePath: string;
  content: string;
  symbolNames: string[];
  symbolKind: string;
  language: string;
  contentEmbedding: number[];
  locStart: number;
  locEnd: number;
}

export type SearchMode = 'fulltext' | 'vector' | 'hybrid';

export interface SearchOptions {
  term?: string;
  vector?: number[];
  mode?: SearchMode;
  limit?: number;
  offset?: number;
  filters?: {
    language?: string;
    filePath?: string;
    symbolKind?: string;
  };
  /** Hybrid-only: fullText weight (0-1). Defaults to 0.5. */
  fullTextWeight?: number;
  /** Hybrid-only: vector weight (0-1). Defaults to 0.5. */
  vectorWeight?: number;
  /** Vector/hybrid: minimum similarity (0-1). Defaults to 0.8. */
  similarity?: number;
}

export interface SearchResult {
  filePath: string;
  content: string;
  symbolNames: string[];
  symbolKind: string;
  language: string;
  locStart: number;
  locEnd: number;
  score: number;
}

// ---------------------------------------------------------------------------
// Code tokenizer — splits camelCase, PascalCase, underscores, numeric boundaries
// Replicates the splitToken logic from scoring.ts
// ---------------------------------------------------------------------------

// Cache cap — recomputation is cheap, so we simply stop caching when full
const MAX_NORMALIZATION_CACHE = 20000;

function createCodeTokenizer() {
  const cache = new Map<string, string[]>();

  return {
    language: 'code' as const,
    normalizationCache: cache,

    tokenize(raw: string): string[] {
      const cached = cache.get(raw);
      if (cached) return cached;

      const tokens: string[] = [];
      const seen = new Set<string>();

      // Step 1: split on non-alphanumeric delimiters (preserve underscores)
      const segments = raw.split(/[^a-zA-Z0-9]+/).filter(Boolean);

      for (const segment of segments) {
        if (!segment) continue;

        // Step 2: split on underscore
        const parts = segment.split('_');

        for (const part of parts) {
          if (!part) continue;

          // Step 3: split on camelCase/PascalCase/numeric boundaries
          const camelCaseParts = part.split(
            /(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[a-zA-Z])(?=[0-9])|(?<=[0-9])(?=[a-zA-Z])/,
          );

          for (const cp of camelCaseParts) {
            if (!cp) continue;

            // For all-uppercase sequences (e.g., "API" in "OAuthAPI"), split into individual letters
            if (/^[A-Z]+$/.test(cp) && cp.length > 1) {
              for (const ch of cp) {
                const lc = ch.toLowerCase();
                if (!seen.has(lc)) {
                  seen.add(lc);
                  tokens.push(lc);
                }
              }
            } else {
              const lc = cp.toLowerCase();
              if (!seen.has(lc)) {
                seen.add(lc);
                tokens.push(lc);
              }
            }
          }
        }
      }

      // Always include the full token (lowercased) first
      const full = raw.toLowerCase();
      if (!seen.has(full)) {
        // Only cache if under the cap
        if (cache.size < MAX_NORMALIZATION_CACHE) {
          cache.set(raw, [full, ...tokens]);
        }
        return [full, ...tokens];
      }

      // Only cache if under the cap
      if (cache.size < MAX_NORMALIZATION_CACHE) {
        cache.set(raw, tokens);
      }
      return tokens;
    },
  };
}

// ---------------------------------------------------------------------------
// Index creation
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CodeSearchDB = any;

/**
 * Creates a new Orama database optimized for code search.
 * @param dimension Embedding vector dimension (e.g., 384, 768, 1536)
 */
export async function createCodeSearchIndex(dimension: number): Promise<CodeSearchDB> {
  const db = await create({
    schema: {
      filePath: 'string',
      content: 'string',
      symbolNames: 'string[]',
      symbolKind: 'string',
      language: 'string',
      contentEmbedding: `vector[${dimension}]` as const,
      locStart: 'number',
      locEnd: 'number',
    },
    components: {
      tokenizer: createCodeTokenizer(),
    },
  });

  return db;
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

/**
 * Batch-insert code chunks into the database.
 * @param db Database created with createCodeSearchIndex
 * @param chunks Array of code chunks to insert
 */
export async function insertCodeChunks(db: CodeSearchDB, chunks: CodeChunk[]): Promise<void> {
  const docs = chunks.map((chunk) => ({
    filePath: chunk.filePath,
    content: chunk.content,
    symbolNames: chunk.symbolNames,
    symbolKind: chunk.symbolKind,
    language: chunk.language,
    contentEmbedding: chunk.contentEmbedding,
    locStart: chunk.locStart,
    locEnd: chunk.locEnd,
  }));

  await insertMultiple(db, docs);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OramaSearchParams = any;

/**
 * Search the code index with full-text, vector, or hybrid mode.
 *
 * @param db Database created with createCodeSearchIndex
 * @param options Search options
 * @returns Array of search results sorted by relevance
 */
export async function searchCode(
  db: CodeSearchDB,
  options: SearchOptions,
): Promise<SearchResult[]> {
  const {
    term = '',
    vector,
    mode = 'fulltext',
    limit = 10,
    offset = 0,
    filters,
    fullTextWeight = 0.5,
    vectorWeight = 0.5,
    similarity = 0.8,
  } = options;

  // Build where clause from filters — use raw string values (Orama's working syntax)
  const where: Record<string, string> = {};
  if (filters) {
    if (filters.language) where.language = filters.language;
    if (filters.filePath) where.filePath = filters.filePath;
    if (filters.symbolKind) where.symbolKind = filters.symbolKind;
  }

  // Build the search params based on mode
  let params: OramaSearchParams;

  if (mode === 'vector') {
    if (!vector) throw new Error('Vector search requires a vector option');
    params = {
      mode: 'vector',
      vector: {
        value: vector,
        property: 'contentEmbedding',
      },
      similarity,
      limit,
      offset,
      ...(Object.keys(where).length > 0 ? { where } : {}),
    };
  } else if (mode === 'hybrid') {
    if (!vector) throw new Error('Hybrid search requires a vector option');
    params = {
      mode: 'hybrid',
      term,
      vector: {
        value: vector,
        property: 'contentEmbedding',
      },
      similarity,
      hybrid: {
        weight: {
          fullText: fullTextWeight,
          vector: vectorWeight,
        },
      },
      limit,
      offset,
      ...(Object.keys(where).length > 0 ? { where } : {}),
    };
  } else {
    // fulltext mode — properties restrict which fields are tokenised & scored
    params = {
      term,
      properties: ['content', 'symbolNames'],
      boost: { content: 1, symbolNames: 3 },
      exact: false,
      limit,
      offset,
      ...(Object.keys(where).length > 0 ? { where } : {}),
    };
  }

  const result = await search(db, params);

  return result.hits.map((hit: { document: CodeChunk; score: number }) => ({
    filePath: hit.document.filePath,
    content: hit.document.content,
    symbolNames: hit.document.symbolNames,
    symbolKind: hit.document.symbolKind,
    language: hit.document.language,
    locStart: hit.document.locStart,
    locEnd: hit.document.locEnd,
    score: hit.score,
  }));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Serialize the database to a JSON-compatible object.
 * @param db Database to serialize
 * @returns Plain object suitable for JSON.stringify
 */
export async function saveCodeIndex(db: CodeSearchDB): Promise<object> {
  return save(db);
}

/**
 * Restore a database from a serialized snapshot.
 * @param db Database (must be created with same schema dimensions)
 * @param snapshot Previously saved snapshot object
 */
export async function loadCodeIndex(db: CodeSearchDB, snapshot: object): Promise<void> {
  await load(db, snapshot as Parameters<typeof load>[1]);
}