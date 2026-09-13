import { readFileSync } from "node:fs";

export interface NearCloneSignature {
  file: string;
  shingles: Set<string>;
  signature: number[];
}

export interface NearClonePair {
  a: string;
  b: string;
  jaccard: number;
}

export interface NearCloneOptions {
  shingleSize?: number;
  numHashes?: number;
  bands?: number;
  threshold?: number;
  maxPairs?: number;
}

const DEFAULT_NUM_HASHES = 64;
const HASH_PRIME = 4_294_967_291;

function hash32(text: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function normalizeCodeForCloneDetection(code: string): string[] {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, " STR ")
    .replace(/\b\d+(?:\.\d+)?\b/g, " NUM ")
    .replace(/\b[A-Za-z_$][\w$]*\b/g, (token) => {
      const keywords = new Set(["STR", "NUM", "if", "else", "for", "while", "return", "function", "class", "const", "let", "var", "import", "export", "from", "async", "await", "try", "catch", "throw", "new"]);
      return keywords.has(token) ? token : "ID";
    })
    .match(/[A-Za-z_$]+|\d+|[^\s]/g) ?? [];
}

export function shingles(tokens: string[], size = 3): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i <= tokens.length - size; i++) {
    result.add(tokens.slice(i, i + size).join(" "));
  }
  return result;
}

export function minHashSignature(values: Set<string>, numHashes = DEFAULT_NUM_HASHES): number[] {
  const signature = Array.from({ length: numHashes }, () => Number.MAX_SAFE_INTEGER);
  for (const value of values) {
    const base1 = hash32(value, 0x9e3779b1);
    const base2 = hash32(value, 0x85ebca6b) || 1;
    for (let i = 0; i < numHashes; i++) {
      const h = (base1 + i * base2) % HASH_PRIME;
      if (h < signature[i]!) signature[i] = h;
    }
  }
  return signature.map((v) => v === Number.MAX_SAFE_INTEGER ? 0 : v);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function signatureForFile(file: string, options: NearCloneOptions = {}): NearCloneSignature | null {
  try {
    const code = readFileSync(file, "utf-8");
    const sh = shingles(normalizeCodeForCloneDetection(code), options.shingleSize ?? 3);
    if (sh.size === 0) return null;
    return { file, shingles: sh, signature: minHashSignature(sh, options.numHashes ?? DEFAULT_NUM_HASHES) };
  } catch {
    return null;
  }
}

export function findNearClones(files: string[], options: NearCloneOptions = {}): NearClonePair[] {
  const numHashes = options.numHashes ?? DEFAULT_NUM_HASHES;
  const bands = options.bands ?? 32;
  const rows = Math.max(1, Math.floor(numHashes / bands));
  const threshold = options.threshold ?? 0.85;
  const maxPairs = options.maxPairs ?? 100;
  const signatures = files.map((file) => signatureForFile(file, { ...options, numHashes })).filter((s): s is NearCloneSignature => s !== null);
  const byFile = new Map(signatures.map((s) => [s.file, s]));
  const candidates = new Set<string>();

  for (let band = 0; band < bands; band++) {
    const buckets = new Map<string, string[]>();
    const start = band * rows;
    const end = Math.min(start + rows, numHashes);
    if (start >= end) break;
    for (const sig of signatures) {
      const key = `${band}:${sig.signature.slice(start, end).join(",")}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(sig.file);
      buckets.set(key, bucket);
    }
    for (const bucket of buckets.values()) {
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          const pair = [bucket[i]!, bucket[j]!].sort().join("\0");
          candidates.add(pair);
        }
      }
    }
  }

  const pairs: NearClonePair[] = [];
  for (const candidate of candidates) {
    const [a, b] = candidate.split("\0");
    const sa = byFile.get(a!);
    const sb = byFile.get(b!);
    if (!sa || !sb) continue;
    const score = jaccard(sa.shingles, sb.shingles);
    if (score >= threshold) pairs.push({ a: a!, b: b!, jaccard: score });
  }
  return pairs.sort((a, b) => b.jaccard - a.jaccard).slice(0, maxPairs);
}
