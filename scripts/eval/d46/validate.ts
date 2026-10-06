/**
 * D46 held-out set validator: structural checks (pure), quota checks
 * (pure), pinned-commit path checks (IO), and the sealed hash manifest.
 *
 * Query files live outside the repo; `findRepoQueryFiles` guards that
 * invariant by scanning a checkout for the sealed query-file layout.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    readdirSync,
    readFileSync,
    realpathSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import {
    D46_CLASSES,
    DEV_QUOTA,
    HOLDOUT_QUOTA,
    type D46Query,
    type D46QueryClass,
    type D46RepoManifest,
    type D46Split,
} from "./schema.js";

export interface D46ValidationResult {
    queries: D46Query[];
    errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/**
 * Reject gold paths that cannot be contained in the pinned checkout:
 * absolute paths and any `..` segment. Symlink escapes are caught by
 * the realpath containment check in checkPathsAtCommit.
 */
export function checkGoldPathForm(path: string, where: string): string[] {
    if (isAbsolute(path)) return [`${where}: absolute path escapes the corpus: ${path}`];
    if (path.split("/").some((segment) => segment === "..")) {
        return [`${where}: \`..\` segment escapes the corpus: ${path}`];
    }
    return [];
}

function checkGoldSpan(span: unknown, prefix: string, si: number): string[] {
    if (!isRecord(span)) return [`${prefix}.gold[${si}]: not an object`];
    const errors: string[] = [];
    if (typeof span["path"] !== "string" || (span["path"] as string).length === 0) {
        errors.push(`${prefix}.gold[${si}]: missing path`);
    } else {
        errors.push(...checkGoldPathForm(span["path"], `${prefix}.gold[${si}]`));
    }
    const start = span["startLine"];
    const end = span["endLine"];
    if (!Number.isInteger(start) || (start as number) < 1) {
        errors.push(`${prefix}.gold[${si}]: startLine must be an integer >= 1`);
    }
    if (!Number.isInteger(end) || (end as number) < 1) {
        errors.push(`${prefix}.gold[${si}]: endLine must be an integer >= 1`);
    }
    if (Number.isInteger(start) && Number.isInteger(end) && (start as number) > (end as number)) {
        errors.push(`${prefix}.gold[${si}]: startLine > endLine`);
    }
    if (span["grade"] !== 1 && span["grade"] !== 2) {
        errors.push(`${prefix}.gold[${si}]: grade must be 1|2`);
    }
    return errors;
}

function checkAbsence(prefix: string, cls: string, gold: unknown, absenceEvidence: unknown): string[] {
    if (cls !== "absence") {
        return absenceEvidence === undefined
            ? []
            : [`${prefix}: absenceEvidence only allowed for absence queries`];
    }
    const errors: string[] = [];
    if (gold !== undefined && Array.isArray(gold) && gold.length > 0) {
        errors.push(`${prefix}: absence queries must have empty gold`);
    }
    if (!isRecord(absenceEvidence)) {
        errors.push(`${prefix}: absence queries require absenceEvidence`);
        return errors;
    }
    if (!Array.isArray(absenceEvidence["searchesRun"]) || (absenceEvidence["searchesRun"] as unknown[]).length === 0) {
        errors.push(`${prefix}: absenceEvidence.searchesRun must be non-empty`);
    }
    if (!Array.isArray(absenceEvidence["synonymsChecked"]) || (absenceEvidence["synonymsChecked"] as unknown[]).length === 0) {
        errors.push(`${prefix}: absenceEvidence.synonymsChecked must be non-empty`);
    }
    return errors;
}

function checkExactForm(prefix: string, cls: string, exactForm: unknown): string[] {
    if (cls === "exact_ish") {
        return exactForm !== "literal" && exactForm !== "regex" && exactForm !== "identifier"
            ? [`${prefix}: exact_ish queries require exactForm literal|regex|identifier`]
            : [];
    }
    return exactForm === undefined ? [] : [`${prefix}: exactForm only allowed for exact_ish queries`];
}

