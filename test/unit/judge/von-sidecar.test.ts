import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    buildVonServeArgs,
    checkPythonVersion,
    ensureVonEndpoint,
    getSharedVonSidecarManager,
    getVonDir,
    getVonHfDir,
    installVonSidecar,
    isVonInstalled,
    parsePythonVersion,
    resetVonSidecarForTests,
    VON_BIND_HOST,
    VON_SDK_PINNED_VERSION,
    VonSidecarManager,
    type RunResult,
    type SpawnedProcess,
} from "../../../src/judge/von-sidecar.js";

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status });
}

let home: string;
let oldAgentDir: string | undefined;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "von-sidecar-"));
    oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    resetVonSidecarForTests();
});

afterEach(() => {
    resetVonSidecarForTests();
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    rmSync(home, { recursive: true, force: true });
});

function okRun(stdout = ""): RunResult {
    return { code: 0, stdout, stderr: "" };
}

function seedInstalled(): void {
    const vonDir = getVonDir(home);
    mkdirSync(join(vonDir, "bin"), { recursive: true });
    writeFileSync(join(vonDir, "bin", "von"), "#!/bin/sh\n", "utf-8");
    writeFileSync(
        join(vonDir, "install.json"),
        JSON.stringify({ package: "von-sdk", version: VON_SDK_PINNED_VERSION }),
        "utf-8",
    );
}

describe("von serve argv", () => {
    it("binds loopback with an ephemeral port and refuse-on-overflow, never 0.0.0.0", () => {
        const args = buildVonServeArgs(51234);
        expect(args).toEqual(["serve", "--host", "127.0.0.1", "--port", "51234", "--on-overflow", "refuse"]);
        expect(VON_BIND_HOST).toBe("127.0.0.1");
        expect(args.join(" ")).not.toContain("0.0.0.0");
    });
});

describe("paths", () => {
    it("lives under ~/.pi/agent/judge/von with HF_HOME beneath it", () => {
        expect(getVonDir(home)).toBe(join(home, ".pi", "agent", "judge", "von"));
        expect(getVonHfDir(home)).toBe(join(getVonDir(home), "hf"));
    });

    it("honors PI_CODING_AGENT_DIR", () => {
        process.env.PI_CODING_AGENT_DIR = join(home, "custom-agent");
        expect(getVonDir(home)).toBe(join(home, "custom-agent", "judge", "von"));
    });
});

describe("python check", () => {
    it("parses versions", () => {
        expect(parsePythonVersion("Python 3.12.4")).toEqual({ major: 3, minor: 12 });
        expect(parsePythonVersion("3.13.0")).toEqual({ major: 3, minor: 13 });
        expect(parsePythonVersion("no python here")).toBeNull();
    });

    it("accepts >= 3.12 and rejects older", async () => {
        await expect(
            checkPythonVersion({ home, runCmd: async () => okRun("Python 3.12.4\n") }),
        ).resolves.toEqual({ ok: true, version: "3.12" });
        const old = await checkPythonVersion({ home, runCmd: async () => okRun("Python 3.11.9\n") });
        expect(old.ok).toBe(false);
    });

    it("fails when no interpreter runs", async () => {
        const res = await checkPythonVersion({
            home,
            runCmd: async () => { throw new Error("spawn ENOENT"); },
        });
        expect(res.ok).toBe(false);
    });
});

describe("install", () => {
    it("creates a venv and pip-installs the pinned SDK with HF_HOME beneath the von dir", async () => {
        const calls: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
        const res = await installVonSidecar({
            home,
            runCmd: async (cmd, args, opts) => {
                calls.push({ cmd, args, env: opts?.env });
                return okRun(cmd.includes("python") ? "Python 3.12.4\n" : "");
            },
        });
        expect(res).toEqual({ ok: true, vonDir: getVonDir(home) });
        const venv = calls.find((c) => c.args.includes("-m"));
        expect(venv?.args).toEqual(["-m", "venv", getVonDir(home)]);
        const pip = calls.find((c) => c.cmd.endsWith("pip") || c.cmd.endsWith("pip.exe"));
        expect(pip?.args).toEqual(["install", `von-sdk==${VON_SDK_PINNED_VERSION}`]);
        expect(pip?.env?.HF_HOME).toBe(getVonHfDir(home));
        // The fake pip creates no files; simulate the installed entry point,
        // then the marker + binary together report installed.
        mkdirSync(join(getVonDir(home), "bin"), { recursive: true });
        writeFileSync(join(getVonDir(home), "bin", "von"), "#!/bin/sh\n", "utf-8");
        expect(isVonInstalled(home)).toBe(true);
    });

    it("refuses without Python >= 3.12 and runs nothing", async () => {
        let calls = 0;
        const res = await installVonSidecar({
            home,
            runCmd: async (cmd) => {
                calls++;
                if (cmd === "python3" || cmd === "python") return okRun("Python 3.11.0\n");
                return okRun("");
            },
        });
        expect(res.ok).toBe(false);
        // Only the version probes ran; no venv or pip install.
        expect(calls).toBeLessThanOrEqual(2);
        expect(isVonInstalled(home)).toBe(false);
    });

    it("does not expose pip output that may contain credential-bearing package URLs", async () => {
        const secret = "package-index-secret";
        const res = await installVonSidecar({
            home,
            runCmd: async (_cmd, args) => {
                if (args.includes("--version")) return okRun("Python 3.12.4");
                if (args.includes("-m")) return okRun();
                return { code: 1, stdout: "", stderr: `https://user:${secret}@packages.example.test/private` };
            },
        });
        expect(res).toEqual({ ok: false, error: "pip install failed (exit 1)" });
        expect(JSON.stringify(res)).not.toContain(secret);
    });
});

