# intent_read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `intent_read` tool that reads up to 20 files, ranks them via hybrid RRF (BM25 + semantic cosine similarity), and returns the top-K results with file contents and per-file relevance metadata.

**Architecture:** Extract shared helpers from `read-many.ts` into `utils.ts`, then build `config.ts` (config loading), `scoring.ts` (BM25 + cosine + RRF), `embedding.ts` (OpenAI-compatible HTTP client), and `resolver.ts` (directory expansion), all wired together in `intent-read.ts`. Both tools are registered via `index.ts`.

**Tech Stack:** TypeScript (NodeNext ESM), Vitest, typebox, fdir, Node built-in `fetch`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `utils.ts` | Create | All shared helpers lifted from `read-many.ts`: path validation, heredoc formatting, packing logic, types |
| `config.ts` | Create | Load `pi-smartread.config.json` → env vars fallback; validate at call-time |
| `scoring.ts` | Create | `tokenize`, `bm25Scores`, `cosineSimilarity`, `computeRanks`, `computeRrfScores` |
| `embedding.ts` | Create | `fetchEmbeddings` — POST to OpenAI-compatible endpoint, validate response |
| `resolver.ts` | Create | `resolveDirectory` — fdir-based, non-recursive, sorted, capped at 20 |
| `intent-read.ts` | Create | `createIntentReadTool` — full pipeline: validate → read → embed → score → pack → return |
| `read-many.ts` | Modify | Import shared types and helpers from `utils.ts` instead of inlining them |
| `index.ts` | Modify | Register both `read_many` and `intent_read`; import config at startup |
| `tsconfig.json` | Modify | Add all new source files to `include` |
| `test/unit/utils.test.ts` | Create | Unit tests for helpers (extracted from `read-many.test.ts`) |
| `test/unit/config.test.ts` | Create | Unit tests for config loading and validation |
| `test/unit/scoring.test.ts` | Create | Unit tests for tokenizer, BM25, cosine, ranks, RRF |
| `test/unit/embedding.test.ts` | Create | Unit tests for embedding HTTP client (mock fetch) |
| `test/unit/resolver.test.ts` | Create | Unit tests for directory expansion |
| `test/unit/intent-read.test.ts` | Create | Integration tests for intent_read tool (mocked deps) |
| `test/unit/read-many.test.ts` | Modify | Remove helper logic tests (moved to utils.test.ts); update imports |
| `test/unit/index.test.ts` | Modify | Assert both tools are registered |

---

## Task 1: Extract utils.ts

**Files:**
- Create: `utils.ts`
- Create: `test/unit/utils.test.ts`
- Modify: `read-many.ts`
- Modify: `test/unit/read-many.test.ts`
- Modify: `tsconfig.json`

- [ ] **Step 1: Write the failing utils test**

Create `test/unit/utils.test.ts`:

```typescript
import { DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  buildPartialSection,
  buildPlan,
  createPathHash,
  formatContentBlock,
  measureText,
  pickDelimiter,
} from "../../utils.js";

function makeCandidate(path: string, text: string, ok: boolean, index: number, body?: string) {
  return { index, path, ok, fullText: text, fullMetrics: measureText(text), body };
}

describe("utils: measureText", () => {
  it("counts bytes and lines", () => {
    expect(measureText("a\nb")).toEqual({ bytes: 3, lines: 2 });
    expect(measureText("")).toEqual({ bytes: 0, lines: 0 });
  });
});

describe("utils: createPathHash", () => {
  it("is deterministic and produces 6 hex chars", () => {
    expect(createPathHash("/tmp/a.txt")).toBe(createPathHash("/tmp/a.txt"));
    expect(createPathHash("/tmp/a.txt")).not.toBe(createPathHash("/tmp/b.txt"));
    expect(createPathHash("/tmp/a.txt")).toMatch(/^[0-9A-F]{6}$/);
  });
});

describe("utils: pickDelimiter", () => {
  it("adds suffix when base collides with content", () => {
    const path = "/tmp/collide.txt";
    const base = `PINE_1_${createPathHash(path)}`;
    const picked = pickDelimiter(path, 1, `hello\n${base}\nworld`);
    expect(picked).toBe(`${base}_1`);
  });

  it("falls back after 256 suffix collisions", () => {
    const path = "/tmp/deep-collide.txt";
    const base = `PINE_1_${createPathHash(path)}`;
    const collisions = [base, ...Array.from({ length: 256 }, (_, i) => `${base}_${i + 1}`)];
    const picked = pickDelimiter(path, 1, collisions.join("\n"));
    expect(new Set(collisions).has(picked)).toBe(false);
  });
});

describe("utils: formatContentBlock", () => {
  it("wraps body in heredoc with matching delimiter", () => {
    const block = formatContentBlock("/tmp/file.txt", "line 1\nline 2", 3);
    const lines = block.split("\n");
    expect(lines[0]).toBe("@/tmp/file.txt");
    expect(lines[1]).toMatch(/^<<'ORBIT_3_[0-9A-F]{6}(?:_.*)?'$/);
    const delimiter = lines[1].slice(3, -1);
    expect(lines.at(-1)).toBe(delimiter);
  });
});

describe("utils: buildPartialSection", () => {
  it("fits within remaining budget", () => {
    const body = Array.from({ length: 200 }, (_, i) => `line-${i}-${"x".repeat(20)}`).join("\n");
    const candidate = makeCandidate("/tmp/large.txt", "ignored", true, 0, body);
    const partial = buildPartialSection(candidate, 40, 1500);
    expect(partial).toBeDefined();
    const m = measureText(partial!);
    expect(m.lines).toBeLessThanOrEqual(40);
    expect(m.bytes).toBeLessThanOrEqual(1500);
  });
});

describe("utils: buildPlan", () => {
  it("request-order stops on first non-fitting block", () => {
    const huge = "H".repeat(DEFAULT_MAX_BYTES + 128);
    const candidates = [
      makeCandidate("/a", "small-a", true, 0),
      makeCandidate("/b", huge, true, 1),
      makeCandidate("/c", "small-c", true, 2),
    ];
    const plan = buildPlan("request-order", [0, 1, 2], candidates);
    expect(plan.fullIncluded.has(0)).toBe(true);
    expect(plan.fullIncluded.has(2)).toBe(false);
  });

  it("counts successful full blocks separately", () => {
    const candidates = [
      makeCandidate("/ok-1", "x", true, 0),
      makeCandidate("/err", "y", false, 1),
      makeCandidate("/ok-2", "z", true, 2),
    ];
    const plan = buildPlan("request-order", [0, 1, 2], candidates);
    expect(plan.fullCount).toBe(3);
    expect(plan.fullSuccessCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd Pi-SmartRead && npx vitest run test/unit/utils.test.ts 2>&1 | tail -20
```

Expected: `Error: Cannot find module '../../utils.js'`

- [ ] **Step 3: Create utils.ts by extracting from read-many.ts**

Create `utils.ts` with the following exports (these are lifted verbatim from `read-many.ts`):

