import { join } from "node:path";
import { isStateRoot } from "../workspace/state-root.js";
import { resolveJudge, type ResolveJudgeResult } from "./judge-resolver.js";
import { readJudgeSettings } from "./judge-settings.js";
import { getSharedVonSidecarManager } from "./von-sidecar.js";

interface PiJudgeContext {
    modelRegistry?: {
        getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
    };
}

/**
 * Verdict-cache dir at the canonical state root, or `undefined` when `root`
 * is not one (F4): no judge cache directory outside a canonical state root.
 */
function workspaceCacheDir(root: string): string | undefined {
    if (!isStateRoot(root)) return undefined;
    return join(root, ".pi-smartread", "judge-cache");
}

/** Resolve a Pi-extension judge using the current execute context and workspace. */
export function resolvePiJudge(
    root: string,
    context: unknown,
    signal?: AbortSignal,
): Promise<ResolveJudgeResult> {
    const registry = (context as PiJudgeContext | undefined)?.modelRegistry;
    return resolveJudge({
        surface: "pi",
        env: process.env,
        readSettings: readJudgeSettings,
        getOpenRouterKey: async () => {
            try {
                return await registry?.getApiKeyForProvider?.("openrouter");
            } catch {
                return undefined;
            }
        },
        ensureLocalEndpoint: (sidecarSignal) => getSharedVonSidecarManager().ensureEndpoint(sidecarSignal),
        cacheDir: workspaceCacheDir(root),
        signal,
    });
}

/** Resolve a standalone MCP judge from its user environment and workspace. */
export function resolveMcpJudge(root: string, signal?: AbortSignal): Promise<ResolveJudgeResult> {
    return resolveJudge({
        surface: "mcp",
        env: process.env,
        readSettings: () => ({ mode: "off" }),
        ensureLocalEndpoint: (sidecarSignal) => getSharedVonSidecarManager().ensureEndpoint(sidecarSignal),
        cacheDir: workspaceCacheDir(root),
        signal,
    });
}
