/**
 * Tests for file-watcher module.
 *
 * Mocks fs.watch to verify debounce, stop, and test-mode no-op behavior.
 * Uses vitest fake timers for deterministic debounce testing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

// Mock fs module before importing file-watcher
const { mockClose, mockWatch } = vi.hoisted(() => ({
  mockClose: vi.fn(),
  mockWatch: vi.fn(),
}));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    watch: mockWatch,
    readdirSync: actual.readdirSync,
    statSync: actual.statSync,
  };
});

// Deterministically simulate chokidar being unavailable: tryRequireChokidar()
// must always resolve to null regardless of the repository's installed modules.
vi.mock("chokidar", () => {
  throw new Error("Cannot find module 'chokidar'");
});

// Must import after mocking
const { startWatching } = await import("../../src/file-watcher.js");

// ── Helpers ────────────────────────────────────────────────────────────────

/** Get the listener callback passed as 3rd arg to the last fs.watch call (recursive mode). */
function getLastWatchListener(): (event: string, filename: string | null) => void {
  const call = mockWatch.mock.calls[mockWatch.mock.calls.length - 1];
  return call![2] as (event: string, filename: string | null) => void;
}

/** Get the listener callback passed as 2nd arg to the last fs.watch call (non-recursive mode). */
function getLastNonRecursiveListener(): (event: string, filename: string | null) => void {
  const call = mockWatch.mock.calls[mockWatch.mock.calls.length - 1];
  return call![1] as (event: string, filename: string | null) => void;
}

