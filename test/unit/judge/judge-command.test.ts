import { describe, expect, it, vi } from "vitest";
import {
    handleJudgeCommand,
    parseJudgeArgs,
    registerJudgeCommand,
    type JudgeCommandDeps,
} from "../../../src/judge/judge-command.js";
import type { JudgeMode } from "../../../src/judge/judge-settings.js";
import type { VonSidecarManager } from "../../../src/judge/von-sidecar.js";

const SECRET = "sk-or-v1-top-secret-key-value";

interface Notified {
    message: string;
    type?: string;
}

function makeCtx(opts: { key?: string; confirm?: boolean } = {}) {
    const notified: Notified[] = [];
    const confirms: Array<{ title: string; message: string }> = [];
    const ctx = {
        cwd: "/tmp/judge-cmd-test",
        modelRegistry: {
            getApiKeyForProvider: async (_provider: string) => opts.key,
        },
        ui: {
            notify: (message: string, type?: "info" | "warning" | "error") => {
                notified.push({ message, type });
            },
            confirm: async (title: string, message: string) => {
                confirms.push({ title, message });
                return opts.confirm ?? false;
            },
        },
    };
    return { ctx, notified, confirms };
}

function makeDeps(overrides: Partial<JudgeCommandDeps> & { mode?: JudgeMode } = {}) {
    let mode: JudgeMode = overrides.mode ?? "off";
    const written: JudgeMode[] = [];
    const manager = {
        getStatus: () => ({ installed: true, running: false, warming: false, version: "1.3.7" }),
        ensureEndpoint: async () => ({ baseUrl: "http://127.0.0.1:51991" }),
        smokeTest: async () => ({ ok: true as const }),
        dispose: () => {},
    } as unknown as VonSidecarManager;
    const deps: JudgeCommandDeps = {
        readSettings: () => ({ mode }),
        writeSettings: (m) => { mode = m; written.push(m); },
        sidecar: () => manager,
        isInstalled: () => true,
        sidecarDeps: { runCmd: async () => ({ code: 0, stdout: "Python 3.12.4\n", stderr: "" }) },
        cacheDir: undefined,
        env: {},
        ...overrides,
    };
    return { deps, written, manager, getMode: () => mode };
}

function leaked(notified: Notified[]): boolean {
    return notified.some((n) => n.message.includes(SECRET));
}

describe("parseJudgeArgs", () => {
    it("defaults empty input to status and lowercases", () => {
        expect(parseJudgeArgs("")).toBe("status");
        expect(parseJudgeArgs("  CLOUD  extra")).toBe("cloud");
    });
});

describe("registerJudgeCommand", () => {
    it("registers a judge command and no-ops without registerCommand", async () => {
        const calls: Array<{ name: string; options: { handler: (args: string, ctx: unknown) => Promise<void> } }> = [];
        registerJudgeCommand(
            { registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => { calls.push({ name, options }); } },
            makeDeps().deps,
        );
        expect(calls.map((c) => c.name)).toEqual(["judge"]);
        // Registration performs no process or network work: handler not invoked.
        expect(calls[0]!.options.handler).toBeTypeOf("function");
        expect(() => registerJudgeCommand({} as never)).not.toThrow();
    });
});

describe("/judge off", () => {
    it("persists off", async () => {
        const { ctx, notified } = makeCtx();
        const { deps, written, getMode } = makeDeps({ mode: "cloud" });
        await handleJudgeCommand("off", ctx, deps);
        expect(written).toEqual(["off"]);
        expect(getMode()).toBe("off");
        expect(notified).toHaveLength(1);
    });
});

