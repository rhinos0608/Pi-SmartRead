/**
 * Bash context guard — caps oversized bash output, writes full output to a
 * temp file, and shows a head/tail preview. Protected notices (doom loop
 * warnings, context guard metadata) are never trimmed.
 *
 * Adapted from pi-hashline-readmap (MIT, github.com/coctostan/pi-hashline-readmap).
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BASH_CONTEXT_GUARD_DEFAULT_MAX_LINES = 2000;
export const BASH_CONTEXT_GUARD_DEFAULT_MAX_BYTES = 50 * 1024;
export const BASH_CONTEXT_GUARD_DEFAULT_HEAD_LINES = 80;
export const BASH_CONTEXT_GUARD_DEFAULT_TAIL_LINES = 120;

/** Per-tool guard profile — merged on top of base config from env vars */
export interface BashContextGuardProfile {
  maxLines: number;
  maxBytes: number;
  headLines: number;
  tailLines: number;
}

export const GUARD_HINT_GENERIC = "💡 To see specific sections, re-run with offset/limit parameters or narrow the query.";
export const GUARD_HINT_DEEP_SEARCH = "💡 Use a more specific query or narrower scope to reduce output size.";

export const GUARD_HINT_RE = /💡 (To see specific sections|Use a more specific query)[^\n]*\n/;

/** Tool-specific overrides for the bash context guard. */
export const TOOL_GUARD_PROFILES: Record<string, Partial<BashContextGuardProfile>> = {
  // Search can return substantial context
  search: { maxLines: 2500, maxBytes: 60 * 1024, headLines: 100, tailLines: 140 },
  // Read with intent/multiple mode can produce large output
  read: { maxLines: 3000, maxBytes: 80 * 1024, headLines: 120, tailLines: 160 },
  // Default profile (also used for bash)
  default: { maxLines: 2000, maxBytes: 50 * 1024, headLines: 80, tailLines: 120 },
};

/**
 * Merge base config with tool-specific profile overrides.
 * Falls back to 'default' profile if tool not in map.
 */
export function resolveGuardProfile(
  toolName: string,
  baseConfig?: BashContextGuardConfig,
): BashContextGuardProfile {
  const base = baseConfig ?? resolveBashContextGuardConfig();
  const profile = TOOL_GUARD_PROFILES[toolName];
  if (profile) {
    return {
      maxLines: profile.maxLines ?? base.maxLines,
      maxBytes: profile.maxBytes ?? base.maxBytes,
      headLines: profile.headLines ?? base.headLines,
      tailLines: profile.tailLines ?? base.tailLines,
    };
  }
  return base;
}

const BASH_CONTEXT_GUARD_PREVIEW_LINE_MAX_BYTES = 1024;
const POSITIVE_BASE10_INT = /^[1-9][0-9]*$/;

export interface BashContextGuardConfig {
  enabled: boolean;
  maxLines: number;
  maxBytes: number;
  headLines: number;
  tailLines: number;
}

export interface BashContextGuardMetadata {
  enabled: boolean;
  trimmed: boolean;
  trimWanted: boolean;
  postRtkLineCount: number;
  postRtkByteCount: number;
  maxLines: number;
  maxBytes: number;
  headLines: number;
  tailLines: number;
  postRtkOutputPath?: string;
  postRtkWriteError?: string;
  preservedNoticeCount?: number;
}

