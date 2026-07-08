/**
 * Tests for bash-context-guard.ts — safety feature that caps oversized bash
 * output, writes full output to a temp file, and shows a head/tail preview.
 */
import { describe, expect, it } from "vitest";
import {
  applyBashContextGuard,
  resolveBashContextGuardConfig,
  resolveGuardProfile,
  suggestShellCommands,
  GUARD_HINT_GENERIC,
  GUARD_HINT_DEEP_SEARCH,
  TOOL_GUARD_PROFILES,
  type BashContextGuardConfig,
} from "../../bash-context-guard.js";

describe("resolveBashContextGuardConfig", () => {
  it("defaults enabled=true when env var not set", () => {
    const config = resolveBashContextGuardConfig({});
    expect(config.enabled).toBe(true);
  });

  it("defaults enabled=false when env var set to '0'", () => {
    const config = resolveBashContextGuardConfig({
      PI_SMARTREAD_BASH_CONTEXT_GUARD: "0",
    });
    expect(config.enabled).toBe(false);
  });

  it("uses default maxLines when env var not set", () => {
    const config = resolveBashContextGuardConfig({});
    expect(config.maxLines).toBeGreaterThan(0);
  });

  it("parses PI_SMARTREAD_BASH_CONTEXT_GUARD_MAX_LINES from env (capped at ceiling)", () => {
    const config = resolveBashContextGuardConfig({
      PI_SMARTREAD_BASH_CONTEXT_GUARD_MAX_LINES: "5000",
    });
    expect(config.maxLines).toBeLessThanOrEqual(5000);
    expect(config.maxLines).toBeGreaterThan(0);
  });

  it("caps maxLines to the ceiling when env value exceeds it", () => {
    const config = resolveBashContextGuardConfig({
      PI_SMARTREAD_BASH_CONTEXT_GUARD_MAX_LINES: "999999999",
    });
    expect(config.maxLines).toBeLessThan(100000);
  });

  it("ignores non-positive or non-numeric values", () => {
    expect(resolveBashContextGuardConfig({ PI_SMARTREAD_BASH_CONTEXT_GUARD_MAX_LINES: "0" }).maxLines).toBeGreaterThan(0);
    expect(resolveBashContextGuardConfig({ PI_SMARTREAD_BASH_CONTEXT_GUARD_MAX_LINES: "-5" }).maxLines).toBeGreaterThan(0);
    expect(resolveBashContextGuardConfig({ PI_SMARTREAD_BASH_CONTEXT_GUARD_MAX_LINES: "abc" }).maxLines).toBeGreaterThan(0);
  });

  it("respects headLines and tailLines from env", () => {
    const config = resolveBashContextGuardConfig({
      PI_SMARTREAD_BASH_CONTEXT_GUARD_HEAD_LINES: "50",
      PI_SMARTREAD_BASH_CONTEXT_GUARD_TAIL_LINES: "75",
    });
    expect(config.headLines).toBe(50);
    expect(config.tailLines).toBe(75);
  });
});

describe("resolveGuardProfile", () => {
  it("falls back to 'default' profile for unknown tools", () => {
    const profile = resolveGuardProfile("unknown-tool");
    expect(profile.maxLines).toBeGreaterThan(0);
    expect(profile.headLines).toBeGreaterThan(0);
  });

  it("returns search-specific profile for 'search' tool", () => {
    const profile = resolveGuardProfile("search");
    expect(profile.maxLines).toBe(2500);
  });

  it("returns read-specific profile for 'read' tool", () => {
    const profile = resolveGuardProfile("read");
    expect(profile.maxLines).toBe(3000);
  });

  it("has profiles for high-output SmartRead tools", () => {
    for (const toolName of ["read_files", "search", "repo_map", "symbol"]) {
      const profile = resolveGuardProfile(toolName);
      expect(profile.maxLines).toBeGreaterThan(0);
      expect(profile.maxBytes).toBeGreaterThan(0);
    }
  });

  it("merges tool profile on top of baseConfig", () => {
    const base: BashContextGuardConfig = {
      enabled: false,
      maxLines: 100,
      maxBytes: 10 * 1024,
      headLines: 10,
      tailLines: 10,
    };
    const profile = resolveGuardProfile("search", base);
    // search profile provides its own headLines/tailLines values
    expect(profile.maxLines).toBe(TOOL_GUARD_PROFILES.search!.maxLines);
    expect(profile.headLines).toBe(TOOL_GUARD_PROFILES.search!.headLines);
  });

  it("handles undefined baseConfig", () => {
    const profile = resolveGuardProfile("search", undefined);
    expect(profile.maxLines).toBe(2500);
  });
});

