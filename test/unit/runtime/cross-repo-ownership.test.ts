import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isDiagnosticsClaimed } from "../../src/mutation-ownership.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Sibling checkout on the same machine — this repo and Pi-SmartEdit coordinate
// through a shared globalThis Symbol map (see src/mutation-ownership.ts) with
// no runtime import between them. Skips gracefully if the sibling isn't checked
// out (e.g. in an isolated CI checkout of this repo alone).
const smartEditModulePath = join(__dirname, "../../../Pi-SmartEdit/src/mutation-ownership.ts");

describe.skipIf(!existsSync(smartEditModulePath))("cross-repo diagnostics ownership compatibility", () => {
  it("SmartRead recognizes a claim written by SmartEdit's mutation-ownership store", async () => {
    const smartEdit = await import(/* @vite-ignore */ smartEditModulePath) as {
      claimDiagnosticsOwner: (id: string) => void;
      resetDiagnosticsOwnership: () => void;
    };
    smartEdit.resetDiagnosticsOwnership();
    smartEdit.claimDiagnosticsOwner("cross-repo-call-1");
    expect(isDiagnosticsClaimed("cross-repo-call-1")).toBe(true);
  });
});