export interface BashContextGuardResult {
  text: string;
  metadata: BashContextGuardMetadata;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function parsePositiveBase10Int(raw: string | undefined | null): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!POSITIVE_BASE10_INT.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function resolveDimension(rawEnvValue: string | undefined, ceiling: number): number {
  const parsed = parsePositiveBase10Int(rawEnvValue);
  if (parsed === undefined) return ceiling;
  return Math.min(parsed, ceiling);
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

function byteCount(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function truncateUtf8(text: string, maxBytes: number): { text: string; byteCount: number } {
  let bytes = 0;
  let result = "";
  for (const char of text) {
    const charBytes = byteCount(char);
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return { text: result, byteCount: bytes };
}

function formatPreviewLine(line: string): string {
  const totalBytes = byteCount(line);
  if (totalBytes <= BASH_CONTEXT_GUARD_PREVIEW_LINE_MAX_BYTES) return line;
  const truncated = truncateUtf8(line, BASH_CONTEXT_GUARD_PREVIEW_LINE_MAX_BYTES);
  return `${truncated.text}\n[truncated preview line: ${totalBytes} bytes total, showing ${truncated.byteCount} bytes]`;
}

function writeOutput(fs: BashContextGuardFs, text: string): string {
  const path = join(fs.tempDir(), `smartread-bash-${fs.randomId()}.txt`);
  fs.writeFile(path, text, { mode: 0o600, flag: "wx" });
  return path;
}

function compactCommand(command: string | undefined): string | undefined {
  const compact = command?.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function isRawCommandWrapper(line: string): boolean {
  return /^Ran\b/.test(line.trim());
}

function isProtectedNotice(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("[Bash context guard:") ||
    trimmed.startsWith("Full post-RTK output:") ||
    trimmed.startsWith("Full output:") ||
    /^Full output:\s*\S+/.test(trimmed) ||
    /^Command exited with code \d+/.test(trimmed) ||
    trimmed.startsWith("⚠ REPEATED-CALL WARNING:") ||
    trimmed.startsWith("⚠ ALTERNATING-CALL WARNING:") ||
    trimmed.startsWith("⚠ DOOM-LOOP WARNING:") ||
    // Guard hint lines for truncated output
    trimmed === GUARD_HINT_GENERIC ||
    trimmed === GUARD_HINT_DEEP_SEARCH
  );
}

function splitPreviewLines(text: string): { bodyLines: string[]; preservedNotices: string[] } {
  const bodyLines: string[] = [];
  const preservedNotices: string[] = [];
  const seenNotices = new Set<string>();
  for (const line of text.split("\n")) {
    if (isRawCommandWrapper(line)) continue;
    if (isProtectedNotice(line)) {
      if (!seenNotices.has(line)) {
        seenNotices.add(line);
        preservedNotices.push(line);
      }
      continue;
    }
    bodyLines.push(line);
  }
  return { bodyLines, preservedNotices };
}

function renderPreview(options: {
  text: string;
  outputPath: string;
  command?: string;
  metadata: BashContextGuardMetadata;
  preservedNotices: string[];
  toolName?: string;
}): string {
  const { bodyLines, preservedNotices } = {
    ...splitPreviewLines(options.text),
    preservedNotices: options.preservedNotices,
  };
  const headEnd = Math.min(options.metadata.headLines, bodyLines.length);
  const tailStart = options.metadata.tailLines === 0
    ? bodyLines.length
    : Math.max(headEnd, bodyLines.length - options.metadata.tailLines);
  const head = bodyLines.slice(0, headEnd).map(formatPreviewLine);
  const tail = bodyLines.slice(tailStart).map(formatPreviewLine);
  const omitted = bodyLines.slice(headEnd, tailStart);
  const omittedText = omitted.join("\n");
  const command = compactCommand(options.command);

  // Generate tool-specific hint for truncated output
  const hint = options.toolName === "deep_search" ? GUARD_HINT_DEEP_SEARCH : GUARD_HINT_GENERIC;

  const rendered: string[] = [
    "[Bash context guard: preview]",
    `Full post-RTK output: ${options.outputPath}`,
    `Post-RTK: ${options.metadata.postRtkLineCount} lines, ${options.metadata.postRtkByteCount} bytes`,
    `Trigger thresholds: ${options.metadata.maxLines} lines, ${options.metadata.maxBytes} bytes`,
  ];
  if (command) rendered.push(`Command: ${command}`);
  if (preservedNotices.length > 0) rendered.push("", "Preserved notices:", ...preservedNotices);
  rendered.push("", "Head:", ...head);
  if (omitted.length > 0) rendered.push(`... omitted ${omitted.length} lines / ${byteCount(omittedText)} bytes ...`);
  rendered.push("Tail:", ...tail, "", hint, "[End Bash context guard preview]");
  return rendered.join("\n");
}

// ─── Filesystem abstraction ───────────────────────────────────────────

interface BashContextGuardFs {
  writeFile(path: string, content: string, options: { mode: number; flag: string }): void;
  randomId(): string;
  tempDir(): string;
}

function defaultFs(): BashContextGuardFs {
  return {
    writeFile: (path, content, options) => writeFileSync(path, content, options),
    randomId: () => randomUUID(),
    tempDir: () => tmpdir(),
  };
}

// ─── Public API ───────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;

export function resolveBashContextGuardConfig(env: Env = process.env): BashContextGuardConfig {
  return {
    enabled: env.PI_SMARTREAD_BASH_CONTEXT_GUARD !== "0",
    maxLines: resolveDimension(env.PI_SMARTREAD_BASH_CONTEXT_GUARD_MAX_LINES, BASH_CONTEXT_GUARD_DEFAULT_MAX_LINES),
    maxBytes: resolveDimension(env.PI_SMARTREAD_BASH_CONTEXT_GUARD_MAX_BYTES, BASH_CONTEXT_GUARD_DEFAULT_MAX_BYTES),
    headLines: resolveDimension(env.PI_SMARTREAD_BASH_CONTEXT_GUARD_HEAD_LINES, BASH_CONTEXT_GUARD_DEFAULT_HEAD_LINES),
    tailLines: resolveDimension(env.PI_SMARTREAD_BASH_CONTEXT_GUARD_TAIL_LINES, BASH_CONTEXT_GUARD_DEFAULT_TAIL_LINES),
  };
}

export function applyBashContextGuard(options: {
  text: string;
  command?: string;
  config?: BashContextGuardConfig;
}): BashContextGuardResult {
  const config = options.config ?? resolveBashContextGuardConfig();
  const postRtkLineCount = lineCount(options.text);
  const postRtkByteCount = byteCount(options.text);
  const trimWanted = config.enabled && options.text !== "" &&
    (postRtkLineCount > config.maxLines || postRtkByteCount > config.maxBytes);
  const preservedNotices = trimWanted ? splitPreviewLines(options.text).preservedNotices : [];
  const baseMetadata: BashContextGuardMetadata = {
    enabled: config.enabled,
    trimmed: false,
    trimWanted,
    postRtkLineCount,
    postRtkByteCount,
    maxLines: config.maxLines,
    maxBytes: config.maxBytes,
    headLines: config.headLines,
    tailLines: config.tailLines,
    preservedNoticeCount: preservedNotices.length,
  };

  if (!trimWanted) return { text: options.text, metadata: baseMetadata };

  try {
    const fs = defaultFs();
    const outputPath = writeOutput(fs, options.text);
    const metadata: BashContextGuardMetadata = { ...baseMetadata, trimmed: true, postRtkOutputPath: outputPath };
    return {
      text: renderPreview({ text: options.text, outputPath, command: options.command, metadata, preservedNotices }),
      metadata,
    };
  } catch (error) {
    return {
      text: options.text,
      metadata: { ...baseMetadata, postRtkWriteError: error instanceof Error ? error.message : String(error) },
    };
  }
}

export function suggestShellCommands(command: string, output: string, _exitCode?: number): string[] {
  const suggestions: string[] = [];
  const isMac = process.platform === "darwin";

  if (/command not found|not found|': not found/.test(output)) {
    suggestions.push(isMac ? "brew install <package>" : "sudo apt-get install <package>");
  }

  if (/\.ts[x]?: error:|: error:/.test(output) || /SyntaxError:|TypeError:/.test(output)) {
    if (command.includes("tsc") || command.includes("tsx")) {
      suggestions.push("npx tsc --noEmit");
    } else {
      suggestions.push("npm run build");
    }
  }

  if (/FAIL|failed.*test|AssertionError|PASS[\s\d]|\d+ tests? failed/.test(output)) {
    suggestions.push("npm test");
    suggestions.push("Check test output for specific failures");
  }

  if (/CONFLICT|git conflict|<<<<<<</.test(output)) {
    suggestions.push("git status");
    suggestions.push("Resolve merge conflicts manually");
  }

  if (/Module not found|Cannot find module|import.*not found/.test(output)) {
    suggestions.push("npm install");
    suggestions.push("Check package.json dependencies");
  }

  if (/Permission denied|EACCES/.test(output)) {
    suggestions.push("chmod +x <script>  # If script execution");
    suggestions.push("sudo <command>  # If system access needed");
  }

  if (/EADDRINUSE|port.*in use|address already in use/.test(output)) {
    suggestions.push("lsof -i :<port>  # Find process using port");
    suggestions.push("kill -9 <PID>  # Kill the process");
  }

  return suggestions.slice(0, 3);
}
