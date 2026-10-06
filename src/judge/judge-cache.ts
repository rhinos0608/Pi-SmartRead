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

export class JudgeCache {
    private readonly file: string;
    private readonly entries = new Map<string, number>();
    private loaded = false;
    private readonly maxEntries: number;
    private persistedLines = 0;

    constructor(cacheDir: string | undefined, maxEntries = JUDGE_CACHE_MAX_ENTRIES) {
        this.file = cacheDir ? join(cacheDir, CACHE_FILE_NAME) : "";
        this.maxEntries = maxEntries;
    }

    get(key: string): number | undefined {
        this.ensureLoaded();
        const value = this.entries.get(key);
        if (value !== undefined) {
            this.entries.delete(key);
            this.entries.set(key, value);
        }
        return value;
    }

    set(key: string, p: number): void {
        if (!Number.isFinite(p) || p < 0 || p > 1) return;
        this.ensureLoaded();
        this.entries.delete(key);
        this.entries.set(key, p);
        if (this.file) {
            try {
                mkdirSync(join(this.file, ".."), { recursive: true });
                appendFileSync(this.file, `${JSON.stringify({ key, p })}\n`, "utf-8");
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
                const parsed = JSON.parse(trimmed) as { key?: unknown; p?: unknown };
                if (
                    typeof parsed.key === "string" &&
                    typeof parsed.p === "number" &&
                    Number.isFinite(parsed.p) &&
                    parsed.p >= 0 &&
                    parsed.p <= 1
                ) {
                    this.entries.delete(parsed.key);
                    this.entries.set(parsed.key, parsed.p);
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
                newest.map(([k, v]) => `${JSON.stringify({ key: k, p: v })}\n`).join(""),
                "utf-8",
            );
            renameSync(tmp, this.file);
            this.persistedLines = newest.length;
        } catch {
            // Best-effort.
        }
    }
}
