import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  unlinkSync,
  rmSync,
  openSync,
  closeSync,
  symlinkSync,
  copyFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn as nodeSpawn } from "node:child_process";

// Storage root: ~/.pi/agent/language-intelligence/ — injectable homedir for tests
export function getInstallerStorageRoot(home = homedir()): string {
  return join(home, ".pi", "agent", "language-intelligence");
}

function packagesDir(home = homedir()): string {
  return join(getInstallerStorageRoot(home), "packages");
}
function binDir(home = homedir()): string {
  return join(getInstallerStorageRoot(home), "bin");
}
function locksDir(home = homedir()): string {
  return join(getInstallerStorageRoot(home), "locks");
}
function lockfilePath(home = homedir()): string {
  return join(getInstallerStorageRoot(home), "runtime.lock.json");
}
function lockPathFor(packageName: string, home = homedir()): string {
  return join(locksDir(home), `${packageName}.lock`);
}

// Lockfile schema
export interface LockfileEntry {
  packageName: string;
  version: string;
  resolvedBinPath: string;
  installedAt: string;
  platform: string;
  arch: string;
}
export interface Lockfile {
  servers: Record<string, LockfileEntry>;
}

export function readLockfile(home = homedir()): Lockfile {
  const p = lockfilePath(home);
  try {
    if (!existsSync(p)) return { servers: {} };
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { servers: {} };
    const servers = (parsed as Record<string, unknown>).servers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { servers: {} };
    // validate entries minimally
    const out: Record<string, LockfileEntry> = {};
    for (const [k, v] of Object.entries(servers as Record<string, unknown>)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const e = v as Record<string, unknown>;
      if (
        typeof e.packageName === "string" &&
        typeof e.version === "string" &&
        typeof e.resolvedBinPath === "string" &&
        typeof e.installedAt === "string"
      ) {
        out[k] = {
          packageName: e.packageName,
          version: e.version,
          resolvedBinPath: e.resolvedBinPath,
          installedAt: e.installedAt,
          platform: typeof e.platform === "string" ? e.platform : process.platform,
          arch: typeof e.arch === "string" ? e.arch : process.arch,
        };
      }
    }
    return { servers: out };
  } catch {
    return { servers: {} };
  }
}

