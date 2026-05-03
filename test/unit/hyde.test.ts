import { describe, expect, it } from "vitest";
import {
  generateHypotheticalDocument,
  applyHyde,
} from "../../hyde.js";

describe("HyDE query expansion", () => {
  describe("generateHypotheticalDocument", () => {
    it("generates function-style document for code queries", () => {
      const doc = generateHypotheticalDocument("authentication middleware handler");
      expect(doc).toContain("authentication");
      // Should look like code
      expect(doc).toContain("export function");
    });

    it("generates class-style document when class keyword present", () => {
      const doc = generateHypotheticalDocument("UserService class definition");
      expect(doc).toContain("class");
      expect(doc).toContain("export");
    });

    it("generates config-style document when config keyword present", () => {
      const doc = generateHypotheticalDocument("database connection config settings");
      expect(doc).toContain("Config");
      expect(doc).toContain("export");
    });

    it("generates module-style document when module keyword present", () => {
      const doc = generateHypotheticalDocument("authentication module import");
      expect(doc).toContain("Module");
      expect(doc).toContain("import");
    });

    it("returns raw query when no identifiers can be extracted", () => {
      const doc = generateHypotheticalDocument("the and or");
      // All stop words — should return the raw query
      expect(doc).toBe("the and or");
    });

    it("handles empty query", () => {
      const doc = generateHypotheticalDocument("");
      expect(doc).toBe("");
    });

    it("uses snake_case identifiers correctly", () => {
      const doc = generateHypotheticalDocument("handle_user_login function");
      expect(doc).toContain("handleUserLogin"); // camelCase conversion
    });
  });

  describe("applyHyde", () => {
    it("returns applied=false when disabled", () => {
      const result = applyHyde({ enabled: false, query: "test query" });
      expect(result.applied).toBe(false);
      expect(result.document).toBe("test query");
    });

    it("returns applied=true when enabled with meaningful query", () => {
      const result = applyHyde({ enabled: true, query: "authentication middleware handler" });
      expect(result.applied).toBe(true);
      expect(result.identifiers.length).toBeGreaterThan(0);
      expect(result.document).not.toBe("authentication middleware handler");
    });

    it("returns applied=false for empty query", () => {
      const result = applyHyde({ enabled: true, query: "" });
      expect(result.applied).toBe(false);
    });

    it("returns applied=false when only stop words", () => {
      const result = applyHyde({ enabled: true, query: "the and or for" });
      expect(result.applied).toBe(false);
    });

    it("detects query pattern correctly", () => {
      const fnResult = applyHyde({ enabled: true, query: "error handler function" });
      expect(fnResult.pattern).toBe("function");

      const classResult = applyHyde({ enabled: true, query: "user class definition" });
      expect(classResult.pattern).toBe("class");

      const configResult = applyHyde({ enabled: true, query: "database config" });
      expect(configResult.pattern).toBe("config");
    });

    it("preserves original query as fallback document", () => {
      const result = applyHyde({ enabled: true, query: "xy" }); // too short
      expect(result.applied).toBe(false);
      expect(result.document).toBe("xy");
    });
  });
});