```typescript
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@mariozechner/pi-coding-agent";

export const DELIMITER_WORDS = [
  "PINE", "MANGO", "ORBIT", "RAVEN", "CEDAR", "LOTUS", "EMBER", "NOVA", "DUNE", "KITE",
  "TIDAL", "QUARTZ", "ACORN", "BLAZE", "FJORD", "GLYPH", "HARBOR", "IVORY", "JUNIPER",
  "SIERRA", "UMBRA", "VIOLET", "WILLOW", "XENON", "YARROW", "ZEPHYR",
] as const;

export interface TextMetrics {
  bytes: number;
  lines: number;
}

export interface FileCandidate {
  index: number;
  path: string;
  ok: boolean;
  fullText: string;
  fullMetrics: TextMetrics;
  body?: string;
}

export interface PackedSection {
  index: number;
  text: string;
  metrics: TextMetrics;
}

export type PackingStrategy = "request-order" | "smallest-first";

export interface PackingPlan {
  strategy: PackingStrategy;
  fullIncluded: Set<number>;
  partialSection?: PackedSection;
  omittedIndexes: number[];
  usedBytes: number;
  usedLines: number;
  sectionCount: number;
  fullCount: number;
  fullSuccessCount: number;
}

export function measureText(text: string): TextMetrics {
  return {
    bytes: Buffer.byteLength(text, "utf-8"),
    lines: text.length === 0 ? 0 : text.split("\n").length,
  };
}

export function createPathHash(path: string): string {
  let hash = 5381;
  for (let i = 0; i < path.length; i++) {
    hash = ((hash << 5) + hash + path.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).toUpperCase().padStart(6, "0").slice(0, 6);
}

export function buildLineSet(content: string): Set<string> {
  const lines = content.split("\n");
  const set = new Set<string>();
  for (const line of lines) set.add(line.replace(/\r$/, ""));
  return set;
}

export function pickDelimiter(path: string, index: number, content: string): string {
  const lineSet = buildLineSet(content);
  const word = DELIMITER_WORDS[index - 1] ?? `FILE${index}`;
  const hash = createPathHash(path);
  const base = `${word}_${index}_${hash}`;

  if (!lineSet.has(base)) return base;

  for (let attempt = 1; attempt <= 256; attempt++) {
    const candidate = `${base}_${attempt}`;
    if (!lineSet.has(candidate)) return candidate;
  }

  const fallbackBase = `${base}_${content.length.toString(36).toUpperCase()}`;
  if (!lineSet.has(fallbackBase)) return fallbackBase;

  for (let suffix = 1; suffix <= 10_000; suffix++) {
    const candidate = `${fallbackBase}_${suffix}`;
    if (!lineSet.has(candidate)) return candidate;
  }

  throw new Error(
    `pickDelimiter: could not find a unique delimiter for "${path}" after exhaustive search.`,
  );
}

export function validatePath(path: string): void {
  if (!path || !path.trim()) throw new Error("File path must not be empty");
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (segment === "..") throw new Error(`Path traversal not allowed: ${path}`);
  }
}

export function formatContentBlock(path: string, body: string, index: number): string {
  const delimiter = pickDelimiter(path, index, body);
  return `@${path}\n<<'${delimiter}'\n${body}\n${delimiter}`;
}

export function canFitSection(
  state: { usedBytes: number; usedLines: number; sectionCount: number },
  metrics: TextMetrics,
): boolean {
  const sepBytes = state.sectionCount > 0 ? 2 : 0;
  const sepLines = state.sectionCount > 0 ? 1 : 0;
  return (
    state.usedBytes + sepBytes + metrics.bytes <= DEFAULT_MAX_BYTES &&
    state.usedLines + sepLines + metrics.lines <= DEFAULT_MAX_LINES
  );
}

export function addSection(
  state: { usedBytes: number; usedLines: number; sectionCount: number },
  metrics: TextMetrics,
): void {
  const sepBytes = state.sectionCount > 0 ? 2 : 0;
  const sepLines = state.sectionCount > 0 ? 1 : 0;
  state.usedBytes += sepBytes + metrics.bytes;
  state.usedLines += sepLines + metrics.lines;
  state.sectionCount += 1;
}

export function buildPartialSection(
  candidate: FileCandidate,
  remainingLines: number,
  remainingBytes: number,
): string | undefined {
  if (!candidate.body) return undefined;

  let maxBodyLines = remainingLines - 3;
  if (maxBodyLines < 1 || remainingBytes < 32) return undefined;

  let maxBodyBytes = Math.max(1, remainingBytes - 96);

  for (let attempt = 0; attempt < 16; attempt++) {
    const trunc = truncateHead(candidate.body, { maxLines: maxBodyLines, maxBytes: maxBodyBytes });
    if (!trunc.content) return undefined;

    const partialText = formatContentBlock(candidate.path, trunc.content, candidate.index + 1);
    const metrics = measureText(partialText);
    if (metrics.lines <= remainingLines && metrics.bytes <= remainingBytes) return partialText;

    if (metrics.lines > remainingLines && maxBodyLines > 1)
      maxBodyLines = Math.max(1, maxBodyLines - (metrics.lines - remainingLines));
    if (metrics.bytes > remainingBytes && maxBodyBytes > 1)
      maxBodyBytes = Math.max(1, maxBodyBytes - (metrics.bytes - remainingBytes) - 8);
  }

  return undefined;
}

export function buildPlan(
  strategy: PackingStrategy,
  order: number[],
  candidates: FileCandidate[],
): PackingPlan {
  const state = { usedBytes: 0, usedLines: 0, sectionCount: 0 };
  const fullIncluded = new Set<number>();
  let fullSuccessCount = 0;

  for (const index of order) {
    const candidate = candidates[index];
    if (canFitSection(state, candidate.fullMetrics)) {
      addSection(state, candidate.fullMetrics);
      fullIncluded.add(index);
      if (candidate.ok) fullSuccessCount += 1;
    } else if (strategy === "request-order") {
      break;
    }
  }

  let partialSection: PackedSection | undefined;
  for (let index = 0; index < candidates.length; index++) {
    if (fullIncluded.has(index)) continue;
    const sepBytes = state.sectionCount > 0 ? 2 : 0;
    const sepLines = state.sectionCount > 0 ? 1 : 0;
    const remainingBytes = DEFAULT_MAX_BYTES - state.usedBytes - sepBytes;
    const remainingLines = DEFAULT_MAX_LINES - state.usedLines - sepLines;
    if (remainingBytes <= 0 || remainingLines <= 0) break;
    const partialText = buildPartialSection(candidates[index], remainingLines, remainingBytes);
    if (!partialText) continue;
    const metrics = measureText(partialText);
    partialSection = { index, text: partialText, metrics };
    addSection(state, metrics);
    break;
  }

  const omittedIndexes: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (fullIncluded.has(i) || partialSection?.index === i) continue;
    omittedIndexes.push(i);
  }

  return {
    strategy, fullIncluded, partialSection, omittedIndexes,
    usedBytes: state.usedBytes, usedLines: state.usedLines,
    sectionCount: state.sectionCount,
    fullCount: fullIncluded.size, fullSuccessCount,
  };
}
```

- [ ] **Step 4: Update read-many.ts to import from utils.ts**

Replace the inlined type/function definitions in `read-many.ts` with imports. The file should begin with:

```typescript
import { Type, type Static } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadToolDetails,
  ReadToolInput,
  ToolDefinition,
  TruncationResult,
} from "@mariozechner/pi-coding-agent";
import { createReadTool, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import {
  type FileCandidate,
  type PackingStrategy,
  type PackingPlan,
  type TextMetrics,
  buildPlan,
  formatContentBlock,
  measureText,
  validatePath,
} from "./utils.js";
```

Remove the inlined definitions of: `DELIMITER_WORDS`, `TextMetrics`, `FileCandidate`, `PackedSection`, `PackedSection`, `PackingStrategy`, `PackingPlan`, `measureText`, `createPathHash`, `buildLineSet`, `pickDelimiter`, `validatePath`, `formatContentBlock`, `canFitSection`, `addSection`, `buildPartialSection`, `buildPlan`.

Replace the `__test` export at the bottom with a re-export from utils so existing tests continue working:

