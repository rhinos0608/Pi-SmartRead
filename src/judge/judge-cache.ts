/**
 * Content-addressed verdict cache for judge probabilities.
 *
 * Key = sha256(backend + normalized baseUrl + model +
 * stableStringify(shared) + stableStringify(state) +
 * stableStringify(question)). Backend kind and endpoint are part of the key
 * so cloud and local verdicts (or two endpoints serving different model
 * versions under one alias) never share entries. API keys and other
 * secrets are never part of the key. Backed by an append-only JSONL file
 * in a caller-supplied directory; lazy-loaded, capped with compaction,
 * tolerant of corrupt lines. No new dependencies.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue, NoulQuestion } from "./types.js";

export const JUDGE_CACHE_MAX_ENTRIES = 20_000;
const CACHE_FILE_NAME = "verdicts.jsonl";

export function stableStringify(value: JsonValue | NoulQuestion | unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
}

/**
 * Normalize a judge endpoint base URL for cache-key purposes: trim
 * whitespace, lowercase scheme and host, drop trailing slashes. Never
 * receives credentials — callers pass only the endpoint URL.
 */
export function normalizeJudgeBaseUrl(baseUrl: string): string {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    const match = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/]*)(\/.*)?$/.exec(trimmed);
    if (!match) return trimmed.toLowerCase();
    return `${match[1]!.toLowerCase()}${match[2]!.toLowerCase()}${match[3] ?? ""}`;
}

export function judgeCacheKey(args: {
    backend: "cloud" | "local";
    baseUrl: string;
    model: string;
    shared: Record<string, JsonValue>;
    state: Record<string, JsonValue>;
    question: NoulQuestion;
}): string {
    const h = createHash("sha256");
    h.update(args.backend);
    h.update("\0");
    h.update(normalizeJudgeBaseUrl(args.baseUrl));
    h.update("\0");
    h.update(args.model);
    h.update("\0");
    h.update(stableStringify(args.shared));
    h.update("\0");
    h.update(stableStringify(args.state));
    h.update("\0");
    h.update(stableStringify(args.question));
    return h.digest("hex");
}

/** Canonical state ref used when computing cache keys (path-independent). */
export const JUDGE_CACHE_CANONICAL_REF = "ref";

/** Default verdict-cache entry lifetime: 7 days, in milliseconds. */
export const JUDGE_CACHE_DEFAULT_MAX_AGE_DAYS = 7;

export const JUDGE_CACHE_DEFAULT_MAX_AGE_MS =
    JUDGE_CACHE_DEFAULT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Resolve the verdict-cache max age from the environment. Accepts a
 * positive number of days; missing or invalid values fall back to the
 * 7-day default.
 */
export function resolveJudgeCacheMaxAgeMs(
    env: Record<string, string | undefined> = process.env,
): number {
    const raw = env.PI_SMARTREAD_JUDGE_CACHE_MAX_AGE_DAYS;
    if (raw === undefined) return JUDGE_CACHE_DEFAULT_MAX_AGE_MS;
    const days = Number(raw);
    if (!Number.isFinite(days) || days <= 0) return JUDGE_CACHE_DEFAULT_MAX_AGE_MS;
    return days * 24 * 60 * 60 * 1000;
}

interface JudgeCacheEntry {
    p: number;
    createdAt: number;
}

export class JudgeCache {
    private readonly file: string;
    private readonly entries = new Map<string, JudgeCacheEntry>();
    private loaded = false;
    private readonly maxEntries: number;
    private readonly maxAgeMs: number;
    private readonly now: () => number;
    private persistedLines = 0;

    constructor(
        cacheDir: string | undefined,
        maxEntries = JUDGE_CACHE_MAX_ENTRIES,
        opts: { maxAgeMs?: number; now?: () => number } = {},
    ) {
        this.file = cacheDir ? join(cacheDir, CACHE_FILE_NAME) : "";
        this.maxEntries = maxEntries;
        this.maxAgeMs = opts.maxAgeMs ?? resolveJudgeCacheMaxAgeMs();
        this.now = opts.now ?? Date.now;
    }

    get(key: string): number | undefined {
        this.ensureLoaded();
        const entry = this.entries.get(key);
        if (entry === undefined) return undefined;
        if (this.now() - entry.createdAt > this.maxAgeMs) {
            this.entries.delete(key);
            return undefined;
        }
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.p;
    }

    set(key: string, p: number): void {
        if (!Number.isFinite(p) || p < 0 || p > 1) return;
        this.ensureLoaded();
        const entry: JudgeCacheEntry = { p, createdAt: this.now() };
        this.entries.delete(key);
        this.entries.set(key, entry);
        if (this.file) {
            try {
                mkdirSync(join(this.file, ".."), { recursive: true });
                appendFileSync(this.file, `${JSON.stringify({ key, p, ts: entry.createdAt })}\n`, "utf-8");
                this.persistedLines++;
            } catch {
                // Cache writes are best-effort; judging must not fail.
            }
        }
        if (this.entries.size > this.maxEntries || this.persistedLines > this.maxEntries * 2) this.compact();
    }

    size(): number {
        this.ensureLoaded();
        return this.entries.size;
    }

    private ensureLoaded(): void {
        if (this.loaded) return;
        this.loaded = true;
        if (!this.file || !existsSync(this.file)) return;
        let raw: string;
        try {
            raw = readFileSync(this.file, "utf-8");
        } catch {
            return;
        }
        const lines = raw.split("\n");
        this.persistedLines = lines.filter((line) => line.trim().length > 0).length;
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const parsed = JSON.parse(trimmed) as { key?: unknown; p?: unknown; ts?: unknown };
                if (
                    typeof parsed.key === "string" &&
                    typeof parsed.p === "number" &&
                    Number.isFinite(parsed.p) &&
                    parsed.p >= 0 &&
                    parsed.p <= 1 &&
                    typeof parsed.ts === "number" &&
                    Number.isFinite(parsed.ts)
                ) {
                    // Old-format lines without a timestamp are misses, never errors.
                    this.entries.delete(parsed.key);
                    this.entries.set(parsed.key, { p: parsed.p, createdAt: parsed.ts });
                }
            } catch {
                continue; // tolerate corrupt lines
            }
        }
        if (this.entries.size > this.maxEntries || this.persistedLines > this.maxEntries * 2) this.compact();
    }

    private compact(): void {
        // Map order tracks access recency; keep the most-recently-used tail.
        const all = [...this.entries.entries()];
        const newest = all.slice(-this.maxEntries);
        this.entries.clear();
        for (const [k, v] of newest) this.entries.set(k, v);
        if (!this.file) return;
        try {
            mkdirSync(join(this.file, ".."), { recursive: true });
            const tmp = `${this.file}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
            writeFileSync(
                tmp,
                newest.map(([k, v]) => `${JSON.stringify({ key: k, p: v.p, ts: v.createdAt })}\n`).join(""),
                "utf-8",
            );
            renameSync(tmp, this.file);
            this.persistedLines = newest.length;
        } catch {
            // Best-effort.
        }
    }
}
