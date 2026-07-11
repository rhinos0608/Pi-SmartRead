import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getIndexLockStatus, withIndexLockSync } from "../../index-lock.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "smartread-lock-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("index lock", () => {
  it("creates and releases lock around work", () => {
    const value = withIndexLockSync(root, "test", () => {
      const status = getIndexLockStatus(root, "test");
      expect(status.locked).toBe(true);
      return 42;
    });

    expect(value).toBe(42);
    expect(getIndexLockStatus(root, "test").locked).toBe(false);
  });

  it("rejects active lock and removes stale lock", () => {
    const status = getIndexLockStatus(root, "test");
    mkdirSync(dirname(status.path), { recursive: true });
    writeFileSync(status.path, JSON.stringify({ pid: 1, createdAt: Date.now(), name: "test" }));
    expect(() => withIndexLockSync(root, "test", () => undefined)).toThrow(/already held/);

    rmSync(status.path, { force: true });
    writeFileSync(status.path, JSON.stringify({ pid: 1, createdAt: Date.now() - 10_000, name: "test" }));
    expect(withIndexLockSync(root, "test", () => "ok", { staleMs: 1 })).toBe("ok");
    expect(existsSync(status.path)).toBe(false);
  });
});