```typescript
export { buildPartialSection, buildPlan, createPathHash, formatContentBlock, measureText, pickDelimiter } from "./utils.js";
export const __test = { measureText, createPathHash, pickDelimiter, formatContentBlock, buildPartialSection, buildPlan };
```

Wait — the `__test` export is currently an object literal. Import those names from utils and re-assemble it:

```typescript
import {
  buildPartialSection, buildPlan, createPathHash,
  formatContentBlock, measureText, pickDelimiter,
} from "./utils.js";

// ... rest of read-many.ts ...

export const __test = {
  measureText,
  createPathHash,
  pickDelimiter,
  formatContentBlock,
  buildPartialSection,
  buildPlan,
};
```

- [ ] **Step 5: Update tsconfig.json to include new files**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node", "vitest/globals"]
  },
  "include": [
    "index.ts",
    "read-many.ts",
    "utils.ts",
    "config.ts",
    "scoring.ts",
    "embedding.ts",
    "resolver.ts",
    "intent-read.ts",
    "test/**/*.ts"
  ]
}
```

- [ ] **Step 6: Run all tests**

```bash
npx vitest run 2>&1 | tail -30
```

Expected: All tests pass (utils.test.ts + existing read-many.test.ts + index.test.ts).

- [ ] **Step 7: Commit**

```bash
git add utils.ts read-many.ts tsconfig.json test/unit/utils.test.ts
git commit -m "refactor: extract shared helpers into utils.ts"
```

---

## Task 2: Create config.ts

**Files:**
- Create: `config.ts`
- Create: `test/unit/config.test.ts`

- [ ] **Step 1: Write the failing config tests**

Create `test/unit/config.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache, validateEmbeddingConfig } from "../../config.js";

