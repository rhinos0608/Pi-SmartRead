/**
 * Tests for layer-analysis — architectural layer derivation.
 */
import { describe, it, expect } from "vitest";
import { deriveLayers, extractPackageSpecifiers } from "../../src/layer-analysis.js";

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
    expect(result.layers.get("controller")).toContain("src/controllers/UserController.ts");
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

  it("classifies controller by rawImportsByFile package specifiers", () => {
    // Use a path that does NOT match any controller filePattern (no handler/route/api segments)
    const files = ["src/modules/user.ts"];
    // Without imports, should be unclassified
    const resultNoImports = deriveLayers([], files);
    expect(resultNoImports.layers.has("controller")).toBe(false);
    expect(resultNoImports.unclassified).toContain("src/modules/user.ts");

    // With express import hint, classifyFile should pick up controller
    const rawImports = new Map([["src/modules/user.ts", new Set(["express"])]]);
    const result = deriveLayers([], files, rawImports);
    expect(result.layers.has("controller")).toBe(true);
    expect(result.layers.get("controller")).toContain("src/modules/user.ts");
  });

  it("backwards-compatible: works without rawImportsByFile param", () => {
    const files = ["src/api/UserController.ts"];
    const result = deriveLayers([], files);
    expect(result.layers.has("controller")).toBe(true);
    expect(result.layers.get("controller")).toContain("src/api/UserController.ts");
  });

  it("classifies controller via extractPackageSpecifiers from source text", () => {
    // Simulate the executeDirectoryInspect({ layers: true }) runtime path:
    // source text → extractPackageSpecifiers → rawImportsByFile → deriveLayers
    const sourceText = `
import { Router } from "express";
import { AuthService } from "./auth/service";
const app = Router();
`;
    const packages = extractPackageSpecifiers(sourceText);
    const files = ["src/modules/user.ts"];
    const rawImports = new Map([["src/modules/user.ts", packages]]);
    const result = deriveLayers([], files, rawImports);
    // "express" import hint should classify as controller
    expect(result.layers.has("controller")).toBe(true);
    expect(result.layers.get("controller")).toContain("src/modules/user.ts");
  });

  it("classifies controller via extractPackageSpecifiers with Python-style imports", () => {
    // Python from-import should not match controller import hints (no express/fastify etc.)
    const sourceText = `
from flask import Flask
import os
`;
    const packages = extractPackageSpecifiers(sourceText);
    const files = ["src/modules/user.py"];
    const rawImports = new Map([["src/modules/user.py", packages]]);
    const result = deriveLayers([], files, rawImports);
    // flask is not in controller importHints, so should remain unclassified
    expect(result.layers.has("controller")).toBe(false);
    expect(result.unclassified).toContain("src/modules/user.py");
  });
});