function fakeSpawn() {
    const killed: string[] = [];
    const spawned: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const spawnFn = (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }): SpawnedProcess => {
        spawned.push({ cmd, args, env: opts?.env });
        return { pid: 4242, kill: (signal?: string) => { killed.push(signal ?? ""); }, unref: () => {} };
    };
    return { killed, spawned, spawnFn };
}

function smokeFetch(answer: unknown = { noul: 0.8, noul_raw: 0.6 }) {
    return vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, { answers: { q: answer }, usage: {} }));
}

describe("VonSidecarManager", () => {
    it("reports sidecar_unavailable when not installed and never spawns", async () => {
        const { spawned, spawnFn } = fakeSpawn();
        const manager = new VonSidecarManager({ home, spawnFn, fetchFn: smokeFetch() });
        await expect(manager.ensureEndpoint()).resolves.toEqual({ unavailable: "sidecar_unavailable" });
        expect(spawned).toHaveLength(0);
        expect(manager.getStatus()).toMatchObject({ installed: false, running: false });
    });

    it("starts lazily on loopback, verifies via smoke, and reuses the endpoint", async () => {
        seedInstalled();
        const { killed, spawned, spawnFn } = fakeSpawn();
        const fetchFn = smokeFetch();
        const manager = new VonSidecarManager({
            home,
            spawnFn,
            fetchFn,
            pickPort: async () => 51991,
            waitForPort: async () => true,
        });
        const first = await manager.ensureEndpoint();
        expect(first).toEqual({ baseUrl: "http://127.0.0.1:51991" });
        expect(spawned).toHaveLength(1);
        expect(spawned[0]!.args).toContain("127.0.0.1");
        expect(spawned[0]!.args).toContain("refuse");
        expect(spawned[0]!.args.join(" ")).not.toContain("0.0.0.0");
        expect(spawned[0]!.env?.HF_HOME).toBe(getVonHfDir(home));
        expect(manager.getStatus()).toMatchObject({ running: true, warming: false });

        const second = await manager.ensureEndpoint();
        expect(second).toEqual(first);
        expect(spawned).toHaveLength(1);
        expect(fetchFn).toHaveBeenCalled();

        manager.dispose();
        expect(killed).toEqual(["SIGTERM"]);
        expect(manager.getStatus()).toMatchObject({ running: false });
    });

    it("passes a minimal sidecar environment without judge or cloud credentials", async () => {
        seedInstalled();
        const { spawned, spawnFn } = fakeSpawn();
        const manager = new VonSidecarManager({
            home,
            spawnFn,
            fetchFn: smokeFetch(),
            pickPort: async () => 51996,
            waitForPort: async () => true,
            env: {
                PI_SMARTREAD_JUDGE_API_KEY: "judge-secret",
                OPENROUTER_API_KEY: "router-secret",
                AWS_SECRET_ACCESS_KEY: "aws-secret",
                AWS_ACCESS_KEY_ID: "aws-id",
                AWS_PROFILE: "developer",
                GOOGLE_APPLICATION_CREDENTIALS: "credentials.json",
                AZURE_CLIENT_SECRET: "azure-secret",
                IDENTITY_ENDPOINT: "http://identity.local/token",
                IDENTITY_HEADER: "identity-secret",
                MSI_ENDPOINT: "http://identity.local/msi",
                MSI_SECRET: "msi-secret",
                OPENAI_API_KEY: "openai-secret",
                SAFE_SETTING: "not-forwarded",
                HTTPS_PROXY: "http://proxy.local:8080",
            },
        });
        await manager.ensureEndpoint();
        expect(spawned[0]!.env?.PI_SMARTREAD_JUDGE_API_KEY).toBeUndefined();
        expect(spawned[0]!.env?.OPENROUTER_API_KEY).toBeUndefined();
        expect(spawned[0]!.env?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
        expect(spawned[0]!.env?.AWS_ACCESS_KEY_ID).toBeUndefined();
        expect(spawned[0]!.env?.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
        expect(spawned[0]!.env?.AWS_PROFILE).toBeUndefined();
        expect(spawned[0]!.env?.AZURE_CLIENT_SECRET).toBeUndefined();
        expect(spawned[0]!.env?.IDENTITY_ENDPOINT).toBeUndefined();
        expect(spawned[0]!.env?.IDENTITY_HEADER).toBeUndefined();
        expect(spawned[0]!.env?.MSI_ENDPOINT).toBeUndefined();
        expect(spawned[0]!.env?.MSI_SECRET).toBeUndefined();
        expect(spawned[0]!.env?.OPENAI_API_KEY).toBeUndefined();
        expect(spawned[0]!.env?.SAFE_SETTING).toBeUndefined();
        expect(spawned[0]!.env?.HTTPS_PROXY).toBe("http://proxy.local:8080");
        manager.dispose();
    });

    it("coalesces concurrent starts into one spawn", async () => {
        seedInstalled();
        const { spawnFn } = fakeSpawn();
        let spawns = 0;
        const manager = new VonSidecarManager({
            home,
            spawnFn: (...a) => { spawns++; return spawnFn(...a); },
            fetchFn: smokeFetch(),
            pickPort: async () => 51992,
            waitForPort: async () => true,
        });
        const [a, b] = await Promise.all([manager.ensureEndpoint(), manager.ensureEndpoint()]);
        expect(a).toEqual(b);
        expect(spawns).toBe(1);
        manager.dispose();
    });

    it("reports warming when the smoke test has no answer yet", async () => {
        seedInstalled();
        const { spawnFn } = fakeSpawn();
        const manager = new VonSidecarManager({
            home,
            spawnFn,
            fetchFn: vi.fn(async () => jsonResponse(200, { answers: {}, usage: {} })),
            pickPort: async () => 51993,
            waitForPort: async () => true,
        });
        await expect(manager.ensureEndpoint()).resolves.toEqual({ unavailable: "warming" });
        expect(manager.getStatus()).toMatchObject({ running: true, warming: true });
        manager.dispose();
    });

    it("kills the process and reports unavailable when health never passes", async () => {
        seedInstalled();
        const { killed, spawnFn } = fakeSpawn();
        const manager = new VonSidecarManager({
            home,
            spawnFn,
            fetchFn: smokeFetch(),
            pickPort: async () => 51994,
            waitForPort: async () => false,
        });
        await expect(manager.ensureEndpoint()).resolves.toEqual({ unavailable: "sidecar_unavailable" });
        expect(killed).toEqual(["SIGTERM"]);
    });

    it("spawn defaults HF_HOME beneath the managed dir when unset", async () => {
        seedInstalled();
        const { spawned, spawnFn } = fakeSpawn();
        const manager = new VonSidecarManager({
            home,
            spawnFn,
            fetchFn: smokeFetch(),
            pickPort: async () => 51990,
            waitForPort: async () => true,
        });
        await manager.ensureEndpoint();
        expect(spawned).toHaveLength(1);
        expect(spawned[0]!.env?.HF_HOME).toBe(getVonHfDir(home));
        manager.dispose();
    });

    it("spawn respects an explicit HF_HOME from deps env", async () => {
        seedInstalled();
        const { spawned, spawnFn } = fakeSpawn();
        const manager = new VonSidecarManager({
            home,
            spawnFn,
            fetchFn: smokeFetch(),
            pickPort: async () => 51989,
            waitForPort: async () => true,
            env: { HF_HOME: "/custom/hf" },
        });
        await manager.ensureEndpoint();
        expect(spawned).toHaveLength(1);
        expect(spawned[0]!.env?.HF_HOME).toBe("/custom/hf");
        manager.dispose();
    });

    it("a user-run base URL skips management entirely", async () => {
        const { spawnFn } = fakeSpawn();
        const manager = new VonSidecarManager({
            home,
            spawnFn,
            fetchFn: smokeFetch(),
            env: { PI_SMARTREAD_JUDGE_BASE_URL: "http://user-run:8123" },
        });
        await expect(manager.ensureEndpoint()).resolves.toEqual({ baseUrl: "http://user-run:8123" });
    });

    it("smokeTest posts to /v1/systemone and never throws", async () => {
        const manager = new VonSidecarManager({ home, fetchFn: smokeFetch(0.42) });
        await expect(manager.smokeTest("http://127.0.0.1:9")).resolves.toEqual({ ok: true });
        const failing = new VonSidecarManager({
            home,
            fetchFn: async () => { throw new Error("conn refused"); },
        });
        const res = await failing.smokeTest("http://127.0.0.1:9");
        expect(res.ok).toBe(false);
        await expect(failing.smokeTest(undefined)).resolves.toEqual({ ok: false, error: "sidecar is not running" });
    });
});

describe("shared singleton", () => {
    it("constructs without spawning; ensureVonEndpoint resolves through it", async () => {
        const manager = getSharedVonSidecarManager({ home });
        expect(manager.getStatus()).toMatchObject({ running: false });
        // Not installed in this fresh tmp home: unavailable, and no process started.
        await expect(ensureVonEndpoint()).resolves.toEqual({ unavailable: "sidecar_unavailable" });
        expect(manager.getStatus()).toMatchObject({ running: false });
    });
});
