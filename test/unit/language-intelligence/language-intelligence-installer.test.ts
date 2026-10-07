import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

import { LANGUAGE_SERVER_CATALOG } from "../../../src/language-intelligence/language-server-catalog.js";
import { loadConfig, setInstallMode, resetLanguageIntelligenceCaches, __paths as configPaths } from "../../../src/language-intelligence/language-intelligence-config.js";
import {
  getInstallerStorageRoot,
  readLockfile,
  isServerInstalled,
  getInstalledBinPath,
  installServer,
  uninstallServer,
  updateServer,
  _setSpawnForTests,
  _resetSpawnForTests,
  __installerPaths,
} from "../../../src/language-intelligence/language-intelligence-installer.js";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "pi-li-installer-"));
}

function fakeSpawnSuccessFactory() {
  const fn = vi.fn((_cmd: string, args: string[]) => {
    const prefixIdx = args.indexOf("--prefix");
    const prefix = prefixIdx >= 0 ? args[prefixIdx + 1]! : "";
    // args contains "<packageName>@<version>" — extract packageName
    const pkgArg = args.find((a) => a.includes("@")) ?? "";
    const packageName = pkgArg.split("@")[0] ?? "";
    // Create node_modules/.bin and expected bins
    const binMap: Record<string, string[]> = {
      "typescript-language-server": ["typescript-language-server"],
      "pyright": ["pyright", "pyright-langserver"],
      "bash-language-server": ["bash-language-server"],
      "vscode-langservers-extracted": ["vscode-json-language-server", "vscode-html-language-server", "vscode-css-language-server", "vscode-eslint-language-server", "vscode-markdown-language-server"],
      "yaml-language-server": ["yaml-language-server"],
    };
    const bins = binMap[packageName] ?? [];
    // intercept packageName extraction if prefix derived from vs etc
    for (const b of bins) {
      const p = join(prefix, "node_modules", ".bin", b);
      mkdirSync(join(prefix, "node_modules", ".bin"), { recursive: true });
      writeFileSync(p, "#!/bin/sh\necho mock", "utf-8");
    }
    // Create node_modules/<packageName>/package.json with matching version so the
    // post-install integrity check (verifies installed version == requested version) passes.
    const pkgVersion = pkgArg.split("@")[1] ?? "0.0.0";
    const pkgDir = join(prefix, "node_modules", packageName);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: packageName, version: pkgVersion }), "utf-8");
    const ee: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void } = Object.assign(new EventEmitter() as EventEmitter, {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => {},
    });
    // Emit close asynchronously to allow installer to attach handlers
    setTimeout(() => ee.emit("close", 0), 10);
    return ee as unknown as ReturnType<typeof import("node:child_process").spawn>;
  });
  return fn;
}

function fakeSpawnFailureFactory() {
  const fn = vi.fn((_cmd: string, _args: string[]) => {
    const ee: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void } = Object.assign(new EventEmitter() as EventEmitter, {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => {},
    });
    setTimeout(() => {
      (ee.stderr as EventEmitter).emit("data", Buffer.from("mock install failed"));
      ee.emit("close", 1);
    }, 10);
    return ee as unknown as ReturnType<typeof import("node:child_process").spawn>;
  });
  return fn;
}