describe("/judge status", () => {
    it("reports mode without ever printing the key", async () => {
        const { ctx, notified } = makeCtx({ key: SECRET });
        const { deps } = makeDeps({ mode: "cloud" });
        await handleJudgeCommand("status", ctx, deps);
        expect(notified).toHaveLength(1);
        expect(notified[0]!.message).toContain("Judge mode: cloud");
        expect(notified[0]!.message).toContain("api key: present");
        expect(leaked(notified)).toBe(false);
    });

    it("reports stopped sidecar for local mode", async () => {
        const { ctx, notified } = makeCtx();
        const { deps } = makeDeps({ mode: "off" });
        await handleJudgeCommand("", ctx, deps);
        expect(notified[0]!.message).toContain("Judge mode: off");
        expect(leaked(notified)).toBe(false);
    });

    it("does not read or display credentials for a non-OpenRouter endpoint", async () => {
        const { ctx, notified } = makeCtx({ key: SECRET });
        const secret = "endpoint-secret-value";
        const getOpenRouterKey = vi.fn(async () => SECRET);
        const { deps } = makeDeps({
            mode: "cloud",
            getOpenRouterKey,
            env: {
                PI_SMARTREAD_JUDGE_BASE_URL: `https://user:${secret}@proxy.test/decisions?token=${secret}`,
                PI_SMARTREAD_JUDGE_API_KEY: SECRET,
            },
        });
        await handleJudgeCommand("status", ctx, deps);
        expect(notified[0]!.message).toContain("endpoint override: https://proxy.test");
        expect(notified[0]!.message).toContain("api key: not checked");
        expect(getOpenRouterKey).not.toHaveBeenCalled();
        expect(notified[0]!.message).not.toContain(secret);
        expect(leaked(notified)).toBe(false);
    });

    it("sanitizes local endpoint overrides in status", async () => {
        const { ctx, notified } = makeCtx();
        const secret = "local-endpoint-secret";
        const { deps } = makeDeps({
            mode: "local",
            env: { PI_SMARTREAD_JUDGE_BASE_URL: `http://user:${secret}@127.0.0.1:8000/serve?token=${secret}` },
        });
        await handleJudgeCommand("status", ctx, deps);
        expect(notified[0]!.message).toContain("endpoint override: http://127.0.0.1:8000 (managed sidecar skipped)");
        expect(notified[0]!.message).not.toContain(secret);
    });
});

describe("/judge cloud", () => {
    it("enables cloud when the auth-store key exists, without printing it", async () => {
        const { ctx, notified } = makeCtx({ key: SECRET });
        const { deps, written } = makeDeps();
        await handleJudgeCommand("cloud", ctx, deps);
        expect(written).toEqual(["cloud"]);
        expect(notified[0]!.type).toBe("info");
        expect(leaked(notified)).toBe(false);
    });

    it("accepts an explicit env key without touching the auth store", async () => {
        const { ctx, notified } = makeCtx();
        const getOpenRouterKey = vi.fn(async () => undefined);
        const { deps, written } = makeDeps({ getOpenRouterKey, env: { PI_SMARTREAD_JUDGE_API_KEY: "env-key" } });
        await handleJudgeCommand("cloud", ctx, deps);
        expect(written).toEqual(["cloud"]);
        expect(getOpenRouterKey).not.toHaveBeenCalled();
        expect(leaked(notified)).toBe(false);
    });

    it("refuses to persist when no key exists and explains OAuth is insufficient", async () => {
        const { ctx, notified } = makeCtx();
        const { deps, written } = makeDeps();
        await handleJudgeCommand("cloud", ctx, deps);
        expect(written).toEqual([]);
        expect(notified[0]!.type).toBe("warning");
        expect(notified[0]!.message).toContain("OAuth-only");
        expect(leaked(notified)).toBe(false);
    });

    it("rejects a non-OpenRouter endpoint even when an explicit key exists", async () => {
        const { ctx, notified } = makeCtx({ key: SECRET });
        const getOpenRouterKey = vi.fn(async () => SECRET);
        const { deps, written } = makeDeps({
            getOpenRouterKey,
            env: {
                PI_SMARTREAD_JUDGE_BASE_URL: "https://custom.internal/decisions",
                PI_SMARTREAD_JUDGE_API_KEY: "explicit-key",
            },
        });
        await handleJudgeCommand("cloud", ctx, deps);
        expect(written).toEqual([]);
        expect(getOpenRouterKey).not.toHaveBeenCalled();
        expect(notified[0]!.message).toContain("only sends credentials to OpenRouter");
        expect(leaked(notified)).toBe(false);
    });
});

