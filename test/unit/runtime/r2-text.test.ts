import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LSP_AFFORDANCE_DESCRIPTION,
  getLspToolDescription,
  getLspToolSchema,
} from "../../../src/lsp/lsp-tool.js";
import {
  getSmartReadToolGuidance,
  renderSmartReadToolGuide,
} from "../../../src/runtime/tool-guidance.js";

const R1_DESC = LSP_AFFORDANCE_DESCRIPTION;
const r1Guidance = getSmartReadToolGuidance("LSP", true)!;
const R1_GUIDE_TEXT = [r1Guidance.snippet, ...r1Guidance.guidelines].join("\n");
const R1_TOTAL = R1_DESC.length + R1_GUIDE_TEXT.length;

function r2Description(): string {
  return getLspToolDescription(true, true);
}

function r2GuideText(): string {
  const guidance = getSmartReadToolGuidance("LSP", true, false, false, true)!;
  return [guidance.snippet, ...guidance.guidelines].join("\n");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("r2 purpose text (stage B)", () => {
  it("differs from the round-1 text", () => {
    expect(r2Description()).not.toBe(R1_DESC);
    expect(r2GuideText()).not.toBe(R1_GUIDE_TEXT);
  });

  it("states what each family answers and what its output contains", () => {
    const text = `${r2Description()}\n${r2GuideText()}`;
    for (const needle of [
      "grouped by file",
      "enclosing",
      "role",
      "scope",
      "100",
      "nextCursor",
      "callSitesOmitted",
      "type",
      "goToDefinition",
      "goToImplementation",
      "investigate",
      "symbol",
      "grep",
      "read",
      "comments",
      "config",
      "0-based",
      "positionEncoding",
      "unavailable",
      "applyProposal",
    ]) {
      expect(text, needle).toContain(needle);
    }
  });

  it("has no generic preference wording", () => {
    const text = `${r2Description()}\n${r2GuideText()}`;
    for (const banned of [/prefer\s+lsp/i, /always\s+use\s+lsp/i, /only\s+path\s+to/i]) {
      expect(text, String(banned)).not.toMatch(banned);
    }
  });

  it("fits the round-1 character budget", () => {
    expect(r2Description().length + r2GuideText().length).toBeLessThanOrEqual(R1_TOTAL);
  });

  it("documents scope for findReferences instead of investigate-only", () => {
    const schema = getLspToolSchema(true, true) as {
      properties: { scope: { description: string } };
    };
    expect(schema.properties.scope.description).not.toContain("investigate only");
    expect(schema.properties.scope.description).toMatch(/findReferences/);
    const r1schema = getLspToolSchema(true) as {
      properties: { scope: { description: string } };
    };
    expect(r1schema.properties.scope.description).toBe(
      "Canonical file or directory filter within the selected workspace; investigate only.",
    );
  });

  it("keeps the r2 guidance to a snippet and at most 4 bullets", () => {
    const guidance = getSmartReadToolGuidance("LSP", true, false, false, true)!;
    expect(guidance.snippet.trim().length).toBeGreaterThan(0);
    expect(guidance.guidelines.length).toBeGreaterThanOrEqual(1);
    expect(guidance.guidelines.length).toBeLessThanOrEqual(4);
  });

  it("snapshots the r2 description and guidance", () => {
    expect(r2Description()).toMatchSnapshot();
    expect(r2GuideText()).toMatchSnapshot();
  });
});

describe("tool-guide rendering across variants", () => {
  it("keeps default rendering byte-identical for baseline and round-1 arms", () => {
    const task = "find usages of X";
    expect(renderSmartReadToolGuide(task)).toBe(
      renderSmartReadToolGuide(task, false, false, false, false),
    );
    expect(renderSmartReadToolGuide(task, true, false, false, false)).toContain(
      "declaration-name anchors",
    );
  });

  it("renders the r2 LSP section under r2 without touching other tools", () => {
    const guide = renderSmartReadToolGuide(undefined, false, false, false, true);
    expect(guide).toContain("grouped by file");
    expect(guide).toContain("grep discovers candidates");
  });

  it("renders the r2 text in MCP instructions under r2", async () => {
    vi.stubEnv("PI_SMARTREAD_AFFORDANCES", "2");
    vi.resetModules();
    const instructions = await import("../../../src/mcp/mcp-instructions.js");
    expect(instructions.SMARTREAD_MCP_INSTRUCTIONS).toContain("grouped by file");
    expect(instructions.SMARTREAD_MCP_INSTRUCTIONS).toContain("callSitesOmitted");
  });
});
