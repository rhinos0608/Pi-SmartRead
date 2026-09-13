import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { findGitRoot } from "./git-history.js";

export { findGitRoot } from "./git-history.js";

const execFileAsync = promisify(execFile);
const DEFAULT_LOG_LIMIT = 30;
const DEFAULT_COCOMMIT_LIMIT = 100;
const MIN_COCOMMIT_CORRELATION = 0.15;
const MIN_COCOMMIT_COUNT = 2;
const MAX_COCOMMIT_PAIRS = 200;
const HIGH_SIGNAL_TRAILERS = new Set(["Constraint", "Directive", "Rejected"]);

interface ExecResult {
  stdout: string;
}

export interface CommitRecord {
  hash: string;
  isoDate: string;
  relativeDate: string;
  author: string;
  subject: string;
  body?: string;
  trailers: CommitTrailer[];
  filesChanged: string[];
}

export interface CommitTrailer {
  key: string;
  value: string;
}

export interface CoCommitPair {
  fromPath: string;
  toPath: string;
  count: number;
  correlation: number;
}

export interface GitContextResult {
  contextString: string | null;
  coCommitPairs: CoCommitPair[];
  branchCommits: CommitRecord[];
  branchPoint: string | null;
  defaultBranch: string | null;
}

export interface LogOptions {
  branchPoint?: string;
  limit?: number;
  since?: string;
  includeFiles?: boolean;
  includeBody?: boolean;
}

export async function detectDefaultBranch(gitRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd: gitRoot,
      encoding: "utf-8",
    }) as ExecResult;
    const ref = stdout.trim();
    if (ref.startsWith("refs/remotes/origin/")) {
      return ref.slice("refs/remotes/origin/".length);
    }
  } catch {
  }

  for (const branch of ["main", "master"]) {
    if (await gitRefExists(gitRoot, branch) || await gitRefExists(gitRoot, `origin/${branch}`)) {
      return branch;
    }
  }

  return null;
}

export async function findBranchPoint(gitRoot: string, defaultBranch: string | null): Promise<string | null> {
  if (!defaultBranch) return null;

  const currentBranch = await getCurrentBranch(gitRoot);
  if (currentBranch === defaultBranch) return null;

  let head: string | null = null;
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: gitRoot,
      encoding: "utf-8",
    }) as ExecResult;
    head = result.stdout.trim();
  } catch {
    return null;
  }

  for (const candidate of [defaultBranch, `origin/${defaultBranch}`]) {
    try {
      const { stdout } = await execFileAsync("git", ["merge-base", "HEAD", candidate], {
        cwd: gitRoot,
        encoding: "utf-8",
      }) as ExecResult;
      const branchPoint = stdout.trim();
      if (branchPoint && branchPoint !== head) return branchPoint;
      if (branchPoint === head) return null;
    } catch {
    }
  }

  return null;
}

export async function getStructuredLog(gitRoot: string, options: LogOptions = {}): Promise<CommitRecord[]> {
  const format = options.includeBody === false
    ? "format:%x1e%h%x00%aI%x00%ar%x00%an%x00%s%x00%x00"
    : "format:%x1e%h%x00%aI%x00%ar%x00%an%x00%s%x00%b%x00";
  const args = ["log"];

  if (options.branchPoint) args.push(`${options.branchPoint}..HEAD`);
  if (options.limit !== undefined) args.push("-n", String(options.limit));
  else if (!options.since) args.push("-n", String(DEFAULT_LOG_LIMIT));
  if (options.since) args.push(`--since=${options.since}`);
  args.push(`--format=${format}`);
  if (options.includeFiles) args.push("--name-only");

  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: gitRoot,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    }) as ExecResult;
    return parseStructuredLogOutput(stdout);
  } catch {
    return [];
  }
}