describe("config: validateEmbeddingConfig", () => {
  beforeEach(() => {
    resetConfigCache();
    delete process.env.PI_SMARTREAD_EMBEDDING_BASE_URL;
    delete process.env.PI_SMARTREAD_EMBEDDING_MODEL;
    delete process.env.PI_SMARTREAD_EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_MODEL;
  });

  afterEach(() => resetConfigCache());

  it("throws when baseUrl is missing", () => {
    process.env.PI_SMARTREAD_EMBEDDING_MODEL = "text-embedding-3-small";
    expect(() => validateEmbeddingConfig()).toThrow(/baseUrl/);
  });

  it("throws when model is missing", () => {
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    expect(() => validateEmbeddingConfig()).toThrow(/model/);
  });

  it("reads PI_SMARTREAD_EMBEDDING_BASE_URL and PI_SMARTREAD_EMBEDDING_MODEL", () => {
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    process.env.PI_SMARTREAD_EMBEDDING_MODEL = "nomic-embed-text";
    const cfg = validateEmbeddingConfig();
    expect(cfg.baseUrl).toBe("http://localhost:11434/v1");
    expect(cfg.model).toBe("nomic-embed-text");
    expect(cfg.apiKey).toBeUndefined();
  });

  it("reads API key from PI_SMARTREAD_EMBEDDING_API_KEY", () => {
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    process.env.PI_SMARTREAD_EMBEDDING_MODEL = "nomic-embed-text";
    process.env.PI_SMARTREAD_EMBEDDING_API_KEY = "sk-test";
    const cfg = validateEmbeddingConfig();
    expect(cfg.apiKey).toBe("sk-test");
  });

  it("falls back to legacy EMBEDDING_BASE_URL and EMBEDDING_MODEL", () => {
    process.env.EMBEDDING_BASE_URL = "http://legacy:11434/v1";
    process.env.EMBEDDING_MODEL = "legacy-model";
    const cfg = validateEmbeddingConfig();
    expect(cfg.baseUrl).toBe("http://legacy:11434/v1");
    expect(cfg.model).toBe("legacy-model");
  });

  it("PI_SMARTREAD_ variables take precedence over legacy EMBEDDING_ variables", () => {
    process.env.EMBEDDING_BASE_URL = "http://legacy:11434/v1";
    process.env.EMBEDDING_MODEL = "legacy-model";
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://primary:11434/v1";
    process.env.PI_SMARTREAD_EMBEDDING_MODEL = "primary-model";
    const cfg = validateEmbeddingConfig();
    expect(cfg.baseUrl).toBe("http://primary:11434/v1");
    expect(cfg.model).toBe("primary-model");
  });

  it("error message points to both config file and env var names", () => {
    try {
      validateEmbeddingConfig();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("pi-smartread.config.json");
      expect(msg).toContain("PI_SMARTREAD_EMBEDDING_BASE_URL");
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run test/unit/config.test.ts 2>&1 | tail -10
```

Expected: `Error: Cannot find module '../../config.js'`

- [ ] **Step 3: Create config.ts**

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ResolvedEmbeddingConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

interface RawConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

let cache: RawConfig | null = null;

function loadRaw(): RawConfig {
  if (cache !== null) return cache;

  let fromFile: RawConfig = {};
  try {
    const raw = readFileSync(join(process.cwd(), "pi-smartread.config.json"), "utf-8");
    fromFile = JSON.parse(raw) as RawConfig;
  } catch {
    // File absent or unparseable — fall through to env vars
  }

  cache = {
    baseUrl:
      fromFile.baseUrl ??
      process.env.PI_SMARTREAD_EMBEDDING_BASE_URL ??
      process.env.EMBEDDING_BASE_URL,
    model:
      fromFile.model ??
      process.env.PI_SMARTREAD_EMBEDDING_MODEL ??
      process.env.EMBEDDING_MODEL,
    apiKey: fromFile.apiKey ?? process.env.PI_SMARTREAD_EMBEDDING_API_KEY,
  };

  return cache;
}

export function validateEmbeddingConfig(): ResolvedEmbeddingConfig {
  const raw = loadRaw();

  if (!raw.baseUrl) {
    throw new Error(
      "Embedding baseUrl is required. Set it in pi-smartread.config.json " +
        "or via the PI_SMARTREAD_EMBEDDING_BASE_URL environment variable.",
    );
  }
  if (!raw.model) {
    throw new Error(
      "Embedding model is required. Set it in pi-smartread.config.json " +
        "or via the PI_SMARTREAD_EMBEDDING_MODEL environment variable.",
    );
  }

  return { baseUrl: raw.baseUrl, model: raw.model, apiKey: raw.apiKey };
}

export function resetConfigCache(): void {
  cache = null;
}
```

- [ ] **Step 4: Run config tests**

```bash
npx vitest run test/unit/config.test.ts 2>&1 | tail -20
```

Expected: All config tests pass.

- [ ] **Step 5: Commit**

```bash
git add config.ts test/unit/config.test.ts
git commit -m "feat: add config.ts with JSON + env var loading and validation"
```

---

## Task 3: Create scoring.ts (tokenizer, BM25, cosine, RRF)

**Files:**
- Create: `scoring.ts`
- Create: `test/unit/scoring.test.ts`

- [ ] **Step 1: Write the failing scoring tests**

Create `test/unit/scoring.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  bm25Scores,
  cosineSimilarity,
  computeRanks,
  computeRrfScores,
  tokenize,
} from "../../scoring.js";

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumeric non-underscore", () => {
    expect(tokenize("Hello, World!")).toEqual(["hello", "world"]);
    expect(tokenize("foo_bar baz")).toEqual(["foo_bar", "baz"]);
    expect(tokenize("  spaces  ")).toEqual(["spaces"]);
  });

  it("discards empty tokens", () => {
    expect(tokenize(",,,,")).toEqual([]);
    expect(tokenize("")).toEqual([]);
  });

  it("keeps underscores inside tokens", () => {
    expect(tokenize("snake_case")).toEqual(["snake_case"]);
  });
});

describe("bm25Scores", () => {
  it("gives higher score to document containing query terms", () => {
    const docs = ["authentication middleware logic", "database schema migration"];
    const scores = bm25Scores("authentication", docs);
    expect(scores[0]).toBeGreaterThan(scores[1]);
  });

  it("returns zero score when query terms not in any document", () => {
    const docs = ["foo bar", "baz qux"];
    const scores = bm25Scores("zzz", docs);
    expect(scores[0]).toBe(0);
    expect(scores[1]).toBe(0);
  });

  it("does not multiply repeated query terms", () => {
    const docs = ["auth auth auth"];
    const scoresOnce = bm25Scores("auth", docs);
    const scoresRepeat = bm25Scores("auth auth auth", docs);
    expect(scoresOnce[0]).toBe(scoresRepeat[0]);
  });

  it("returns a score per document in input order", () => {
    const docs = ["a b c", "d e f", "a b c"];
    const scores = bm25Scores("a", docs);
    expect(scores).toHaveLength(3);
    expect(scores[0]).toBe(scores[2]);
    expect(scores[1]).toBe(0);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns -Infinity when either vector has zero norm", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(-Infinity);
    expect(cosineSimilarity([1, 2], [0, 0])).toBe(-Infinity);
  });
});

describe("computeRanks", () => {
  it("assigns rank 1 to highest score", () => {
    const ranks = computeRanks([0.9, 0.5, 0.7], ["a", "b", "c"]);
    expect(ranks[0]).toBe(1);
    expect(ranks[2]).toBe(2);
    expect(ranks[1]).toBe(3);
  });

  it("breaks ties by original index then path", () => {
    // Same score: index 0 (path "b") vs index 1 (path "a")
    // Original index takes priority over path
    const ranks = computeRanks([0.5, 0.5], ["b", "a"]);
    expect(ranks[0]).toBe(1);
    expect(ranks[1]).toBe(2);
  });

  it("handles single element", () => {
    expect(computeRanks([0.9], ["a"])).toEqual([1]);
  });
});

describe("computeRrfScores", () => {
  it("applies RRF formula with k=60", () => {
    const scores = computeRrfScores([1, 2], [2, 1]);
    // File 0: 1/(60+1) + 1/(60+2) = 1/61 + 1/62
    // File 1: 1/(60+2) + 1/(60+1) = 1/62 + 1/61
    expect(scores[0]).toBeCloseTo(scores[1]);
  });

  it("produces higher scores for lower combined ranks", () => {
    const scores = computeRrfScores([1, 3], [1, 3]);
    expect(scores[0]).toBeGreaterThan(scores[1]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run test/unit/scoring.test.ts 2>&1 | tail -10
```

Expected: `Error: Cannot find module '../../scoring.js'`

- [ ] **Step 3: Create scoring.ts**

```typescript
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0);
}

export function bm25Scores(query: string, documents: string[]): number[] {
  const k1 = 1.2;
  const b = 0.75;
  const N = documents.length;

  if (N === 0) return [];

  const tokenizedDocs = documents.map(tokenize);
  const avgDocLen = tokenizedDocs.reduce((sum, d) => sum + d.length, 0) / N;

  const queryTokens = [...new Set(tokenize(query))];

  // df: number of documents containing each unique query token
  const df = new Map<string, number>();
  for (const token of queryTokens) {
    let count = 0;
    for (const doc of tokenizedDocs) {
      if (doc.includes(token)) count += 1;
    }
    df.set(token, count);
  }

  // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
  const idf = new Map<string, number>();
  for (const token of queryTokens) {
    const d = df.get(token) ?? 0;
    idf.set(token, Math.log((N - d + 0.5) / (d + 0.5) + 1));
  }

  return tokenizedDocs.map((docTokens) => {
    const docLen = docTokens.length;
    // term frequency map for this document
    const tf = new Map<string, number>();
    for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    let score = 0;
    for (const token of queryTokens) {
      const f = tf.get(token) ?? 0;
      const tfScore = (f * (k1 + 1)) / (f + k1 * (1 - b + b * (docLen / avgDocLen)));
      score += (idf.get(token) ?? 0) * tfScore;
    }
    return score;
  });
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return -Infinity;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function computeRanks(scores: number[], paths: string[]): number[] {
  const order = scores.map((score, i) => ({ score, i, path: paths[i] }));
  order.sort((a, b) => {
    const d = b.score - a.score;
    if (d !== 0) return d;
    if (a.i !== b.i) return a.i - b.i;
    return a.path.localeCompare(b.path);
  });
  const ranks = new Array<number>(scores.length);
  order.forEach((item, rank) => { ranks[item.i] = rank + 1; });
  return ranks;
}

export function computeRrfScores(semanticRanks: number[], keywordRanks: number[]): number[] {
  const k = 60;
  return semanticRanks.map((sr, i) => 1 / (k + sr) + 1 / (k + keywordRanks[i]));
}
```

- [ ] **Step 4: Run scoring tests**

```bash
npx vitest run test/unit/scoring.test.ts 2>&1 | tail -20
```

Expected: All scoring tests pass.

- [ ] **Step 5: Commit**

```bash
git add scoring.ts test/unit/scoring.test.ts
git commit -m "feat: add scoring.ts with tokenizer, BM25, cosine similarity, and RRF"
```

---

## Task 4: Create embedding.ts

**Files:**
- Create: `embedding.ts`
- Create: `test/unit/embedding.test.ts`

- [ ] **Step 1: Write the failing embedding tests**

Create `test/unit/embedding.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchEmbeddings } from "../../embedding.js";

const BASE_URL = "http://localhost:11434/v1";
const MODEL = "nomic-embed-text";

function makeOkResponse(vectors: number[][]): Response {
  const body = JSON.stringify({
    data: vectors.map((embedding, index) => ({ object: "embedding", embedding, index })),
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("fetchEmbeddings", () => {
  beforeEach(() => { vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("POSTs to baseUrl/embeddings with correct body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeOkResponse([[0.1, 0.2], [0.3, 0.4]]));

    await fetchEmbeddings({ baseUrl: BASE_URL, model: MODEL, inputs: ["query", "file body"] });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/embeddings`);
    expect(opts?.method).toBe("POST");
    const body = JSON.parse(opts?.body as string);
    expect(body.model).toBe(MODEL);
    expect(body.input).toEqual(["query", "file body"]);
  });

  it("normalizes trailing slash in baseUrl", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeOkResponse([[0.1], [0.2]]));
    await fetchEmbeddings({ baseUrl: `${BASE_URL}/`, model: MODEL, inputs: ["a", "b"] });
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/embeddings`);
  });

  it("includes Authorization header when apiKey is provided", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeOkResponse([[0.1], [0.2]]));
    await fetchEmbeddings({ baseUrl: BASE_URL, model: MODEL, inputs: ["a", "b"], apiKey: "sk-test" });
    const [, opts] = vi.mocked(fetch).mock.calls[0];
    expect((opts?.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
  });

  it("omits Authorization header when apiKey is absent", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeOkResponse([[0.1], [0.2]]));
    await fetchEmbeddings({ baseUrl: BASE_URL, model: MODEL, inputs: ["a", "b"] });
    const [, opts] = vi.mocked(fetch).mock.calls[0];
    expect((opts?.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("returns vectors in input order", async () => {
    const v1 = [0.1, 0.2];
    const v2 = [0.3, 0.4];
    vi.mocked(fetch).mockResolvedValueOnce(makeOkResponse([v1, v2]));
    const { vectors } = await fetchEmbeddings({ baseUrl: BASE_URL, model: MODEL, inputs: ["a", "b"] });
    expect(vectors[0]).toEqual(v1);
    expect(vectors[1]).toEqual(v2);
  });

  it("throws when response status is not ok", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("error", { status: 500 }));
    await expect(fetchEmbeddings({ baseUrl: BASE_URL, model: MODEL, inputs: ["a"] }))
      .rejects.toThrow("500");
  });

  it("throws when response has fewer embeddings than inputs", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeOkResponse([[0.1]]));
    await expect(fetchEmbeddings({ baseUrl: BASE_URL, model: MODEL, inputs: ["a", "b"] }))
      .rejects.toThrow(/fewer/i);
  });

  it("throws when an embedding is not an array", async () => {
    const body = JSON.stringify({ data: [{ embedding: "not-an-array" }] });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await expect(fetchEmbeddings({ baseUrl: BASE_URL, model: MODEL, inputs: ["a"] }))
      .rejects.toThrow(/embedding/i);
  });

  it("throws when vector contains non-numeric values", async () => {
    const body = JSON.stringify({ data: [{ embedding: ["not", "numbers"] }] });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await expect(fetchEmbeddings({ baseUrl: BASE_URL, model: MODEL, inputs: ["a"] }))
      .rejects.toThrow(/numeric/i);
  });

  it("throws when vectors have mismatched dimensions", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeOkResponse([[0.1, 0.2], [0.3]]));
    await expect(fetchEmbeddings({ baseUrl: BASE_URL, model: MODEL, inputs: ["a", "b"] }))
      .rejects.toThrow(/dimension/i);
  });

  it("throws when fetch rejects (network error)", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(fetchEmbeddings({ baseUrl: BASE_URL, model: MODEL, inputs: ["a"] }))
      .rejects.toThrow("ECONNREFUSED");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run test/unit/embedding.test.ts 2>&1 | tail -10
```

Expected: `Error: Cannot find module '../../embedding.js'`

- [ ] **Step 3: Create embedding.ts**

```typescript
export interface EmbedRequest {
  baseUrl: string;
  model: string;
  apiKey?: string;
  inputs: string[];
  timeoutMs?: number;
}

export interface EmbedResult {
  vectors: number[][];
}

export async function fetchEmbeddings(req: EmbedRequest): Promise<EmbedResult> {
  const url = req.baseUrl.replace(/\/+$/, "") + "/embeddings";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (req.apiKey) headers["Authorization"] = `Bearer ${req.apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 30_000);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: req.model, input: req.inputs }),
      signal: controller.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Embedding API request failed: ${msg}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Embedding API returned HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Embedding API returned malformed JSON");
  }

  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error("Embedding API response missing data array");
  }

  if (data.length < req.inputs.length) {
    throw new Error(
      `Embedding API returned fewer embeddings than requested: got ${data.length}, expected ${req.inputs.length}`,
    );
  }

  const vectors: number[][] = [];
  let expectedDim: number | undefined;

  for (let i = 0; i < req.inputs.length; i++) {
    const entry = data[i] as { embedding?: unknown };
    const embedding = entry?.embedding;

    if (!Array.isArray(embedding)) {
      throw new Error(`Embedding at index ${i} is not an array`);
    }
    for (const v of embedding) {
      if (typeof v !== "number") {
        throw new Error(`Embedding at index ${i} contains non-numeric values`);
      }
    }
    if (expectedDim === undefined) {
      expectedDim = embedding.length;
    } else if (embedding.length !== expectedDim) {
      throw new Error(
        `Embedding dimension mismatch at index ${i}: expected ${expectedDim}, got ${embedding.length}`,
      );
    }
    vectors.push(embedding as number[]);
  }

  return { vectors };
}
```

- [ ] **Step 4: Run embedding tests**

```bash
npx vitest run test/unit/embedding.test.ts 2>&1 | tail -20
```

Expected: All embedding tests pass.

- [ ] **Step 5: Commit**

```bash
git add embedding.ts test/unit/embedding.test.ts
git commit -m "feat: add embedding.ts with OpenAI-compatible fetch client and response validation"
```

---

## Task 5: Create resolver.ts

**Files:**
- Create: `resolver.ts`
- Create: `test/unit/resolver.test.ts`

- [ ] **Step 1: Write the failing resolver tests**

Create `test/unit/resolver.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDirectory } from "../../resolver.js";

