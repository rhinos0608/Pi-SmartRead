import { describe, it, expect } from "vitest";
import {
  SMARTREAD_TOOL_GUIDE_TITLE,
  SMARTREAD_TOOL_GUIDANCE,
  SMARTREAD_GUIDED_TOOLS,
  getSmartReadToolGuidance,
  renderSmartReadToolGuide,
} from "../../../src/runtime/tool-guidance.js";

describe("per-tool guidance data", () => {
  it("covers read, grep, find, inspect, LSP, and skill", () => {
    expect([...SMARTREAD_GUIDED_TOOLS].sort()).toEqual(
      ["LSP", "find", "grep", "inspect", "read", "skill"].sort(),
    );
    for (const name of SMARTREAD_GUIDED_TOOLS) {
      expect(getSmartReadToolGuidance(name)).toBe(SMARTREAD_TOOL_GUIDANCE[name]);
    }
  });

  it("gives every tool a non-empty snippet and 1-4 guideline bullets", () => {
    for (const name of SMARTREAD_GUIDED_TOOLS) {
      const guidance = getSmartReadToolGuidance(name);
      expect(guidance, name).toBeDefined();
      expect(guidance!.snippet.trim().length, `${name} snippet`).toBeGreaterThan(0);
      expect(guidance!.guidelines.length, `${name} guidelines`).toBeGreaterThanOrEqual(1);
      expect(guidance!.guidelines.length, `${name} guidelines`).toBeLessThanOrEqual(4);
      for (const bullet of guidance!.guidelines) {
        expect(bullet.trim().length, `${name} bullet`).toBeGreaterThan(0);
      }
    }
  });

  it("returns undefined for tools without guidance (e.g. experimental ones)", () => {
    expect(getSmartReadToolGuidance("graph_mutate")).toBeUndefined();
    expect(getSmartReadToolGuidance("git_notes_read")).toBeUndefined();
  });
});

describe("renderSmartReadToolGuide", () => {
  it("keeps the title and key routing sentences", () => {
    expect(SMARTREAD_TOOL_GUIDE_TITLE).toBe("SmartRead Tool Guide");
    const guide = renderSmartReadToolGuide();
    expect(guide).toContain("grep discovers candidates");
    expect(guide).toContain("read has no natural-language query mode");
    expect(guide).toContain("Inspect does not expose LSP navigation or diagnostics");
    expect(guide).toContain("LSP { operation, ... }");
    expect(guide).toContain("strong evidence");
    expect(guide).toContain("0-based");
    expect(guide).toContain("applyProposal");
    expect(guide).toContain("script");
  });

  it("is generated from the same per-tool data", () => {
    const guide = renderSmartReadToolGuide();
    for (const name of SMARTREAD_GUIDED_TOOLS) {
      const guidance = getSmartReadToolGuidance(name)!;
      expect(guide).toContain(guidance.snippet);
      for (const bullet of guidance.guidelines) {
        expect(guide).toContain(bullet);
      }
    }
  });

  it("prefixes the task line when a task is provided", () => {
    expect(renderSmartReadToolGuide("find usages of X")).toMatch(/^Task: find usages of X\n/);
  });

  it("omits the task line when no task is given", () => {
    expect(renderSmartReadToolGuide()).not.toMatch(/^Task:/);
  });
});

describe("registration passes promptGuidelines to pi.registerTool", () => {
  function makeCapturingPi() {
    const registered: Array<Record<string, unknown>> = [];
    const pi = {
      registerTool: (def: Record<string, unknown>) => {
        registered.push(def);
      },
    };
    return { pi, registered };
  }

  it("registerReadTool forwards read snippet + guidelines", async () => {
    const { registerReadTool } = await import("../../../src/extension-registration.js");
    const { pi, registered } = makeCapturingPi();
    registerReadTool(pi as any, { editMode: "text" } as any);
    const read = registered.find((d) => d.name === "read");
    expect(read).toBeDefined();
    const expected = getSmartReadToolGuidance("read")!;
    expect(read!.promptSnippet).toBe(expected.snippet);
    expect(read!.promptGuidelines).toEqual([...expected.guidelines]);
  });

  it("registerFindTool forwards find snippet + guidelines", async () => {
    const { registerFindTool } = await import("../../../src/extension-registration.js");
    const { pi, registered } = makeCapturingPi();
    registerFindTool(pi as any);
    const find = registered.find((d) => d.name === "find");
    expect(find).toBeDefined();
    const expected = getSmartReadToolGuidance("find")!;
    expect(find!.promptSnippet).toBe(expected.snippet);
    expect(find!.promptGuidelines).toEqual([...expected.guidelines]);
  });

  it("registerCoreTools attaches guidance to every guided registry tool", async () => {
    const { registerCoreTools } = await import("../../../src/extension-registration.js");
    const { pi, registered } = makeCapturingPi();
    registerCoreTools(pi as any);
    for (const name of SMARTREAD_GUIDED_TOOLS) {
      if (name === "read" || name === "find") continue; // registered via dedicated paths above
      const def = registered.find((d) => d.name === name);
      expect(def, `registry tool ${name}`).toBeDefined();
      const expected = getSmartReadToolGuidance(name)!;
      expect(def!.promptSnippet, `${name} snippet`).toBe(expected.snippet);
      expect(def!.promptGuidelines, `${name} guidelines`).toEqual([...expected.guidelines]);
    }
  });
});
