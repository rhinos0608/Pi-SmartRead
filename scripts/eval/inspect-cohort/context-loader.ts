import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { InspectTask } from "./schema.js";
import type { FrozenGraderContext, TaskGraderContext } from "./grade.js";

const execFileAsync = promisify(execFile);
const SHA256 = /^[0-9a-f]{64}$/;
const MANIFEST_KEYS = ["version", "repo", "commit", "head", "clean", "tasks", "sourceDigests", "goldSha256"] as const;

export type GraderContextLoadErrorCode =
    | "manifest-unreadable" | "manifest-mode" | "manifest-digest-mismatch" | "manifest-malformed"
    | "snapshot-mismatch" | "unclean-snapshot" | "task-missing" | "source-missing"
    | "source-digest-mismatch" | "symlink-escape" | "gold-digest-mismatch" | "task-context-malformed" | "task-context-mismatch";

export class GraderContextLoadError extends Error {
    constructor(readonly code: GraderContextLoadErrorCode, message: string) {
        super(message);
        this.name = "GraderContextLoadError";
    }
}

interface SealedManifest {
    version: 1;
    repo: string;
    commit: string;
    head: string;
    clean: boolean;
    tasks: Record<string, TaskGraderContext>;
    sourceDigests: Record<string, string>;
    goldSha256: Record<string, string>;
}

export interface LoadCertifiedGraderContextOptions {
    task: InspectTask;
    checkoutPath: string;
    manifestPath: string;
    /** Externally pinned digest of the exact canonical manifest bytes. */
    expectedManifestSha256: string;
    /** Gold input bytes whose digest is sealed in the manifest. */
    goldPath: string;
}

