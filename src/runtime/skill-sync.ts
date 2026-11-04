/**
 * Skill sync — installs this package's bundled skills (skills/:
 * inspect-script-mode, lsp-cross-root, lsp-explore, lsp-fix, lsp-impact,
 * lsp-local-symbols, lsp-rename, lsp-safe-refactor, lsp-verify) into the
 * user's global Pi skills dir (`<agent-dir>/skills/`, default
 * `~/.pi/agent/skills/`).
 *
 * Agent-dir resolution follows Pi's documented configuration: the agent
 * directory defaults to `~/.pi/agent` and can be overridden with the
 * `PI_CODING_AGENT_DIR` environment variable (see Pi docs
 * `configuration.md` — "Set its location with the `PI_CODING_AGENT_DIR`
 * environment variable" — and `environment-variables.md` —
 * "`PI_CODING_AGENT_DIR`: Override the config directory; default is
 * `~/.pi/agent`"). Pi keeps the first discovered skill with a given name
 * and warns on duplicates, so this sync only manages copies it installed
 * itself (tracked via a `.smartread-managed` marker file) and never
 * touches unmanaged or user-edited content.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_SYNC_OPT_OUT_ENV = "PI_SMARTREAD_SKILL_SYNC";
export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const MANAGED_MARKER = ".smartread-managed";
export const PACKAGE_NAME = "pi-smartread";

export interface SkillSyncReport {
  installed: string[];
  updated: string[];
  removed: string[];
  skippedUnmanaged: string[];
  skippedModified: string[];
  unchanged: string[];
  errors: string[];
  /**
   * Canonical skills root every operation ran under (one `realpath` at
   * sync start). Differs from the configured target when that root was
   * itself a symlink, which is followed once rather than refused.
   */
  canonicalTarget?: string;
}

export interface SkillSyncOptions {
  sourceDir?: string;
  targetDir?: string;
  version?: string;
  dryRun?: boolean;
  /** Internal test seam; defaults to node:fs. */
  fs?: Partial<SkillSyncFs>;
}

interface ManagedMarker {
  package: string;
  /** Skill directory name this marker authorizes. Must equal the dirname. */
  skill: string;
  version: string;
  hash: string;
  files: string[];
}

/** Filesystem operations used by mutating sync steps (internal test seam). */
export interface SkillSyncFs {
  lstatSync: typeof lstatSync;
  mkdtempSync: typeof mkdtempSync;
  realpathSync: typeof realpathSync;
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
}

const defaultFsOps: SkillSyncFs = { lstatSync, mkdtempSync, realpathSync, renameSync, rmSync };

function emptyReport(): SkillSyncReport {
  return {
    installed: [],
    updated: [],
    removed: [],
    skippedUnmanaged: [],
    skippedModified: [],
    unchanged: [],
    errors: [],
  };
}

/** True when the user opted out via `PI_SMARTREAD_SKILL_SYNC=0`. */
export function isSkillSyncOptOut(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SKILL_SYNC_OPT_OUT_ENV] === "0";
}

/**
 * Resolve the Pi agent dir. Defaults to `~/.pi/agent`; `PI_CODING_AGENT_DIR`
 * overrides it (per Pi docs configuration.md / environment-variables.md).
 */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[AGENT_DIR_ENV]?.trim();
  if (override) return override;
  return path.join(homedir(), ".pi", "agent");
}

/** Default sync target: `<agent-dir>/skills`. */
export function resolveDefaultSkillsTargetDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveAgentDir(env), "skills");
}

/** Package root derived from this module's location (src/runtime/skill-sync.ts). */
export function resolvePackageRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(new URL(".", import.meta.url))));
}

/** Default skill source dir: the bundled `skills/` directory in the package. */
export function resolvePackageSkillsSourceDir(): string {
  return path.join(resolvePackageRoot(), "skills");
}

