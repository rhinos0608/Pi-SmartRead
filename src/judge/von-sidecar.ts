/**
 * Managed von sidecar: pinned von-sdk venv under `~/.pi/agent/judge/von/`,
 * weights beneath it via `HF_HOME`, launch on 127.0.0.1 with an ephemeral
 * port and refuse-on-overflow, lazy start, TCP health check plus a smoke
 * question for readiness, and session shutdown.
 *
 * Security posture: the serve bind host is a constant (`127.0.0.1`, never
 * `0.0.0.0`); `--on-overflow refuse` is always passed so over-window units
 * fail loudly instead of being silently middle-truncated. The child receives
 * an allowlisted environment (process, proxy, certificate), not judge keys or
 * cloud identity variables. Process and network seams are injectable so tests
 * never touch the machine or network.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { postSystemOneDecisions, type FetchFn } from "./systemone-client.js";
import type { JudgeErrorCode } from "./types.js";

/** Pinned von-sdk version (verified 2026-10-05 against PyPI; requires-python >= 3.12). */
export const VON_SDK_PINNED_VERSION = "1.3.7";
export const VON_SDK_PACKAGE = "von-sdk";

/** The sidecar never binds anywhere except loopback. */
export const VON_BIND_HOST = "127.0.0.1";

/** Over-window units must be refused, never silently truncated. */
export const VON_OVERFLOW_MODE = "refuse";

export const VON_LOCAL_MODEL = "von";
const VON_SERVE_ROUTE = "/v1/systemone";
const VON_HEALTH_TIMEOUT_MS = 60_000;
const VON_HEALTH_POLL_MS = 250;

function agentDir(home: string): string {
    const override = process.env.PI_CODING_AGENT_DIR;
    if (override && override.trim() !== "") return override;
    return join(home, ".pi", "agent");
}

/** Managed install root: `~/.pi/agent/judge/von/` (honors PI_CODING_AGENT_DIR). */
export function getVonDir(home = homedir()): string {
    return join(agentDir(home), "judge", "von");
}

/** Weights/cache root: always beneath the managed install root. */
export function getVonHfDir(home = homedir()): string {
    return join(getVonDir(home), "hf");
}

/** venv binary dir inside the managed root: `Scripts` on Windows, `bin` elsewhere. Exported for tests. */
export function venvBinDir(vonDir: string): string {
    return join(vonDir, process.platform === "win32" ? "Scripts" : "bin");
}

/** Installed `von` entry point inside the managed venv. Exported for tests. */
export function venvServeBin(vonDir: string): string {
    const suffix = process.platform === "win32" ? ".exe" : "";
    return join(venvBinDir(vonDir), `von${suffix}`);
}

function installMarkerPath(vonDir: string): string {
    return join(vonDir, "install.json");
}

export interface RunResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

export interface SpawnedProcess {
    pid?: number;
    kill(signal?: string): void;
    unref?(): void;
}

export interface VonSidecarDeps {
    home?: string;
    runCmd?: (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => Promise<RunResult>;
    spawnFn?: (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => SpawnedProcess;
    pickPort?: () => Promise<number>;
    waitForPort?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
    fetchFn?: FetchFn;
    env?: Record<string, string | undefined>;
}

export type VonEndpoint = { baseUrl: string } | { unavailable: JudgeErrorCode };
export type VonInstallResult = { ok: true; vonDir: string } | { ok: false; error: string };

async function defaultRunCmd(cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }): Promise<RunResult> {
    const { execFile } = await import("node:child_process");
    return new Promise((resolve) => {
        execFile(cmd, args, { env: opts?.env ?? process.env, timeout: 60_000 }, (err, stdout, stderr) => {
            resolve({
                code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0,
                stdout: String(stdout ?? ""),
                stderr: err ? String(stderr ?? "") + String((err as Error).message ?? "") : String(stderr ?? ""),
            });
        });
    });
}

function defaultSpawnFn(cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }): SpawnedProcess {
    // Production path: stdio ignored, process reaped on dispose().
    // Tests inject spawnFn and never reach here.
    const child = nodeSpawn(cmd, args, { env: opts?.env ?? process.env, stdio: "ignore" });
    return {
        pid: child.pid,
        kill: (signal?: string) => {
            try {
                child.kill(signal as NodeJS.Signals);
            } catch {
                // Best-effort shutdown.
            }
        },
        unref: () => child.unref(),
    };
}

