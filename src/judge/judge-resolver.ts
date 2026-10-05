/**
 * Backend resolution: pi surface (settings file + auth store) vs MCP
 * surface (environment variables).
 *
 * Security: network destinations and keys come only from the user
 * environment, pi's auth store, or the user-level settings file — never
 * from pi-smartread.config.json. The auth-store OpenRouter key is sent only
 * to the OpenRouter default origin. Cloud resolution refuses any endpoint
 * whose origin is not OpenRouter, even when an explicit key is configured.
 */
import { CLOUD_JUDGE_DEFAULT_BASE_URL, CLOUD_JUDGE_DEFAULT_MODEL, CloudJudge } from "./cloud-judge.js";
import { LOCAL_JUDGE_DEFAULT_MODEL, LocalJudge } from "./local-judge.js";
import { readJudgeSettings, type JudgeMode } from "./judge-settings.js";
import { JudgeError, type Judge, type JudgeErrorCode } from "./types.js";

export type JudgeSurface = "pi" | "mcp";

export interface ResolveJudgeDeps {
    surface: JudgeSurface;
    env: Record<string, string | undefined>;
    readSettings(): { mode: JudgeMode };
    getOpenRouterKey?(): Promise<string | undefined>;
    isOpenRouterOAuth?(): boolean;
    ensureLocalEndpoint?(signal?: AbortSignal): Promise<{ baseUrl: string } | { unavailable: string }>;
    cacheDir?: string;
    signal?: AbortSignal;
}

export type ResolveJudgeResult = { judge: Judge } | { unavailable: JudgeErrorCode };

function isJudgeMode(value: string | undefined): value is JudgeMode {
    return value === "off" || value === "local" || value === "cloud";
}

function openRouterOrigin(url: string): string | undefined {
    try {
        return new URL(url).origin;
    } catch {
        return undefined;
    }
}

export async function resolveJudge(deps: ResolveJudgeDeps): Promise<ResolveJudgeResult> {
    const mode = resolveMode(deps);
    if (mode === "off") return { unavailable: "aborted" as JudgeErrorCode };
    if (mode === "cloud") return resolveCloud(deps);
    return resolveLocal(deps);
}

function resolveMode(deps: ResolveJudgeDeps): JudgeMode {
    if (deps.surface === "mcp") {
        return isJudgeMode(deps.env.PI_SMARTREAD_JUDGE_MODE) ? deps.env.PI_SMARTREAD_JUDGE_MODE : "off";
    }
    // Pi surface: explicit per-process env override wins (benchmark
    // parallelism); invalid values fall back to the settings file.
    const envMode = deps.env.PI_SMARTREAD_JUDGE_MODE;
    if (envMode !== undefined && isJudgeMode(envMode)) return envMode;
    if (envMode !== undefined && envMode !== "" && !isJudgeMode(envMode)) {
        // Invalid: ignore, fall through to settings file.
    }
    try {
        return deps.readSettings().mode;
    } catch {
        return "off";
    }
}

async function resolveCloud(deps: ResolveJudgeDeps): Promise<ResolveJudgeResult> {
    const baseUrl = deps.env.PI_SMARTREAD_JUDGE_BASE_URL ?? CLOUD_JUDGE_DEFAULT_BASE_URL;
    const model = deps.env.PI_SMARTREAD_JUDGE_MODEL ?? CLOUD_JUDGE_DEFAULT_MODEL;
    const baseIsDefault = openRouterOrigin(baseUrl) === openRouterOrigin(CLOUD_JUDGE_DEFAULT_BASE_URL);
    if (!baseIsDefault) return { unavailable: "endpoint_not_allowed" };

    if (deps.surface === "pi") {
        const explicitKey = deps.env.PI_SMARTREAD_JUDGE_API_KEY;
        if (explicitKey) {
            return {
                judge: new CloudJudge({ apiKey: explicitKey, baseUrl, model, cacheDir: deps.cacheDir }),
            };
        }
        if (deps.isOpenRouterOAuth?.()) return { unavailable: "oauth_only" };
        const storeKey = await deps.getOpenRouterKey?.();
        if (!storeKey) return { unavailable: "no_key" };
        return { judge: new CloudJudge({ apiKey: storeKey, baseUrl, model, cacheDir: deps.cacheDir }) };
    }
    // MCP surface: key only from the environment.
    const key = deps.env.PI_SMARTREAD_JUDGE_API_KEY;
    if (!key) return { unavailable: "no_key" };
    return { judge: new CloudJudge({ apiKey: key, baseUrl, model, cacheDir: deps.cacheDir }) };
}

async function resolveLocal(deps: ResolveJudgeDeps): Promise<ResolveJudgeResult> {
    const model = deps.env.PI_SMARTREAD_JUDGE_MODEL ?? LOCAL_JUDGE_DEFAULT_MODEL;
    const override = deps.env.PI_SMARTREAD_JUDGE_BASE_URL;
    if (override) {
        return { judge: new LocalJudge({ baseUrl: override, model, cacheDir: deps.cacheDir }) };
    }
    if (!deps.ensureLocalEndpoint) return { unavailable: "sidecar_unavailable" };
    const endpoint = await deps.ensureLocalEndpoint(deps.signal);
    if ("unavailable" in endpoint) return { unavailable: endpoint.unavailable as JudgeErrorCode };
    return { judge: new LocalJudge({ baseUrl: endpoint.baseUrl, model, cacheDir: deps.cacheDir }) };
}

export function toJudgeError(result: ResolveJudgeResult): JudgeError | undefined {
    if ("judge" in result) return undefined;
    return new JudgeError(result.unavailable, result.unavailable);
}

/** Default `readSettings` wired to the user-level settings file. */
export function defaultReadSettings(): { mode: JudgeMode } {
    return readJudgeSettings();
}
