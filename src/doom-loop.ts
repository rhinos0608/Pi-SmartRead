/**
 * Doom-loop detection — detects when the LLM repeats identical tool calls,
 * gets stuck in alternating call sequences, produces repetitive output,
 * calls the same tool too many times consecutively, or reads files excessively.
 *
 * Injects a warning into the tool result text so the model can self-correct.
 *
 * Adapted from pi-hashline-readmap (MIT, github.com/coctostan/pi-hashline-readmap).
 */

export const MAX_RECENT_TOOL_CALLS = 24;

export interface RecordedToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  fingerprint: string;
}

export interface DoomLoopStep {
  toolName: string;
  input: Record<string, unknown>;
}

export type DoomLoopWarning =
  | { kind: "identical-tail"; toolName: string; fingerprint: string }
  | { kind: "repeated-subsequence"; toolName: string; fingerprint: string; steps: DoomLoopStep[] }
  | { kind: "content-chanting"; count: number }
  | { kind: "action-stagnation"; toolName: string; count: number }
  | { kind: "read-file-loop"; readCount: number; windowSize: number }
  | { kind: "global-duplicate"; toolName: string; count: number; fingerprint: string }

interface ContentChunkRecord {
  hash: string;
  text: string;
  toolName: string;
  shingles: Set<string>;
}

export interface DoomLoopState {
  recentCalls: RecordedToolCall[];
  pendingWarnings: Map<string, DoomLoopWarning>;
  stagedWarnings: Map<string, DoomLoopWarning>;
  contentChunks: ContentChunkRecord[];
  sameNameStreak: number;
  sameNameFingerprints: string[];
  lastSeenToolName: string | null;
  recentToolNames: string[];
  globalFingerprintCounts: Map<string, number>;
  resultFingerprintsByTool: Map<string, Set<string>>;
}

export function createDoomLoopState(): DoomLoopState {
  return {
    recentCalls: [],
    pendingWarnings: new Map<string, DoomLoopWarning>(),
    stagedWarnings: new Map<string, DoomLoopWarning>(),
    contentChunks: [],
    sameNameStreak: 0,
    sameNameFingerprints: [],
    lastSeenToolName: null,
    recentToolNames: [],
    globalFingerprintCounts: new Map<string, number>(),
    resultFingerprintsByTool: new Map<string, Set<string>>(),
  };
}

