/**
 * Unified-diff patch parsing for the external grep benchmark.
 *
 * Derives known-patch-file gold (D14): production files plus base-side
 * hunk line ranges. Production-filter rules are explicit in
 * PRODUCTION_FILTER_RULES and unit-tested. New files (--- /dev/null,
 * no base side) are recorded as excluded, never counted as locatable gold.
 * Deleted files (+++ /dev/null) keep their base-side hunks: the file
 * exists at the base commit.
 */

import type { ExcludedFile, GoldHunk } from "./instance.js";

export interface ParsedFilePatch {
    /** New-side path (b/... stripped); null when unparseable. */
    file: string | null;
    /** True when the file is new in the patch (--- /dev/null). */
    isNewFile: boolean;
    /** True when the file is deleted by the patch (+++ /dev/null). */
    isDeletedFile: boolean;
    /** Base-side 1-based inclusive ranges from @@ -start,len @@ headers. */
    baseRanges: Array<{ start: number; end: number }>;
}

export interface ClassifiedPatchFile {
    file: string;
    excluded: boolean;
    /** Set when excluded: the filter reason. */
    reason?: ExcludedFile["reason"];
}

/**
 * Production filter, evaluated in order. A path is excluded when ANY rule
 * matches; the first matching rule supplies the reason.
 */
const FILTER_RULES: Array<{ reason: ExcludedFile["reason"]; test: (file: string) => boolean }> = [
    {
        reason: "test",
        test: (f) =>
            /(^|\/)(test|tests|__tests__|__fixtures__|fixtures|snapshots|__snapshots__)\//.test(f) ||
            /\.test\.[^/]+$/.test(f) ||
            /\.spec\.[^/]+$/.test(f) ||
            /(^|\/)(test|spec|e2e)[^/]*\.[^/]+$/.test(f),
    },
    {
        reason: "doc",
        test: (f) =>
            /(^|\/)(docs?|documentation|examples|website|blog)\//.test(f) ||
            /\.(md|mdx|rst|txt)$/.test(f),
    },
    {
        reason: "config",
        test: (f) => {
            if (
                /(^|\/)(\.github|\.circleci|\.travis|\.vscode|\.changeset)\//.test(f) ||
                /(^|\/)(\.travis\.yml|Jenkinsfile|Dockerfile|docker-compose.*\.yml)$/.test(f) ||
                /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock|poetry\.lock)$/.test(f)
            ) {
                return true;
            }
            const base = f.slice(f.lastIndexOf("/") + 1);
            return (
                /^(tsconfig|jsconfig|babel|webpack|vite|vitest|jest|eslint|prettier|rollup|esbuild).*/.test(base) ||
                /\.config\.[^/]+$/.test(base) ||
                /^\.(babelrc|eslintrc|prettierrc)/.test(base)
            );
        },
    },
];

function stripPrefix(path: string): string {
    return path.replace(/^[ab]\//, "");
}

/** Parse a unified diff into per-file entries (base-side ranges only). */
export function parseUnifiedDiff(patch: string): ParsedFilePatch[] {
    const files: ParsedFilePatch[] = [];
    const lines = patch.split("\n");
    let current: ParsedFilePatch | null = null;
    for (const line of lines) {
        if (line.startsWith("diff --git ")) {
            const parts = line.split(" ");
            const bSide = parts[parts.length - 1] ?? "";
            current = { file: stripPrefix(bSide), isNewFile: false, isDeletedFile: false, baseRanges: [] };
            files.push(current);
        } else if (current && line.startsWith("--- ")) {
            if (line.slice(4).trim() === "/dev/null") current.isNewFile = true;
        } else if (current && line.startsWith("+++ ")) {
            const rest = line.slice(4).trim();
            if (rest === "/dev/null") {
                current.isDeletedFile = true;
            } else if (current.file === null || current.file === "/dev/null") {
                current.file = stripPrefix(rest.split("\t")[0] ?? rest);
            }
        } else if (current && line.startsWith("@@ ")) {
            const m = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
            if (m) {
                const start = Number(m[1]);
                const len = m[2] === undefined ? 1 : Number(m[2]);
                // Zero-length base range (pure insertion point): record the
                // anchor line so hunk overlap still has a base-side span.
                const end = len === 0 ? start : start + len - 1;
                current.baseRanges.push({ start, end });
            }
        }
    }
    return files.filter((f) => f.file !== null && f.file !== "/dev/null");
}

/** Apply the production filter to a repo-relative path. */
export function classifyPatchFile(file: string): ClassifiedPatchFile {
    for (const rule of FILTER_RULES) {
        if (rule.test(file)) return { file, excluded: true, reason: rule.reason };
    }
    return { file, excluded: false };
}

export interface GoldDerivation {
    goldFiles: string[];
    goldHunks: GoldHunk[];
    excludedFiles: ExcludedFile[];
}

/**
 * Derive known-patch-file gold from a fix patch. New files (no base side)
 * are recorded as excluded with reason "new-file-no-base" and never appear
 * in goldFiles/goldHunks.
 */
export function deriveGold(patch: string): GoldDerivation {
    const goldFiles: string[] = [];
    const goldHunks: GoldHunk[] = [];
    const excludedFiles: ExcludedFile[] = [];
    for (const entry of parseUnifiedDiff(patch)) {
        const file = entry.file as string;
        if (entry.isNewFile) {
            excludedFiles.push({ file, reason: "new-file-no-base" });
            continue;
        }
        const classified = classifyPatchFile(file);
        if (classified.excluded) {
            excludedFiles.push({ file, reason: classified.reason as ExcludedFile["reason"] });
            continue;
        }
        goldFiles.push(file);
        goldHunks.push({ file, ranges: entry.baseRanges });
    }
    return { goldFiles, goldHunks, excludedFiles };
}
