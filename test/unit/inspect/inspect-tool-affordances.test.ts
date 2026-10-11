import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInspectV4Tool } from "../../../src/inspect/inspect-tool.js";
import { captureAffordanceSelectors, selectSurfaceVariants } from "../../../src/runtime/affordances.js";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inspect-tool-affordance-"));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const context = (cwd: string) => ({ cwd } as never);
const tool = (enabled = true) => createInspectV4Tool({ getSessionFilePath: () => "/sessions/inspect-affordance.jsonl", affordances: enabled });

describe("inspect affordance integration", () => {
  it("selects exactly one inspect variant across the selector composition matrix", () => {
    const variants = [
      selectSurfaceVariants(captureAffordanceSelectors({})),
      selectSurfaceVariants(captureAffordanceSelectors({ PI_SMARTREAD_AFFORDANCES: "1" })),
      selectSurfaceVariants(captureAffordanceSelectors({ PI_SMARTREAD_INSPECT_AFFORDANCES: "1" })),
      selectSurfaceVariants(captureAffordanceSelectors({ PI_SMARTREAD_AFFORDANCES: "1", PI_SMARTREAD_INSPECT_AFFORDANCES: "1" })),
    ];
    expect(variants.map((variant) => variant.inspect)).toEqual(["baseline", "baseline", "inspect-bundle", "inspect-bundle"]);
    expect(variants[1]?.note).toBe("wp-c-unbuilt");
    expect(captureAffordanceSelectors({ PI_SMARTREAD_INSPECT_AFFORDANCES: "invalid" }).inspect).toEqual({ enabled: false, invalid: "invalid" });
  });

  it("keeps baseline schema and description identical when inspect affordances are off", () => {
    const baseline = createInspectV4Tool({ getSessionFilePath: () => null });
    const explicitOff = createInspectV4Tool({ getSessionFilePath: () => null, affordances: false });
    const generalOnly = createInspectV4Tool({ getSessionFilePath: () => null, affordances: false });
    expect(explicitOff.parameters).toEqual(baseline.parameters);
    expect(explicitOff.description).toBe(baseline.description);
    expect(generalOnly.parameters).toEqual(baseline.parameters);
  });

  it("preserves the baseline foreign-field validation error when the selector is off", async () => {
    const root = await fixture();
    const file = join(root, "legacy.ts");
    await writeFile(file, "export {};\n");
    await expect(tool(false).execute("legacy", { mode: "file", path: file, view: "routes" } as never, undefined, undefined, context(root)))
      .rejects.toThrow('Error: inspect param "view" cannot be combined with mode "file"');
  });

  it("dispatches view and gather requests through the constructed tool without strong evidence", async () => {
    const root = await fixture();
    const file = join(root, "routes.ts");
    await writeFile(file, "app.get('/ready', readyHandler);\n");
    const viewResult = await tool().execute("view", { mode: "file", path: file, view: "routes" } as never, undefined, undefined, context(root)) as any;
    expect(viewResult.content[0].text).toContain("/ready");
    expect(viewResult.details.upstreamDetails.inspectTask.view).toBe("routes");
    expect(viewResult.details.workspaceEvidence.resources).toEqual([]);

    const gatherResult = await tool().execute("gather", { mode: "file", path: file, view: "routes", gather: true } as never, undefined, undefined, context(root)) as any;
    expect(gatherResult.details.upstreamDetails.gather.recipe).toBe("routes");
    expect(gatherResult.details.workspaceEvidence.resources).toEqual([]);
  });

  it("rejects invalid view combinations before dispatch", async () => {
    const root = await fixture();
    const file = join(root, "one.ts");
    await writeFile(file, "export {};\n");
    await expect(tool().execute("bad", { mode: "file", path: file, view: "routes", analysis: {} } as never, undefined, undefined, context(root))).rejects.toThrow(/combined with analysis/);
    await expect(tool().execute("bad", { mode: "script", script: "return 1", view: "routes" } as never, undefined, undefined, context(root))).rejects.toThrow(/script mode/);
    await expect(tool().execute("bad", { mode: "directory", path: root, view: "dependencies" } as never, undefined, undefined, context(root))).rejects.toThrow(/requires file mode/);
    await expect(tool().execute("bad", { mode: "file", path: file, view: "change-review" } as never, undefined, undefined, context(root))).rejects.toThrow(/requires diff/);
    await expect(tool().execute("bad", { mode: "directory", path: file, view: "overview" } as never, undefined, undefined, context(root))).rejects.toThrow(/directory target/);
  });
});
