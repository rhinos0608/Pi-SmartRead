/**
 * User-level judge mode file `~/.pi/agent/smartread-judge.json`
 * (`{mode, updatedAt}`), mirroring language-intelligence-config.ts:
 * tolerant reads, atomic tmp+rename writes. Directory injectable for tests.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type JudgeMode = "off" | "local" | "cloud";

export interface JudgeSettings {
    mode: JudgeMode;
    updatedAt: string;
}

function agentDir(home: string): string {
    const override = process.env.PI_CODING_AGENT_DIR;
    if (override && override.trim() !== "") return override;
    return join(home, ".pi", "agent");
}

function settingsPath(home: string): string {
    return join(agentDir(home), "smartread-judge.json");
}

function isJudgeMode(value: unknown): value is JudgeMode {
    return value === "off" || value === "local" || value === "cloud";
}

export function readJudgeSettings(home = homedir()): JudgeSettings {
    const fallback: JudgeSettings = { mode: "off", updatedAt: new Date(0).toISOString() };
    try {
        const p = settingsPath(home);
        if (!existsSync(p)) return fallback;
        const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
        const mode = (parsed as Record<string, unknown>).mode;
        if (!isJudgeMode(mode)) return fallback;
        const updatedAt = (parsed as Record<string, unknown>).updatedAt;
        return {
            mode,
            updatedAt: typeof updatedAt === "string" ? updatedAt : fallback.updatedAt,
        };
    } catch {
        return fallback;
    }
}

export function writeJudgeSettings(mode: JudgeMode, home = homedir()): JudgeSettings {
    const next: JudgeSettings = { mode, updatedAt: new Date().toISOString() };
    const p = settingsPath(home);
    const dir = dirname(p);
    try {
        mkdirSync(dir, { recursive: true });
    } catch {
        // mkdir failure surfaces at write time below.
    }
    const tmp = `${p}.tmp.${Date.now()}.${randomUUID()}`;
    try {
        writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8");
        renameSync(tmp, p);
    } catch {
        try {
            unlinkSync(tmp);
        } catch {
            // Best-effort cleanup.
        }
        throw new Error("failed to persist judge settings");
    }
    try {
        for (const f of readdirSync(dir)) {
            if (f.startsWith("smartread-judge.json.tmp.")) {
                try {
                    unlinkSync(join(dir, f));
                } catch {
                    // Best-effort cleanup.
                }
            }
        }
    } catch {
        // Best-effort cleanup.
    }
    return next;
}

export const __paths = { settingsPath };