function sha256(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function fail(code: GraderContextLoadErrorCode, message: string): never {
    throw new GraderContextLoadError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTaskContext(value: unknown): value is TaskGraderContext {
    if (!isRecord(value)) return false;
    const allowed = ["binding", "universe", "sourceLines", "trackedFiles", "certifiedRoutes", "certifiedRelations", "certifiedEdges", "requestedEndpoints", "patchSha", "negativePolicy", "scalarPolicy", "completeness", "manifestRef"];
    if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
    const binding = value.binding;
    const universe = value.universe;
    if (!isRecord(binding) || typeof binding.repo !== "string" || typeof binding.commit !== "string" || typeof binding.subpath !== "string" || typeof binding.scope !== "string" || typeof binding.snapshotHead !== "string" || typeof binding.snapshotClean !== "boolean") return false;
    if (!isRecord(universe) || typeof universe.id !== "string" || typeof universe.sha256 !== "string" || typeof universe.count !== "number" || !Array.isArray(universe.files) || !universe.files.every((file) => typeof file === "string")) return false;
    if (!isRecord(value.sourceLines) || !Object.values(value.sourceLines).every((lines) => typeof lines === "number" && Number.isInteger(lines) && lines >= 1)) return false;
    if (!Array.isArray(value.trackedFiles) || !value.trackedFiles.every((file) => typeof file === "string")) return false;
    if (!Array.isArray(value.certifiedRoutes) || !value.certifiedRoutes.every((route) => isRecord(route) && typeof route.file === "string")) return false;
    if (!Array.isArray(value.certifiedRelations) || !value.certifiedRelations.every((relation) => isRecord(relation) && isRecord(relation.witness) && typeof relation.witness.path === "string")) return false;
    if (!Array.isArray(value.certifiedEdges) || !value.certifiedEdges.every((edge) => isRecord(edge) && isRecord(edge.witness) && typeof edge.witness.path === "string")) return false;
    if (value.requestedEndpoints !== undefined && (!isRecord(value.requestedEndpoints) || typeof value.requestedEndpoints.from !== "string" || typeof value.requestedEndpoints.to !== "string")) return false;
    if (value.patchSha !== undefined && typeof value.patchSha !== "string") return false;
    if (value.negativePolicy !== undefined && (!isRecord(value.negativePolicy) || typeof value.negativePolicy.minRecall !== "number" || typeof value.negativePolicy.minPrecision !== "number")) return false;
    if (value.scalarPolicy !== undefined && (!isRecord(value.scalarPolicy) || typeof value.scalarPolicy.caseSensitive !== "boolean")) return false;
    if (value.completeness !== undefined && (!isRecord(value.completeness) || typeof value.completeness.complete !== "boolean" || (value.completeness.truncated !== undefined && typeof value.completeness.truncated !== "boolean"))) return false;
    if (value.manifestRef !== undefined && typeof value.manifestRef !== "string") return false;
    return true;
}

function isInside(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function readContainedFile(root: string, relativePath: string): Promise<Buffer> {
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => part === ".." || part === "")) {
        fail("symlink-escape", `unsafe manifest path: ${relativePath}`);
    }
    const candidate = path.resolve(root, relativePath);
    let canonical: string;
    try { canonical = await realpath(candidate); }
    catch { return fail("source-missing", `manifest source file missing: ${relativePath}`); }
    if (!isInside(root, canonical)) fail("symlink-escape", `manifest path escapes checkout: ${relativePath}`);
    return readFile(canonical);
}

function parseManifest(value: unknown): SealedManifest {
    if (!isRecord(value) || Object.keys(value).length !== MANIFEST_KEYS.length || Object.keys(value).some((key) => !(MANIFEST_KEYS as readonly string[]).includes(key))) {
        return fail("manifest-malformed", "sealed manifest has unknown or missing fields");
    }
    if (value.version !== 1 || typeof value.repo !== "string" || typeof value.commit !== "string" || typeof value.head !== "string" || typeof value.clean !== "boolean" || !isRecord(value.tasks) || !isRecord(value.sourceDigests) || !isRecord(value.goldSha256)) {
        return fail("manifest-malformed", "sealed manifest shape/version is invalid");
    }
    for (const [file, digest] of Object.entries(value.sourceDigests)) {
        if (!file || typeof digest !== "string" || !SHA256.test(digest)) return fail("manifest-malformed", "sealed source digest map is invalid");
    }
    if (Object.values(value.goldSha256).some((digest) => typeof digest !== "string" || !SHA256.test(digest))) return fail("manifest-malformed", "sealed gold digest map is invalid");
    return value as unknown as SealedManifest;
}

async function snapshot(checkout: string): Promise<{ head: string; clean: boolean }> {
    try {
        const [{ stdout: head }, { stdout: status }] = await Promise.all([
            execFileAsync("git", ["rev-parse", "HEAD"], { cwd: checkout }),
            execFileAsync("git", ["status", "--porcelain"], { cwd: checkout }),
        ]);
        return { head: head.trim(), clean: status.length === 0 };
    } catch {
        return fail("snapshot-mismatch", "cannot verify checkout git snapshot");
    }
}

/** Load grader metadata only after independently verifying its sealed provenance and source bytes. */
export async function loadCertifiedGraderContext(options: LoadCertifiedGraderContextOptions): Promise<FrozenGraderContext> {
    let checkout: string;
    let manifestBytes: Buffer;
    let manifestStat;
    try {
        checkout = await realpath(options.checkoutPath);
        manifestStat = await lstat(options.manifestPath);
        manifestBytes = await readFile(options.manifestPath);
    } catch {
        return fail("manifest-unreadable", "cannot read checkout or sealed manifest");
    }
    if (process.platform !== "win32" && (manifestStat.mode & 0o777) !== 0o600) fail("manifest-mode", "sealed manifest must have mode 0600");
    if (!SHA256.test(options.expectedManifestSha256) || sha256(manifestBytes) !== options.expectedManifestSha256) fail("manifest-digest-mismatch", "sealed manifest digest does not match external pin");
    let parsed: unknown;
    try { parsed = JSON.parse(manifestBytes.toString("utf8")) as unknown; }
    catch { return fail("manifest-malformed", "sealed manifest is not valid JSON"); }
    const manifest = parseManifest(parsed);
    const current = await snapshot(checkout);
    if (manifest.repo !== options.task.repo || manifest.commit !== options.task.commit || manifest.head !== options.task.snapshot.head || current.head !== manifest.commit || current.head !== manifest.head) {
        fail("snapshot-mismatch", "task, manifest and checkout commit do not match");
    }
    if (!manifest.clean || !current.clean || !options.task.snapshot.clean) fail("unclean-snapshot", "sealed or current checkout snapshot is not clean");
    const taskContext = manifest.tasks[options.task.id];
    if (!taskContext) fail("task-missing", "task has no sealed grader context");
    if (!validateTaskContext(taskContext)) fail("task-context-malformed", "sealed task grader context has invalid or unknown fields");
    const binding = taskContext.binding;
    if (binding.repo !== options.task.repo || binding.commit !== options.task.commit || binding.subpath !== options.task.subpath || binding.scope !== options.task.scope || binding.snapshotHead !== options.task.snapshot.head || binding.snapshotClean !== true) {
        fail("task-context-mismatch", "sealed task grader context binding does not match task");
    }
    const requiredSources = new Set<string>([
        ...taskContext.trackedFiles,
        ...taskContext.universe.files,
        ...Object.keys(taskContext.sourceLines),
        ...taskContext.certifiedRoutes.map((route) => route.file),
        ...taskContext.certifiedRelations.map((relation) => relation.witness.path),
        ...taskContext.certifiedEdges.map((edge) => edge.witness.path),
    ]);
    for (const file of requiredSources) {
        const relative = path.posix.join(options.task.subpath.replace(/\\/g, "/"), file);
        if (!manifest.sourceDigests[relative]) fail("manifest-malformed", `sealed digest missing for cited source: ${relative}`);
    }
    for (const [relative, expected] of Object.entries(manifest.sourceDigests)) {
        const bytes = await readContainedFile(checkout, relative);
        if (sha256(bytes) !== expected) fail("source-digest-mismatch", `source digest mismatch: ${relative}`);
    }
    const goldPath = await realpath(options.goldPath).catch(() => fail("source-missing", "sealed gold input is missing"));
    const goldStat = await lstat(goldPath);
    if (process.platform !== "win32" && (goldStat.mode & 0o777) !== 0o600) fail("manifest-mode", "sealed gold input must have mode 0600");
    const gold = await readFile(goldPath);
    if (sha256(gold) !== manifest.goldSha256[options.task.split]) fail("gold-digest-mismatch", "sealed gold input digest mismatch");
    const context: TaskGraderContext = structuredClone(taskContext);
    context.manifestRef = options.expectedManifestSha256;
    return { tasks: { [options.task.id]: context } };
}