function writeLockfileAtomic(lockfile: Lockfile, home = homedir()): void {
  const p = lockfilePath(home);
  const dir = dirname(p);
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const tmp = `${p}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmp, JSON.stringify(lockfile, null, 2), "utf-8");
    renameSync(tmp, p);
  } catch {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw new Error("failed to persist lockfile");
  }
  try {
    const files = readdirSync(dir);
    for (const f of files) {
      if (f.startsWith("runtime.lock.json.tmp.")) {
        try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function ensureDirs(home = homedir()): void {
  for (const d of [getInstallerStorageRoot(home), packagesDir(home), binDir(home), locksDir(home), join(getInstallerStorageRoot(home), "logs")]) {
    try { mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  }
}

// Cross-process advisory lock using exclusive-create
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;
const STALE_LOCK_MARGIN_MS = 60_000;
export function _staleThresholdMsForTests(timeoutMs: number): number {
  // no-timeout (<=0/NaN/Infinity) installs are unbounded — use generous fallback so crash-recovery does not reclaim active installs
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_INSTALL_TIMEOUT_MS + STALE_LOCK_MARGIN_MS;
  return timeoutMs + STALE_LOCK_MARGIN_MS;
}
async function acquireLock(packageName: string, home = homedir(), installTimeoutMs: number = DEFAULT_INSTALL_TIMEOUT_MS, lockRetryTimeoutMs?: number): Promise<{ ok: true; fd: number; path: string; token: string } | { ok: false; error: string }> {
  const lp = lockPathFor(packageName, home);
  try { mkdirSync(dirname(lp), { recursive: true }); } catch { /* ignore */ }
  const timeoutMs = lockRetryTimeoutMs ?? 5000;
  // no-timeout installs use generous fallback (crash-recovery only, not perf opt) to avoid reclaiming active long-running installs
  const staleThresholdMs = (!Number.isFinite(installTimeoutMs) || installTimeoutMs <= 0) ? DEFAULT_INSTALL_TIMEOUT_MS + STALE_LOCK_MARGIN_MS : installTimeoutMs + STALE_LOCK_MARGIN_MS;
  const start = Date.now();
  let delay = 20;
  while (true) {
    try {
      const fd = openSync(lp, "wx");
      const token = `${process.pid}:${Date.now()}:${staleThresholdMs}`;
      try { writeSync(fd, token); } catch { /* ignore */ }
      return { ok: true, fd, path: lp, token };
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") {
        return { ok: false, error: `failed to acquire lock for ${packageName}: ${String(e)}` };
      }
      // stale lock detection — threshold derived from install timeout, stored in lock file if available
      try {
        // read stored threshold from lock content if present (pid:timestamp:threshold)
        let effectiveThreshold = staleThresholdMs;
        try {
          const content = readFileSync(lp, "utf-8");
          const stored = Number(content.split(":")[2]);
          if (Number.isFinite(stored) && stored > 0) effectiveThreshold = stored;
        } catch { /* ignore — empty or unreadable, keep caller's threshold */ }
        const st = statSync(lp);
        const age = Date.now() - st.mtimeMs;
        if (age > effectiveThreshold) {
          try { unlinkSync(lp); } catch { /* ignore */ }
          // log reclamation — best effort via console warn (caller can observe via onLog if needed)
          try { console.warn(`reclaimed stale lock for ${packageName} (age ${Math.round(age)}ms)`); } catch { /* ignore */ }
          continue;
        }
        // also check content timestamp if available (PID:timestamp[:threshold])
        try {
          const content = readFileSync(lp, "utf-8");
          const ts = Number(content.split(":")[1]);
          if (Number.isFinite(ts) && Date.now() - ts > effectiveThreshold) {
            try { unlinkSync(lp); } catch { /* ignore */ }
            continue;
          }
        } catch { /* ignore — empty or unreadable */ }
      } catch { /* ignore stat failure */ }
      if (Date.now() - start >= timeoutMs) {
        return { ok: false, error: `install already in progress for ${packageName}` };
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 200);
    }
  }
}

function releaseLock(fd: number, path: string, token?: string): void {
  try { closeSync(fd); } catch { /* ignore */ }
  if (token !== undefined) {
    try {
      const cur = readFileSync(path, "utf-8");
      if (cur !== token) return;
    } catch { return; /* file missing/unreadable — don't unlink; another process may own it */ }
  }
  try { unlinkSync(path); } catch { /* ignore */ }
}

// Allow tests to inject a fake spawn
let spawnImpl: typeof nodeSpawn = nodeSpawn;
export function _setSpawnForTests(fn: typeof nodeSpawn): void {
  spawnImpl = fn;
}
export function _resetSpawnForTests(): void {
  spawnImpl = nodeSpawn;
  _forceRenameFailNext = false;
  _forceLockfileFailNext = false;
  _forceRestoreFailNext = false;
}
let _forceRenameFailNext = false;
let _forceLockfileFailNext = false;
let _forceRestoreFailNext = false;
export function _setRenameFailureForTests(v: boolean): void {
  _forceRenameFailNext = v;
}
export function _setLockfileFailureForTests(v: boolean): void {
  _forceLockfileFailNext = v;
}
export function _setRestoreFailureForTests(v: boolean): void {
  _forceRestoreFailNext = v;
}

export type ManagedInstall = { packageName: string; version: string; bin: string };

export function isServerInstalled(packageName: string, version: string, home = homedir()): boolean {
  const lf = readLockfile(home);
  for (const entry of Object.values(lf.servers)) {
    if (entry.packageName === packageName && entry.version === version) {
      if (existsSync(entry.resolvedBinPath)) return true;
    }
  }
  return false;
}

export function getInstalledBinPath(packageName: string, bin: string, home = homedir()): string | null {
  const lf = readLockfile(home);
  // key is bin; also search by values for robustness
  const byKey = lf.servers[bin];
  if (byKey && byKey.packageName === packageName && existsSync(byKey.resolvedBinPath)) return byKey.resolvedBinPath;
  for (const entry of Object.values(lf.servers)) {
    if (entry.packageName === packageName && (entry.resolvedBinPath.endsWith(`/${bin}`) || entry.resolvedBinPath.endsWith(`\\${bin}`))) {
      if (existsSync(entry.resolvedBinPath)) return entry.resolvedBinPath;
    }
  }
  // Also check entry with matching bin in key but different package? already handled
  // Fallback: check if any entry's bin matches requested bin and package matches
  for (const [k, entry] of Object.entries(lf.servers)) {
    if (k === bin && entry.packageName === packageName) {
      if (existsSync(entry.resolvedBinPath)) return entry.resolvedBinPath;
    }
  }
  return null;
}

function runSpawn(
  args: string[],
  opts: { onLog?: (line: string) => void; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise((resolve) => {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const proc = spawnImpl(npmCmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    } as never);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { (proc as unknown as { kill: (sig?: string) => void }).kill("SIGTERM"); } catch { /* ignore */ }
        setTimeout(() => {
          try { (proc as unknown as { kill: (sig?: string) => void }).kill("SIGKILL"); } catch { /* ignore */ }
        }, 2000);
      }, timeoutMs);
    }

    const onData = (chunk: Buffer | string, isErr: boolean) => {
      const text = chunk.toString();
      if (isErr) stderr += text;
      else stdout += text;
      if (opts.onLog) {
        const lines = text.split("\n");
        for (const l of lines) if (l.trim()) opts.onLog(l);
      }
    };

    // proc.stdout/stderr may be null in mocked spawn; guard
    try { (proc.stdout as unknown as { on: (ev: string, fn: (c: Buffer) => void) => void })?.on("data", (c) => onData(c, false)); } catch { /* ignore */ }
    try { (proc.stderr as unknown as { on: (ev: string, fn: (c: Buffer) => void) => void })?.on("data", (c) => onData(c, true)); } catch { /* ignore */ }
    proc.on("error", (err: Error) => {
      if (timer) clearTimeout(timer);
      stderr += String(err.message);
      resolve({ code: 1, stdout, stderr });
    });
    proc.on("close", (code: number | null) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        resolve({ code: 1, stdout, stderr: stderr + "\ninstall timed out" });
      } else {
        resolve({ code, stdout, stderr });
      }
    });
  });
}

export async function installServer(
  managedInstall: ManagedInstall,
  opts: { onLog?: (line: string) => void; homedir?: string; timeoutMs?: number; lockRetryTimeoutMs?: number } = {},
): Promise<{ ok: true; binPath: string } | { ok: false; error: string }> {
  const home = opts.homedir ?? homedir();
  const { packageName, version, bin } = managedInstall;
  ensureDirs(home);

  const lock = await acquireLock(packageName, home, opts.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS, opts.lockRetryTimeoutMs);
  if (!lock.ok) return { ok: false, error: lock.error };

  let tempDir: string | null = null;
  try {
    const pkgRoot = join(packagesDir(home), packageName);
    // Create temp install dir
    const tmpBase = join(packagesDir(home), `.tmp-${packageName}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDir = tmpBase;
    try { mkdirSync(tempDir, { recursive: true }); } catch (e) {
      return { ok: false, error: `failed to create temp dir: ${String(e)}` };
    }

    const npmArgs = [
      "install",
      "--prefix",
      tempDir,
      `${packageName}@${version}`,
      "--ignore-scripts",
      "--no-audit",
      "--fund=false",
    ];

    const result = await runSpawn(npmArgs, { onLog: opts.onLog, timeoutMs: opts.timeoutMs ?? 120_000 });

    if (result.code !== 0) {
      // cleanup temp
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      tempDir = null;
      const msg = result.stderr.trim() || result.stdout.trim() || `npm install failed with code ${result.code}`;
      return { ok: false, error: msg.slice(0, 2000) };
    }

    // Verify bin exists in temp install
    const candidateBin = join(tempDir, "node_modules", ".bin", bin);
    // Also handle .cmd on windows alternative check — but spec says exact bin name, so check existence
    if (!existsSync(candidateBin)) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      tempDir = null;
      return { ok: false, error: `installed package missing expected bin: ${bin} not found at ${candidateBin}` };
    }

    // Atomic swap with backup/restore to preserve prior install on failure
    const backupPath = `${pkgRoot}.bak`;
    let usedBackup = false;
    try {
      // remove stale backup if any
      if (existsSync(backupPath)) {
        try { rmSync(backupPath, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      if (existsSync(pkgRoot)) {
        renameSync(pkgRoot, backupPath);
        usedBackup = true;
      }
      if (_forceRenameFailNext) {
        _forceRenameFailNext = false;
        throw new Error("mock rename failure");
      }
      renameSync(tempDir, pkgRoot);
      tempDir = null;
    } catch (e) {
      let restoreFailed = false;
      let restoreErr: unknown = null;
      if (usedBackup) {
        try {
          if (existsSync(pkgRoot)) {
            try { rmSync(pkgRoot, { recursive: true, force: true }); } catch { /* ignore */ }
          }
          if (_forceRestoreFailNext) { throw new Error("mock restore failure"); }
          renameSync(backupPath, pkgRoot);
        } catch (re) {
          restoreErr = re;
          restoreFailed = true;
        }
      }
      try { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      if (usedBackup && !existsSync(pkgRoot) && existsSync(backupPath)) {
        try {
          if (_forceRestoreFailNext) { throw new Error("mock restore failure"); }
          renameSync(backupPath, pkgRoot);
          restoreFailed = false;
          restoreErr = null;
        } catch (re2) {
          restoreErr = re2;
          restoreFailed = true;
        }
      }
      if (restoreFailed) {
        return { ok: false, error: `install failed and backup restore also failed — manual recovery needed at ${backupPath}: ${String(restoreErr)} (original: ${String(e)})` };
      }
      return { ok: false, error: `failed to finalize install: ${String(e)}` };
    }
    // helper to restore from backup on later failure (e.g. lockfile write)
    const restoreFromBackup = (): { ok: true } | { ok: false; error: string } => {
      if (usedBackup) {
        try {
          if (existsSync(pkgRoot)) rmSync(pkgRoot, { recursive: true, force: true });
        } catch { /* ignore */ }
        try {
          if (_forceRestoreFailNext) { throw new Error("mock restore failure"); }
          renameSync(backupPath, pkgRoot);
          return { ok: true };
        } catch (re) {
          return { ok: false, error: String(re) };
        }
      } else {
        try { if (existsSync(pkgRoot)) rmSync(pkgRoot, { recursive: true, force: true }); } catch { /* ignore */ }
        return { ok: true };
      }
    };

    const resolvedBinPath = join(pkgRoot, "node_modules", ".bin", bin);

    // Symlink (or copy fallback) into bin/<bin>
    const binDest = join(binDir(home), bin);
    try { mkdirSync(binDir(home), { recursive: true }); } catch { /* ignore */ }
    try { if (existsSync(binDest)) { try { unlinkSync(binDest); } catch { try { rmSync(binDest, { force: true }); } catch {} } } } catch { /* ignore */ }
    let linked = false;
    try {
      symlinkSync(resolvedBinPath, binDest);
      linked = true;
    } catch {
      // fallback copy
      try {
        copyFileSync(resolvedBinPath, binDest);
        linked = true;
      } catch (e) {
        // non-fatal: lockfile still points at resolved path directly, symlink is convenience
        if (opts.onLog) opts.onLog(`warn: failed to create bin symlink/copy for ${bin}: ${String(e)}`);
      }
    }
    void linked;

    // Update lockfile atomically — key by bin to allow vscode triple sharing packageName
    const lf = readLockfile(home);
    lf.servers[bin] = {
      packageName,
      version,
      resolvedBinPath,
      installedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
    };
    try {
      if (_forceLockfileFailNext) {
        _forceLockfileFailNext = false;
        throw new Error("mock lockfile write failure");
      }
      writeLockfileAtomic(lf, home);
    } catch (e) {
      const restored = restoreFromBackup();
      if (!restored.ok) {
        return { ok: false, error: `install failed and backup restore also failed — manual recovery needed at ${backupPath}: ${restored.error} (original: failed to write lockfile: ${String(e)})` };
      }
      return { ok: false, error: `failed to write lockfile: ${String(e)}` };
    }

    if (usedBackup) {
      try { rmSync(backupPath, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    return { ok: true, binPath: resolvedBinPath };
  } finally {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    releaseLock(lock.fd, lock.path, (lock as any).token);
  }
}

export async function uninstallServer(
  packageName: string,
  home = homedir(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  ensureDirs(home);
  const lock = await acquireLock(packageName, home);
  if (!lock.ok) return { ok: false, error: lock.error };
  let uninstallError: string | null = null;
  try {
    const pkgRoot = join(packagesDir(home), packageName);
    // Remove package dir if exists
    if (existsSync(pkgRoot)) {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
    // Remove all lockfile entries referencing this packageName
    const lf = readLockfile(home);
    let changed = false;
    for (const [k, v] of Object.entries(lf.servers)) {
      if (v.packageName === packageName) {
        // also remove bin symlink if exists
        const binDest = join(binDir(home), k);
        try { if (existsSync(binDest)) unlinkSync(binDest); } catch { try { rmSync(binDest, { force: true }); } catch {} }
        // also try by bin name from entry
        const binFromPath = v.resolvedBinPath.split("/").pop() ?? "";
        if (binFromPath && binFromPath !== k) {
          const alt = join(binDir(home), binFromPath);
          try { if (existsSync(alt)) unlinkSync(alt); } catch { /* ignore */ }
        }
        delete lf.servers[k];
        changed = true;
      }
    }
    if (changed) {
      writeLockfileAtomic(lf, home);
    }
    // Cleanup any leftover temp dirs for this package
    try {
      const files = readdirSync(packagesDir(home));
      for (const f of files) {
        if (f.startsWith(`.tmp-${packageName}-`)) {
          try { rmSync(join(packagesDir(home), f), { recursive: true, force: true }); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    return { ok: true };
  } catch (e) {
    uninstallError = String(e);
    return { ok: false, error: uninstallError };
  } finally {
    releaseLock(lock.fd, lock.path, (lock as any).token);
  }
}

export async function updateServer(
  managedInstall: ManagedInstall,
  opts: { onLog?: (line: string) => void; homedir?: string; timeoutMs?: number } = {},
): Promise<{ ok: true; binPath: string } | { ok: false; error: string }> {
  // Reinstall same pinned version even if already present
  return installServer(managedInstall, opts);
}

// For tests: expose storage subdir helpers
export const __installerPaths = {
  lockfilePath,
  packagesDir,
  binDir,
  locksDir,
};
