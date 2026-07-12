import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installInspectAndResolver, getSharedEvidenceResolver } from "../../mcp-registry.js";
import { computePathEvidence } from "../../path-evidence.js";

function makeFakeBus() {
  const handlers = new Map<string, Array<(d: unknown) => void>>();
  return {
    emit(channel: string, data: unknown) {
      for (const h of handlers.get(channel) ?? []) h(data);
    },
    on(channel: string, handler: (d: unknown) => void) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
      return () => {
        const cur = handlers.get(channel) ?? [];
        handlers.set(channel, cur.filter((h) => h !== handler));
      };
    },
  };
}

describe("read tool_result re-indexing", () => {
  it("re-indexes envelopes from pi.tool_result.read and stops after disposal", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "read-reindex-")));
    const session = path.join(dir, "session.jsonl");
    writeFileSync(path.join(dir, "x.ts"), "a\nb\n");
    const bus = makeFakeBus();
    const dispose = await installInspectAndResolver(bus);
    const { workspaceEvidence } = computePathEvidence({ path: "x.ts", cwd: dir, sessionFilePath: session });

    bus.emit("pi.tool_result.read", {
      details: { workspaceEvidence },
      sessionFilePath: session,
      workspaceRoot: workspaceEvidence.canonicalWorkspaceRoot,
    });
    expect(getSharedEvidenceResolver().getEnvelope(workspaceEvidence.inspectionId)).not.toBeNull();

    dispose(); // clears the resolver cache and unsubscribes both channels
    bus.emit("pi.tool_result.read", {
      details: { workspaceEvidence },
      sessionFilePath: session,
      workspaceRoot: workspaceEvidence.canonicalWorkspaceRoot,
    });
    expect(getSharedEvidenceResolver().getEnvelope(workspaceEvidence.inspectionId)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