export function resetDoomLoopState(state: DoomLoopState): void {
  state.recentCalls = [];
  state.pendingWarnings.clear();
  state.stagedWarnings.clear();
  state.contentChunks = [];
  state.sameNameStreak = 0;
  state.sameNameFingerprints = [];
  state.lastSeenToolName = null;
  state.recentToolNames = [];
  state.globalFingerprintCounts.clear();
  state.resultFingerprintsByTool.clear();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function makeToolFingerprint(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}:${stableStringify(input)}`;
}

function sameFingerprints(left: RecordedToolCall[], right: RecordedToolCall[]): boolean {
  return left.length === right.length && left.every((call, index) => call.fingerprint === right[index]?.fingerprint);
}

function hasIdenticalTail(calls: RecordedToolCall[]): boolean {
  if (calls.length < 3) return false;
  const last = calls[calls.length - 1]?.fingerprint;
  return calls[calls.length - 2]?.fingerprint === last && calls[calls.length - 3]?.fingerprint === last;
}

function findRepeatedSubsequenceWindow(calls: RecordedToolCall[]): number | null {
  const maxWindowSize = Math.floor(calls.length / 3);
  for (let windowSize = 2; windowSize <= maxWindowSize; windowSize++) {
    const newest = calls.slice(-windowSize);
    const middle = calls.slice(-windowSize * 2, -windowSize);
    const oldest = calls.slice(-windowSize * 3, -windowSize * 2);
    if (sameFingerprints(newest, middle) && sameFingerprints(middle, oldest)) {
      return windowSize;
    }
  }
  return null;
}

// ─── Content chanting ─────────────────────────────────────────────────────

export const MAX_CONTENT_CHUNKS = 200;
export const CHUNK_SIZE = 50;
export const CONTENT_CHANTING_THRESHOLD = 10;
export const MAX_RESULT_FINGERPRINTS_PER_TOOL = 32;
const CONTENT_SHINGLE_SIZE = 3;
const MIN_CONTENT_SHINGLES = 8;
const CONTENT_SIMILARITY_THRESHOLD = 0.8;

/** Simple string hash for content-chunk comparison (not cryptographic). */
function hashString(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) + s.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// ─── Action stagnation / read-file loop constants ─────────────────────────

export const ACTION_STAGNATION_THRESHOLD = 8;
export const READ_LIKE_STAGNATION_THRESHOLD = 16;
export const MAX_SAME_NAME_FINGERPRINTS = READ_LIKE_STAGNATION_THRESHOLD * 2;
export const READ_FILE_LOOP_WINDOW = 15;
export const READ_FILE_LOOP_THRESHOLD = 12;
export const GLOBAL_DUPLICATE_THRESHOLD = 5;

/** Tool names considered "read-like" for read-file loop detection. */
const READ_LIKE_TOOLS = new Set([
  "read",
  "read_files",
  "search",
  "symbol",
  "inspect",
  "grep",
]);

const CONTEXT_GATHERING_TOOLS = new Set([
  ...READ_LIKE_TOOLS,
  "repo_map",
]);

const HIGH_VOLUME_TOOLS = new Set([...CONTEXT_GATHERING_TOOLS, "bash"]);
const PROGRESS_TOOLS = new Set(["bash", "edit", "write", "graph_mutate"]);

function hasLowInputDiversity(fingerprints: string[]): boolean {
  return new Set(fingerprints).size <= Math.floor(fingerprints.length / 2);
}

function normalizeResultContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

function makeResultFingerprint(content: string): string {
  return `${hashString(content)}:${content.length}`;
}

function makeContentShingles(content: string): Set<string> {
  const tokens = content.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const shingles = new Set<string>();
  for (let i = 0; i <= tokens.length - CONTENT_SHINGLE_SIZE; i++) {
    shingles.add(tokens.slice(i, i + CONTENT_SHINGLE_SIZE).join("\u0000"));
  }
  return shingles;
}

function isSimilarResult(left: ContentChunkRecord, right: ContentChunkRecord): boolean {
  if (left.toolName !== right.toolName) return false;
  if (left.hash === right.hash && left.text === right.text) return true;
  if (Math.min(left.shingles.size, right.shingles.size) < MIN_CONTENT_SHINGLES) return false;

  const [smaller, larger] = left.shingles.size <= right.shingles.size
    ? [left.shingles, right.shingles]
    : [right.shingles, left.shingles];
  let overlap = 0;
  for (const shingle of smaller) {
    if (larger.has(shingle)) overlap++;
  }
  return overlap / larger.size >= CONTENT_SIMILARITY_THRESHOLD;
}

function findCallById(state: DoomLoopState, toolCallId: string): RecordedToolCall | undefined {
  return state.recentCalls.find((call) => call.toolCallId === toolCallId);
}

function isWeakProgressWarning(warning: DoomLoopWarning): boolean {
  return warning.kind === "action-stagnation" || warning.kind === "read-file-loop";
}

// ─── Core API ──────────────────────────────────────────────────────────────

export function recordToolCall(
  state: DoomLoopState,
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown>,
): void {
  const fingerprint = makeToolFingerprint(toolName, input);
  state.recentCalls.push({ toolCallId, toolName, input, fingerprint });
  if (state.recentCalls.length > MAX_RECENT_TOOL_CALLS) {
    const evicted = state.recentCalls.splice(0, state.recentCalls.length - MAX_RECENT_TOOL_CALLS);
    for (const call of evicted) {
      state.pendingWarnings.delete(call.toolCallId);
      state.stagedWarnings.delete(call.toolCallId);
      const next = (state.globalFingerprintCounts.get(call.fingerprint) ?? 0) - 1;
      if (next <= 0) {
        state.globalFingerprintCounts.delete(call.fingerprint);
      } else {
        state.globalFingerprintCounts.set(call.fingerprint, next);
      }
    }
  }

  const globalCount = (state.globalFingerprintCounts.get(fingerprint) ?? 0) + 1;
  state.globalFingerprintCounts.set(fingerprint, globalCount);

  if (hasIdenticalTail(state.recentCalls)) {
    state.stagedWarnings.set(toolCallId, { kind: "identical-tail", toolName, fingerprint });
    return;
  }
  const windowSize = findRepeatedSubsequenceWindow(state.recentCalls);
  if (windowSize !== null) {
    const newest = state.recentCalls.slice(-windowSize);
    state.stagedWarnings.set(toolCallId, {
      kind: "repeated-subsequence",
      toolName,
      fingerprint,
      steps: newest.map((call) => ({ toolName: call.toolName, input: call.input })),
    });
    return;
  }

  if (globalCount >= GLOBAL_DUPLICATE_THRESHOLD) {
    state.stagedWarnings.set(toolCallId, { kind: "global-duplicate", toolName, count: globalCount, fingerprint });
    return;
  }

  // ── Action stagnation ──
  if (toolName === state.lastSeenToolName) {
    state.sameNameStreak++;
    state.sameNameFingerprints.push(fingerprint);
    if (state.sameNameFingerprints.length > MAX_SAME_NAME_FINGERPRINTS) {
      state.sameNameFingerprints.splice(0, state.sameNameFingerprints.length - MAX_SAME_NAME_FINGERPRINTS);
    }
  } else {
    state.sameNameStreak = 1;
    state.sameNameFingerprints = [fingerprint];
    state.lastSeenToolName = toolName;
  }
  const stagnationThreshold = HIGH_VOLUME_TOOLS.has(toolName) ? READ_LIKE_STAGNATION_THRESHOLD : ACTION_STAGNATION_THRESHOLD;
  if (state.sameNameStreak >= stagnationThreshold && hasLowInputDiversity(state.sameNameFingerprints) && !state.pendingWarnings.has(toolCallId) && !state.stagedWarnings.has(toolCallId)) {
    state.stagedWarnings.set(toolCallId, {
      kind: "action-stagnation",
      toolName,
      count: state.sameNameStreak,
    });
  }

  // ── Read-file loop ──
  state.recentToolNames.push(toolName);
  if (state.recentToolNames.length > READ_FILE_LOOP_WINDOW) {
    state.recentToolNames.shift();
  }
  if (state.recentToolNames.length === READ_FILE_LOOP_WINDOW) {
    const contextCount = state.recentToolNames.filter((n) => CONTEXT_GATHERING_TOOLS.has(n)).length;
    const contextKinds = new Set(state.recentToolNames.filter((n) => CONTEXT_GATHERING_TOOLS.has(n))).size;
    const hasProgress = state.recentToolNames.some((n) => PROGRESS_TOOLS.has(n));
    if (contextCount >= READ_FILE_LOOP_THRESHOLD && contextKinds > 1 && !hasProgress && !state.pendingWarnings.has(toolCallId) && !state.stagedWarnings.has(toolCallId)) {
      state.stagedWarnings.set(toolCallId, {
        kind: "read-file-loop",
        readCount: contextCount,
        windowSize: READ_FILE_LOOP_WINDOW,
      });
    }
  }
}

/**
 * Record tool result text for content-chanting detection.
 *
 * Tracks same-tool whole-result similarity in a sliding window. Novel results
 * also clear weak call-pattern warnings before they are injected.
 */
export function recordToolResult(
  state: DoomLoopState,
  toolCallId: string,
  content: string,
): void {
  const normalized = normalizeResultContent(content);
  if (!normalized) {
    state.stagedWarnings.delete(toolCallId);
    return;
  }

  const call = findCallById(state, toolCallId);
  const toolName = call?.toolName ?? "__unknown__";
  const fingerprint = makeResultFingerprint(normalized);
  const result = {
    hash: fingerprint,
    text: normalized,
    toolName,
    shingles: makeContentShingles(normalized),
  };
  const similarResultCount = state.contentChunks.reduce(
    (count, previous) => count + (isSimilarResult(result, previous) ? 1 : 0),
    0,
  );
  let seenForTool = state.resultFingerprintsByTool.get(toolName);
  if (!seenForTool) {
    seenForTool = new Set<string>();
    state.resultFingerprintsByTool.set(toolName, seenForTool);
  }
  const isNovelResult = !seenForTool.has(fingerprint) && similarResultCount === 0;
  seenForTool.add(fingerprint);
  if (seenForTool.size > MAX_RESULT_FINGERPRINTS_PER_TOOL) {
    const excess = seenForTool.size - MAX_RESULT_FINGERPRINTS_PER_TOOL;
    let removed = 0;
    for (const existing of seenForTool) {
      if (removed >= excess) break;
      if (existing === fingerprint) continue;
      seenForTool.delete(existing);
      removed++;
    }
  }

  const pendingWarning = state.pendingWarnings.get(toolCallId);
  if (pendingWarning && isNovelResult && isWeakProgressWarning(pendingWarning)) {
    state.pendingWarnings.delete(toolCallId);
  }

  state.contentChunks.push(result);

  if (state.contentChunks.length > MAX_CONTENT_CHUNKS) {
    state.contentChunks.splice(0, state.contentChunks.length - MAX_CONTENT_CHUNKS);
  }

  // ── Promote staged call-pattern warnings when result content repeats ──
  // Run before content-chanting so its guard prevents overwriting promoted warnings.
  const stagedWarning = state.stagedWarnings.get(toolCallId);
  if (stagedWarning) {
    if (!isNovelResult) {
      state.pendingWarnings.set(toolCallId, stagedWarning);
    }
    state.stagedWarnings.delete(toolCallId);
  }

  const repetitionCount = similarResultCount + 1;
  if (repetitionCount >= CONTENT_CHANTING_THRESHOLD && !state.pendingWarnings.has(toolCallId)) {
    state.pendingWarnings.set(toolCallId, { kind: "content-chanting", count: repetitionCount });
  }
}

export function consumeDoomLoopWarning(
  state: DoomLoopState,
  toolCallId: string,
): DoomLoopWarning | null {
  const warning = state.pendingWarnings.get(toolCallId);
  if (!warning) return null;
  state.pendingWarnings.delete(toolCallId);
  return warning;
}

// ─── Rendering ───────────────────────────────────────────────────────

import {
  SUGGESTIONS,
  type Suggestion,
  GENERIC_SUGGESTION,
} from "./doom-loop-suggestions.js";

const COMPACT_LINE_BUDGET = 80;
const STEP_PREFIX = "  → ";

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return "…";
  return `${value.slice(0, max - 1)}…`;
}

function renderCompactStep(toolName: string, input: Record<string, unknown>): string {
  const keys = Object.keys(input).sort();
  const salient = keys.slice(0, 2);
  const base = `${STEP_PREFIX}${toolName}`;
  if (salient.length === 0) return truncate(`${base} {}`, COMPACT_LINE_BUDGET);
  let line = base;
  for (const key of salient) {
    const rendered = JSON.stringify(input[key]);
    const part = ` ${key}=${rendered}`;
    const candidate = line + part;
    if (candidate.length > COMPACT_LINE_BUDGET) {
      const remaining = COMPACT_LINE_BUDGET - (line + ` ${key}=`).length;
      line = `${line} ${key}=${truncate(rendered, Math.max(1, remaining))}`;
      return line;
    }
    line = candidate;
  }
  return truncate(line, COMPACT_LINE_BUDGET);
}

function parseFingerprintInput(fingerprint: string): Record<string, unknown> {
  const colon = fingerprint.indexOf(":");
  if (colon < 0) return {};
  const json = fingerprint.slice(colon + 1);
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function suggestionsFor(toolName: string): Suggestion[] {
  const entry = SUGGESTIONS[toolName];
  if (entry && entry.length > 0) return [...entry];
  return [{ text: GENERIC_SUGGESTION }];
}

/** Format a DoomLoopSuggestion into a readable line with optional tool hint */
function formatSuggestion(suggestion: Suggestion): string {
  if (typeof suggestion === "string") {
    return `  • ${suggestion}`;
  }
  const bullet = `  • ${suggestion.text}`;
  if (suggestion.toolHint) {
    if (!suggestion.toolInput) {
      return `${bullet}\n    → Consider using: ${suggestion.toolHint}`;
    }
    const inputStr = JSON.stringify(suggestion.toolInput).replace(/\"/g, '"');
    return `${bullet}\n    → Consider calling: ${suggestion.toolHint}(${inputStr})`;
  }
  return bullet;
}

function renderSuggestionBullets(toolNames: string[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const name of toolNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    const bullets = suggestionsFor(name);
    lines.push(`For ${name}:`);
    for (const suggestion of bullets) {
      lines.push(formatSuggestion(suggestion));
    }
  }
  return lines.join("\n");
}

function renderGenericTips(): string {
  return [
    "  • stop and synthesise what is already known before another tool call",
    "  • name the failed pattern, then choose one materially different next action",
    "  • ask the user for direction if no new information path remains",
  ].join("\n");
}

export function formatDoomLoopMessage(warning: DoomLoopWarning): string {
  if (warning.kind === "identical-tail") {
    const input = parseFingerprintInput(warning.fingerprint);
    const compact = renderCompactStep(warning.toolName, input);
    const suggestions = renderSuggestionBullets([warning.toolName]);
    return [
      "⚠ REPEATED-CALL WARNING: This is the 3rd identical tool call.",
      compact,
      "",
      "Continuing this pattern will not make progress. First synthesise what you already know.",
      "Suggestions:",
      suggestions,
    ].join("\n");
  }

  if (warning.kind === "repeated-subsequence") {
    const stepLines = warning.steps.map((step) => renderCompactStep(step.toolName, step.input));
    const suggestions = renderSuggestionBullets(warning.steps.map((step) => step.toolName));
    return [
      `${warning.steps.length > 0 ? `⚠ ALTERNATING-CALL WARNING: You have called this sequence 3 times:` : "⚠ ALTERNATING-CALL WARNING: No repeating steps detected"}`,
      ...stepLines,
      "",
      "Neither call is producing new information. synthesise current evidence, then pick a materially different action.",
      "",
      suggestions,
    ].join("\n");
  }

  if (warning.kind === "content-chanting") {
    return [
      `⚠ CONTENT-CHANTING WARNING: Same output pattern detected ${warning.count}+ times.`,
      "",
      "The tool results have become repetitive. synthesise the repeated evidence before calling another tool.",
      "",
      renderGenericTips(),
    ].join("\n");
  }

  if (warning.kind === "action-stagnation") {
    const suggestions = renderSuggestionBullets([warning.toolName]);
    return [
      `⚠ ACTION-STAGNATION WARNING: Same tool called ${warning.count} times consecutively.`,
      `  → ${warning.toolName}`,
      "",
      "Repeated use of one tool is not producing progress. synthesise current evidence before continuing.",
      "Suggestions:",
      suggestions,
    ].join("\n");
  }

  if (warning.kind === "read-file-loop") {
    return [
      `⚠ READ-FILE-LOOP WARNING: ${warning.readCount}+ read operations in last ${warning.windowSize} calls.`,
      "",
      "Reading more files without acting on what you already have is unlikely to make progress.",
      "Stop reading, synthesising known information, then act with the context already gathered.",
      "",
      renderGenericTips(),
    ].join("\n");
  }

  if (warning.kind === "global-duplicate") {
    const input = parseFingerprintInput(warning.fingerprint);
    const compact = renderCompactStep(warning.toolName, input);
    const suggestions = renderSuggestionBullets([warning.toolName]);
    return [
      `⚠ GLOBAL-DUPLICATE WARNING: Same tool call seen ${warning.count}+ times this turn.`,
      compact,
      "",
      "Repeating this call non-consecutively is still not producing progress. synthesise current evidence before continuing.",
      "",
      suggestions,
    ].join("\n");
  }


  return "⚠ DOOM-LOOP WARNING: The model appears to be stuck in a loop.";
}
