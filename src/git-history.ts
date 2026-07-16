import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CoCommitResult {
  path: string;
  count: number;
  correlation: number; // 0.0 to 1.0 (count / total_commits_of_target)
}

/**
 * Finds the Git repository root for a given path asynchronously.
 */
export async function findGitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Analyzes git history to find files frequently modified in the same commits as the target file.
 * Uses a single git log command to avoid the N+1 query problem.
 */
export async function getCoCommittedFiles(
  cwd: string,
  targetPath: string,
  maxResults = 5,
  maxCommitsToAnalyze = 50
): Promise<CoCommitResult[]> {
  const gitRoot = await findGitRoot(cwd);
  if (!gitRoot) return [];

  const fullPath = isAbsolute(targetPath) ? targetPath : resolve(cwd, targetPath);
  const relTarget = relative(gitRoot, fullPath);

  if (!existsSync(fullPath)) return [];

  try {
    // Get commits and changed files in a single command
    const { stdout } = await execFileAsync(
      "git",
      ["log", "-n", String(maxCommitsToAnalyze), "--name-only", "--format=COMMIT_START", "--", relTarget],
      { cwd: gitRoot, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    );

    const lines = stdout.split(/\r?\n/).map(l => l.trim());
    
    let totalCommits = 0;
    const coCommitCounts = new Map<string, number>();
    let currentCommitFiles = new Set<string>();

    for (const line of lines) {
      if (line === "COMMIT_START") {
        totalCommits++;
        // Tally unique files from the previous commit
        for (const file of currentCommitFiles) {
          if (file !== relTarget && file.length > 0) {
            coCommitCounts.set(file, (coCommitCounts.get(file) || 0) + 1);
          }
        }
        currentCommitFiles = new Set<string>();
      } else if (line.length > 0) {
        currentCommitFiles.add(line);
      }
    }
    
    // Tally the last commit
    for (const file of currentCommitFiles) {
      if (file !== relTarget && file.length > 0) {
        coCommitCounts.set(file, (coCommitCounts.get(file) || 0) + 1);
      }
    }

    if (totalCommits === 0) return [];

    // Sort and format results
    const results: CoCommitResult[] = Array.from(coCommitCounts.entries())
      .map(([path, count]) => ({
        path: resolve(gitRoot, path), // Return absolute paths for consistency
        count,
        correlation: count / totalCommits,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, maxResults);

    return results;
  } catch (err) {
    // Git might not be initialized, or the file has no history
    return [];
  }
}

const recentFilesCache = new Map<string, { timestamp: number; files: Set<string> }>();

/**
 * Determines if a file has been modified within a certain time window (e.g., '1.day.ago').
 * Useful for boosting recently active files in retrieval.
 */
export async function isRecentlyModified(cwd: string, targetPath: string, since = "1.day.ago"): Promise<boolean> {
  const gitRoot = await findGitRoot(cwd);
  if (!gitRoot) return false;

  const cacheKey = `${gitRoot}:${since}`;
  const now = Date.now();
  let cacheEntry = recentFilesCache.get(cacheKey);

  if (!cacheEntry || now - cacheEntry.timestamp > 5 * 60 * 1000) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["log", `--since=${since}`, "--name-only", "--pretty=format:"],
        { cwd: gitRoot, encoding: "utf-8" }
      );
      const files = new Set(stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0));
      cacheEntry = { timestamp: now, files };
      recentFilesCache.set(cacheKey, cacheEntry);
    } catch {
      cacheEntry = { timestamp: now, files: new Set() };
      recentFilesCache.set(cacheKey, cacheEntry);
    }
  }

  const fullPath = isAbsolute(targetPath) ? targetPath : resolve(cwd, targetPath);
  const relTarget = relative(gitRoot, fullPath);

  return cacheEntry.files.has(relTarget);
}

/**
 * Get the last modification time of a file as both ISO string and relative string.
 * Uses `git log -1 --format=%ar` when git root is available, falls back to
 * file mtime ("today" if <1 day, "Unknown" otherwise).
 * Returns null if neither git nor stat succeeds.
 */
export async function fileLastModifiedRelative(
  absolutePath: string,
  cwd: string,
): Promise<{ iso: string; relative: string } | null> {
  const gitRoot = await findGitRoot(cwd);
  if (gitRoot) {
    try {
      const relPath = relative(gitRoot, absolutePath);
      const { stdout } = await execFileAsync(
        "git",
        ["log", "-1", "--format=%ar", "--", relPath],
        { cwd: gitRoot, encoding: "utf-8" },
      );
      const relativeTime = stdout.trim();
      if (relativeTime) {
        const { stdout: isoOut } = await execFileAsync(
          "git",
          ["log", "-1", "--format=%aI", "--", relPath],
          { cwd: gitRoot, encoding: "utf-8" },
        );
        const iso = isoOut.trim();
        if (iso) return { iso, relative: relativeTime };
      }
    } catch {
      // git unavailable or file has no history — fall through to mtime
    }
  }

  // Fallback: file mtime
  try {
    const st = statSync(absolutePath);
    const iso = new Date(st.mtimeMs).toISOString();
    const now = Date.now();
    const diffMs = now - st.mtimeMs;
    const diffDays = diffMs / (24 * 60 * 60 * 1000);
    if (diffDays < 1) {
      return { iso, relative: "today" };
    }
    // Old mtime → no reliable relative string
    return null;
  } catch {
    return null;
  }
}