describe("applyBashContextGuard", () => {
  describe("returns original text when guard is disabled", () => {
    it("returns text unchanged when config.enabled=false", () => {
      const config: BashContextGuardConfig = {
        enabled: false,
        maxLines: 2000,
        maxBytes: 50 * 1024,
        headLines: 80,
        tailLines: 120,
      };
      const longOutput = "line\n".repeat(10000);
      const result = applyBashContextGuard({ text: longOutput, config });
      expect(result.text).toBe(longOutput);
      expect(result.metadata.trimmed).toBe(false);
    });
  });

  describe("returns original text when below thresholds", () => {
    it("returns text unchanged when within all limits", () => {
      const smallText = "hello world\n";
      const result = applyBashContextGuard({ text: smallText });
      expect(result.text).toBe(smallText);
      expect(result.metadata.trimmed).toBe(false);
    });

    it("metadata reflects exact counts for small text", () => {
      const text = "one\ntwo\nthree\n";
      const result = applyBashContextGuard({ text });
      // split("\n") adds a trailing empty element for the final newline
      expect(result.metadata.postRtkLineCount).toBeGreaterThanOrEqual(3);
      expect(result.metadata.postRtkByteCount).toBeGreaterThan(0);
      expect(result.metadata.trimWanted).toBe(false);
    });
  });

  describe("trims output exceeding thresholds", () => {
    it("trims output exceeding maxLines", () => {
      const lines: string[] = [];
      for (let i = 0; i < 3000; i++) lines.push(`line ${i}`);
      const text = lines.join("\n");
      const config: BashContextGuardConfig = {
        enabled: true,
        maxLines: 2000,
        maxBytes: 50 * 1024,
        headLines: 80,
        tailLines: 120,
      };
      const result = applyBashContextGuard({ text, config });
      expect(result.metadata.trimmed).toBe(true);
      expect(result.metadata.postRtkLineCount).toBe(3000);
      expect(result.text).toContain("[Bash context guard: preview]");
    });

    it("trims output exceeding maxBytes", () => {
      // Each line is ~100 bytes; 600 lines = 60KB > 50KB limit
      const lines: string[] = [];
      for (let i = 0; i < 600; i++) lines.push(`x`.repeat(100));
      const text = lines.join("\n");
      const config: BashContextGuardConfig = {
        enabled: true,
        maxLines: 10000,
        maxBytes: 50 * 1024,
        headLines: 80,
        tailLines: 120,
      };
      const result = applyBashContextGuard({ text, config });
      expect(result.metadata.trimmed).toBe(true);
    });

    it("records output path for trimmed text", () => {
      const lines: string[] = [];
      for (let i = 0; i < 3000; i++) lines.push(`line ${i}`);
      const text = lines.join("\n");
      const config: BashContextGuardConfig = {
        enabled: true,
        maxLines: 2000,
        maxBytes: 50 * 1024,
        headLines: 80,
        tailLines: 120,
      };
      const result = applyBashContextGuard({ text, config });
      expect(result.metadata.postRtkOutputPath).toBeDefined();
      expect(result.metadata.postRtkOutputPath).toContain("smartread-bash-");
    });
  });

  describe("preserves protected notices in preview", () => {
    it("preserves REPEATED-CALL WARNING lines", () => {
      const lines: string[] = [];
      for (let i = 0; i < 3000; i++) lines.push(`line ${i}`);
      lines.splice(100, 0, "⚠ REPEATED-CALL WARNING: This is the 3rd identical tool call.");
      const text = lines.join("\n");
      const config: BashContextGuardConfig = {
        enabled: true,
        maxLines: 2000,
        maxBytes: 50 * 1024,
        headLines: 80,
        tailLines: 120,
      };
      const result = applyBashContextGuard({ text, config });
      expect(result.text).toContain("⚠ REPEATED-CALL WARNING:");
    });

    it("preserves DOOM-LOOP WARNING lines", () => {
      const lines: string[] = [];
      for (let i = 0; i < 3000; i++) lines.push(`line ${i}`);
      lines.splice(100, 0, "⚠ DOOM-LOOP WARNING: something went wrong");
      const text = lines.join("\n");
      const config: BashContextGuardConfig = {
        enabled: true,
        maxLines: 2000,
        maxBytes: 50 * 1024,
        headLines: 80,
        tailLines: 120,
      };
      const result = applyBashContextGuard({ text, config });
      expect(result.text).toContain("⚠ DOOM-LOOP WARNING:");
    });

    it("preserves ACTION-STAGNATION WARNING lines", () => {
    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) lines.push(`line ${i}`);
    lines.splice(100, 0, "⚠ ACTION-STAGNATION WARNING: Same tool called 10 times consecutively.");
    const text = lines.join("\n");
    const config: BashContextGuardConfig = {
      enabled: true,
      maxLines: 2000,
      maxBytes: 50 * 1024,
      headLines: 80,
      tailLines: 120,
    };
    const result = applyBashContextGuard({ text, config });
    expect(result.text).toContain("⚠ ACTION-STAGNATION WARNING:");
  });

  it("preserves CONTENT-CHANTING WARNING lines", () => {
    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) lines.push(`line ${i}`);
    lines.splice(100, 0, "⚠ CONTENT-CHANTING WARNING: Same output pattern detected 12+ times.");
    const text = lines.join("\n");
    const config: BashContextGuardConfig = {
      enabled: true,
      maxLines: 2000,
      maxBytes: 50 * 1024,
      headLines: 80,
      tailLines: 120,
    };
    const result = applyBashContextGuard({ text, config });
    expect(result.text).toContain("⚠ CONTENT-CHANTING WARNING:");
  });

  it("preserves READ-FILE-LOOP WARNING lines", () => {
    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) lines.push(`line ${i}`);
    lines.splice(100, 0, "⚠ READ-FILE-LOOP WARNING: 10+ read operations in last 15 calls.");
    const text = lines.join("\n");
    const config: BashContextGuardConfig = {
      enabled: true,
      maxLines: 2000,
      maxBytes: 50 * 1024,
      headLines: 80,
      tailLines: 120,
    };
    const result = applyBashContextGuard({ text, config });
    expect(result.text).toContain("⚠ READ-FILE-LOOP WARNING:");
  });

  it("preserves guard hint lines", () => {
      const lines: string[] = [];
      for (let i = 0; i < 3000; i++) lines.push(`line ${i}`);
      const text = lines.join("\n");
      const config: BashContextGuardConfig = {
        enabled: true,
        maxLines: 2000,
        maxBytes: 50 * 1024,
        headLines: 80,
        tailLines: 120,
      };
      const result = applyBashContextGuard({ text, config });
      expect(result.text).toContain("💡");
    });

    it("deduplicates identical preserved notices in the input", () => {
      // Feed input with duplicate notices — splitPreviewLines deduplicates
      const lines: string[] = [];
      for (let i = 0; i < 3000; i++) lines.push(`line ${i}`);
      lines.splice(50, 0, "⚠ REPEATED-CALL WARNING: test notice");
      lines.splice(150, 0, "⚠ REPEATED-CALL WARNING: test notice");
      const text = lines.join("\n");
      const config: BashContextGuardConfig = {
        enabled: true,
        maxLines: 2000,
        maxBytes: 50 * 1024,
        headLines: 80,
        tailLines: 120,
      };
      const result = applyBashContextGuard({ text, config });
      // Deduplicated to 1 in preservedNotices
      expect(result.metadata.preservedNoticeCount).toBe(1);
    });

    it("skips 'Ran' command wrapper lines", () => {
      const lines: string[] = [];
      for (let i = 0; i < 3000; i++) lines.push(`line ${i}`);
      lines.splice(50, 0, "Ran cat foo.ts in 0.1s");
      lines.splice(60, 0, "Ran git status in 0.2s");
      const text = lines.join("\n");
      const config: BashContextGuardConfig = {
        enabled: true,
        maxLines: 2000,
        maxBytes: 50 * 1024,
        headLines: 80,
        tailLines: 120,
      };
      const result = applyBashContextGuard({ text, config });
      expect(result.text).not.toContain("Ran cat foo.ts");
      expect(result.text).not.toContain("Ran git status");
    });
  });

  describe("metadata accuracy", () => {
    it("records preservedNoticeCount in metadata", () => {
      const lines: string[] = [];
      for (let i = 0; i < 3000; i++) lines.push(`line ${i}`);
      lines.splice(100, 0, "⚠ DOOM-LOOP WARNING: test");
      const text = lines.join("\n");
      const config: BashContextGuardConfig = {
        enabled: true,
        maxLines: 2000,
        maxBytes: 50 * 1024,
        headLines: 80,
        tailLines: 120,
      };
      const result = applyBashContextGuard({ text, config });
      expect(result.metadata.preservedNoticeCount).toBeGreaterThan(0);
    });

    it("sets trimmed flag when output exceeds limits", () => {
      const text = "test\n".repeat(3000);
      const config: BashContextGuardConfig = {
        enabled: true,
        maxLines: 2000,
        maxBytes: 50 * 1024,
        headLines: 80,
        tailLines: 120,
      };
      const result = applyBashContextGuard({ text, config });
      // Output exceeds maxLines (2000), so trimmed should be true
      expect(result.metadata.trimmed).toBe(true);
    });
  });

  describe("command compacting", () => {
    it("renders command in preview when provided", () => {
      const lines: string[] = [];
      for (let i = 0; i < 3000; i++) lines.push(`line ${i}`);
      const text = lines.join("\n");
      const config: BashContextGuardConfig = {
        enabled: true,
        maxLines: 2000,
        maxBytes: 50 * 1024,
        headLines: 80,
        tailLines: 120,
      };
      const result = applyBashContextGuard({
        text,
        config,
        command: "git log --oneline --all --graph --decorate --color",
      });
      expect(result.text).toContain("Command:");
    });

    it("truncates long commands (>120 chars) with ellipsis", () => {
      const lines: string[] = [];
      for (let i = 0; i < 3000; i++) lines.push(`line ${i}`);
      const text = lines.join("\n");
      const config: BashContextGuardConfig = {
        enabled: true,
        maxLines: 2000,
        maxBytes: 50 * 1024,
        headLines: 80,
        tailLines: 120,
      };
      const longCommand = "git log --oneline --all --graph --decorate --color --simplify-by-decoration --date=iso --author='Someone Very Long Name' --since='2020-01-01'";
      const result = applyBashContextGuard({ text, config, command: longCommand });
      expect(result.text).toContain("...");
    });
  });

  describe("tool-specific hints", () => {
    it("uses generic hint when trimming", () => {
      const lines: string[] = [];
      for (let i = 0; i < 3000; i++) lines.push(`line ${i}`);
      const text = lines.join("\n");
      const config: BashContextGuardConfig = {
        enabled: true,
        maxLines: 2000,
        maxBytes: 50 * 1024,
        headLines: 80,
        tailLines: 120,
      };
      const result = applyBashContextGuard({ text, config });
      expect(result.text).toContain(GUARD_HINT_GENERIC);
    });
  });

  describe("tool-specific guidance", () => {
    it("uses deep-search hint for the search tool", () => {
      const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
      const result = applyBashContextGuard({
        text,
        toolName: "search",
        config: { enabled: true, maxLines: 5, maxBytes: 1024 * 1024, headLines: 2, tailLines: 2 },
      });

      expect(result.text).toContain(GUARD_HINT_DEEP_SEARCH);
      expect(result.text).not.toContain(GUARD_HINT_GENERIC);
    });
  });

  describe("empty text handling", () => {
    it("does not attempt trim for empty string", () => {
      const result = applyBashContextGuard({ text: "" });
      expect(result.metadata.trimWanted).toBe(false);
      expect(result.metadata.trimmed).toBe(false);
    });
  });
});