function checkQueryIdentity(value: Record<string, unknown>, prefix: string, seen: Set<string>): string[] {
    const errors: string[] = [];
    const id = value["id"];
    if (typeof id !== "string" || id.length === 0) {
        errors.push(`${prefix}: missing id`);
    } else if (seen.has(id)) {
        errors.push(`${prefix}: duplicate id ${id}`);
    } else {
        seen.add(id);
    }
    if (typeof value["repo"] !== "string" || (value["repo"] as string).length === 0) {
        errors.push(`${prefix}: missing repo`);
    }
    if (value["split"] !== "dev" && value["split"] !== "holdout") {
        errors.push(`${prefix}: split must be dev|holdout`);
    }
    const cls = value["class"] as string;
    if (!D46_CLASSES.includes(cls as D46QueryClass)) {
        errors.push(`${prefix}: unknown class ${String(cls)}`);
    }
    return errors;
}

function checkQueryProse(value: Record<string, unknown>, prefix: string): string[] {
    const errors: string[] = [];
    if (typeof value["query"] !== "string" || (value["query"] as string).length === 0) {
        errors.push(`${prefix}: missing query text`);
    }
    if (typeof value["rationale"] !== "string" || (value["rationale"] as string).length === 0) {
        errors.push(`${prefix}: missing rationale`);
    }
    if (typeof value["author"] !== "string" || (value["author"] as string).length === 0) {
        errors.push(`${prefix}: missing author`);
    }
    if (typeof value["authoredAt"] !== "string" || Number.isNaN(Date.parse(value["authoredAt"] as string))) {
        errors.push(`${prefix}: authoredAt must be a date string`);
    }
    return errors;
}

function checkQueryMeta(value: Record<string, unknown>, prefix: string, seen: Set<string>): string[] {
    return [...checkQueryIdentity(value, prefix, seen), ...checkQueryProse(value, prefix)];
}

function checkQuery(value: unknown, index: number, seen: Set<string>): string[] {
    const prefix = `query[${index}]`;
    if (!isRecord(value)) return [`${prefix}: not an object`];
    const errors: string[] = checkQueryMeta(value, prefix, seen);
    const cls = value["class"] as string;
    const gold = value["gold"];
    if (!Array.isArray(gold)) {
        errors.push(`${prefix}: gold must be an array`);
    } else {
        errors.push(...gold.flatMap((span: unknown, si: number) => checkGoldSpan(span, prefix, si)));
    }
    errors.push(...checkAbsence(prefix, cls, gold, value["absenceEvidence"]));
    errors.push(...checkExactForm(prefix, cls, value["exactForm"]));
    return errors;
}

export function validateQueryDoc(doc: unknown): D46ValidationResult {
    if (!Array.isArray(doc)) return { queries: [], errors: ["doc: top level must be an array"] };
    const seen = new Set<string>();
    const errors = doc.flatMap((q, i) => checkQuery(q, i, seen));
    return { queries: errors.length === 0 ? (doc as D46Query[]) : [], errors };
}

export function quotaFor(split: D46Split) {
    return split === "holdout" ? HOLDOUT_QUOTA : DEV_QUOTA;
}

export function checkQuota(queries: D46Query[], split: D46Split): string[] {
    const quota = quotaFor(split);
    const errors: string[] = [];
    if (queries.some((q) => q.split !== split)) {
        errors.push(`${split}: mixed splits in one file`);
    }
    for (const cls of D46_CLASSES) {
        const count = queries.filter((q) => q.class === cls).length;
        if (count !== quota.perClass) {
            errors.push(`${split}: class ${cls} has ${count}, want ${quota.perClass}`);
        }
    }
    if (queries.length !== quota.total) {
        errors.push(`${split}: total ${queries.length}, want ${quota.total}`);
    }
    const repos = new Set(queries.map((q) => q.repo));
    if (repos.size !== quota.repos) {
        errors.push(`${split}: ${repos.size} repos, want ${quota.repos}`);
    }
    return errors;
}