async function defaultPickPort(): Promise<number> {
    const { createServer } = await import("node:net");
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, VON_BIND_HOST, () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            server.close((err) => {
                if (err) reject(err);
                else resolve(port);
            });
        });
    });
}

async function defaultWaitForPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
    const { connect } = await import("node:net");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const connected = await new Promise<boolean>((resolve) => {
            const socket = connect(port, host);
            socket.once("connect", () => {
                socket.destroy();
                resolve(true);
            });
            socket.once("error", () => {
                socket.destroy();
                resolve(false);
            });
            setTimeout(() => {
                socket.destroy();
                resolve(false);
            }, VON_HEALTH_POLL_MS);
        });
        if (connected) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, VON_HEALTH_POLL_MS));
    }
}

function resolveDeps(deps: VonSidecarDeps = {}): Required<Omit<VonSidecarDeps, "home" | "env">> & { home: string; env: Record<string, string | undefined> } {
    return {
        home: deps.home ?? homedir(),
        runCmd: deps.runCmd ?? defaultRunCmd,
        spawnFn: deps.spawnFn ?? defaultSpawnFn,
        pickPort: deps.pickPort ?? defaultPickPort,
        waitForPort: deps.waitForPort ?? defaultWaitForPort,
        fetchFn: deps.fetchFn ?? ((url, init) => fetch(url, init)),
        env: deps.env ?? process.env,
    };
}

/** Parse `Python 3.12.x` (or `3.12.x`) into { major, minor }; null when unparseable. */
export function parsePythonVersion(output: string): { major: number; minor: number } | null {
    const match = output.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]) };
}

export async function checkPythonVersion(deps: VonSidecarDeps = {}): Promise<{ ok: true; version: string; executable: string } | { ok: false; error: string }> {
    const resolved = resolveDeps(deps);
    const candidates = ["python3", "python"];
    let lastError = "no python interpreter found";
    for (const cmd of candidates) {
        try {
            const res = await resolved.runCmd(cmd, ["--version"]);
            const combined = `${res.stdout}\n${res.stderr}`;
            const parsed = parsePythonVersion(combined);
            if (res.code !== 0 || !parsed) {
                lastError = `could not determine ${cmd} version`;
                continue;
            }
            if (parsed.major > 3 || (parsed.major === 3 && parsed.minor >= 12)) {
                return { ok: true, version: `${parsed.major}.${parsed.minor}`, executable: cmd };
            }
            return { ok: false, error: `${cmd} is ${parsed.major}.${parsed.minor}; von requires Python >= 3.12` };
        } catch (e) {
            lastError = e instanceof Error ? e.message : String(e);
        }
    }
    return { ok: false, error: lastError };
}

export function isVonInstalled(home = homedir()): boolean {
    const vonDir = getVonDir(home);
    try {
        if (!existsSync(venvServeBin(vonDir))) return false;
        const raw = readFileSync(installMarkerPath(vonDir), "utf-8");
        const parsed = JSON.parse(raw) as { package?: unknown; version?: unknown };
        return parsed.package === VON_SDK_PACKAGE && parsed.version === VON_SDK_PINNED_VERSION;
    } catch {
        return false;
    }
}

/**
 * argv for the managed server. The bind host is pinned to loopback and
 * overflow is always refuse; callers cannot override either.
 */
export function buildVonServeArgs(port: number): string[] {
    return ["serve", "--host", VON_BIND_HOST, "--port", String(port), "--on-overflow", VON_OVERFLOW_MODE];
}