describe("suggestShellCommands", () => {
  it("suggests brew/apt for 'command not found'", () => {
    const suggestions = suggestShellCommands("foo --bar", "bash: foo: command not found");
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it("suggests npm build for TypeScript errors", () => {
    // Output must match \/.ts[x]?: error:\/ regex — needs "foo.ts:5: error:" format (not "error TS2345:")
    const suggestions = suggestShellCommands("tsc --noEmit", "foo.ts:5: error: cannot find name");
    expect(suggestions.some((s) => s.includes("npx tsc --noEmit"))).toBe(true);
  });

  it("suggests npm test for test failures", () => {
    const suggestions = suggestShellCommands("jest", "FAIL src/foo.test.ts\n2 tests failed");
    expect(suggestions.some((s) => s.includes("test"))).toBe(true);
  });

  it("suggests git status for merge conflicts", () => {
    const suggestions = suggestShellCommands("git merge", "CONFLICT (content): Merge conflict in foo.ts");
    expect(suggestions.some((s) => s.includes("git status"))).toBe(true);
  });

  it("suggests npm install for module-not-found errors", () => {
    const suggestions = suggestShellCommands("node server.js", "Error: Cannot find module 'express'");
    expect(suggestions.some((s) => s.includes("install"))).toBe(true);
  });

  it("suggests chmod/sudo for permission denied", () => {
    const suggestions = suggestShellCommands("./script.sh", "Permission denied");
    expect(suggestions.some((s) => s.includes("chmod") || s.includes("sudo"))).toBe(true);
  });

  it("suggests port diagnostics for EADDRINUSE", () => {
    const suggestions = suggestShellCommands("npm run dev", "Error: EADDRINUSE address already in use");
    expect(suggestions.some((s) => s.includes("lsof") || s.includes("kill"))).toBe(true);
  });

  it("returns empty array for clean output", () => {
    const suggestions = suggestShellCommands("echo hello", "hello");
    expect(suggestions).toHaveLength(0);
  });

  it("caps suggestions at 3", () => {
    const output = "command not found\nSyntaxError\nFAIL tests\nCONFLICT\nModule not found\nPermission denied\nEADDRINUSE";
    const suggestions = suggestShellCommands("multi-error", output);
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });
});

describe("TOOL_GUARD_PROFILES", () => {
  it("search profile has higher maxLines than default", () => {
    const search = TOOL_GUARD_PROFILES.search;
    const default_ = TOOL_GUARD_PROFILES.default;
    if (!search || !default_ || search.maxLines == null || default_.maxLines == null) throw new Error("missing profile data");
    expect(search.maxLines).toBeGreaterThan(default_.maxLines);
  });

  it("read profile has higher maxLines than search profile", () => {
    const read = TOOL_GUARD_PROFILES.read;
    const search = TOOL_GUARD_PROFILES.search;
    if (!read || !search || read.maxLines == null || search.maxLines == null) throw new Error("missing profile data");
    expect(read.maxLines).toBeGreaterThan(search.maxLines);
  });

  it("all profiles have headLines <= maxLines", () => {
    for (const profile of Object.values(TOOL_GUARD_PROFILES)) {
      if (!profile || profile.headLines == null || profile.maxLines == null) continue;
      expect(profile.headLines).toBeLessThanOrEqual(profile.maxLines);
    }
  });

  it("all profiles have tailLines <= maxLines", () => {
    for (const profile of Object.values(TOOL_GUARD_PROFILES)) {
      if (!profile || profile.tailLines == null || profile.maxLines == null) continue;
      expect(profile.tailLines).toBeLessThanOrEqual(profile.maxLines);
    }
  });
});