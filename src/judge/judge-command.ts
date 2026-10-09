/**
 * `/judge` slash command: `off | local | cloud | status | install`.
 *
 * Mode persists to the user-level settings file (honors PI_CODING_AGENT_DIR
 * via judge-settings.ts). The cloud path checks OpenRouter key *presence*
 * only — the key value is never printed, logged, or embedded in any message.
 * The local path asks explicit UI confirmation before the ~3 GB install.
 * All collaborators are injectable; registering the command performs no
 * network or process work.
 */

import { CLOUD_JUDGE_DEFAULT_BASE_URL, CLOUD_JUDGE_DEFAULT_MODEL } from "./cloud-judge.js";
import { LOCAL_JUDGE_DEFAULT_MODEL } from "./local-judge.js";
import { JudgeCache } from "./judge-cache.js";
import { isStateRoot } from "../workspace/state-root.js";
import { readJudgeSettings, writeJudgeSettings, type JudgeMode } from "./judge-settings.js";
import {
    checkPythonVersion,
    getSharedVonSidecarManager,
    installVonSidecar,
    isVonInstalled,
    type VonSidecarDeps,
    type VonSidecarManager,
} from "./von-sidecar.js";

const JUDGE_USAGE = "Usage: /judge off | local | cloud | status | install";

/** Local von judge is experimental: measured near chance on the SmartRead relevance benchmark. */
export const LOCAL_JUDGE_EXPERIMENTAL_NOTE =
    "experimental: local mode measured near chance on the SmartRead relevance benchmark; cloud recommended";

export interface JudgeCommandDeps {
    readSettings?: () => { mode: JudgeMode };
    writeSettings?: (mode: JudgeMode) => unknown;
    getOpenRouterKey?: (ctx: unknown) => Promise<string | undefined>;
    sidecar?: () => VonSidecarManager;
    sidecarDeps?: VonSidecarDeps;
    isInstalled?: () => boolean;
    cacheDir?: string;
    getSessionCostUsd?: () => number | undefined;
    env?: Record<string, string | undefined>;
}

interface Ctx {
    cwd?: string;
    modelRegistry?: { getApiKeyForProvider?: (provider: string) => Promise<string | undefined> };
    ui?: {
        notify?: (message: string, type?: "info" | "warning" | "error") => void;
        confirm?: (title: string, message: string) => Promise<boolean>;
    };
}

function notify(ctx: Ctx, message: string, type: "info" | "warning" | "error" = "info"): void {
    try {
        ctx.ui?.notify?.(message, type);
    } catch {
        // UI is best-effort (headless hosts may throw).
    }
}

function defaultCacheDir(ctx: Ctx): string | undefined {
    const root = ctx.cwd ?? process.cwd();
    if (!root) return undefined;
    // F4: no verdict cache outside a canonical state root (memory-only judging).
    if (!isStateRoot(root)) return undefined;
    return `${root}/.pi-smartread/judge-cache`;
}

function openRouterOrigin(url: string): string | undefined {
    try {
        return new URL(url).origin;
    } catch {
        return undefined;
    }
}

function displayEndpoint(url: string): string {
    return openRouterOrigin(url) ?? "custom endpoint";
}

async function defaultGetOpenRouterKey(ctx: unknown): Promise<string | undefined> {
    try {
        const registry = (ctx as Ctx).modelRegistry;
        if (typeof registry?.getApiKeyForProvider !== "function") return undefined;
        return await registry.getApiKeyForProvider("openrouter");
    } catch {
        return undefined;
    }
}

function cacheSize(cacheDir: string | undefined): number | undefined {
    if (!cacheDir) return undefined;
    try {
        return new JudgeCache(cacheDir).size();
    } catch {
        return undefined;
    }
}

export function parseJudgeArgs(args: string): string {
    return (args.trim().split(/\s+/).filter(Boolean)[0] ?? "status").toLowerCase();
}

interface ResolvedDeps {
    env: Record<string, string | undefined>;
    readSettings: () => { mode: JudgeMode };
    writeSettings: (mode: JudgeMode) => unknown;
    getOpenRouterKey: (ctx: unknown) => Promise<string | undefined>;
    getSidecar: () => VonSidecarManager;
    isInstalled: () => boolean;
    sidecarDeps: VonSidecarDeps;
    cacheDir: string | undefined;
    getSessionCostUsd?: () => number | undefined;
}