export function parseCommitTrailers(body: string): CommitTrailer[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  if (lines.length === 0) return [];

  let start = lines.length - 1;
  while (start >= 0 && lines[start]?.trim() !== "") start--;
  const trailerLines = lines.slice(start + 1).map((line) => line.trim()).filter(Boolean);
  if (trailerLines.length === 0) return [];
  if (start < 0 && lines.length !== trailerLines.length) return [];

  const trailers: CommitTrailer[] = [];
  for (const line of trailerLines) {
    const match = /^([A-Z][A-Za-z0-9-]*):\s*(.+)$/.exec(line);
    if (!match) return [];
    trailers.push({ key: match[1]!, value: match[2]!.trim() });
  }
  return trailers;
}

export async function extractCoCommitPairs(gitRoot: string, limit = DEFAULT_COCOMMIT_LIMIT): Promise<CoCommitPair[]> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      "git",
      ["log", "-n", String(limit), "--name-only", "--format=format:COMMIT_START"],
      { cwd: gitRoot, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
    ) as ExecResult;
    stdout = result.stdout;
  } catch {
    return [];
  }

  const commits: string[][] = [];
  let current = new Set<string>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "COMMIT_START") {
      if (current.size > 0) commits.push([...current]);
      current = new Set<string>();
    } else if (line) {
      current.add(line);
    }
  }
  if (current.size > 0) commits.push([...current]);
  if (commits.length === 0) return [];

  const counts = new Map<string, { fromPath: string; toPath: string; count: number }>();
  for (const files of commits) {
    const sorted = [...files].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const fromPath = sorted[i]!;
        const toPath = sorted[j]!;
        const key = `${fromPath}\0${toPath}`;
        const existing = counts.get(key);
        if (existing) existing.count += 1;
        else counts.set(key, { fromPath, toPath, count: 1 });
      }
    }
  }

  return [...counts.values()]
    .map((pair) => ({
      ...pair,
      correlation: pair.count / commits.length,
    }))
    .filter((pair) => pair.count >= MIN_COCOMMIT_COUNT && pair.correlation >= MIN_COCOMMIT_CORRELATION)
    .sort((a, b) => b.correlation - a.correlation || b.count - a.count || a.fromPath.localeCompare(b.fromPath))
    .slice(0, MAX_COCOMMIT_PAIRS);
}

export async function getFileCommitContext(gitRoot: string, relPath: string, limit = 3): Promise<CommitRecord[]> {
  const format = "format:%x1e%h%x00%aI%x00%ar%x00%an%x00%s%x00%b%x00";
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "-n", String(limit), "--follow", `--format=${format}`, "--", relPath],
      { cwd: gitRoot, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 },
    ) as ExecResult;
    return parseStructuredLogOutput(stdout);
  } catch {
    return [];
  }
}

export async function autoPopulateEdgeStore(gitRoot: string, pairs: CoCommitPair[]): Promise<void> {
  if (pairs.length === 0) return;

  const { EdgeStore } = await import("./context-graph.js");
  if (EdgeStore.readEdges(gitRoot).length > 0) return;

  for (const pair of pairs) {
    const context = `git co-commit count=${pair.count} correlation=${pair.correlation.toFixed(2)}`;
    EdgeStore.recordCoChange(gitRoot, pair.fromPath, pair.toPath, context, pair.correlation);
    EdgeStore.recordCoChange(gitRoot, pair.toPath, pair.fromPath, context, pair.correlation);
  }
}

export async function buildStartupGitContext(cwd: string, tokenBudget = 1800): Promise<GitContextResult> {
  const gitRoot = await findGitRoot(cwd);
  if (!gitRoot) {
    return emptyGitContext();
  }

  const [defaultBranch, currentBranch] = await Promise.all([
    detectDefaultBranch(gitRoot),
    getCurrentBranch(gitRoot),
  ]);
  const branchPoint = await findBranchPoint(gitRoot, defaultBranch);
  const logLimit = branchPoint ? 30 : 20;
  const [branchCommits, coCommitPairs] = await Promise.all([
    getStructuredLog(gitRoot, { branchPoint: branchPoint ?? undefined, limit: logLimit, includeBody: true }),
    extractCoCommitPairs(gitRoot, DEFAULT_COCOMMIT_LIMIT),
  ]);

  const contextString = formatStartupGitContext({
    currentBranch,
    defaultBranch,
    branchPoint,
    branchCommits,
    coCommitPairs,
    tokenBudget,
  });

  return {
    contextString,
    coCommitPairs,
    branchCommits,
    branchPoint,
    defaultBranch,
  };
}

