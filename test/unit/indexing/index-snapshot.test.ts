import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeSourceHash, readSnapshot, snapshotPath, verifySnapshot, writeSnapshot } from "../../src/index-snapshot.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "smartread-snapshot-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("index snapshots", () => {
  it("round-trips gzip snapshot data with manifest", () => {
    const sourceHash = computeSourceHash([{ path: "b.ts", contentHash: "h1" }, { path: "a.ts", contentHash: "h2" }]);
    writeSnapshot(root, "graph", { nodes: ["a"] }, { fileCount: 2, tagCount: 1, sourceHash });

    const snapshot = readSnapshot<{ nodes: string[] }>(root, "graph");
    expect(snapshot?.data.nodes).toEqual(["a"]);
    expect(snapshot?.manifest.fileCount).toBe(2);
    expect(verifySnapshot(root, "graph", { fileCount: 2, sourceHash }).status).toBe("ok");
  });

  it("marks snapshots degraded when persisted file count is implausibly low", () => {
    writeSnapshot(root, "graph", { nodes: [] }, { fileCount: 1, sourceHash: computeSourceHash([{ path: "a.ts", contentHash: "x" }]) });
    const status = verifySnapshot(root, "graph", { fileCount: 10 });
    expect(status.status).toBe("degraded");
    expect(status.reason).toBe("file-count-ratio-below-threshold");
  });

  it("returns missing for absent snapshot", () => {
    expect(verifySnapshot(root, "graph").status).toBe("missing");
  });

  it("returns invalid on sourceHash mismatch", () => {
    writeSnapshot(root, "graph", { nodes: [] }, { fileCount: 1, sourceHash: computeSourceHash([{ path: "a.ts", contentHash: "x" }]) });
    expect(verifySnapshot(root, "graph", { sourceHash: computeSourceHash([{ path: "b.ts", contentHash: "x" }]) }).status).toBe("invalid");
  });

  it("returns null on schema version mismatch", () => {
    writeSnapshot(root, "graph", { nodes: [] }, { fileCount: 1, sourceHash: computeSourceHash([{ path: "a.ts", contentHash: "x" }]) });
    const path = snapshotPath(root, "graph");
    const raw = JSON.parse(require("node:zlib").gunzipSync(require("node:fs").readFileSync(path)).toString("utf-8"));
    raw.manifest.schemaVersion = 999;
    require("node:fs").writeFileSync(path, require("node:zlib").gzipSync(Buffer.from(JSON.stringify(raw))));
    expect(readSnapshot(root, "graph")).toBeNull();
  });

  it("returns null on root mismatch", () => {
    writeSnapshot(root, "graph", { nodes: [] }, { fileCount: 1, sourceHash: computeSourceHash([{ path: "a.ts", contentHash: "x" }]) });
    const path = snapshotPath(root, "graph");
    const raw = JSON.parse(require("node:zlib").gunzipSync(require("node:fs").readFileSync(path)).toString("utf-8"));
    raw.manifest.root = "/other";
    require("node:fs").writeFileSync(path, require("node:zlib").gzipSync(Buffer.from(JSON.stringify(raw))));
    expect(readSnapshot(root, "graph")).toBeNull();
  });

  it("returns null on corrupt gzip", () => {
    const path = snapshotPath(root, "graph");
    require("node:fs").mkdirSync(require("node:path").dirname(path), { recursive: true });
    require("node:fs").writeFileSync(path, Buffer.from([0x00, 0x01, 0x02]));
    expect(readSnapshot(root, "graph")).toBeNull();
    expect(verifySnapshot(root, "graph").status).toBe("invalid");
  });
});

describe("computeSourceHash — content-aware hashing", () => {
  it("same paths but different content produce different hashes", () => {
    const hashA = computeSourceHash([
      { path: "a.ts", contentHash: "abc" },
      { path: "b.ts", contentHash: "def" },
    ]);
    const hashB = computeSourceHash([
      { path: "a.ts", contentHash: "abc" },
      { path: "b.ts", contentHash: "xyz" },
    ]);
    expect(hashA).not.toBe(hashB);
  });

  it("same paths and content produce the same hash", () => {
    const hashA = computeSourceHash([
      { path: "a.ts", contentHash: "abc" },
      { path: "b.ts", contentHash: "def" },
    ]);
    const hashB = computeSourceHash([
      { path: "b.ts", contentHash: "def" },
      { path: "a.ts", contentHash: "abc" },
    ]);
    expect(hashA).toBe(hashB);
  });

  it("string-only backward compatibility: plain path array produces a deterministic hash", () => {
    const hashA = computeSourceHash(["a.ts", "b.ts"]);
    const hashB = computeSourceHash(["b.ts", "a.ts"]);
    expect(hashA).toBe(hashB);
  });

  it("empty entries produce a consistent hash", () => {
    const hashA = computeSourceHash([]);
    const hashB = computeSourceHash([]);
    expect(hashA).toBe(hashB);
  });

  it("string-based and object-based calls with same paths differ when content hashes differ", () => {
    const strHash = computeSourceHash(["a.ts"]);
    const objHash = computeSourceHash([{ path: "a.ts", contentHash: "nonempty" }]);
    // strHash uses contentHash="" so they should differ
    expect(strHash).not.toBe(objHash);
  });
});
