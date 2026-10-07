/**
 * Structural reranker for Pi-SmartRead.
 *
 * Compat entry point — implementation lives in:
 * - rerank-structural.ts (rerank + structural signals)
 * - rerank-external.ts (external API reranker + fallback)
 * - rerank-colbert.ts (ColBERT-style late-interaction reranker)
 *
 * Re-exported here so existing `from "./rerank.js"` imports keep working.
 */
import { cosineSimilarity } from "../scoring.js";

export { cosineSimilarity };

export {
  DEFAULT_OPTIONS,
  computeStructuralScore,
  normalize,
  rerank,
  type RerankerInput,
  type RerankerOptions,
  type RerankerResult,
} from "./rerank-structural.js";

export {
  externalRerank,
  rerankWithExternal,
  type ExternalRerankerRequest,
  type ExternalRerankerResponse,
} from "./rerank-external.js";

export {
  colbertRerank,
  computeMaxSim,
  meanPool,
  segmentText,
  type ColbertRerankerInput,
  type ColbertRerankerOptions,
  type ColbertRerankerResult,
} from "./rerank-colbert.js";
