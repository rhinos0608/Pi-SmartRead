/**
 * Tests for file-watcher module.
 *
 * Mocks fs.watch to verify debounce, stop, and test-mode no-op behavior.
 * Uses vitest fake timers for deterministic debounce testing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs module before importing file-watcher
const mockClose = vi.fn();
const mockWatch = vi.fn();
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    watch: mockWatch,
    readdirSync: actual.readdirSync,
    statSync: actual.statSync,
  };
});

// Must import after mocking
const { startWatching } = await import("../../src/file-watcher.js");

// ── Helpers ────────────────────────────────────────────────────────────────

/** Get the listener callback passed as 3rd arg to the last fs.watch call. */
function getLastWatchListener(): (event: string, filename: string | null) => void {
  const call = mockWatch.mock.calls[mockWatch.mock.calls.length - 1];
  return call![2] as (event: string, filename: string | null) => void;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("file-watcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockWatch.mockReset();
    mockClose.mockReset();
    // Set test mode to allow watcher to start in test environment
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("test-mode no-op", () => {
    it("returns no-op stop when VITEST env is set", () => {
      process.env.VITEST = "true";
      const onDirty = vi.fn();
      const stop = startWatching("/tmp", onDirty, { mode: "none" });
      expect(typeof stop).toBe("function");
      // No watchers should have been created
      expect(mockWatch).not.toHaveBeenCalled();
      // Calling stop should not throw
      stop();
      delete process.env.VITEST;
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
      mockWatch.mockImplementation(() => {
        throw new Error("EPERM");
      });

      // Should not throw
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const stop = startWatching("/test/root", onDirty, { mode: "recursive" });

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to start recursive watcher"),
      );
      stop();
      consoleWarnSpy.mockRestore();
    });
  });

  describe("non-recursive mode", () => {
    it("creates per-directory watchers with cap", () => {
      process.env.NODE_ENV = "development";
      delete process.env.VITEST;
      const onDirty = vi.fn();
      mockWatch.mockReturnValue({ close: mockClose });

      const stop = startWatching("/test/root", onDirty, {
        mode: "non-recursive",
        maxWatcherCount: 3,
      });

      // Should create at least one watcher (the root dir)
      expect(mockWatch).toHaveBeenCalled();
      stop();
    });

    it("warns when watcher cap is reached", () => {
      process.env.NODE_ENV = "development";
      delete process.env.VITEST;
      const onDirty = vi.fn();
      mockWatch.mockReturnValue({ close: mockClose });
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const stop = startWatching("/test/root", onDirty, {
        mode: "non-recursive",
        maxWatcherCount: 1, // very low cap
      });

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Reached watcher cap"),
      );
      stop();
      consoleWarnSpy.mockRestore();
    });

    it("stop closes all directory watchers", () => {
      process.env.NODE_ENV = "development";
      delete process.env.VITEST;
      const onDirty = vi.fn();
      mockWatch.mockReturnValue({ close: mockClose });

      const stop = startWatching("/test/root", onDirty, {
        mode: "non-recursive",
        maxWatcherCount: 10,
      });

      // Each directory gets its own close
      stop();
      expect(mockClose).toHaveBeenCalled();
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