function sidecarEnv(home: string, env: Record<string, string | undefined>): NodeJS.ProcessEnv {
    const inheritedKeys = [
        "PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "COMSPEC", "PATHEXT",
        "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
        "http_proxy", "https_proxy", "all_proxy", "no_proxy",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
    ];
    const next: NodeJS.ProcessEnv = {};
    for (const key of inheritedKeys) {
        const value = env[key] ?? process.env[key];
        if (value !== undefined) next[key] = value;
    }
    const vonDir = getVonDir(home);
    next.HF_HOME = getVonHfDir(home);
    const binDir = venvBinDir(vonDir);
    next.PATH = `${binDir}${delimiter}${next.PATH ?? ""}`;
    return next;
}

export async function installVonSidecar(deps: VonSidecarDeps = {}, onLog?: (line: string) => void): Promise<VonInstallResult> {
    const resolved = resolveDeps(deps);
    const vonDir = getVonDir(resolved.home);
    try {
        mkdirSync(vonDir, { recursive: true });
        mkdirSync(getVonHfDir(resolved.home), { recursive: true });
    } catch (e) {
        return { ok: false, error: `failed to create ${vonDir}: ${e instanceof Error ? e.message : String(e)}` };
    }
    const env = sidecarEnv(resolved.home, resolved.env);
    // 1. Isolated venv inside the managed root.
    const checked = await checkPythonVersion({ ...deps, home: resolved.home, runCmd: resolved.runCmd });
    if (!checked.ok) return { ok: false, error: checked.error };
    const venv = await resolved.runCmd(checked.executable, ["-m", "venv", vonDir], { env });
    if (venv.code !== 0) {
        return { ok: false, error: `venv creation failed (exit ${venv.code ?? "unknown"})` };
    }
    // 2. Pinned SDK install.
    onLog?.(`Installing ${VON_SDK_PACKAGE}==${VON_SDK_PINNED_VERSION} (first run downloads ~3 GB)…`);
    const pip = join(venvBinDir(vonDir), process.platform === "win32" ? "pip.exe" : "pip");
    const installed = await resolved.runCmd(pip, ["install", `${VON_SDK_PACKAGE}==${VON_SDK_PINNED_VERSION}`], { env });
    if (installed.code !== 0) {
        return { ok: false, error: `pip install failed (exit ${installed.code ?? "unknown"})` };
    }
    try {
        writeFileSync(
            installMarkerPath(vonDir),
            JSON.stringify({ package: VON_SDK_PACKAGE, version: VON_SDK_PINNED_VERSION, installedAt: new Date().toISOString() }, null, 2),
            "utf-8",
        );
    } catch (e) {
        return { ok: false, error: `failed to record install marker: ${e instanceof Error ? e.message : String(e)}` };
    }
    onLog?.(`Installed ${VON_SDK_PACKAGE}==${VON_SDK_PINNED_VERSION} → ${vonDir}`);
    return { ok: true, vonDir };
}

export interface VonSidecarStatus {
    installed: boolean;
    running: boolean;
    warming: boolean;
    baseUrl?: string;
    version: string;
}

export class VonSidecarManager {
    private readonly deps: ReturnType<typeof resolveDeps>;
    private proc: SpawnedProcess | null = null;
    private baseUrl: string | null = null;
    private verified = false;
    private starting: Promise<VonEndpoint> | null = null;

    constructor(deps: VonSidecarDeps = {}) {
        this.deps = resolveDeps(deps);
    }

    getStatus(): VonSidecarStatus {
        return {
            installed: isVonInstalled(this.deps.home),
            running: this.proc !== null,
            warming: this.proc !== null && !this.verified,
            baseUrl: this.baseUrl ?? undefined,
            version: VON_SDK_PINNED_VERSION,
        };
    }