describe("/judge local", () => {
    it("asks confirmation before installing and stops when declined", async () => {
        const { ctx, notified, confirms } = makeCtx({ confirm: false });
        const { deps, written } = makeDeps({ isInstalled: () => false });
        await handleJudgeCommand("local", ctx, deps);
        expect(confirms).toHaveLength(1);
        expect(confirms[0]!.message).toContain("~3 GB");
        expect(written).toEqual([]);
        expect(notified.some((n) => n.message.includes("cancelled"))).toBe(true);
    });

    it("enables local after a running sidecar passes smoke", async () => {
        const { ctx, notified } = makeCtx();
        const { deps, written } = makeDeps({ mode: "off" });
        await handleJudgeCommand("local", ctx, deps);
        expect(written).toEqual(["local"]);
        expect(notified[notified.length - 1]!.message).toContain("http://127.0.0.1:51991");
    });

    it("persists local with a warming notice when the sidecar is still starting", async () => {
        const { ctx, notified } = makeCtx();
        const warming = {
            getStatus: () => ({ installed: true, running: true, warming: true, version: "1.3.7" }),
            ensureEndpoint: async () => ({ unavailable: "warming" as const }),
            smokeTest: async () => ({ ok: true as const }),
            dispose: () => {},
        } as unknown as VonSidecarManager;
        const { deps, written } = makeDeps({ sidecar: () => warming });
        await handleJudgeCommand("local", ctx, deps);
        expect(written).toEqual(["local"]);
        expect(notified[notified.length - 1]!.type).toBe("warning");
    });

    it("does not change mode when Python is too old", async () => {
        const { ctx, notified } = makeCtx();
        const { deps, written } = makeDeps({
            sidecarDeps: { runCmd: async () => ({ code: 0, stdout: "Python 3.11.0\n", stderr: "" }) },
        });
        await handleJudgeCommand("local", ctx, deps);
        expect(written).toEqual([]);
        expect(notified[0]!.type).toBe("error");
    });
});

describe("/judge install", () => {
    it("reports already-installed without prompting", async () => {
        const { ctx, notified, confirms } = makeCtx();
        const { deps, written } = makeDeps();
        await handleJudgeCommand("install", ctx, deps);
        expect(confirms).toHaveLength(0);
        expect(written).toEqual([]);
        expect(notified[0]!.message).toContain("already installed");
    });
});

describe("unknown subcommand", () => {
    it("shows usage", async () => {
        const { ctx, notified } = makeCtx();
        await handleJudgeCommand("frobnicate", ctx, makeDeps().deps);
        expect(notified[0]!.type).toBe("warning");
        expect(notified[0]!.message).toContain("Usage: /judge");
    });
});

describe("local experimental label (D48)", () => {
    it("status for local mode states experimental, near chance, and recommends cloud", async () => {
        const { ctx, notified } = makeCtx();
        const { deps } = makeDeps({ mode: "local" });
        await handleJudgeCommand("status", ctx, deps);
        const text = notified.map((n) => n.message).join("\n").toLowerCase();
        expect(text).toContain("experimental");
        expect(text).toContain("near chance");
        expect(text).toContain("cloud");
    });

    it("/judge local labels the mode experimental", async () => {
        const { ctx, notified } = makeCtx();
        const { deps } = makeDeps();
        await handleJudgeCommand("local", ctx, deps);
        const text = notified.map((n) => n.message).join("\n").toLowerCase();
        expect(text).toContain("experimental");
        expect(text).toContain("near chance");
    });
});