function resolvePackageVersion(): string {
  try {
    const raw = readFileSync(path.join(resolvePackageRoot(), "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version) return parsed.version;
  } catch {
    /* fall through */
  }
  return "unknown";
}

/**
 * Validate a skill directory name. Rejects path separators, dot segments,
 * and anything outside `[A-Za-z0-9_-]` so a crafted source layout can never
 * cause writes outside the target dir.
 */
export function isValidSkillName(name: string): boolean {
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name);
}

/** Recursively list regular files under `dir`, as posix-style relative paths. */
function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, rel: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full, entryRel);
      } else if (entry.isFile()) {
        out.push(entryRel);
      }
    }
  };
  walk(dir, "");
  return out.sort();
}

/** Content hash over sorted `rel\0bytes` pairs. `exclude` holds relative names to skip. */
function hashFiles(dir: string, files: string[], exclude?: Set<string>): string {
  const hash = createHash("sha256");
  for (const rel of files) {
    if (exclude?.has(rel)) continue;
    hash.update(rel, "utf-8");
    hash.update("\0");
    hash.update(readFileSync(path.join(dir, ...rel.split("/"))));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** List skill names in a source dir: subdirectories containing a SKILL.md file. */
function listSourceSkills(sourceDir: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!isValidSkillName(entry.name)) continue;
    if (existsSync(path.join(sourceDir, entry.name, "SKILL.md"))) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

function readMarker(skillDir: string): ManagedMarker | undefined {
  const markerPath = path.join(skillDir, MANAGED_MARKER);
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf-8")) as Partial<ManagedMarker>;
    // The marker must name this exact skill dir: a marker copied (or forged)
    // into a differently named dir authorizes nothing.
    if (
      parsed.package !== PACKAGE_NAME ||
      typeof parsed.skill !== "string" ||
      parsed.skill.length === 0 ||
      parsed.skill !== path.basename(skillDir) ||
      typeof parsed.hash !== "string" ||
      !Array.isArray(parsed.files)
    ) {
      return undefined;
    }
    return {
      package: parsed.package,
      skill: parsed.skill,
      version: typeof parsed.version === "string" ? parsed.version : "unknown",
      hash: parsed.hash,
      files: parsed.files.filter((f): f is string => typeof f === "string"),
    };
  } catch {
    return undefined;
  }
}

function copyDirContents(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      copyDirContents(src, dest);
    } else if (entry.isFile()) {
      writeFileSync(dest, readFileSync(src));
    }
  }
}