// Escape special regex characters in a path string
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("file-watcher", () => {
  let savedNodeEnv: string | undefined;
  let savedVitest: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWatch.mockReset();
    mockClose.mockReset();
    // Capture originals for safe restore
    savedNodeEnv = process.env.NODE_ENV;
    savedVitest = process.env.VITEST;
    // Set test mode to allow watcher to start in test environment
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Restore originals
    if (savedNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = savedNodeEnv;
    }
    if (savedVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = savedVitest;
    }
  });

  describe("test-mode no-op", () => {
    it("returns no-op stop when VITEST env is set", () => {
      process.env.VITEST = "true";
      const onDirty = vi.fn();
      // mode:recursive would normally create a watcher, but VITEST guard suppresses
      const stop = startWatching("/tmp", onDirty, { mode: "recursive" });
      expect(typeof stop).toBe("function");
      expect(mockWatch).not.toHaveBeenCalled();
      stop();
    });

    it("returns no-op stop when mode is 'none'", () => {
      process.env.NODE_ENV = "development"; // not test
      delete process.env.VITEST;
      const onDirty = vi.fn();
      const stop = startWatching("/tmp", onDirty, { mode: "none" });
      expect(mockWatch).not.toHaveBeenCalled();
      stop();
    });
  });

  describe("chokidar mode contract", () => {
    it("explicit mode:'chokidar' warns then falls back to native when chokidar is absent", () => {
      process.env.NODE_ENV = "development";
      delete process.env.VITEST;
      const onDirty = vi.fn();
      mockWatch.mockReturnValue({ close: mockClose });
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // chokidar is mocked as unavailable, so tryRequireChokidar() returns null.
      const stop = startWatching("/test/root", onDirty, { mode: "chokidar" });

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("chokidar not installed"),
      );
      // Falls back to native fs.watch (recursive on darwin/win32).
      expect(mockWatch).toHaveBeenCalled();
      expect(typeof stop).toBe("function");
      stop();
      // The native watcher must be closed by the returned stop function.
      expect(mockClose).toHaveBeenCalled();
      consoleWarnSpy.mockRestore();
    });
  });

  describe("recursive mode", () => {
    it("uses fs.watch with recursive: true", () => {
      process.env.NODE_ENV = "development";
      delete process.env.VITEST;
      const onDirty = vi.fn();
      mockWatch.mockReturnValue({ close: mockClose });

      const stop = startWatching("/test/root", onDirty, { mode: "recursive" });

      expect(mockWatch).toHaveBeenCalledWith(
        "/test/root",
        { recursive: true },
        expect.any(Function),
      );
      expect(typeof stop).toBe("function");
      stop();
    });

    it("debounces and batches dirty paths", () => {
      process.env.NODE_ENV = "development";
      delete process.env.VITEST;
      const onDirty = vi.fn();
      mockWatch.mockReturnValue({ close: mockClose });

      const stop = startWatching("/test/root", onDirty, { mode: "recursive" });
      const listener = getLastWatchListener();

      // Simulate multiple file change events
      listener("rename", "src/foo.ts");
      listener("rename", "src/bar.ts");
      listener("rename", "src/baz.ts");

      // Before debounce fires — nothing emitted yet
      expect(onDirty).not.toHaveBeenCalled();

      // Advance past debounce window
      vi.advanceTimersByTime(500);

      // All paths should be batched into one call
      expect(onDirty).toHaveBeenCalledTimes(1);
      const paths = onDirty.mock.calls[0]![0] as string[];
      expect(paths.sort()).toEqual(["src/bar.ts", "src/baz.ts", "src/foo.ts"].sort());

      stop();
    });

    it("collects new paths during debounce window", () => {
      process.env.NODE_ENV = "development";
      delete process.env.VITEST;
      const onDirty = vi.fn();
      mockWatch.mockReturnValue({ close: mockClose });

      const stop = startWatching("/test/root", onDirty, { mode: "recursive" });
      const listener = getLastWatchListener();

      // First batch
      listener("rename", "a.ts");
      vi.advanceTimersByTime(300); // within debounce window
      listener("rename", "b.ts");
      vi.advanceTimersByTime(500); // flush

      expect(onDirty).toHaveBeenCalledTimes(1);
      const paths = onDirty.mock.calls[0]![0] as string[];
      expect(paths.sort()).toEqual(["a.ts", "b.ts"].sort());

      stop();
    });

    it("stop closes watchers and clears pending timer", () => {
      process.env.NODE_ENV = "development";
      delete process.env.VITEST;
      const onDirty = vi.fn();
      const mockWatcher = { close: mockClose };
      mockWatch.mockReturnValue(mockWatcher);

      const stop = startWatching("/test/root", onDirty, { mode: "recursive" });
      const listener = getLastWatchListener();

      // Trigger a change but don't flush yet
      listener("rename", "x.ts");

      // Stop — should close watcher and cancel debounce
      stop();

      // Advance timer — onDirty should NOT be called (timer was cleared)
      vi.advanceTimersByTime(1000);
      expect(onDirty).not.toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });

    it("ignores null filenames", () => {
      process.env.NODE_ENV = "development";
      delete process.env.VITEST;
      const onDirty = vi.fn();
      mockWatch.mockReturnValue({ close: mockClose });

      const stop = startWatching("/test/root", onDirty, { mode: "recursive" });
      const listener = getLastWatchListener();

      listener("rename", null);
      vi.advanceTimersByTime(1000);

      expect(onDirty).not.toHaveBeenCalled();
      stop();
    });

    it("handles fs.watch error gracefully", () => {
      process.env.NODE_ENV = "development";
      delete process.env.VITEST;
      const onDirty = vi.fn();

      // First call (recursive) throws, second call (non-recursive fallback) succeeds
      mockWatch
        .mockImplementationOnce(() => {
          throw new Error("EPERM");
        })
        .mockImplementation(() => ({ close: vi.fn() }));

      // Should not throw — falls back to non-recursive
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const stop = startWatching("/test/root", onDirty, { mode: "recursive" });

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("falling back to non-recursive"),
      );
      expect(mockWatch).toHaveBeenCalledTimes(2);
      expect(mockWatch).toHaveBeenLastCalledWith("/test/root", expect.any(Function));
      stop();
      consoleWarnSpy.mockRestore();
    });
  });

  describe("non-recursive mode", () => {
    let tmpRoot: string;

    beforeEach(() => {
      process.env.NODE_ENV = "development";
      delete process.env.VITEST;
      // Create real nested dir tree for collectDirectories
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fw-test-"));
      // root / a / a/b / a/b/c
      const a = path.join(tmpRoot, "a");
      const ab = path.join(a, "b");
      const abc = path.join(ab, "c");
      for (const d of [a, ab, abc]) {
        fs.mkdirSync(d, { recursive: true });
      }
    });

    afterEach(() => {
      // Clean up temp dirs
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("creates one watcher per discovered directory (up to maxWatcherCount)", () => {
      const onDirty = vi.fn();
      mockWatch.mockReturnValue({ close: mockClose });

      const stop = startWatching(tmpRoot, onDirty, {
        mode: "non-recursive",
        maxWatcherCount: 3,
      });

      // 4 dirs exist (root, a, a/b, a/b/c), but cap=3 so 3 watchers
      expect(mockWatch).toHaveBeenCalledTimes(3);
      // All watched dirs should be within tmpRoot
      const rootPattern = escapeRegExp(tmpRoot);
      for (const call of mockWatch.mock.calls) {
        expect((call[0] as string)).toMatch(new RegExp("^" + rootPattern));
      }
      stop();
    });

    it("creates watchers for all dirs when under cap", () => {
      const onDirty = vi.fn();
      mockWatch.mockReturnValue({ close: mockClose });

      const stop = startWatching(tmpRoot, onDirty, {
        mode: "non-recursive",
        maxWatcherCount: 100,
      });

      // 4 dirs (root + 3 nested) — all under cap
      expect(mockWatch).toHaveBeenCalledTimes(4);
      stop();
    });

    it("warns when watcher cap is reached", () => {
      const onDirty = vi.fn();
      mockWatch.mockReturnValue({ close: mockClose });
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const stop = startWatching(tmpRoot, onDirty, {
        mode: "non-recursive",
        maxWatcherCount: 2,
      });

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Reached watcher cap"),
      );
      stop();
      consoleWarnSpy.mockRestore();
    });

    it("stop closes all watchers and cancels pending debounce", () => {
      const onDirty = vi.fn();
      mockWatch.mockReturnValue({ close: mockClose });

      const stop = startWatching(tmpRoot, onDirty, {
        mode: "non-recursive",
        maxWatcherCount: 100,
      });

      const listener = getLastNonRecursiveListener();
      listener("rename", "dirty.ts");

      stop();

      // Advance — onDirty should NOT fire (timer cleared)
      vi.advanceTimersByTime(1000);
      expect(onDirty).not.toHaveBeenCalled();
      // close() called for each watcher
      expect(mockClose).toHaveBeenCalledTimes(4);
    });

    it("reports dirty paths as relative to root", () => {
      const onDirty = vi.fn();
      mockWatch.mockReturnValue({ close: mockClose });

      const stop = startWatching(tmpRoot, onDirty, {
        mode: "non-recursive",
        maxWatcherCount: 100,
      });

      const listener = getLastNonRecursiveListener();
      listener("rename", "changed.ts");
      vi.advanceTimersByTime(500);

      expect(onDirty).toHaveBeenCalledTimes(1);
      const paths = onDirty.mock.calls[0]![0] as string[];
      expect(paths.length).toBe(1);
      // Last watched dir is deepest (a/b/c), so relative path includes the nested subdirs
      expect(paths[0]).toMatch(/a\/b\/c\/changed\.ts$/);
      stop();
    });

    it("retries a dir that failed initial watch via dynamic discovery", () => {
      const onDirty = vi.fn();
      const failedDir = path.join(tmpRoot, "a");
      let failedDirCalls = 0;
      mockWatch.mockImplementation((dir: string) => {
        if (dir === failedDir && failedDirCalls === 0) {
          failedDirCalls++;
          throw new Error("EPERM");
        }
        return { close: mockClose };
      });
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const stop = startWatching(tmpRoot, onDirty, {
        mode: "non-recursive",
        maxWatcherCount: 100,
      });

      // Initial: root, a(throws), a/b, a/b/c → 4 calls, 3 successful watchers.
      expect(mockWatch).toHaveBeenCalledTimes(4);

      // Simulate a rename on the root watcher re-creating dir "a".
      const rootListener = mockWatch.mock.calls[0]![1] as (event: string, filename: string | null) => void;
      rootListener("rename", "a");

      // Dynamic discovery must retry watching the previously-failed dir. The
      // already-watched a/b and a/b/c are also re-watched (pathToWatcher
      // close+rewatch for the deleted-and-recreated case), so total = 7.
      expect(mockWatch).toHaveBeenCalledTimes(7);
      const postInitial = mockWatch.mock.calls.slice(4).map((c) => c[0]);
      expect(postInitial).toContain(failedDir);
      stop();
      consoleWarnSpy.mockRestore();
    });
  });

  describe("debounce behavior", () => {
    it("respects custom debounceMs", () => {
      process.env.NODE_ENV = "development";
      delete process.env.VITEST;
      const onDirty = vi.fn();
      mockWatch.mockReturnValue({ close: mockClose });

      const stop = startWatching("/test/root", onDirty, {
        mode: "recursive",
        debounceMs: 100,
      });
      const listener = getLastWatchListener();

      listener("rename", "a.ts");

      // 50ms — too early
      vi.advanceTimersByTime(50);
      expect(onDirty).not.toHaveBeenCalled();

      // 100ms — fires
      vi.advanceTimersByTime(50);
      expect(onDirty).toHaveBeenCalledTimes(1);

      stop();
    });

    it("resets debounce timer on new events within window", () => {
      process.env.NODE_ENV = "development";
      delete process.env.VITEST;
      const onDirty = vi.fn();
      mockWatch.mockReturnValue({ close: mockClose });

      const stop = startWatching("/test/root", onDirty, {
        mode: "recursive",
        debounceMs: 500,
      });
      const listener = getLastWatchListener();

      listener("rename", "a.ts");
      vi.advanceTimersByTime(400); // 400ms — not yet
      listener("rename", "b.ts");
      vi.advanceTimersByTime(400); // 800ms total but 400ms since last event
      expect(onDirty).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100); // 500ms since last event — fires
      expect(onDirty).toHaveBeenCalledTimes(1);

      stop();
    });
  });

  describe("path deduplication", () => {
    it("deduplicates identical paths within debounce window", () => {
      process.env.NODE_ENV = "development";
      delete process.env.VITEST;
      const onDirty = vi.fn();
      mockWatch.mockReturnValue({ close: mockClose });

      const stop = startWatching("/test/root", onDirty, { mode: "recursive" });
      const listener = getLastWatchListener();

      // Duplicate events for same file (common with fs.watch)
      listener("rename", "src/a.ts");
      listener("rename", "src/a.ts");
      listener("rename", "src/a.ts");
      vi.advanceTimersByTime(500);

      expect(onDirty).toHaveBeenCalledTimes(1);
      expect(onDirty.mock.calls[0]![0]).toEqual(["src/a.ts"]);
      stop();
    });
  });

  describe("multiple debounce cycles", () => {
    it("emits separate batches for separate debounce windows", () => {
      process.env.NODE_ENV = "development";
      delete process.env.VITEST;
      const onDirty = vi.fn();
      mockWatch.mockReturnValue({ close: mockClose });

      const stop = startWatching("/test/root", onDirty, { mode: "recursive" });
      const listener = getLastWatchListener();

      // First batch
      listener("rename", "a.ts");
      vi.advanceTimersByTime(500);
      expect(onDirty).toHaveBeenCalledTimes(1);
      expect(onDirty.mock.calls[0]![0]).toEqual(["a.ts"]);

      // Second batch (after first flush)
      listener("rename", "b.ts");
      vi.advanceTimersByTime(500);
      expect(onDirty).toHaveBeenCalledTimes(2);
      expect(onDirty.mock.calls[1]![0]).toEqual(["b.ts"]);

      stop();
    });
  });
});
