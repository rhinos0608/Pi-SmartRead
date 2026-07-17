/**
 * Tests for layer-analysis — architectural layer derivation.
 */
import { describe, it, expect } from "vitest";
import { deriveLayers } from "../../src/layer-analysis.js";

describe("deriveLayers", () => {
  it("classifies controller files by name pattern", () => {
    const files = [
      "src/routes.ts",
      "src/handler.ts",
      "src/controllers/UserController.ts",
    ];
    const result = deriveLayers([], files);
    expect(result.layers.has("controller")).toBe(true);
    expect(result.layers.get("controller")).toContain("src/routes.ts");
    expect(result.layers.get("controller")).toContain("src/handler.ts");
  });

  it("classifies service files by name pattern", () => {
    const files = [
      "src/services/AuthService.ts",
      "src/biz/UserService.ts",
    ];
    const result = deriveLayers([], files);
    expect(result.layers.has("service")).toBe(true);
    expect(result.layers.get("service")).toHaveLength(2);
  });

  it("classifies repository files", () => {
    const files = [
      "src/db/UserRepo.ts",
      "src/repositories/SessionRepository.ts",
      "src/data/CacheGateway.ts",
    ];
    const result = deriveLayers([], files);
    expect(result.layers.has("repository")).toBe(true);
    expect(result.layers.get("repository")).toHaveLength(3);
  });

  it("classifies model files", () => {
    const files = [
      "src/types/User.ts",
      "src/models/Session.ts",
      "src/schemas/auth.ts",
    ];
    const result = deriveLayers([], files);
    expect(result.layers.has("model")).toBe(true);
    expect(result.layers.get("model")).toHaveLength(3);
  });

  it("classifies utility files", () => {
    const files = [
      "src/utils/format.ts",
      "src/helpers/validate.ts",
      "src/lib/crypto.ts",
    ];
    const result = deriveLayers([], files);
    expect(result.layers.has("utility")).toBe(true);
    expect(result.layers.get("utility")).toHaveLength(3);
  });

  it("unclassifies files with no pattern match", () => {
    const files = ["src/random.ts", "src/xyz.ts"];
    const result = deriveLayers([], files);
    expect(result.unclassified).toHaveLength(2);
  });

  it("handles empty file list", () => {
    const result = deriveLayers([], []);
    expect(result.layers.size).toBe(0);
    expect(result.unclassified).toEqual([]);
  });

  it("classifies controller by route import hints", () => {
    const files = ["src/api/handlers.ts"];
    const edges = [{ from: "src/api/handlers.ts", to: "express" }];
    const result = deriveLayers(edges, files);
    expect(result.layers.has("controller")).toBe(true);
  });
});
