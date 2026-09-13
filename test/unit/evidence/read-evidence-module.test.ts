import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateInspectionEnvelope } from "@rhinos0608/pi-workspace-protocol";
import {
  shownMatchesAttested,
  sessionFileFromCtx,
  resolveAttestedRange,
  attestPathRead,
  attestStructuralOutline,
  publishEvidence,
} from "../../../src/evidence/read-evidence.js";

function makeCtx(cwd: string, sessionFile: string | null) {
  return {
    cwd,
    sessionManager: sessionFile ? { getSessionFile: () => sessionFile } : undefined,
  } as any;
}

describe("read-evidence module: shownMatchesAttested", () => {
  it("exact match passes", () => {
    expect(
      shownMatchesAttested({
        builtinText: "hello",
        truncationContent: undefined,
        sliceText: "hello",
        totalLines: 5,
        evidenceOffset: undefined,
        evidenceLimit: undefined,
      }),
    ).toBe(true);
  });

  it("adversarial suffix without limit fails closed", () => {
    expect(
      shownMatchesAttested({
        builtinText: "safe\n\n[old content removed]",
        truncationContent: undefined,
        sliceText: "safe",
        totalLines: 3,
        evidenceOffset: undefined,
        evidenceLimit: undefined,
      }),
    ).toBe(false);
  });

  it("reconstructed continuation note passes only on exact numbers", () => {
    const sliceText = "line1\nline2";
    const note = "\n\n[5 more lines in file. Use offset=3 to continue.]";
    expect(
      shownMatchesAttested({
        builtinText: sliceText + note,
        truncationContent: undefined,
        sliceText,
        totalLines: 7,
        evidenceOffset: 1,
        evidenceLimit: 2,
      }),
    ).toBe(true);
    expect(
      shownMatchesAttested({
        builtinText: sliceText + "\n\n[99 more lines in file. Use offset=100 to continue.]",
        truncationContent: undefined,
        sliceText,
        totalLines: 7,
        evidenceOffset: 1,
        evidenceLimit: 2,
      }),
    ).toBe(false);
  });

  it("truncation content compares directly", () => {
    expect(
      shownMatchesAttested({
        builtinText: "unused",
        truncationContent: "line1\nline2",
        sliceText: "line1\nline2",
        totalLines: 3000,
        evidenceOffset: undefined,
        evidenceLimit: undefined,
      }),
    ).toBe(true);
    expect(
      shownMatchesAttested({
        builtinText: "unused",
        truncationContent: "line1\nline2",
        sliceText: "different",
        totalLines: 3000,
        evidenceOffset: undefined,
        evidenceLimit: undefined,
      }),
    ).toBe(false);
  });
});

describe("read-evidence module: session extract", () => {
  it("returns session file path and null when absent", () => {
    expect(sessionFileFromCtx(makeCtx("/tmp", "/tmp/s.jsonl"))).toBe("/tmp/s.jsonl");
    expect(sessionFileFromCtx(makeCtx("/tmp", null))).toBeNull();
    expect(sessionFileFromCtx({} as any)).toBeNull();
  });
});

describe("read-evidence module: range resolution", () => {
  it("rejects zero shown lines", () => {
    expect(
      resolveAttestedRange({
        normalizedOffset: 1,
        normalizedLimit: 2,
        displayStartLine: 1,
        truncation: { truncated: false, firstLineExceedsLimit: true } as any,
      }),
    ).toEqual({ zeroLines: true });
  });

  it("clamps truncated output to shown lines", () => {
    expect(
      resolveAttestedRange({
        normalizedOffset: undefined,
        normalizedLimit: undefined,
        displayStartLine: 1,
        truncation: { truncated: true, outputLines: 2000 } as any,
      }),
    ).toEqual({ evidenceOffset: 1, evidenceLimit: 2000 });
  });

  it("passes through explicit offset/limit untouched", () => {
    expect(
      resolveAttestedRange({
        normalizedOffset: 2,
        normalizedLimit: 2,
        displayStartLine: 2,
        truncation: undefined,
      }),
    ).toEqual({ evidenceOffset: 2, evidenceLimit: 2 });
  });
});

