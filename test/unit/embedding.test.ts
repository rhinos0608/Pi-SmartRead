import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchEmbeddings, fetchEmbeddingsSharded, SHARD_SIZE } from "../../src/embedding.js";

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
    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/embeddings`);
    expect(opts?.method).toBe("POST");
    const body = JSON.parse(opts?.body as string);
    expect(body.model).toBe(MODEL);
    expect(body.input).toEqual(["query", "file body"]);
  });

  it("formats typed EmbeddingGemma inputs before POSTing", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeOkResponse([[0.1], [0.2]]));

    await fetchEmbeddings({
      baseUrl: BASE_URL,
      model: "text-embedding-embeddinggemma-300m",
      inputs: ["find auth", "export const auth = true;"],
      inputTypes: ["query", "document"],
      inputTitles: [undefined, "src/auth.ts"],
    });

    const [, opts] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse(opts?.body as string);
    expect(body.input).toEqual([
      "task: code retrieval | query: find auth",
      "title: src/auth.ts | text: export const auth = true;",
    ]);
  });

  it("preserves EmbeddingGemma roles and titles across shards", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      const body = JSON.parse(options?.body as string) as { input: string[] };
      return makeOkResponse(body.input.map(() => [0.1]));
    });
    const inputs = Array.from({ length: SHARD_SIZE + 1 }, (_, index) => `input ${index}`);

    await fetchEmbeddingsSharded({
      baseUrl: BASE_URL,
      model: "google/embeddinggemma-300m",
      inputs,
      inputTypes: ["query", ...inputs.slice(1).map(() => "document" as const)],
      inputTitles: [undefined, ...inputs.slice(1).map((_, index) => `src/file-${index + 1}.ts`)],
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
    const secondBody = JSON.parse(vi.mocked(fetch).mock.calls[1]![1]?.body as string);
    expect(firstBody.input[0]).toBe("task: code retrieval | query: input 0");
    expect(firstBody.input.at(-1)).toBe("title: src/file-39.ts | text: input 39");
    expect(secondBody.input).toEqual(["title: src/file-40.ts | text: input 40"]);
  });

  it("normalizes trailing slash in baseUrl", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeOkResponse([[0.1], [0.2]]));
    await fetchEmbeddings({ baseUrl: `${BASE_URL}/`, model: MODEL, inputs: ["a", "b"] });
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/embeddings`);
  });

  it("includes Authorization header when apiKey is provided", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeOkResponse([[0.1], [0.2]]));
    await fetchEmbeddings({ baseUrl: BASE_URL, model: MODEL, inputs: ["a", "b"], apiKey: "sk-test" });
    const [, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect((opts?.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
  });

  it("omits Authorization header when apiKey is absent", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeOkResponse([[0.1], [0.2]]));
    await fetchEmbeddings({ baseUrl: BASE_URL, model: MODEL, inputs: ["a", "b"] });
    const [, opts] = vi.mocked(fetch).mock.calls[0]!;
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