export function parseStructuredLogOutput(output: string): CommitRecord[] {
  const records: CommitRecord[] = [];
  for (const rawRecord of output.split("\x1e")) {
    const record = rawRecord.trim();
    if (!record) continue;

    const fields = record.split("\0");
    if (fields.length < 6) continue;

    const hash = fields[0]?.trim();
    if (!hash) continue;

    const body = fields[5] ?? "";
    const fileTail = fields.slice(6).join("\0");
    const filesChanged = fileTail
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    records.push({
      hash,
      isoDate: fields[1]?.trim() ?? "",
      relativeDate: fields[2]?.trim() ?? "",
      author: fields[3]?.trim() ?? "",
      subject: fields[4]?.trim() ?? "",
      body: body.trim() || undefined,
      trailers: parseCommitTrailers(body),
      filesChanged,
    });
  }
  return records;
}

async function gitRefExists(gitRoot: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", ref], {
      cwd: gitRoot,
      encoding: "utf-8",
    });
    return true;
  } catch {
    return false;
  }
}

async function getCurrentBranch(gitRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: gitRoot,
      encoding: "utf-8",
    }) as ExecResult;
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

function formatStartupGitContext(input: {
  currentBranch: string | null;
  defaultBranch: string | null;
  branchPoint: string | null;
  branchCommits: CommitRecord[];
  coCommitPairs: CoCommitPair[];
  tokenBudget: number;
}): string | null {
  if (input.branchCommits.length === 0 && input.coCommitPairs.length === 0) return null;

  const lines: string[] = ["## Git Context"];
  const branch = input.currentBranch ?? "detached HEAD";
  if (input.branchPoint && input.defaultBranch) {
    lines.push(`Branch: ${branch} (${input.branchCommits.length} commits since ${input.defaultBranch})`);
  } else if (input.defaultBranch) {
    lines.push(`Branch: ${branch} (default: ${input.defaultBranch})`);
  } else {
    lines.push(`Branch: ${branch}`);
  }

  if (input.branchCommits.length > 0) {
    lines.push("", "Recent commits:");
    for (const commit of input.branchCommits) {
      lines.push(`  ${commit.hash} (${commit.relativeDate}) ${commit.subject}`);
      for (const trailer of commit.trailers) {
        if (HIGH_SIGNAL_TRAILERS.has(trailer.key)) {
          lines.push(`    ${trailer.key}: ${trailer.value}`);
        }
      }
    }
  }

  const hotspots = input.coCommitPairs.filter((pair) => pair.correlation >= 0.3);
  if (hotspots.length > 0) {
    lines.push("", "Co-changed files (coupling from last 100 commits):");
    for (const pair of hotspots.slice(0, 20)) {
      lines.push(`  ${pair.fromPath} ↔ ${pair.toPath}  [${pair.correlation.toFixed(2)}]`);
    }
  }

  return clampLinesToTokenBudget(lines, input.tokenBudget);
}

function clampLinesToTokenBudget(lines: string[], tokenBudget: number): string {
  const maxChars = Math.max(0, tokenBudget) * 4;
  const kept: string[] = [];
  let chars = 0;

  for (const line of lines) {
    const nextChars = chars + line.length + 1;
    if (kept.length > 0 && nextChars > maxChars) break;
    kept.push(line);
    chars = nextChars;
  }

  return kept.join("\n");
}

function emptyGitContext(): GitContextResult {
  return {
    contextString: null,
    coCommitPairs: [],
    branchCommits: [],
    branchPoint: null,
    defaultBranch: null,
  };
}
