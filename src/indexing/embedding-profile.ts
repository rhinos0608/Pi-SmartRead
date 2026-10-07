export type EmbeddingInputType = "query" | "document";

export interface EmbeddingInputProfile {
  model: string;
  inputs: readonly string[];
  inputTypes?: readonly EmbeddingInputType[];
  inputTitles?: readonly (string | undefined)[];
}

const EMBEDDING_GEMMA_MODEL_TOKEN = "embeddinggemma-300m";
const DEFAULT_PROFILE_ID = "default-v1";
const EMBEDDING_GEMMA_PROFILE_ID = "embeddinggemma-code-retrieval-v1";

/** Detect official EmbeddingGemma IDs and server aliases containing its model token. */
export function isEmbeddingGemmaModel(model: string): boolean {
  return model.toLowerCase().includes(EMBEDDING_GEMMA_MODEL_TOKEN);
}

/** Stable behavior ID for persistent embedding cache and index invalidation. */
export function embeddingProfileId(model: string): string {
  return isEmbeddingGemmaModel(model) ? EMBEDDING_GEMMA_PROFILE_ID : DEFAULT_PROFILE_ID;
}

function validateMetadataLengths(profile: EmbeddingInputProfile): void {
  if (profile.inputTypes && profile.inputTypes.length !== profile.inputs.length) {
    throw new Error(
      `inputTypes length (${profile.inputTypes.length}) must match inputs length (${profile.inputs.length})`,
    );
  }
  if (profile.inputTitles && profile.inputTitles.length !== profile.inputs.length) {
    throw new Error(
      `inputTitles length (${profile.inputTitles.length}) must match inputs length (${profile.inputs.length})`,
    );
  }
}

function normalizeTitle(title: string | undefined): string {
  const normalized = title?.trim().replace(/[|\s]+/g, " ");
  return normalized || "none";
}

/** Apply model-specific prompts while preserving input order. */
export function formatEmbeddingInputs(profile: EmbeddingInputProfile): string[] {
  validateMetadataLengths(profile);
  if (!isEmbeddingGemmaModel(profile.model) || !profile.inputTypes) {
    return [...profile.inputs];
  }

  return profile.inputs.map((input, index) => {
    if (profile.inputTypes![index] === "query") {
      return `task: code retrieval | query: ${input}`;
    }
    return `title: ${normalizeTitle(profile.inputTitles?.[index])} | text: ${input}`;
  });
}