let tmpDir: string;

beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "intent-read-test-")); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function touch(name: string) { writeFileSync(join(tmpDir, name), `content of ${name}`); }

describe("resolveDirectory", () => {
  it("returns paths of regular files in the directory", () => {
    touch("a.ts");
    touch("b.ts");
    const result = resolveDirectory(tmpDir);
    expect(result.paths).toHaveLength(2);
    expect(result.paths.every((p) => p.endsWith(".ts"))).toBe(true);
  });

  it("returns paths sorted lexicographically", () => {
    touch("c.ts");
    touch("a.ts");
    touch("b.ts");
    const { paths } = resolveDirectory(tmpDir);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
  });

  it("is not recursive — ignores files in subdirectories", () => {
    touch("top.ts");
    mkdirSync(join(tmpDir, "sub"));
    writeFileSync(join(tmpDir, "sub", "nested.ts"), "nested");
    const { paths } = resolveDirectory(tmpDir);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("top.ts");
  });

  it("does not follow symlinks", () => {
    touch("real.ts");
    symlinkSync(join(tmpDir, "real.ts"), join(tmpDir, "link.ts"));
    const { paths } = resolveDirectory(tmpDir);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("real.ts");
  });

  it("caps at 20 files and reports capped status", () => {
    for (let i = 0; i < 25; i++) touch(`file-${i}.ts`);
    const result = resolveDirectory(tmpDir, 20);
    expect(result.paths).toHaveLength(20);
    expect(result.capped).toBe(true);
    expect(result.countBeforeCap).toBe(25);
  });

  it("reports capped false when files are within limit", () => {
    touch("a.ts");
    touch("b.ts");
    const result = resolveDirectory(tmpDir, 20);
    expect(result.capped).toBe(false);
    expect(result.countBeforeCap).toBe(2);
  });

  it("returns empty array for empty directory", () => {
    const result = resolveDirectory(tmpDir);
    expect(result.paths).toEqual([]);
    expect(result.capped).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run test/unit/resolver.test.ts 2>&1 | tail -10
```

Expected: `Error: Cannot find module '../../resolver.js'`

- [ ] **Step 3: Create resolver.ts**

```typescript
import { fdir } from "fdir";
import { resolve } from "node:path";

export interface DirectoryResolution {
  paths: string[];
  capped: boolean;
  countBeforeCap: number;
}

export function resolveDirectory(directory: string, cap = 20): DirectoryResolution {
  const resolved = resolve(directory);

  const all = (
    new fdir()
      .withFullPaths()
      .crawlWithOptions(resolved, { maxDepth: 0, excludeSymlinks: true })
      .sync() as string[]
  ).sort((a, b) => a.localeCompare(b));

  return {
    paths: all.slice(0, cap),
    capped: all.length > cap,
    countBeforeCap: all.length,
  };
}
```

- [ ] **Step 4: Run resolver tests**

```bash
npx vitest run test/unit/resolver.test.ts 2>&1 | tail -20
```

Expected: All resolver tests pass.

- [ ] **Step 5: Commit**

```bash
git add resolver.ts test/unit/resolver.test.ts
git commit -m "feat: add resolver.ts for non-recursive directory expansion via fdir"
```

---

## Task 6: Create intent-read.ts

**Files:**
- Create: `intent-read.ts`
- Create: `test/unit/intent-read.test.ts`

- [ ] **Step 1: Write the failing intent-read tests**

Create `test/unit/intent-read.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createIntentReadTool } from "../../intent-read.js";
import type { EmbedRequest, EmbedResult } from "../../embedding.js";
import { resetConfigCache } from "../../config.js";

// Stub fetchEmbeddings: returns unit vectors for easy scoring
function makeEmbedder(vectors: number[][]): (req: EmbedRequest) => Promise<EmbedResult> {
  return async () => ({ vectors });
}

// Stub readTool: returns text content by path
function makeReadTool(map: Record<string, string | Error>) {
  return {
    execute: async (_id: string, input: { path: string }) => {
      const val = map[input.path];
      if (!val) throw new Error(`No stub for: ${input.path}`);
      if (val instanceof Error) throw val;
      return { content: [{ type: "text" as const, text: val }] };
    },
  };
}

beforeEach(() => {
  resetConfigCache();
  process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
  process.env.PI_SMARTREAD_EMBEDDING_MODEL = "nomic-embed-text";
});

afterEach(() => {
  resetConfigCache();
  delete process.env.PI_SMARTREAD_EMBEDDING_BASE_URL;
  delete process.env.PI_SMARTREAD_EMBEDDING_MODEL;
});

describe("intent_read: input validation", () => {
  it("throws when both files and directory are provided", async () => {
    const tool = createIntentReadTool(() => makeReadTool({}) as any, makeEmbedder([]));
    await expect(
      tool.execute("id", { query: "auth", files: [{ path: "/a" }], directory: "/tmp" }, undefined, undefined, { cwd: "/" } as any),
    ).rejects.toThrow(/files.*directory|directory.*files/i);
  });

  it("throws when neither files nor directory is provided", async () => {
    const tool = createIntentReadTool(() => makeReadTool({}) as any, makeEmbedder([]));
    await expect(
      tool.execute("id", { query: "auth" } as any, undefined, undefined, { cwd: "/" } as any),
    ).rejects.toThrow(/files.*directory|directory.*files/i);
  });

  it("throws when query is empty after trimming", async () => {
    const tool = createIntentReadTool(() => makeReadTool({}) as any, makeEmbedder([]));
    await expect(
      tool.execute("id", { query: "   ", files: [{ path: "/a" }] }, undefined, undefined, { cwd: "/" } as any),
    ).rejects.toThrow(/query/i);
  });
});

describe("intent_read: ranking and output", () => {
  it("returns top-K files by RRF score in relevance order", async () => {
    // query vector: [1,0,0]
    // file a vector: [1,0,0] → high cosine similarity
    // file b vector: [0,1,0] → low cosine similarity
    const queryVec = [1, 0, 0];
    const fileAVec = [1, 0, 0];
    const fileBVec = [0, 1, 0];

    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "authentication logic here", "/b": "database schema" }) as any,
      makeEmbedder([queryVec, fileAVec, fileBVec]),
    );

    const result = await tool.execute(
      "id",
      { query: "authentication", files: [{ path: "/a" }, { path: "/b" }], topK: 2 },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const text = (result.content[0] as any).text as string;
    const details = result.details as any;

    // /a should rank higher (both keyword and semantic match)
    const posA = text.indexOf("@/a");
    const posB = text.indexOf("@/b");
    expect(posA).toBeGreaterThanOrEqual(0);
    expect(posB).toBeGreaterThan(posA);

    expect(details.query).toBe("authentication");
    expect(details.successCount).toBe(2);
    expect(details.requestedTopK).toBe(2);

    const fileA = details.files.find((f: any) => f.path === "/a");
    expect(fileA.included).toBe(true);
    expect(fileA.rrfScore).toBeGreaterThan(0);
    expect(fileA.inclusion).toBe("full");
  });

  it("puts errored files after successful files in details.files", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "content", "/b": new Error("missing") }) as any,
      makeEmbedder([[1, 0], [1, 0]]),
    );

    const result = await tool.execute(
      "id",
      { query: "auth", files: [{ path: "/a" }, { path: "/b" }] },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const details = result.details as any;
    const errorFile = details.files.find((f: any) => f.path === "/b");
    const successFile = details.files.find((f: any) => f.path === "/a");

    expect(errorFile.ok).toBe(false);
    expect(errorFile.inclusion).toBe("error");
    expect(errorFile.included).toBe(false);

    // Successful file should appear before errored file
    const successIdx = details.files.indexOf(successFile);
    const errorIdx = details.files.indexOf(errorFile);
    expect(successIdx).toBeLessThan(errorIdx);
  });

  it("marks files outside topK as not_top_k", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "auth", "/b": "db", "/c": "cache" }) as any,
      makeEmbedder([[1, 0], [1, 0], [0, 1], [0, 1]]),
    );

    const result = await tool.execute(
      "id",
      { query: "auth", files: [{ path: "/a" }, { path: "/b" }, { path: "/c" }], topK: 2 },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const details = result.details as any;
    const notTopK = details.files.filter((f: any) => f.inclusion === "not_top_k");
    expect(notTopK).toHaveLength(1);
  });

  it("stops on first error when stopOnError is true and does not embed", async () => {
    const embedder = vi.fn(makeEmbedder([]));
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": new Error("bad"), "/b": "ok" }) as any,
      embedder,
    );

    await expect(
      tool.execute(
        "id",
        { query: "auth", files: [{ path: "/a" }, { path: "/b" }], stopOnError: true },
        undefined,
        undefined,
        { cwd: "/" } as any,
      ),
    ).rejects.toThrow("bad");

    expect(embedder).not.toHaveBeenCalled();
  });

  it("throws before reading when embedding config is missing", async () => {
    resetConfigCache();
    delete process.env.PI_SMARTREAD_EMBEDDING_BASE_URL;
    delete process.env.PI_SMARTREAD_EMBEDDING_MODEL;

    const readSpy = vi.fn();
    const tool = createIntentReadTool(() => ({ execute: readSpy }) as any, makeEmbedder([]));

    await expect(
      tool.execute("id", { query: "auth", files: [{ path: "/a" }] }, undefined, undefined, { cwd: "/" } as any),
    ).rejects.toThrow(/baseUrl|model/i);

    expect(readSpy).not.toHaveBeenCalled();
  });

  it("returns no content when all files fail to read", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": new Error("gone") }) as any,
      makeEmbedder([]),
    );

    const result = await tool.execute(
      "id",
      { query: "auth", files: [{ path: "/a" }] },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const text = (result.content[0] as any).text as string;
    const details = result.details as any;
    expect(text).toBe("");
    expect(details.successCount).toBe(0);
    expect(details.effectiveTopK).toBe(0);
  });

  it("includes per-file semanticRank, keywordRank, and rrfScore for successful files", async () => {
    const tool = createIntentReadTool(
      () => makeReadTool({ "/a": "authentication middleware" }) as any,
      makeEmbedder([[1, 0], [1, 0]]),
    );

    const result = await tool.execute(
      "id",
      { query: "authentication", files: [{ path: "/a" }] },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );

    const details = result.details as any;
    const fileDetail = details.files[0];
    expect(typeof fileDetail.semanticRank).toBe("number");
    expect(typeof fileDetail.keywordRank).toBe("number");
    expect(typeof fileDetail.rrfScore).toBe("number");
    expect(typeof fileDetail.semanticScore).toBe("number");
    expect(typeof fileDetail.keywordScore).toBe("number");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run test/unit/intent-read.test.ts 2>&1 | tail -10
```

Expected: `Error: Cannot find module '../../intent-read.js'`

- [ ] **Step 3: Create intent-read.ts**

```typescript
import { Type, type Static } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadToolInput,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { createReadTool, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";
import { validateEmbeddingConfig } from "./config.js";
import { type EmbedRequest, type EmbedResult, fetchEmbeddings as defaultFetchEmbeddings } from "./embedding.js";
import { resolveDirectory } from "./resolver.js";
import { bm25Scores, cosineSimilarity, computeRanks, computeRrfScores } from "./scoring.js";
import {
  type FileCandidate,
  buildPlan,
  formatContentBlock,
  measureText,
  validatePath,
} from "./utils.js";

const IntentReadSchema = Type.Object({
  query: Type.String({ description: "The search intent" }),
  files: Type.Optional(
    Type.Array(
      Type.Object({
        path: Type.String({ description: "Path to the file (relative or absolute)" }),
        offset: Type.Optional(Type.Number({ minimum: 0 })),
        limit: Type.Optional(Type.Number({ minimum: 1 })),
      }),
      { minItems: 1, maxItems: 20 },
    ),
  ),
  directory: Type.Optional(Type.String({ description: "Directory to scan (non-recursive, max 20 files)" })),
  topK: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "Max results to return (default 5)" })),
  stopOnError: Type.Optional(Type.Boolean({ description: "Stop on first read error (default false)" })),
});