describe("read-evidence module: path attestation", () => {
  it("attests full-file read with valid envelope, fails closed on mismatch, never throws", () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "re-mod-")));
    try {
      writeFileSync(path.join(dir, "x.ts"), "line1\nline2\nline3\nline4\n");
      const session = path.join(dir, "session.jsonl");
      const fullPath = path.join(dir, "x.ts");
      const ok = attestPathRead({
        fullPath,
        cwd: dir,
        sessionFilePath: session,
        builtinText: "line1\nline2\nline3\nline4\n",
        truncation: undefined,
        evidenceOffset: undefined,
        evidenceLimit: undefined,
        displayStartLine: 1,
      });
      expect(ok).not.toBeNull();
      expect(validateInspectionEnvelope(ok!.workspaceEvidence).ok).toBe(true);
      expect(ok!.workspaceEvidence.resources[0]!.coverage).toBe("full-file");

      const mismatch = attestPathRead({
        fullPath,
        cwd: dir,
        sessionFilePath: session,
        builtinText: "tampered content",
        truncation: undefined,
        evidenceOffset: undefined,
        evidenceLimit: undefined,
        displayStartLine: 1,
      });
      expect(mismatch).toBeNull();

      const zero = attestPathRead({
        fullPath,
        cwd: dir,
        sessionFilePath: session,
        builtinText: "",
        truncation: { firstLineExceedsLimit: true } as any,
        evidenceOffset: undefined,
        evidenceLimit: undefined,
        displayStartLine: 1,
      });
      expect(zero).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows out-of-workspace target with valid evidence (no cross-root gate)", () => {
    const ws = realpathSync(mkdtempSync(path.join(tmpdir(), "re-ws-")));
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "re-out-")));
    try {
      writeFileSync(path.join(outside, "o.ts"), "a\nb\n");
      const session = path.join(ws, "session.jsonl");
      const res = attestPathRead({
        fullPath: path.join(outside, "o.ts"),
        cwd: ws,
        sessionFilePath: session,
        builtinText: "a\nb\n",
        truncation: undefined,
        evidenceOffset: undefined,
        evidenceLimit: undefined,
        displayStartLine: 1,
      });
      expect(res).not.toBeNull();
      expect(validateInspectionEnvelope(res!.workspaceEvidence).ok).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("read-evidence module: structural outline + publish", () => {
  it("authorizes only declaration lines, rejects empty set without throwing", () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "re-so-")));
    try {
      const content = "export function f() {}\nconst x = 1;\n";
      writeFileSync(path.join(dir, "x.ts"), content);
      const session = path.join(dir, "session.jsonl");
      const res = attestStructuralOutline({
        path: "x.ts",
        cwd: dir,
        sessionFilePath: session,
        fullContent: content,
        declarationLines: [1],
      });
      expect(res).not.toBeNull();
      expect(res!.workspaceEvidence.resources).toHaveLength(1);
      expect(res!.workspaceEvidence.resources[0]!.coverage).toBe("line-range");
      expect(attestStructuralOutline({ path: "x.ts", cwd: dir, sessionFilePath: session, fullContent: content, declarationLines: [] })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishEvidence never throws", () => {
    const publish = vi.fn(() => {
      throw new Error("boom");
    });
    expect(() => publishEvidence(publish, { a: 1 }, "/s", "/r")).not.toThrow();
    expect(publish).toHaveBeenCalledOnce();
    const ok = vi.fn();
    publishEvidence(ok, { a: 1 }, "/s", "/r");
    expect(ok).toHaveBeenCalledWith({ a: 1 }, "/s", "/r");
    expect(() => publishEvidence(undefined, { a: 1 }, "/s", "/r")).not.toThrow();
  });
});