function canonicalize(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
    if (isRecord(value)) {
        const keys = Object.keys(value).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

export interface D46Seal {
    sha256: string;
    queryCount: number;
}

export function sealQueries(queries: D46Query[]): D46Seal {
    const sorted = [...queries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const sha256 = createHash("sha256").update(canonicalize(sorted)).digest("hex");
    return { sha256, queryCount: sorted.length };
}

export function readRepoManifest(path: string): D46RepoManifest {
    return JSON.parse(readFileSync(path, "utf8")) as D46RepoManifest;
}

function countFileLines(path: string): number {
    const text = readFileSync(path, "utf8");
    if (text.length === 0) return 0;
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/**
 * Verify every gold path exists under the pinned clone at the pinned
 * commit and that each line range falls inside the file.
 */
export function checkPathsAtCommit(
    queries: D46Query[],
    manifest: D46RepoManifest,
    reposRoot: string,
): string[] {
    const errors: string[] = [];
    const pins = new Map(manifest.repos.map((r) => [`${r.owner}/${r.name}`, r]));
    for (const q of queries) {
        const pin = pins.get(q.repo);
        if (pin === undefined) {
            errors.push(`${q.id}: repo ${q.repo} not pinned`);
            continue;
        }
        const repoDir = join(reposRoot, `${pin.owner}__${pin.name}`);
        let head = "";
        try {
            head = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        } catch {
            errors.push(`${q.id}: cannot read HEAD of ${repoDir}`);
            continue;
        }
        if (head !== pin.sha) {
            errors.push(`${q.id}: ${q.repo} at ${head}, pinned ${pin.sha}`);
            continue;
        }
        for (const span of q.gold) {
            const full = join(repoDir, pin.corpusRoot, span.path);
            if (!existsSync(full) || !statSync(full).isFile()) {
                errors.push(`${q.id}: missing file ${span.path} in ${q.repo}`);
                continue;
            }
            try {
                const corpusReal = realpathSync(join(repoDir, pin.corpusRoot));
                const targetReal = realpathSync(full);
                if (targetReal !== corpusReal && !targetReal.startsWith(corpusReal + sep)) {
                    errors.push(`${q.id}: gold path escapes the corpus checkout: ${span.path}`);
                    continue;
                }
            } catch {
                errors.push(`${q.id}: missing file ${span.path} in ${q.repo}`);
                continue;
            }
            const lines = countFileLines(full);
            if (span.endLine > lines) {
                errors.push(`${q.id}: ${span.path} endLine ${span.endLine} beyond ${lines} lines`);
            }
        }
    }
    return errors;
}

const QUERY_FILE_RE = /(^|[./_-])d46-(dev|holdout)([./_-]|$)/;
const QUERY_DIR_RE = /(^|[\\/])d46[\\/]/;

export function findRepoQueryFiles(repoRoot: string): string[] {
    const hits: string[] = [];
    const skip = new Set([".git", "node_modules", ".pi-smartread", ".pi", "dist", "graphify-out"]);
    const walk = (dir: string): void => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (skip.has(entry.name)) continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (QUERY_DIR_RE.test(full) && full !== repoRoot) {
                    hits.push(full);
                }
                walk(full);
            } else if (entry.isFile() && (QUERY_FILE_RE.test(entry.name) || entry.name.endsWith(".d46.json"))) {
                hits.push(full);
            }
        }
    };
    walk(repoRoot);
    return hits.sort();
}

// ---- CLI: validate sealed query files ------------------------------------

export const D46_BENCH_ROOT = join(homedir(), ".cache", "pi-smartread-bench", "d46");

export interface D46SplitFile {
    file: string;
    sha256: string;
    queryCount: number;
}

export interface D46LoadedSplit {
    queries: D46Query[];
    files: D46SplitFile[];
    errors: string[];
}

/**
 * Load every `*.jsonl` query file in a split dir (one D46Query per
 * non-blank line). Manifest and second-label files are never query files.
 */
export function loadSplitQueries(splitDir: string): D46LoadedSplit {
    const queries: D46Query[] = [];
    const files: D46SplitFile[] = [];
    const errors: string[] = [];
    let entries;
    try {
        entries = readdirSync(splitDir).sort();
    } catch {
        return { queries, files, errors: [`split dir not found: ${splitDir}`] };
    }
    for (const name of entries) {
        if (!name.endsWith(".jsonl")) continue;
        const full = join(splitDir, name);
        const raw = readFileSync(full, "utf8");
        files.push({
            file: name,
            sha256: createHash("sha256").update(raw).digest("hex"),
            queryCount: 0,
        });
        const entry = files[files.length - 1] as D46SplitFile;
        for (const [li, line] of raw.split("\n").entries()) {
            if (line.trim().length === 0) continue;
            try {
                const parsed: unknown = JSON.parse(line);
                if (!isRecord(parsed)) {
                    errors.push(`${name}:${li + 1}: not an object`);
                    continue;
                }
                queries.push(parsed as unknown as D46Query);
                entry.queryCount += 1;
            } catch {
                errors.push(`${name}:${li + 1}: invalid JSON`);
            }
        }
    }
    if (files.length === 0) errors.push(`no .jsonl query files in ${splitDir}`);
    return { queries, files, errors };
}

export interface D46SplitManifest {
    version: 1;
    split: D46Split;
    createdAt: string;
    files: D46SplitFile[];
    countsByClass: Record<string, number>;
    countsByRepo: Record<string, number>;
    repos: D46RepoManifest["repos"];
    queriesSha256: string;
}

function expandHome(path: string): string {
    return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

export function loadRepoManifest(benchRoot: string): D46RepoManifest {
    const raw = readFileSync(join(benchRoot, "repos.json"), "utf8");
    return JSON.parse(raw) as D46RepoManifest;
}

/** Write the sealed manifest for a split (mode 0600). Returns the path. */
export function writeSplitManifest(
    splitDir: string,
    split: D46Split,
    loaded: D46LoadedSplit,
    pins: D46RepoManifest["repos"],
): string {
    const countsByClass: Record<string, number> = {};
    const countsByRepo: Record<string, number> = {};
    for (const cls of D46_CLASSES) countsByClass[cls] = 0;
    for (const q of loaded.queries) {
        countsByClass[q.class] = (countsByClass[q.class] ?? 0) + 1;
        countsByRepo[q.repo] = (countsByRepo[q.repo] ?? 0) + 1;
    }
    const manifest: D46SplitManifest = {
        version: 1,
        split,
        createdAt: new Date().toISOString(),
        files: loaded.files,
        countsByClass,
        countsByRepo,
        repos: pins,
        queriesSha256: sealQueries(loaded.queries).sha256,
    };
    const out = join(splitDir, "MANIFEST.sha256.json");
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
    chmodSync(out, 0o600);
    return out;
}

export function runValidateCli(argv: string[], benchRoot: string = D46_BENCH_ROOT): number {
    let split: string | undefined;
    let repo: string | undefined;
    let seal = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] as string;
        if (arg === "--split") split = argv[++i];
        else if (arg === "--repo") repo = argv[++i];
        else if (arg === "--seal") seal = true;
        else {
            console.error(`unknown argument: ${arg}`);
            console.error("usage: validate.ts --split dev|holdout [--repo <owner__name>] [--seal]");
            return 2;
        }
    }
    if (split !== "dev" && split !== "holdout") {
        console.error("usage: validate.ts --split dev|holdout [--repo <owner__name>] [--seal]");
        return 2;
    }
    if (seal && repo !== undefined) {
        console.error("--seal writes a split-wide manifest and cannot be combined with --repo");
        return 2;
    }
    const splitDir = join(benchRoot, split);
    const loaded = loadSplitQueries(splitDir);
    const errors = [...loaded.errors];
    let queries = loaded.queries;
    if (repo !== undefined) {
        const slug = repo.includes("__") ? repo.replace("__", "/") : repo;
        queries = queries.filter((q) => q.repo === slug);
        if (queries.length === 0) errors.push(`--repo ${repo}: no queries for ${slug}`);
    }
    errors.push(...validateQueryDoc(queries).errors);
    if (repo === undefined) errors.push(...checkQuota(queries, split));
    let manifest: D46RepoManifest;
    try {
        manifest = loadRepoManifest(benchRoot);
    } catch {
        console.error(`${benchRoot}/repos.json: cannot load repo pins`);
        return 2;
    }
    const reposRoot = manifest.reposDir ? expandHome(manifest.reposDir) : join(benchRoot, "repos");
    errors.push(...checkPathsAtCommit(queries, manifest, reposRoot));
    if (errors.length > 0) {
        for (const e of errors) console.error(`error: ${e}`);
        console.error(`${split}: ${errors.length} error(s), ${queries.length} queries`);
        return 2;
    }
    if (seal) {
        const pins = manifest.repos.filter((p) => p.split === split);
        const out = writeSplitManifest(splitDir, split, loaded, pins);
        console.log(`${split}: ok, ${queries.length} queries, manifest ${out}`);
    } else {
        console.log(`${split}: ok, ${queries.length} queries in ${loaded.files.length} file(s)`);
    }
    return 0;
}

const invokedAsCli =
    typeof process !== "undefined" &&
    process.argv[1] !== undefined &&
    (process.argv[1].endsWith("d46/validate.ts") || process.argv[1].endsWith("d46\\validate.ts"));
if (invokedAsCli) {
    process.exitCode = runValidateCli(process.argv.slice(2));
}
