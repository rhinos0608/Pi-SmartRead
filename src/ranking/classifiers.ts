export type RelevanceClass = "exact" | "strong" | "related" | "weak" | "none";
export type ConfidenceClass = "verified" | "high" | "medium" | "low";

export function classifyRelevance(value: number | undefined): RelevanceClass {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "none";
  if (value >= 0.85) return "exact";
  if (value >= 0.6) return "strong";
  if (value >= 0.25) return "related";
  return "weak";
}

export function classifyRelevanceByScore(score: number | undefined, maxScore: number | undefined): RelevanceClass {
  if (score === undefined || maxScore === undefined || !Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) {
    return "none";
  }
  return classifyRelevance(score / maxScore);
}

export function classifySimilarity(similarity: number | undefined): RelevanceClass {
  if (similarity === undefined || !Number.isFinite(similarity)) return "none";
  // Cosine similarity may be negative; clamp to the classifier's 0..1 range.
  return classifyRelevance(Math.max(0, Math.min(1, similarity)));
}

export function classifyConfidence(confidence: number | undefined): ConfidenceClass {
  if (confidence === undefined || !Number.isFinite(confidence) || confidence <= 0) return "low";
  if (confidence >= 0.95) return "verified";
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.45) return "medium";
  return "low";
}

export function relevanceClassWeight(relevance: RelevanceClass | undefined): number {
  switch (relevance) {
    case "exact":
      return 1;
    case "strong":
      return 0.7;
    case "related":
      return 0.35;
    case "weak":
      return 0.1;
    case "none":
    default:
      return 0;
  }
}