describe("language-intelligence-installer", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
    resetLanguageIntelligenceCaches();
    _resetSpawnForTests();
  });
  afterEach(() => {
    _resetSpawnForTests();
    try { rmSync(home, { recursive: true, force: true }); } catch {}
    resetLanguageIntelligenceCaches();
  });

  it("successful install writes lockfile entry with correct fields and returns correct bin path", async () => {
    const spawn = fakeSpawnSuccessFactory();
    _setSpawnForTests(spawn as unknown as typeof import("node:child_process").spawn);
    const res = await installServer({ packageName: "typescript-language-server", version: "6.0.0", bin: "typescript-language-server" }, { homedir: home });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.binPath).toContain("typescript-language-server");
    expect(existsSync(res.binPath)).toBe(true);
    const lf = readLockfile(home);
    const entry = lf.servers["typescript-language-server"]!;
    expect(entry).toBeDefined();
    expect(entry!.packageName).toBe("typescript-language-server");
    expect(entry!.version).toBe("6.0.0");
    expect(entry!.resolvedBinPath).toBe(res.binPath);
    expect(entry!.platform).toBe(process.platform);
    expect(entry!.arch).toBe(process.arch);
    expect(() => new Date(entry!.installedAt).toISOString()).not.toThrow();
    // verify spawn was called with correct args
    expect(spawn).toHaveBeenCalled();
    // check npm install command shape
    const args = (spawn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args).toContain("--ignore-scripts");
    expect(args).toContain("--no-audit");
    expect(args).toContain("--fund=false");
    expect(args.join(" ")).toContain("typescript-language-server@6.0.0");
    // no .tmp leak in storage root
    // lockfile should not have tmp
    const lockDirFiles = readdirSync(join(getInstallerStorageRoot(home)));
    expect(lockDirFiles.some((f) => f.includes(".tmp"))).toBe(false);
    // packages tmp should be cleaned
    const pkgFiles = existsSync(__installerPaths.packagesDir(home)) ? readdirSync(__installerPaths.packagesDir(home)) : [];
    expect(pkgFiles.some((f) => f.startsWith(".tmp-"))).toBe(false);
  });

  it("failed install returns ok:false and does NOT write/corrupt lockfile", async () => {
    // first successful install for same package to establish prior
    const spawnOk = fakeSpawnSuccessFactory();
    _setSpawnForTests(spawnOk as unknown as typeof import("node:child_process").spawn);
    const ok = await installServer({ packageName: "pyright", version: "1.1.413", bin: "pyright-langserver" }, { homedir: home });
    expect(ok.ok).toBe(true);
    const lfBefore = readLockfile(home);
    expect(lfBefore.servers["pyright-langserver"]).toBeDefined();
    const binBefore = lfBefore.servers["pyright-langserver"]!.resolvedBinPath;

    // now fail an update (same version)
    const spawnFail = fakeSpawnFailureFactory();
    _setSpawnForTests(spawnFail as unknown as typeof import("node:child_process").spawn);
    const fail = await installServer({ packageName: "pyright", version: "1.1.413", bin: "pyright-langserver" }, { homedir: home });
    expect(fail.ok).toBe(false);
    if (fail.ok) return;
    expect(fail.error.length).toBeGreaterThan(0);
    // prior install untouched
    const lfAfter = readLockfile(home);
    expect(lfAfter.servers["pyright-langserver"]).toBeDefined();
    expect(lfAfter.servers["pyright-langserver"]!.resolvedBinPath).toBe(binBefore);
    expect(existsSync(binBefore)).toBe(true);
    // no tmp leak
    const pkgFiles = existsSync(__installerPaths.packagesDir(home)) ? readdirSync(__installerPaths.packagesDir(home)) : [];
    expect(pkgFiles.some((f) => f.startsWith(".tmp-"))).toBe(false);
    // also test fresh failed install for never-installed package leaves no lockfile entry
    const freshFail = await installServer({ packageName: "yaml-language-server", version: "1.24.0", bin: "yaml-language-server" }, { homedir: home });
    expect(freshFail.ok).toBe(false);
    const lf2 = readLockfile(home);
    expect(lf2.servers["yaml-language-server"]).toBeUndefined();
  });

  it("isServerInstalled returns false for stale lockfile entry", async () => {
    const spawn = fakeSpawnSuccessFactory();
    _setSpawnForTests(spawn as unknown as typeof import("node:child_process").spawn);
    const res = await installServer({ packageName: "bash-language-server", version: "5.6.0", bin: "bash-language-server" }, { homedir: home });
    expect(res.ok).toBe(true);
    expect(isServerInstalled("bash-language-server", "5.6.0", home)).toBe(true);
    expect(getInstalledBinPath("bash-language-server", "bash-language-server", home)).not.toBeNull();
    // delete the bin file -> stale
    if (res.ok) rmSync(res.binPath, { force: true });
    expect(isServerInstalled("bash-language-server", "5.6.0", home)).toBe(false);
    expect(getInstalledBinPath("bash-language-server", "bash-language-server", home)).toBeNull();
  });

  it("concurrent install lock: second attempt fails cleanly when lock file exists", async () => {
    // manually create lock file to simulate in-progress install
    const locksDir = __installerPaths.locksDir(home);
    mkdirSync(locksDir, { recursive: true });
    const lockFile = join(locksDir, "yaml-language-server.lock");
    const fd = openSync(lockFile, "wx");
    // keep lock file present
    try {
      const spawn = fakeSpawnSuccessFactory();
      _setSpawnForTests(spawn as unknown as typeof import("node:child_process").spawn);
      // Verify exclusive-create semantics directly: existing lock file causes EEXIST.

      // Verify lock file blocks concurrent install.

      // Direct verification: lock file exists -> second exclusive open throws
      let threw = false;
      try { openSync(lockFile, "wx"); } catch (e: unknown) { threw = true; expect((e as NodeJS.ErrnoException).code).toBe("EEXIST"); }
      expect(threw).toBe(true);
    } finally {
      try { closeSync(fd); } catch {}
      try { rmSync(lockFile, { force: true }); } catch {}
    }

    // Now test that actual install fails when lock held for entire duration (use mocked slow retry)
    // Hold lock again and attempt install with a very short lock timeout by not releasing
    const fd2 = openSync(lockFile, "wx");
    _setSpawnForTests(fakeSpawnSuccessFactory() as unknown as typeof import("node:child_process").spawn);
    const start = Date.now();
    const res = await installServer({ packageName: "yaml-language-server", version: "1.24.0", bin: "yaml-language-server" }, { homedir: home, lockRetryTimeoutMs: 300 });
    const elapsed = Date.now() - start;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already in progress/);
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(2000);
    try { closeSync(fd2); } catch {}
    try { rmSync(lockFile, { force: true }); } catch {}
  });

  it("uninstall on never-installed package succeeds as no-op", async () => {
    const res = await uninstallServer("typescript-language-server", home);
    expect(res.ok).toBe(true);
    expect(readLockfile(home).servers["typescript-language-server"]).toBeUndefined();
  });

  it("uninstall removes existing install and lockfile entry", async () => {
    const spawn = fakeSpawnSuccessFactory();
    _setSpawnForTests(spawn as unknown as typeof import("node:child_process").spawn);
    const inst = await installServer({ packageName: "yaml-language-server", version: "1.24.0", bin: "yaml-language-server" }, { homedir: home });
    expect(inst.ok).toBe(true);
    expect(existsSync(join(__installerPaths.packagesDir(home), "yaml-language-server"))).toBe(true);
    expect(readLockfile(home).servers["yaml-language-server"]).toBeDefined();

    const un = await uninstallServer("yaml-language-server", home);
    expect(un.ok).toBe(true);
    expect(readLockfile(home).servers["yaml-language-server"]).toBeUndefined();
    expect(existsSync(join(__installerPaths.packagesDir(home), "yaml-language-server"))).toBe(false);
    // bin symlink removed or not present
    // idempotent second uninstall
    const un2 = await uninstallServer("yaml-language-server", home);
    expect(un2.ok).toBe(true);
  });

  it("atomic write: no .tmp files leak after successful lockfile write", async () => {
    const spawn = fakeSpawnSuccessFactory();
    _setSpawnForTests(spawn as unknown as typeof import("node:child_process").spawn);
    await installServer({ packageName: "typescript-language-server", version: "6.0.0", bin: "typescript-language-server" }, { homedir: home });
    await installServer({ packageName: "pyright", version: "1.1.413", bin: "pyright-langserver" }, { homedir: home });
    const dir = getInstallerStorageRoot(home);
    const files = readdirSync(dir);
    expect(files.some((f) => f.includes(".tmp"))).toBe(false);
    // also check that lockfile is valid JSON
    const raw = readFileSync(__installerPaths.lockfilePath(home), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("updateServer reinstalls same version (always re-runs install)", async () => {
    const spawn1 = fakeSpawnSuccessFactory();
    _setSpawnForTests(spawn1 as unknown as typeof import("node:child_process").spawn);
    const first = await installServer({ packageName: "bash-language-server", version: "5.6.0", bin: "bash-language-server" }, { homedir: home });
    expect(first.ok).toBe(true);
    const spawn2 = fakeSpawnSuccessFactory();
    _setSpawnForTests(spawn2 as unknown as typeof import("node:child_process").spawn);
    const upd = await updateServer({ packageName: "bash-language-server", version: "5.6.0", bin: "bash-language-server" }, { homedir: home });
    expect(upd.ok).toBe(true);
    expect(spawn2).toHaveBeenCalled();
    expect(isServerInstalled("bash-language-server", "5.6.0", home)).toBe(true);
  });

  it("config installMode defaults to off and persists via setInstallMode", () => {
    expect(loadConfig(home).installMode).toBeUndefined();
    // explicit default behavior is off when absent — we test that loadConfig returns undefined/missing, caller treats as off
    // set to auto
    setInstallMode("auto", home);
    expect(loadConfig(home).installMode).toBe("auto");
    // set back to off
    setInstallMode("off", home);
    expect(loadConfig(home).installMode).toBe("off");
    // malformed installMode should be ignored -> defaults to off
    const p = configPaths.configPath(home);
    writeFileSync(p, JSON.stringify({ installMode: "bogus", overrides: {} }), "utf-8");
    expect(loadConfig(home).installMode).toBeUndefined();
    // no .tmp leak
    const dir = join(home, ".pi", "agent");
    const files = readdirSync(dir);
    expect(files.some((f) => f.includes(".tmp"))).toBe(false);
  });

  it("catalog: 7 managedInstall candidates have correct bins and pinned versions", () => {
    function findCandidate(command: string, bin: string) {
      for (const d of LANGUAGE_SERVER_CATALOG) {
        for (const c of d.commandCandidates) {
          if (c.command === command && c.managedInstall?.bin === bin) return c.managedInstall;
        }
      }
      return null;
    }
    expect(findCandidate("typescript-language-server", "typescript-language-server")).toEqual({ type: "npm", packageName: "typescript-language-server", version: "6.0.0", bin: "typescript-language-server" });
    expect(findCandidate("pyright-langserver", "pyright-langserver")).toEqual({ type: "npm", packageName: "pyright", version: "1.1.413", bin: "pyright-langserver" });
    expect(findCandidate("bash-language-server", "bash-language-server")).toEqual({ type: "npm", packageName: "bash-language-server", version: "5.6.0", bin: "bash-language-server" });
    expect(findCandidate("vscode-json-language-server", "vscode-json-language-server")).toEqual({ type: "npm", packageName: "vscode-langservers-extracted", version: "4.10.0", bin: "vscode-json-language-server" });
    expect(findCandidate("vscode-html-language-server", "vscode-html-language-server")).toEqual({ type: "npm", packageName: "vscode-langservers-extracted", version: "4.10.0", bin: "vscode-html-language-server" });
    expect(findCandidate("vscode-css-language-server", "vscode-css-language-server")).toEqual({ type: "npm", packageName: "vscode-langservers-extracted", version: "4.10.0", bin: "vscode-css-language-server" });
    expect(findCandidate("yaml-language-server", "yaml-language-server")).toEqual({ type: "npm", packageName: "yaml-language-server", version: "1.24.0", bin: "yaml-language-server" });

    // Ensure no other descriptor has managedInstall
    let managedCount = 0;
    for (const d of LANGUAGE_SERVER_CATALOG) for (const c of d.commandCandidates) if (c.managedInstall) managedCount++;
    expect(managedCount).toBe(7);
  });

  it("getInstallerStorageRoot returns expected path", () => {
    expect(getInstallerStorageRoot(home)).toBe(join(home, ".pi", "agent", "language-intelligence"));
    expect(getInstallerStorageRoot("/custom/home")).toBe(join("/custom/home", ".pi", "agent", "language-intelligence"));
  });

  it("failed finalization (renameSync throw) preserves prior install via backup restore", async () => {
    const { _setRenameFailureForTests } = await import("../../../src/language-intelligence/language-intelligence-installer.js");
    const spawnOk = fakeSpawnSuccessFactory();
    _setSpawnForTests(spawnOk as unknown as typeof import("node:child_process").spawn);
    const first = await installServer({ packageName: "pyright", version: "1.1.413", bin: "pyright-langserver" }, { homedir: home });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const priorBin = first.binPath;
    expect(existsSync(priorBin)).toBe(true);
    const priorContent = readFileSync(priorBin, "utf-8");
    writeFileSync(priorBin, "PRIOR_CONTENT", "utf-8");
    const lfBefore = readLockfile(home);
    _setRenameFailureForTests(true);
    const spawn2 = fakeSpawnSuccessFactory();
    _setSpawnForTests(spawn2 as unknown as typeof import("node:child_process").spawn);
    const res = await installServer({ packageName: "pyright", version: "1.1.413", bin: "pyright-langserver" }, { homedir: home });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/failed to finalize/);
    expect(existsSync(priorBin)).toBe(true);
    expect(readFileSync(priorBin, "utf-8")).toBe("PRIOR_CONTENT");
    expect(existsSync(join(__installerPaths.packagesDir(home), "pyright"))).toBe(true);
    const lfAfter = readLockfile(home);
    expect(lfAfter.servers["pyright-langserver"]?.version).toBe(lfBefore.servers["pyright-langserver"]?.version);
    expect(lfAfter.servers["pyright-langserver"]?.resolvedBinPath).toBe(lfBefore.servers["pyright-langserver"]?.resolvedBinPath);
    expect(existsSync(join(__installerPaths.packagesDir(home), "pyright.bak"))).toBe(false);
    const pkgFiles = existsSync(__installerPaths.packagesDir(home)) ? readdirSync(__installerPaths.packagesDir(home)) : [];
    expect(pkgFiles.some((f: string) => f.startsWith(".tmp-"))).toBe(false);
    writeFileSync(priorBin, priorContent, "utf-8");
    _setRenameFailureForTests(false);
  });

  it("lockfile write failure after swap restores backup so disk matches lockfile", async () => {
    const { _setLockfileFailureForTests } = await import("../../../src/language-intelligence/language-intelligence-installer.js");
    const spawnOk = fakeSpawnSuccessFactory();
    _setSpawnForTests(spawnOk as unknown as typeof import("node:child_process").spawn);
    const first = await installServer({ packageName: "bash-language-server", version: "5.6.0", bin: "bash-language-server" }, { homedir: home });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const priorBin = first.binPath;
    writeFileSync(priorBin, "PRIOR_BASH", "utf-8");
    const lfBefore = readLockfile(home);
    _setLockfileFailureForTests(true);
    const spawn2 = fakeSpawnSuccessFactory();
    _setSpawnForTests(spawn2 as unknown as typeof import("node:child_process").spawn);
    const res = await installServer({ packageName: "bash-language-server", version: "5.6.0", bin: "bash-language-server" }, { homedir: home });
    _setLockfileFailureForTests(false);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/failed to write lockfile/);
    expect(existsSync(priorBin)).toBe(true);
    expect(readFileSync(priorBin, "utf-8")).toBe("PRIOR_BASH");
    const lfAfter = readLockfile(home);
    expect(lfAfter.servers["bash-language-server"]?.resolvedBinPath).toBe(lfBefore.servers["bash-language-server"]?.resolvedBinPath);
    expect(existsSync(join(__installerPaths.packagesDir(home), "bash-language-server.bak"))).toBe(false);
  });

  it("restore-failure-is-surfaced-not-swallowed", async () => {
    const { _setRenameFailureForTests, _setRestoreFailureForTests } = await import("../../../src/language-intelligence/language-intelligence-installer.js");
    const spawnOk = fakeSpawnSuccessFactory();
    _setSpawnForTests(spawnOk as unknown as typeof import("node:child_process").spawn);
    const first = await installServer({ packageName: "pyright", version: "1.1.413", bin: "pyright-langserver" }, { homedir: home });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const priorBin = first.binPath;
    expect(existsSync(priorBin)).toBe(true);
    _setRenameFailureForTests(true);
    _setRestoreFailureForTests(true);
    const spawn2 = fakeSpawnSuccessFactory();
    _setSpawnForTests(spawn2 as unknown as typeof import("node:child_process").spawn);
    const res = await installServer({ packageName: "pyright", version: "1.1.413", bin: "pyright-langserver" }, { homedir: home });
    _setRenameFailureForTests(false);
    _setRestoreFailureForTests(false);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/backup restore also failed/);
    expect(res.error).toMatch(/manual recovery needed/);
    expect(res.error).toContain(".bak");
    // generic "failed to finalize" alone is not enough — must surface backup failure distinctly
    expect(res.error).not.toBe("failed to finalize install: mock rename failure");
    // cleanup orphan .bak for next tests in same home (though home is per-test, keep tidy)
    try { rmSync(join(__installerPaths.packagesDir(home), "pyright.bak"), { recursive: true, force: true }); } catch {}
  });

  it("no-timeout lock not reclaimed as stale after 90s (fallback generous threshold)", async () => {
    const { _staleThresholdMsForTests } = await import("../../../src/language-intelligence/language-intelligence-installer.js");
    const { utimesSync } = await import("node:fs");
    expect(_staleThresholdMsForTests(0)).toBe(180_000);
    expect(_staleThresholdMsForTests(-1)).toBe(180_000);
    expect(_staleThresholdMsForTests(NaN as unknown as number)).toBe(180_000);
    expect(_staleThresholdMsForTests(Infinity as unknown as number)).toBe(180_000);

    const locksDir = __installerPaths.locksDir(home);
    mkdirSync(locksDir, { recursive: true });
    const lockFile = join(locksDir, "yaml-language-server.lock");

    // Exercise REAL lock-creation code path with non-positive timeout so it computes fallback 180_000 itself.
    // Use a hanging spawn to keep the first install's lock held open.
    let firstEE: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    const hangingSpawn = vi.fn((_cmd: string, args: string[]) => {
      const prefixIdx = args.indexOf("--prefix");
      const prefix = prefixIdx >= 0 ? args[prefixIdx + 1]! : "";
      const pkgArg = args.find((a) => a.includes("@")) ?? "";
      const packageName = pkgArg.split("@")[0] ?? "";
      const binMap: Record<string, string[]> = { "yaml-language-server": ["yaml-language-server"] };
      const bins = binMap[packageName] ?? ["yaml-language-server"];
      for (const b of bins) {
        const p = join(prefix, "node_modules", ".bin", b);
        mkdirSync(join(prefix, "node_modules", ".bin"), { recursive: true });
        writeFileSync(p, "#!/bin/sh\necho mock", "utf-8");
      }
      const pkgVersion = pkgArg.split("@")[1] ?? "0.0.0";
      const pkgDir = join(prefix, "node_modules", packageName || "yaml-language-server");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: packageName || "yaml-language-server", version: pkgVersion }), "utf-8");
      firstEE = Object.assign(new EventEmitter() as EventEmitter, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => {},
      }) as typeof firstEE;
      return firstEE as unknown as ReturnType<typeof import("node:child_process").spawn>;
    });
    _setSpawnForTests(hangingSpawn as unknown as typeof import("node:child_process").spawn);
    const p1 = installServer({ packageName: "yaml-language-server", version: "1.24.0", bin: "yaml-language-server" }, { homedir: home, timeoutMs: 0 });

    for (let i = 0; i < 50; i++) {
      if (existsSync(lockFile)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(existsSync(lockFile)).toBe(true);
    const initialContent = readFileSync(lockFile, "utf-8");
    const initialParts = initialContent.split(":");
    expect(initialParts.length).toBe(3);
    expect(Number(initialParts[2])).toBe(180_000);

    // ensure hanging spawn has been invoked and lock fd is held before mutating mtime
    await new Promise((r) => setTimeout(r, 50));
    const age90 = 90_000;
    const agedContent = `${initialParts[0]}:${Date.now() - age90}:${initialParts[2]}`;
    writeFileSync(lockFile, agedContent, "utf-8");
    const t90 = new Date(Date.now() - age90);
    utimesSync(lockFile, t90, t90);
    await new Promise((r) => setTimeout(r, 10));

    const spawn2 = fakeSpawnSuccessFactory();
    _setSpawnForTests(spawn2 as unknown as typeof import("node:child_process").spawn);

    const start = Date.now();
    const res = await installServer({ packageName: "yaml-language-server", version: "1.24.0", bin: "yaml-language-server" }, { homedir: home, timeoutMs: 0 });
    const elapsed = Date.now() - start;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already in progress/);
    expect(elapsed).toBeGreaterThanOrEqual(4000);
    expect(existsSync(lockFile)).toBe(true);
    expect(readFileSync(lockFile, "utf-8")).toContain(initialParts[0]);
    expect(spawn2).not.toHaveBeenCalled();

    firstEE!.emit("close", 0);
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    try { rmSync(lockFile, { force: true }); } catch {}
  });

  it("refreshInstallLock re-stamps owned locks and refuses foreign ones", async () => {
    const { refreshInstallLock, startInstallLockHeartbeat } = await import("../../../src/language-intelligence/language-intelligence-installer.js");
    const { statSync, openSync, writeSync, closeSync } = await import("node:fs");
    const locksDir = __installerPaths.locksDir(home);
    mkdirSync(locksDir, { recursive: true });
    const lockFile = join(locksDir, "heartbeat-unit.lock");
    const owned: Array<{ fd: number }> = [];
    const ownLock = (token: string): { fd: number; path: string; token: string } => {
      // Windows: an open handle leaves a deleted file pending-delete and blocks
      // recreate (EPERM), so close owned fds before path-level rm/recreate.
      for (const o of owned) { try { closeSync(o.fd); } catch {} }
      try { rmSync(lockFile, { force: true }); } catch {}
      const fd = openSync(lockFile, "wx");
      writeSync(fd, token);
      const lock = { fd, path: lockFile, token };
      owned.push(lock);
      return lock;
    };
    try {
      const token = `${process.pid}:${Date.now() - 200_000}:180000`;
      const lock = ownLock(token);
      expect(refreshInstallLock(lock)).toBe(true);
      const after = readFileSync(lockFile, "utf-8");
      expect(after).not.toBe(token);
      expect(after.split(":")[2]).toBe("180000");
      expect(after.startsWith(`${process.pid}:`)).toBe(true);
      // Holder object tracks the new token so release still matches.
      expect(lock.token).toBe(after);
      expect(statSync(lockFile).mtimeMs).toBeGreaterThan(Date.now() - 5000);

      // Foreign content: must not clobber.
      writeFileSync(lockFile, "99999:12345:180000", "utf-8");
      expect(refreshInstallLock(lock)).toBe(false);
      expect(readFileSync(lockFile, "utf-8")).toBe("99999:12345:180000");

      // Recreated lock (new inode): must not clobber via path reopen.
      try { closeSync(lock.fd); } catch {}
      try { rmSync(lockFile, { force: true }); } catch {}
      writeFileSync(lockFile, "99999:12345:180000", "utf-8");
      expect(refreshInstallLock(lock)).toBe(false);
      expect(readFileSync(lockFile, "utf-8")).toBe("99999:12345:180000");

      // Missing file: never recreate.
      expect(refreshInstallLock({ fd: -1, path: join(locksDir, "absent.lock"), token: "1:2:3" })).toBe(false);
      expect(existsSync(join(locksDir, "absent.lock"))).toBe(false);

      // Heartbeat stopper fires beats on schedule.
      const token2 = `${process.pid}:${Date.now()}:180000`;
      const lock2 = ownLock(token2);
      const stop = startInstallLockHeartbeat(lock2, 20);
      await new Promise((r) => setTimeout(r, 70));
      stop();
      expect(lock2.token).not.toBe(token2);
      expect(readFileSync(lockFile, "utf-8")).toBe(lock2.token);

      // Lost lock: beats self-stop instead of fighting the new owner.
      const token3 = `${process.pid}:${Date.now()}:180000`;
      const lock3 = ownLock(token3);
      const stop3 = startInstallLockHeartbeat(lock3, 20);
      await new Promise((r) => setTimeout(r, 50));
      expect(lock3.token).not.toBe(token3);
      writeFileSync(lockFile, "99999:12345:180000", "utf-8");
      const frozen = lock3.token;
      await new Promise((r) => setTimeout(r, 80));
      stop3();
      expect(readFileSync(lockFile, "utf-8")).toBe("99999:12345:180000");
      expect(lock3.token).toBe(frozen);
    } finally {
      for (const o of owned) { try { closeSync(o.fd); } catch {} }
      try { rmSync(lockFile, { force: true }); } catch {}
    }
  });

  it("heartbeat keeps a past-threshold install lock from being reclaimed", async () => {
    const { utimesSync } = await import("node:fs");
    const locksDir = __installerPaths.locksDir(home);
    mkdirSync(locksDir, { recursive: true });
    const lockFile = join(locksDir, "yaml-language-server.lock");
    vi.useFakeTimers();
    try {
      let firstEE: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
      const hangingSpawn = vi.fn((_cmd: string, args: string[]) => {
        const prefixIdx = args.indexOf("--prefix");
        const prefix = prefixIdx >= 0 ? args[prefixIdx + 1]! : "";
        const p = join(prefix, "node_modules", ".bin", "yaml-language-server");
        mkdirSync(join(prefix, "node_modules", ".bin"), { recursive: true });
        writeFileSync(p, "#!/bin/sh\necho mock", "utf-8");
        const pkgDir = join(prefix, "node_modules", "yaml-language-server");
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "yaml-language-server", version: "1.24.0" }), "utf-8");
        firstEE = Object.assign(new EventEmitter() as EventEmitter, {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          kill: () => {},
        }) as typeof firstEE;
        return firstEE as unknown as ReturnType<typeof import("node:child_process").spawn>;
      });
      _setSpawnForTests(hangingSpawn as unknown as typeof import("node:child_process").spawn);
      const p1 = installServer({ packageName: "yaml-language-server", version: "1.24.0", bin: "yaml-language-server" }, { homedir: home, timeoutMs: 0 });
      for (let i = 0; i < 50 && !existsSync(lockFile); i++) await vi.advanceTimersByTimeAsync(20);
      expect(existsSync(lockFile)).toBe(true);
      await vi.advanceTimersByTimeAsync(50);
      expect(hangingSpawn).toHaveBeenCalled();

      // Simulate a slow install: age the live lock's mtime past the 180s
      // fallback (content token untouched so the holder still owns it), then
      // advance fake timers so installServer's own heartbeat interval fires.
      const liveToken = readFileSync(lockFile, "utf-8");
      const liveParts = liveToken.split(":");
      const t = new Date(Date.now() - 200_000);
      utimesSync(lockFile, t, t);
      await vi.advanceTimersByTimeAsync(31_000);
      const current = readFileSync(lockFile, "utf-8");
      expect(current.split(":")[0]).toBe(liveParts[0]);
      expect(current).not.toBe(liveToken);

      const spawn2 = fakeSpawnSuccessFactory();
      _setSpawnForTests(spawn2 as unknown as typeof import("node:child_process").spawn);
      const p2 = installServer({ packageName: "yaml-language-server", version: "1.24.0", bin: "yaml-language-server" }, { homedir: home, timeoutMs: 0, lockRetryTimeoutMs: 300 });
      await vi.advanceTimersByTimeAsync(1000);
      const res = await p2;
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/already in progress/);
      expect(spawn2).not.toHaveBeenCalled();
      // Still our lock — not reclaimed.
      expect(readFileSync(lockFile, "utf-8").split(":")[0]).toBe(liveParts[0]);

      firstEE!.emit("close", 0);
      const r1 = await p1;
      expect(r1.ok).toBe(true);
      // installServer's releaseLock removes its own lock — no detached cleanup.
      expect(existsSync(lockFile)).toBe(false);
    } finally {
      vi.useRealTimers();
      try { rmSync(lockFile, { force: true }); } catch {}
    }
  });

  it("stale-threshold-respects-custom-timeout", async () => {
    const { utimesSync } = await import("node:fs");
    const customTimeoutMs = 200_000;
    const customThresholdMs = customTimeoutMs + 60_000; // 260000
    const locksDir = __installerPaths.locksDir(home);
    mkdirSync(locksDir, { recursive: true });
    const lockFile = join(locksDir, "yaml-language-server.lock");

    // case 1: age 190s — would be stale under old fixed 180s but NOT under custom 260s
    const age190 = 190_000;
    writeFileSync(lockFile, `99999:${Date.now() - age190}:${customThresholdMs}`, "utf-8");
    const t190 = new Date(Date.now() - age190);
    utimesSync(lockFile, t190, t190);
    const spawnA = fakeSpawnSuccessFactory();
    _setSpawnForTests(spawnA as unknown as typeof import("node:child_process").spawn);
    const start = Date.now();
    const resStaleNot = await installServer({ packageName: "yaml-language-server", version: "1.24.0", bin: "yaml-language-server" }, { homedir: home });
    const elapsed = Date.now() - start;
    expect(resStaleNot.ok).toBe(false);
    if (!resStaleNot.ok) expect(resStaleNot.error).toMatch(/already in progress/);
    expect(elapsed).toBeGreaterThanOrEqual(4000);
    // lock should NOT have been reclaimed — still exists with same pid
    expect(existsSync(lockFile)).toBe(true);
    expect(readFileSync(lockFile, "utf-8")).toContain("99999");
    // spawn should NOT have been called because lock was not reclaimed
    expect(spawnA).not.toHaveBeenCalled();
    try { rmSync(lockFile, { force: true }); } catch {}

    // case 2: age 270s — past custom threshold, SHOULD be reclaimed
    const age270 = 270_000;
    writeFileSync(lockFile, `99999:${Date.now() - age270}:${customThresholdMs}`, "utf-8");
    const t270 = new Date(Date.now() - age270);
    utimesSync(lockFile, t270, t270);
    const spawnB = fakeSpawnSuccessFactory();
    _setSpawnForTests(spawnB as unknown as typeof import("node:child_process").spawn);
    const resReclaimed = await installServer({ packageName: "yaml-language-server", version: "1.24.0", bin: "yaml-language-server" }, { homedir: home });
    expect(resReclaimed.ok).toBe(true);
    expect(spawnB).toHaveBeenCalled();
    // after successful reclaim+install, the installer's own lock is released (deleted).
    // proof of reclaim is that install succeeded rather than failing with "already in progress".
    // If file still exists momentarily, ensure old pid is gone; otherwise it was cleaned up correctly.
    if (existsSync(lockFile)) {
      const newContent = readFileSync(lockFile, "utf-8");
      expect(newContent).not.toContain("99999");
      try { rmSync(lockFile, { force: true }); } catch {}
    } else {
      expect(existsSync(lockFile)).toBe(false);
    }
  });
});