function writeMarkerFile(skillDir: string, marker: ManagedMarker): void {
  writeFileSync(path.join(skillDir, MANAGED_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
}

function assertDirUsable(
  label: string,
  dir: string,
  stat: { isSymbolicLink(): boolean; isDirectory(): boolean },
): void {
  if (stat.isSymbolicLink()) throw new Error(`refused: ${label} is a symlink: ${dir}`);
  if (!stat.isDirectory()) throw new Error(`refused: ${label} is not a directory: ${dir}`);
}

/**
 * Atomically install `srcSkillDir` content at `targetSkillDir` (+ marker) by
 * staging into a sibling temp dir and renaming. An existing target is moved
 * aside first, then removed after the new dir is in place. If moving the
 * staged dir into place fails, the old dir is restored so the skill is
 * never left missing. Aside/staging paths are freshly created unique dirs;
 * pre-existing paths are never deleted.
 */
function atomicInstall(
  srcSkillDir: string,
  targetSkillDir: string,
  marker: ManagedMarker,
  fsOps: SkillSyncFs = defaultFsOps,
): void {
  const parent = path.dirname(targetSkillDir);
  mkdirSync(parent, { recursive: true });
  // Re-lstat the target root immediately before mutating: a symlink swap
  // after the one-time sync check must not be followed.
  assertDirUsable("skills target", parent, fsOps.lstatSync(parent));
  const staging = fsOps.mkdtempSync(path.join(parent, ".smartread-staging-"));
  let asideRoot: string | undefined;
  let aside: string | undefined;
  try {
    copyDirContents(srcSkillDir, staging);
    writeMarkerFile(staging, marker);
    if (existsSync(targetSkillDir)) {
      // Re-lstat the specific skill path immediately before the rename.
      assertDirUsable("target skill dir", targetSkillDir, fsOps.lstatSync(targetSkillDir));
      asideRoot = fsOps.mkdtempSync(path.join(parent, ".smartread-old-"));
      aside = path.join(asideRoot, path.basename(targetSkillDir));
      fsOps.renameSync(targetSkillDir, aside);
      // Re-check the root immediately before moving the new dir in place
      // (rename over an existing dir fails on Windows, so the target
      // path must still be free and the root still a real dir).
      assertDirUsable("skills target", parent, fsOps.lstatSync(parent));
    }
    fsOps.renameSync(staging, targetSkillDir);
  } catch (err) {
    try {
      fsOps.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
    if (aside !== undefined) {
      try {
        if (!existsSync(targetSkillDir)) fsOps.renameSync(aside, targetSkillDir);
      } catch {
        /* restore attempted; the original error below still reports */
      }
    }
    if (asideRoot !== undefined && (aside === undefined || !existsSync(aside))) {
      try {
        fsOps.rmSync(asideRoot, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
    throw err;
  }
  if (asideRoot !== undefined) {
    try {
      fsOps.rmSync(asideRoot, { recursive: true, force: true });
    } catch {
      /* stale aside dir is harmless; leave it */
    }
  }
}

function buildMarker(sourceSkillDir: string, skillName: string, version: string): ManagedMarker {
  const files = listFilesRecursive(sourceSkillDir);
  return {
    package: PACKAGE_NAME,
    skill: skillName,
    version,
    hash: hashFiles(sourceSkillDir, files),
    files,
  };
}

/**
 * Sync bundled skills into the global skills dir.
 *
 * Rules per skill:
 * - target missing → install (atomic copy + marker).
 * - target exists without a marker → never touch (`skippedUnmanaged`).
 * - marker present but current content hash differs → user-edited, skip
 *   (`skippedModified`).
 * - marker present, unmodified, source hash differs → update.
 * - a managed, unmodified copy whose skill vanished from the source →
 *   remove. User-edited copies are never removed.
 * - the skills root is resolved with realpath once at sync start and every
 *   operation runs under that canonical root, so swapping the configured
 *   root for a symlink afterwards has no effect. A configured root that is
 *   itself a symlink is followed once (recorded as
 *   `report.canonicalTarget`), not refused.
 * - symlinks below the root (a skill dir) are never followed; the affected
 *   skill is reported in `errors`.
 */
export function syncSmartReadSkills(options: SkillSyncOptions = {}): SkillSyncReport {
  const report = emptyReport();
  if (isSkillSyncOptOut()) return report;

  const sourceDir = options.sourceDir ?? resolvePackageSkillsSourceDir();
  const configuredTarget = options.targetDir ?? resolveDefaultSkillsTargetDir();
  const version = options.version ?? resolvePackageVersion();
  const dryRun = options.dryRun === true;
  const fsOps: SkillSyncFs = { ...defaultFsOps, ...options.fs };

  let sourceSkills: string[];
  try {
    sourceSkills = listSourceSkills(sourceDir);
  } catch (err) {
    report.errors.push(`source skills dir unreadable: ${sourceDir} (${(err as Error).message})`);
    return report;
  }
  const sourceSet = new Set(sourceSkills);

  // Resolve the skills root with realpath once, after creating it if
  // needed and verifying it is a directory. Every operation below runs on
  // paths under this canonical root, so swapping the configured root for a
  // symlink afterwards cannot redirect installs or removals. A configured
  // root that is itself a symlink is followed once (recorded as
  // report.canonicalTarget), not refused.
  // Residual race (accepted, out of scope): swapping an *ancestor* of the
  // canonical root afterwards can still redirect paths, but that requires
  // write access to the user's home directory — a local attacker who
  // already owns the skills — and Node offers no openat-bound rm to close
  // it. See E5 in docs/plans/2026-10-07-tool-ergonomics-decision-log.md.
  let targetDir: string;
  try {
    if (!existsSync(configuredTarget)) {
      if (dryRun) {
        // Nothing exists to canonicalize and nothing will be written.
        targetDir = configuredTarget;
      } else {
        mkdirSync(configuredTarget, { recursive: true });
        targetDir = fsOps.realpathSync(configuredTarget);
      }
    } else {
      const rootStat = fsOps.lstatSync(configuredTarget);
      if (!rootStat.isDirectory() && !rootStat.isSymbolicLink()) {
        report.errors.push(`refused: skills target is not a directory: ${configuredTarget}`);
        return report;
      }
      targetDir = fsOps.realpathSync(configuredTarget);
      const canonicalStat = fsOps.lstatSync(targetDir);
      if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) {
        report.errors.push(`refused: skills target is not a directory: ${configuredTarget}`);
        return report;
      }
    }
  } catch (err) {
    report.errors.push(`skills target unusable: ${configuredTarget} (${(err as Error).message})`);
    return report;
  }
  report.canonicalTarget = targetDir;

  for (const name of sourceSkills) {
    const srcSkillDir = path.join(sourceDir, name);
    const targetSkillDir = path.join(targetDir, name);
    let sourceMarker: ManagedMarker;
    try {
      sourceMarker = buildMarker(srcSkillDir, name, version);
    } catch (err) {
      report.errors.push(`${name}: cannot read source skill (${(err as Error).message})`);
      continue;
    }

    if (!existsSync(targetSkillDir)) {
      if (dryRun) {
        report.installed.push(name);
        continue;
      }
      try {
        atomicInstall(srcSkillDir, targetSkillDir, sourceMarker, fsOps);
        report.installed.push(name);
      } catch (err) {
        report.errors.push(`${name}: install failed (${(err as Error).message})`);
      }
      continue;
    }

    let targetStat;
    try {
      targetStat = lstatSync(targetSkillDir);
    } catch (err) {
      report.errors.push(`${name}: cannot stat target (${(err as Error).message})`);
      continue;
    }
    if (targetStat.isSymbolicLink()) {
      report.errors.push(`${name}: refused, target skill dir is a symlink`);
      continue;
    }
    if (!targetStat.isDirectory()) {
      report.errors.push(`${name}: refused, target exists and is not a directory`);
      continue;
    }

    const marker = readMarker(targetSkillDir);
    if (!marker) {
      report.skippedUnmanaged.push(name);
      continue;
    }
    const currentFiles = listFilesRecursive(targetSkillDir);
    const currentHash = hashFiles(targetSkillDir, currentFiles, new Set([MANAGED_MARKER]));
    if (currentHash !== marker.hash) {
      report.skippedModified.push(name);
      continue;
    }
    if (marker.hash === sourceMarker.hash) {
      report.unchanged.push(name);
      continue;
    }
    if (dryRun) {
      report.updated.push(name);
      continue;
    }
    try {
      atomicInstall(srcSkillDir, targetSkillDir, sourceMarker, fsOps);
      report.updated.push(name);
    } catch (err) {
      report.errors.push(`${name}: update failed (${(err as Error).message})`);
    }
  }

  // Removal pass: managed, unmodified copies of skills no longer shipped.
  let targetEntries;
  try {
    targetEntries = readdirSync(targetDir, { withFileTypes: true });
  } catch (err) {
    if (!dryRun || existsSync(targetDir)) {
      report.errors.push(`cannot list skills target: ${targetDir} (${(err as Error).message})`);
    }
    return report;
  }
  for (const entry of targetEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (sourceSet.has(entry.name)) continue;
    const targetSkillDir = path.join(targetDir, entry.name);
    const marker = readMarker(targetSkillDir);
    if (!marker) continue;
    const currentFiles = listFilesRecursive(targetSkillDir);
    const currentHash = hashFiles(targetSkillDir, currentFiles, new Set([MANAGED_MARKER]));
    if (currentHash !== marker.hash) {
      report.skippedModified.push(entry.name);
      continue;
    }
    if (dryRun) {
      report.removed.push(entry.name);
      continue;
    }
    try {
      // Re-lstat the root and the skill path immediately before removing:
      // a symlink swap after the earlier check must not be followed.
      assertDirUsable("skills target", targetDir, fsOps.lstatSync(targetDir));
      assertDirUsable("target skill dir", targetSkillDir, fsOps.lstatSync(targetSkillDir));
      fsOps.rmSync(targetSkillDir, { recursive: true, force: true });
      report.removed.push(entry.name);
    } catch (err) {
      report.errors.push(`${entry.name}: removal failed (${(err as Error).message})`);
    }
  }

  return report;
}