type IntentReadInput = Static<typeof IntentReadSchema>;

type InclusionStatus = "full" | "partial" | "omitted" | "not_top_k" | "error";

interface IntentReadFileDetail {
  path: string;
  ok: boolean;
  error?: string;
  semanticRank?: number;
  semanticScore?: number;
  keywordRank?: number;
  keywordScore?: number;
  rrfScore?: number;
  selectedForPacking: boolean;
  included: boolean;
  inclusion: InclusionStatus;
}

interface IntentReadDetails {
  query: string;
  processedCount: number;
  successCount: number;
  errorCount: number;
  requestedTopK: number;
  effectiveTopK: number;
  candidateCountBeforeCap?: number;
  candidateCountAfterCap?: number;
  capped?: boolean;
  files: IntentReadFileDetail[];
  packing: {
    strategy: string;
    switchedForCoverage: boolean;
    fullIncludedCount: number;
    fullIncludedSuccessCount: number;
    partialIncludedPath?: string;
    omittedPaths: string[];
  };
}

export function createIntentReadTool(
  readToolFactory: typeof createReadTool = createReadTool,
  fetchEmbeddingsImpl: (req: EmbedRequest) => Promise<EmbedResult> = defaultFetchEmbeddings,
): ToolDefinition {
  return {
    name: "intent_read",
    label: "intent_read",
    description: `Read up to 20 files, rank them by hybrid RRF (BM25 keyword + semantic cosine) against a query, and return the top-K relevant files. Combined output respects limits (${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}). Requires embedding config via pi-smartread.config.json or PI_SMARTREAD_EMBEDDING_BASE_URL / PI_SMARTREAD_EMBEDDING_MODEL env vars.`,
    parameters: IntentReadSchema,

    async execute(
      toolCallId: string,
      params: IntentReadInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      // 1. Validate embedding config first (before any reads)
      const embeddingConfig = validateEmbeddingConfig();

      // 2. Validate input
      const query = params.query.trim();
      if (!query) throw new Error("query must not be empty or whitespace-only");

      const hasFiles = Array.isArray(params.files) && params.files.length > 0;
      const hasDirectory = typeof params.directory === "string" && params.directory.length > 0;

      if (hasFiles && hasDirectory) {
        throw new Error("Provide either files or directory, not both");
      }
      if (!hasFiles && !hasDirectory) {
        throw new Error("Provide either files or directory");
      }

      const topK = params.topK ?? 5;

      // 3. Resolve candidates
      interface ResolvedFile { path: string; offset?: number; limit?: number; }
      let resolvedFiles: ResolvedFile[];
      let dirCap: { countBeforeCap: number; countAfterCap: number; capped: boolean } | undefined;

      if (hasDirectory) {
        const resolution = resolveDirectory(params.directory!);
        if (resolution.capped) {
          dirCap = {
            countBeforeCap: resolution.countBeforeCap,
            countAfterCap: resolution.paths.length,
            capped: true,
          };
        }
        resolvedFiles = resolution.paths.map((p) => ({ path: p }));
      } else {
        resolvedFiles = params.files!;
      }

      // 4. Read files
      const readTool = readToolFactory(ctx.cwd);
      interface FileReadResult { path: string; ok: boolean; body?: string; error?: string; }
      const fileResults: FileReadResult[] = [];

      for (let i = 0; i < resolvedFiles.length; i++) {
        if (signal?.aborted) throw new Error("Operation aborted");

        const req = resolvedFiles[i];
        try {
          validatePath(req.path);
          const input: ReadToolInput = { path: req.path, offset: req.offset, limit: req.limit };
          const result = await readTool.execute(`${toolCallId}:${i}`, input, signal, undefined);

          const body = result.content
            .filter((item): item is { type: "text"; text: string } => item.type === "text")
            .map((item) => item.text)
            .join("\n");

          fileResults.push({ path: req.path, ok: true, body: body || "[No text content]" });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          fileResults.push({ path: req.path, ok: false, error: message });
          if (params.stopOnError) throw err;
        }
      }

      const successfulFiles = fileResults.filter((f) => f.ok);
      const erroredFiles = fileResults.filter((f) => !f.ok);

      // 5. Embed + score (skip if no successful files)
      const fileDetails = new Map<string, Partial<IntentReadFileDetail>>();
      for (const f of fileResults) {
        fileDetails.set(f.path, { path: f.path, ok: f.ok, error: f.error });
      }

      let rankedSuccessOrder: string[] = []; // paths in RRF rank order (rank 1 first)

      if (successfulFiles.length > 0) {
        const bodies = successfulFiles.map((f) => f.body!);
        const paths = successfulFiles.map((f) => f.path);

        const { vectors } = await fetchEmbeddingsImpl({
          ...embeddingConfig,
          inputs: [query, ...bodies],
        });

        const queryVec = vectors[0];
        const fileVecs = vectors.slice(1);

        const semanticScores = fileVecs.map((v) => cosineSimilarity(queryVec, v));
        const keywordScoresArr = bm25Scores(query, bodies);
        const semanticRanks = computeRanks(semanticScores, paths);
        const keywordRanks = computeRanks(keywordScoresArr, paths);
        const rrfScores = computeRrfScores(semanticRanks, keywordRanks);
        const rrfRanks = computeRanks(rrfScores, paths);

        for (let i = 0; i < successfulFiles.length; i++) {
          fileDetails.set(paths[i], {
            ...fileDetails.get(paths[i]),
            semanticRank: semanticRanks[i],
            semanticScore: semanticScores[i],
            keywordRank: keywordRanks[i],
            keywordScore: keywordScoresArr[i],
            rrfScore: rrfScores[i],
          });
        }

        // Sort by RRF rank (ascending rank = descending score)
        rankedSuccessOrder = [...paths].sort((a, b) => {
          const ri = paths.indexOf(a);
          const rj = paths.indexOf(b);
          return rrfRanks[ri] - rrfRanks[rj];
        });
      }

      const effectiveTopK = Math.min(topK, successfulFiles.length);
      const topKPaths = new Set(rankedSuccessOrder.slice(0, effectiveTopK));

      // Mark each file's selection status
      for (const f of fileResults) {
        const detail = fileDetails.get(f.path)!;
        detail.selectedForPacking = f.ok && topKPaths.has(f.path);
        if (!f.ok) {
          detail.inclusion = "error";
          detail.included = false;
        } else if (!topKPaths.has(f.path)) {
          detail.inclusion = "not_top_k";
          detail.included = false;
        }
        // included/inclusion for top-K files is set after packing
      }

      // 6. Pack top-K files using buildPlan (in RRF rank order)
      const topKOrdered = rankedSuccessOrder.slice(0, effectiveTopK);
      const packCandidates: FileCandidate[] = topKOrdered.map((path, i) => {
        const f = successfulFiles.find((x) => x.path === path)!;
        const body = f.body!;
        const fullText = formatContentBlock(path, body, i + 1);
        return {
          index: i,
          path,
          ok: true,
          fullText,
          fullMetrics: measureText(fullText),
          body,
        };
      });

      const requestOrder = packCandidates.map((_, i) => i);
      const smallestFirstOrder = [...requestOrder].sort((a, b) => {
        const d = packCandidates[a].fullMetrics.bytes - packCandidates[b].fullMetrics.bytes;
        return d !== 0 ? d : a - b;
      });

      const requestPlan = buildPlan("request-order", requestOrder, packCandidates);
      const smallestPlan = buildPlan("smallest-first", smallestFirstOrder, packCandidates);
      const switchedForCoverage = smallestPlan.fullSuccessCount > requestPlan.fullSuccessCount;
      const plan = switchedForCoverage ? smallestPlan : requestPlan;

      // Build output sections in RRF rank order
      const sections: string[] = [];
      for (let i = 0; i < packCandidates.length; i++) {
        const path = packCandidates[i].path;
        if (plan.fullIncluded.has(i)) {
          sections.push(packCandidates[i].fullText);
          const d = fileDetails.get(path)!;
          d.inclusion = "full";
          d.included = true;
        } else if (plan.partialSection?.index === i) {
          sections.push(plan.partialSection.text);
          const d = fileDetails.get(path)!;
          d.inclusion = "partial";
          d.included = true;
        } else {
          const d = fileDetails.get(path)!;
          d.inclusion = "omitted";
          d.included = false;
        }
      }

      const outputText = sections.join("\n\n");

      // 7. Build details.files: successful files in RRF order, then errored files in input order
      const allFileDetails: IntentReadFileDetail[] = [
        ...rankedSuccessOrder.map((path) => fileDetails.get(path) as IntentReadFileDetail),
        ...erroredFiles.map((f) => fileDetails.get(f.path) as IntentReadFileDetail),
      ];

      // Fill in selectedForPacking and included defaults for any still-undefined entries
      for (const d of allFileDetails) {
        d.selectedForPacking ??= false;
        d.included ??= false;
      }

      const partialIncludedPath =
        plan.partialSection !== undefined
          ? packCandidates[plan.partialSection.index]?.path
          : undefined;

      const details: IntentReadDetails = {
        query,
        processedCount: fileResults.length,
        successCount: successfulFiles.length,
        errorCount: erroredFiles.length,
        requestedTopK: topK,
        effectiveTopK,
        ...(dirCap && {
          candidateCountBeforeCap: dirCap.countBeforeCap,
          candidateCountAfterCap: dirCap.countAfterCap,
          capped: true,
        }),
        files: allFileDetails,
        packing: {
          strategy: plan.strategy,
          switchedForCoverage,
          fullIncludedCount: plan.fullCount,
          fullIncludedSuccessCount: plan.fullSuccessCount,
          partialIncludedPath,
          omittedPaths: plan.omittedIndexes.map((i) => packCandidates[i].path),
        },
      };

      return {
        content: [{ type: "text", text: outputText }],
        details,
      };
    },
  } as unknown as ToolDefinition;
}
```

- [ ] **Step 4: Run intent-read tests**

```bash
npx vitest run test/unit/intent-read.test.ts 2>&1 | tail -30
```

Expected: All intent-read tests pass.

- [ ] **Step 5: Commit**

```bash
git add intent-read.ts test/unit/intent-read.test.ts
git commit -m "feat: add intent-read.ts — ephemeral RAG pipeline tool"
```

---

## Task 7: Wire up index.ts and update index test

**Files:**
- Modify: `index.ts`
- Modify: `test/unit/index.test.ts`

- [ ] **Step 1: Update index.test.ts to expect both tools**

Replace `test/unit/index.test.ts` entirely with:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import registerExtension from "../../index.js";

describe("index extension wiring", () => {
  it("registers read_many and intent_read tools", () => {
    const registered: { name: string; execute: unknown }[] = [];

    const api = {
      registerTool: (definition: { name: string; execute: unknown }) => {
        registered.push(definition);
      },
    } as unknown as ExtensionAPI;

    registerExtension(api);

    const names = registered.map((t) => t.name);
    expect(names).toContain("read_many");
    expect(names).toContain("intent_read");
    expect(registered.every((t) => typeof t.execute === "function")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run test/unit/index.test.ts 2>&1 | tail -10
```