function resolveDeps(ctx: Ctx, deps: JudgeCommandDeps): ResolvedDeps {
    return {
        env: deps.env ?? process.env,
        readSettings: deps.readSettings ?? readJudgeSettings,
        writeSettings: deps.writeSettings ?? writeJudgeSettings,
        getOpenRouterKey: deps.getOpenRouterKey ?? defaultGetOpenRouterKey,
        getSidecar: deps.sidecar ?? (() => getSharedVonSidecarManager(deps.sidecarDeps ?? {})),
        isInstalled: deps.isInstalled ?? isVonInstalled,
        sidecarDeps: deps.sidecarDeps ?? {},
        cacheDir: deps.cacheDir ?? defaultCacheDir(ctx),
        getSessionCostUsd: deps.getSessionCostUsd,
    };
}

async function handleStatus(ctx: Ctx, r: ResolvedDeps): Promise<void> {
    const mode = r.readSettings().mode;
    const lines = [`Judge mode: ${mode}`];
    if (mode === "off") {
        lines.push("backend: none (judging disabled; grep output is unjudged)");
    } else if (mode === "cloud") {
        const model = r.env.PI_SMARTREAD_JUDGE_MODEL ?? CLOUD_JUDGE_DEFAULT_MODEL;
        lines.push(`backend: cloud (TypeSafe Jev via OpenRouter, model ${model})`);
        const baseUrl = r.env.PI_SMARTREAD_JUDGE_BASE_URL ?? CLOUD_JUDGE_DEFAULT_BASE_URL;
        const baseIsOpenRouter = openRouterOrigin(baseUrl) === openRouterOrigin(CLOUD_JUDGE_DEFAULT_BASE_URL);
        if (r.env.PI_SMARTREAD_JUDGE_BASE_URL) lines.push(`endpoint override: ${displayEndpoint(baseUrl)}`);
        if (!baseIsOpenRouter) {
            lines.push("api key: not checked (cloud only accepts OpenRouter)");
        } else {
            const key = r.env.PI_SMARTREAD_JUDGE_API_KEY ?? (await r.getOpenRouterKey(ctx));
            lines.push(`api key: ${key ? "present" : "missing"}`);
        }
    } else {
        const model = r.env.PI_SMARTREAD_JUDGE_MODEL ?? LOCAL_JUDGE_DEFAULT_MODEL;
        lines.push(`backend: local (von sidecar, model ${model})`);
        lines.push(`note: ${LOCAL_JUDGE_EXPERIMENTAL_NOTE}.`);
        const override = r.env.PI_SMARTREAD_JUDGE_BASE_URL;
        if (override) {
            lines.push(`endpoint override: ${displayEndpoint(override)} (managed sidecar skipped)`);
        } else {
            lines.push(`installed: ${r.isInstalled() ? "yes" : "no"}`);
            const status = r.getSidecar().getStatus();
            lines.push(`sidecar: ${status.running ? (status.warming ? "running (warming up)" : `running (${displayEndpoint(status.baseUrl ?? "")})`) : "stopped"}`);
        }
    }
    const size = cacheSize(r.cacheDir);
    if (size !== undefined) lines.push(`verdict cache: ${size} entries`);
    const cost = r.getSessionCostUsd?.();
    lines.push(`session cost: ${cost === undefined ? "n/a" : `$${cost.toFixed(4)}`}`);
    notify(ctx, lines.join("\n"), "info");
}

/** D46 holdout finding surfaced when enabling cloud (D70): concise evidence note. */
export const CLOUD_JUDGE_HOLDOUT_NOTE =
    "D46 holdout (210 queries / 8 repos): judge-on raised emptied answerable queries (false-empty ~2.4%→17.3%; net harms under 6:1 FN:FP utility, 95% CI [+0.55,+1.06]/query).\n" +
    "Kept queries gained precision/read-ready; prefer judge where precision matters more than recall.\n" +
    "Thresholds were dev-tuned — do not retune against this holdout.";

async function handleCloud(ctx: Ctx, r: ResolvedDeps): Promise<void> {
    const baseUrl = r.env.PI_SMARTREAD_JUDGE_BASE_URL ?? CLOUD_JUDGE_DEFAULT_BASE_URL;
    const baseIsDefault = openRouterOrigin(baseUrl) === openRouterOrigin(CLOUD_JUDGE_DEFAULT_BASE_URL);
    if (!baseIsDefault) {
        notify(ctx, "Cloud judge only sends credentials to OpenRouter; this endpoint override is not allowed. Mode unchanged.", "warning");
        return;
    }
    const explicitKey = r.env.PI_SMARTREAD_JUDGE_API_KEY;
    const present = !!explicitKey || !!(await r.getOpenRouterKey(ctx));
    if (!present) {
        notify(
            ctx,
            "Cloud judge needs an OpenRouter API key, which was not found. " +
                "Add one via pi's auth store (an OAuth-only login is not sufficient) or set PI_SMARTREAD_JUDGE_API_KEY. Mode unchanged.",
            "warning",
        );
        return;
    }
    r.writeSettings("cloud");
    notify(ctx, `Cloud judge enabled (TypeSafe Jev via OpenRouter). API key present.\n${CLOUD_JUDGE_HOLDOUT_NOTE}`, "info");
}

