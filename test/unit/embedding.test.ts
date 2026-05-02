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
    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/embeddings`);
    expect(opts?.method).toBe("POST");
    const body = JSON.parse(opts?.body as string);
    expect(body.model).toBe(MODEL);
    expect(body.input).toEqual(["query", "file body"]);
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
