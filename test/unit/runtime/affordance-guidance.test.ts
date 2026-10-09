import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { getSmartReadToolGuidance, renderSmartReadToolGuide } from "../../../src/runtime/tool-guidance.js";

describe("affordance guidance", () => {
  it("documents anchor XOR, discovery-only pathless targets, investigation status, bounds, and examples", () => {
    const guidance = getSmartReadToolGuidance("LSP", true)!;
    const text = [guidance.snippet, ...guidance.guidelines].join("\n");
    expect(text).toContain("pathless");
    expect(text).toContain("ambiguous_anchor");
    expect(text).toContain("anchor_search_incomplete");
    expect(text).toContain("stale_anchor");
    expect(text).toContain("anchor_invalid_path");
    expect(text).toContain("callers");
    expect(renderSmartReadToolGuide(undefined, true)).toContain(text.split("\n")[0]);
  });

  it("replaces inspect guidance with the bounded task-view contract and hashes differently", () => {
    const baseline = getSmartReadToolGuidance("inspect")!;
    const bundle = getSmartReadToolGuidance("inspect", false, true)!;
    const baselineText = [baseline.snippet, ...baseline.guidelines].join("\n");
    const bundleText = [bundle.snippet, ...bundle.guidelines].join("\n");
    expect(bundleText).toContain("gather: true");
    expect(bundleText).toContain("discovery only");
    expect(bundleText).toContain("focused read");
    expect(bundleText).not.toContain("nextActions");
    expect(createHash("sha256").update(baselineText).digest("hex")).not.toBe(createHash("sha256").update(bundleText).digest("hex"));
    expect(renderSmartReadToolGuide(undefined, false, true)).toContain(bundle.snippet);
  });

  it("supports distinct guidance text hashes for baseline and bundle surfaces", () => {
    const baseline = [getSmartReadToolGuidance("LSP")!.snippet, ...getSmartReadToolGuidance("LSP")!.guidelines].join("\n");
    const bundle = [getSmartReadToolGuidance("LSP", true)!.snippet, ...getSmartReadToolGuidance("LSP", true)!.guidelines].join("\n");
    expect(createHash("sha256").update(baseline).digest("hex")).not.toBe(createHash("sha256").update(bundle).digest("hex"));
    expect(renderSmartReadToolGuide(undefined, true)).toContain("anchor_search_incomplete");
  });
});