    /** One-question smoke test: proves the model is loaded, not just listening. */
    async smokeTest(baseUrl?: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
        const target = baseUrl ?? this.baseUrl;
        if (!target) return { ok: false, error: "sidecar is not running" };
        try {
            const res = await postSystemOneDecisions({
                baseUrl: target,
                route: VON_SERVE_ROUTE,
                model: VON_LOCAL_MODEL,
                state: { probe: "sidecar readiness check" },
                questions: { q: { type: "noul", instructions: "Reply with your relevance judgment for `probe`." } },
                signal,
                fetchFn: this.deps.fetchFn,
            });
            if (res.answers.q === undefined) return { ok: false, error: "smoke test returned no answer (model still loading?)" };
            this.verified = this.verified || target === this.baseUrl;
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    }

    /**
     * Lazily start the sidecar on first use and reuse it for the session.
     * A user-run `PI_SMARTREAD_JUDGE_BASE_URL` skips management entirely.
     */
    ensureEndpoint(signal?: AbortSignal): Promise<VonEndpoint> {
        const override = this.deps.env.PI_SMARTREAD_JUDGE_BASE_URL;
        if (override && override.trim() !== "") return Promise.resolve({ baseUrl: override });
        if (this.proc && this.baseUrl) {
            if (this.verified) return Promise.resolve({ baseUrl: this.baseUrl });
            return this.refreshReadiness(signal);
        }
        if (this.starting) return this.starting;
        this.starting = this.startLocked(signal).finally(() => {
            this.starting = null;
        });
        return this.starting;
    }

    private async refreshReadiness(signal?: AbortSignal): Promise<VonEndpoint> {
        const smoke = await this.smokeTest(this.baseUrl ?? undefined, signal);
        if (smoke.ok && this.baseUrl) {
            this.verified = true;
            return { baseUrl: this.baseUrl };
        }
        return { unavailable: "warming" };
    }

    private async startLocked(signal?: AbortSignal): Promise<VonEndpoint> {
        if (!isVonInstalled(this.deps.home)) return { unavailable: "sidecar_unavailable" };
        const vonDir = getVonDir(this.deps.home);
        const port = await this.deps.pickPort();
        const args = buildVonServeArgs(port);
        const env = sidecarEnv(this.deps.home, this.deps.env);
        let proc: SpawnedProcess;
        try {
            proc = this.deps.spawnFn(venvServeBin(vonDir), args, { env });
            proc.unref?.();
        } catch (e) {
            return { unavailable: "sidecar_unavailable" };
        }
        this.proc = proc;
        this.baseUrl = `http://${VON_BIND_HOST}:${port}`;
        this.verified = false;
        const healthy = await this.deps.waitForPort(VON_BIND_HOST, port, VON_HEALTH_TIMEOUT_MS);
        if (!healthy || signal?.aborted) {
            this.stopProc();
            return { unavailable: signal?.aborted ? "aborted" : "sidecar_unavailable" };
        }
        return this.refreshReadiness(signal);
    }

    private stopProc(): void {
        const proc = this.proc;
        this.proc = null;
        this.baseUrl = null;
        this.verified = false;
        try {
            proc?.kill("SIGTERM");
        } catch {
            // Best-effort shutdown.
        }
    }

    /** Stop the sidecar; safe to call when it was never started. */
    dispose(): void {
        this.stopProc();
    }
}

let sharedManager: VonSidecarManager | null = null;

/** Session-scoped singleton. Construction alone never spawns a process. */
export function getSharedVonSidecarManager(deps: VonSidecarDeps = {}): VonSidecarManager {
    if (!sharedManager) sharedManager = new VonSidecarManager(deps);
    return sharedManager;
}

/** Resolver seam: lazy endpoint for the `local` backend. No work until called. */
export function ensureVonEndpoint(signal?: AbortSignal): Promise<VonEndpoint> {
    return getSharedVonSidecarManager().ensureEndpoint(signal);
}

export function resetVonSidecarForTests(): void {
    try {
        sharedManager?.dispose();
    } catch {
        // Best-effort.
    }
    sharedManager = null;
}