Expected: test fails because `intent_read` is not registered yet.

- [ ] **Step 3: Update index.ts**

Replace `index.ts` with:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createIntentReadTool } from "./intent-read.js";
import { createReadManyTool } from "./read-many.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool(createReadManyTool());
  pi.registerTool(createIntentReadTool());
}
```

- [ ] **Step 4: Run all tests**

```bash
npx vitest run 2>&1 | tail -30
```

Expected: All tests pass across all test files.

- [ ] **Step 5: Run typecheck**

```bash
npx tsc --noEmit 2>&1
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add index.ts test/unit/index.test.ts
git commit -m "feat: register intent_read alongside read_many in index.ts"
```

---

## Self-Review Checklist

Spec requirements vs plan coverage:

| Spec requirement | Task |
|---|---|
| Batch read up to 20 files | Task 6 (resolver caps at 20, input schema maxItems: 20) |
| Either files list or directory input | Task 6 (XOR validation) |
| `fdir` non-recursive, no symlinks, sorted | Task 5 |
| Directory cap reported in details | Task 6 |
| Validate all paths before reading | Task 6 (validatePath per file) |
| Embedding config from JSON then env | Task 2 |
| Config throws at call time, not import | Task 2 (validateEmbeddingConfig called in execute) |
| PI_SMARTREAD_ env vars + legacy fallbacks | Task 2 |
| POST `baseUrl/embeddings` with model + input | Task 4 |
| Auth header when apiKey present | Task 4 |
| 30s request timeout | Task 4 |
| Malformed response validation (count, shape, dims, numeric) | Task 4 |
| BM25 with k1=1.2, b=0.75, IDF over corpus | Task 3 |
| Tokenize: lowercase, split non-alphanum non-underscore | Task 3 |
| Unique query tokens (no multiplier for repeats) | Task 3 |
| Cosine similarity; zero-norm → -Infinity | Task 3 |
| computeRanks with tie-breaking (index then path) | Task 3 |
| RRF with k=60 | Task 3 |
| Errored files excluded from scoring, ranked last | Task 6 |
| stopOnError: throw before embedding | Task 6 |
| Top-K selection from successful files | Task 6 |
| buildPlan re-used for output budget | Task 6 |
| Heredoc output format (same as read_many) | Task 6 |
| details.files ordered: success by RRF, errors by input order | Task 6 |
| inclusion field: full/partial/omitted/not_top_k/error | Task 6 |
| selectedForPacking field | Task 6 |
| semanticRank/Score, keywordRank/Score, rrfScore | Task 6 |
| requestedTopK, effectiveTopK in details | Task 6 |
| packing.omittedPaths excludes non-top-K files | Task 6 |
| Both tools registered in index.ts | Task 7 |
| Shared utils extracted from read-many.ts | Task 1 |