async function ensureInstalled(ctx: Ctx, r: ResolvedDeps): Promise<boolean> {
    if (r.isInstalled()) return true;
    let confirmed = false;
    try {
        confirmed = await ctx.ui?.confirm?.(
            "Install von local judge?",
            "Downloads ~3 GB (model weights + Python dependencies) into ~/.pi/agent/judge/von/ and installs a pinned von-sdk in an isolated venv.",
        ) ?? false;
    } catch {
        confirmed = false;
    }
    if (!confirmed) {
        notify(ctx, "Install cancelled. Mode unchanged.", "info");
        return false;
    }
    notify(ctx, "Installing von local judge (~3 GB first download)…", "info");
    const result = await installVonSidecar(r.sidecarDeps, (line) => notify(ctx, line, "info"));
    if (!result.ok) {
        notify(ctx, `Install failed: ${result.error}. Mode unchanged.`, "error");
        return false;
    }
    notify(ctx, `Installed von local judge → ${result.vonDir}`, "info");
    return true;
}

async function handleLocal(ctx: Ctx, r: ResolvedDeps): Promise<void> {
    const python = await checkPythonVersion(r.sidecarDeps);
    if (!python.ok) {
        notify(ctx, `Local judge unavailable: ${python.error}. Mode unchanged.`, "error");
        return;
    }
    if (!(await ensureInstalled(ctx, r))) return;
    const endpoint = await r.getSidecar().ensureEndpoint();
    if ("unavailable" in endpoint) {
        if (endpoint.unavailable === "warming") {
            r.writeSettings("local");
            notify(ctx, `Local judge enabled (${LOCAL_JUDGE_EXPERIMENTAL_NOTE}); sidecar is still warming up. Grep returns unjudged results until it is ready.`, "warning");
        } else {
            notify(ctx, `Local judge installed but the sidecar failed to start (${endpoint.unavailable}). Mode unchanged.`, "error");
        }
        return;
    }
    const smoke = await r.getSidecar().smokeTest(endpoint.baseUrl);
    r.writeSettings("local");
    if (smoke.ok) {
        notify(ctx, `Local judge enabled (${LOCAL_JUDGE_EXPERIMENTAL_NOTE}; von sidecar at ${displayEndpoint(endpoint.baseUrl)}).`, "info");
    } else {
        notify(ctx, `Local judge enabled (${LOCAL_JUDGE_EXPERIMENTAL_NOTE}); sidecar smoke test failed (${smoke.error}). Grep returns unjudged results until it is ready.`, "warning");
    }
}

async function handleInstall(ctx: Ctx, r: ResolvedDeps): Promise<void> {
    const python = await checkPythonVersion(r.sidecarDeps);
    if (!python.ok) {
        notify(ctx, `Local judge unavailable: ${python.error}.`, "error");
        return;
    }
    if (r.isInstalled()) {
        notify(ctx, "von local judge is already installed.", "info");
        return;
    }
    await ensureInstalled(ctx, r);
}

export async function handleJudgeCommand(args: string, ctx: Ctx, deps: JudgeCommandDeps = {}): Promise<void> {
    const r = resolveDeps(ctx, deps);
    const sub = parseJudgeArgs(args);

    if (sub === "status" || sub === "") {
        await handleStatus(ctx, r);
        return;
    }

    if (sub === "off") {
        r.writeSettings("off");
        notify(ctx, "Judge disabled. Grep output returns unjudged results.", "info");
        return;
    }

    if (sub === "cloud") {
        await handleCloud(ctx, r);
        return;
    }

    if (sub === "install") {
        await handleInstall(ctx, r);
        return;
    }

    if (sub === "local") {
        await handleLocal(ctx, r);
        return;
    }

    notify(ctx, `Unknown subcommand: ${sub}. ${JUDGE_USAGE}`, "warning");
}

export function registerJudgeCommand(pi: { registerCommand?: unknown }, deps: JudgeCommandDeps = {}): void {
    if (typeof (pi as { registerCommand?: unknown }).registerCommand !== "function") return;
    (pi as { registerCommand: (name: string, options: { description: string; handler: (args: string, ctx: Ctx) => Promise<void> }) => void }).registerCommand("judge", {
        description: "Relevance judge — off | local (experimental) | cloud | status | install",
        handler: async (args: string, ctx: Ctx) => handleJudgeCommand(args, ctx, deps),
    });
}
