import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { INSPECT_ANSWER_SHAPES, parseInspectJsonl, toInspectRunnerView, type InspectFamily, type InspectTask } from "./schema.js";
import { INSPECT_GENERIC_TEXT, INSPECT_INSTRUCTED_TEXT } from "./prompts.js";
import { parseSurfaceIdentity, type SurfaceIdentity } from "../surface-identity.js";
import { buildPiArgs, launchPiSession, type PiSpawnFn, type TebArm } from "../teb/launch.js";
import { claimHoldoutOpening, classifyInfraFailure, extractSessionIdentity, parseFreezeFile, scanLogForContamination, sha256Hex, type TebInfraFailure, type TebSessionIdentity } from "../teb/run.js";

export const INSPECT_RUNNER_VERSION = 1;
export const INSPECT_TOOL_ALLOWLIST = "read,bash,grep,find,inspect,LSP";
export type InspectSelectorIdentity = SurfaceIdentity;

export interface InspectSessionValidityInput {
    identityMismatch: string | null;
    infraFailure: TebInfraFailure | null;
    contaminated: boolean;
    timedOut: boolean;
    failed?: boolean;
}
export interface InspectSessionValidity {
    excluded: boolean;
    exclusionReason: string | null;
    rerunRequired: boolean;
    gradedFailure: boolean;
}
export function sessionValidity(input: InspectSessionValidityInput): InspectSessionValidity {
    const excluded = !input.contaminated && !input.timedOut && (input.identityMismatch !== null || input.infraFailure !== null);
    return {
        excluded,
        exclusionReason: excluded ? input.infraFailure?.detail ?? input.identityMismatch : null,
        rerunRequired: excluded,
        gradedFailure: input.contaminated || input.timedOut || (input.failed === true && !excluded),
    };
}

export function summarizeExclusions<T extends { excluded: boolean }>(sessions: T[]): { batchInvalidated: boolean; rerunList: number[] } {
    const rerunList = sessions.flatMap((session, index) => session.excluded ? [index] : []);
    return { batchInvalidated: sessions.length > 0 && rerunList.length / sessions.length > 0.05, rerunList };
}

export interface InspectResolvedIdentity extends TebSessionIdentity {
    responseModel?: string | null;
    providerThinkingLevel?: string | null;
}

export function extractInspectSessionIdentity(logText: string): InspectResolvedIdentity {
    const base = extractSessionIdentity(logText);
    let responseModel: string | null = null;
    let providerThinkingLevel: string | null = null;
    for (const line of logText.split("\n")) {
        let parsed: unknown;
        try { parsed = JSON.parse(line) as unknown; } catch { continue; }
        if (typeof parsed !== "object" || parsed === null) continue;
        const wrapper = parsed as Record<string, unknown>;
        const event = wrapper["event"] !== undefined ? wrapper["event"] : parsed;
        if (typeof event !== "object" || event === null) continue;
        const envelope = event as Record<string, unknown>;
        const message = typeof envelope["message"] === "object" && envelope["message"] !== null ? envelope["message"] as Record<string, unknown> : null;
        const rawResponseModel = message?.["responseModel"] ?? envelope["responseModel"];
        const rawThinking = message?.["providerThinkingLevel"] ?? envelope["providerThinkingLevel"];
        if (responseModel === null && typeof rawResponseModel === "string") responseModel = rawResponseModel;
        if (providerThinkingLevel === null && typeof rawThinking === "string") providerThinkingLevel = rawThinking;
    }
    return { ...base, responseModel, providerThinkingLevel };
}

export function checkInspectSessionIdentity(
    identity: InspectResolvedIdentity,
    requested: { model: string; thinking: string },
): { ok: boolean; reason: string | null } {
    const separator = requested.model.indexOf("/");
    if (separator < 1) return { ok: false, reason: "requested model must pin provider/model" };
    const provider = requested.model.slice(0, separator);
    const modelId = requested.model.slice(separator + 1);
    if (identity.provider !== provider) return { ok: false, reason: `provider mismatch: requested ${provider}, resolved ${identity.provider ?? "none"}` };
    if (identity.model === null) return { ok: false, reason: "no resolved responseModel in the event log" };
    const matchesModel = (resolved: string): boolean => {
        const resolvedModelId = resolved.startsWith(`${provider}/`) ? resolved.slice(provider.length + 1) : resolved;
        return resolvedModelId === modelId;
    };
    if (!matchesModel(identity.model)) return { ok: false, reason: `model mismatch: requested ${requested.model}, resolved ${identity.model}` };
    if (identity.responseModel !== null && identity.responseModel !== undefined && !matchesModel(identity.responseModel)) {
        return { ok: false, reason: `responseModel mismatch: requested ${requested.model}, resolved ${identity.responseModel}` };
    }
    const thinking = identity.providerThinkingLevel ?? identity.thinking;
    if (thinking !== requested.thinking || identity.thinking !== requested.thinking) {
        return { ok: false, reason: `thinking mismatch: requested ${requested.thinking}, resolved ${thinking ?? "none"}` };
    }
    return { ok: true, reason: null };
}

export function selectorIdentityMismatch(actual: InspectSelectorIdentity, expected: InspectSelectorIdentity): string | null {
    if (actual.selectors.invalid?.length) return `invalid selector value: ${actual.selectors.invalid.join(", ")}`;
    if (JSON.stringify(actual.selectors) !== JSON.stringify(expected.selectors)) return "effective selector mismatch";
    if (JSON.stringify(actual.variants) !== JSON.stringify(expected.variants)) return "surface variants mismatch";
    if (actual.surfaceIdentity !== expected.surfaceIdentity) return "surface identity mismatch";
    if (actual.schemaHash !== expected.schemaHash) return "schema hash mismatch";
    if (actual.guidanceHash !== expected.guidanceHash) return "guidance hash mismatch";
    return null;
}
export interface InspectArm extends TebArm { name: "off" | "on" | "instructed" | "generic"; }
export type InspectArmName = InspectArm["name"];

export function checkPromptParity(instructed: string, generic: string): boolean {
    const count = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;
    const a = count(instructed), b = count(generic);
    return a > 0 && b > 0 && Math.abs(a - b) / a <= 0.1;
}

if (!checkPromptParity(INSPECT_INSTRUCTED_TEXT, INSPECT_GENERIC_TEXT)) {
    throw new Error("instructed and generic prompt token counts differ by more than 10%");
}

export function resolveInspectArms(names: string[], positive: boolean): InspectArm[] {
    const known = ["off", "on", "instructed", "generic"];
    for (const name of names) if (!known.includes(name)) throw new Error(`unknown inspect arm ${JSON.stringify(name)}`);
    return names.filter((name) => positive || name === "off" || name === "on").map((name) => ({
        name: name as InspectArm["name"],
        env: { PI_SMARTREAD_AFFORDANCES: "0", PI_SMARTREAD_INSPECT_AFFORDANCES: name === "on" ? "1" : "0" },
        promptSuffix: name === "instructed" ? `\n\n${INSPECT_INSTRUCTED_TEXT}` : name === "generic" ? `\n\n${INSPECT_GENERIC_TEXT}` : undefined,
    }));
}

export function collectGoldPathMarkers(gold: unknown): string[] {
    const markers = new Set<string>();
    const visit = (value: unknown, key = ""): void => {
        if (Array.isArray(value)) { for (const item of value) visit(item, key); return; }
        if (typeof value !== "object" || value === null) return;
        for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
            if ((childKey === "path" || childKey === "file" || childKey === "from" || childKey === "resolved" || childKey === "to") && typeof child === "string") markers.add(child);
            else visit(child, childKey);
        }
    };
    visit(gold);
    return [...markers].filter((marker) => marker.length >= 2);
}

export function assertNoHoldoutExposure(prompt: string, extraMarkers: string[] = []): void {
    const hits = ["pi-smartread-bench", "candidateUniverse", "grade.ts", "grader", "adjudication", ...extraMarkers]
        .filter((marker) => marker.length > 0 && prompt.includes(marker));
    if (/(?:^|[\s"'])\/(?:tmp|home|Users)\/[^\s"']+/.test(prompt)) hits.push("absolute path");
    if (hits.length) throw new Error(`holdout exposure blacklist hit in prompt: ${hits.join(", ")}`);
}

function collectHandoffBlacklist(otherSplitTasks: InspectTask[], currentSplit: InspectTask["split"]): string[] {
    const markers = new Set<string>();
    for (const task of otherSplitTasks) {
        if (task.split === "holdout") markers.add(task.id);
        if (task.split !== currentSplit && (task.split === "pilot" || task.split === "dev")) markers.add(task.prompt);
        for (const path of collectGoldPathMarkers(task.gold)) markers.add(path);
        markers.add(task.candidateUniverse.id);
        markers.add(task.candidateUniverse.sha256);
    }
    return [...markers].filter((marker) => marker.length >= 3);
}

export function buildInspectTaskPrompt(view: { prompt: string; answerShape: string }, arm: InspectArm): string {
    return `${view.prompt}\n\nEnd your run with exactly one fenced json block as the last substantive output, with this shape and no extra keys:\n\`\`\`json\n${view.answerShape}\n\`\`\`${arm.promptSuffix ?? ""}`;
}

export interface InspectRunArgs {
    tasks: string; split: "pilot" | "dev" | "holdout"; arms: string[]; replicates: number;
    maxTurns: number; model: string; thinking: string; timeoutMs: number; out: string; dryRun: boolean;
    taskIds: string[] | null; limit: number | null; openHoldout: boolean; freezeFile: string | null; piBin: string;
}
export function parseInspectRunArgs(argv: string[]): InspectRunArgs {
    const get = (flag: string): string | undefined => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
    const has = (flag: string): boolean => argv.includes(flag);
    const tasks = get("--tasks"), out = get("--out");
    if (!tasks) throw new Error("missing required --tasks <jsonl>");
    if (!out) throw new Error("missing required --out <dir>");
    const split = get("--split") ?? "pilot";
    if (!(split === "pilot" || split === "dev" || split === "holdout")) throw new Error(`unknown --split ${JSON.stringify(split)}`);
    const arms = (get("--arms") ?? "off").split(",").map((s) => s.trim()).filter(Boolean);
    if (arms.length === 0) throw new Error("--arms must name at least one arm");
    const integer = (flag: string, fallback: number): number => {
        const value = Number(get(flag) ?? fallback);
        if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer`);
        return value;
    };
    const timeoutMs = Number(get("--timeout-ms") ?? 240000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number");
    const limitRaw = get("--limit"), limit = limitRaw === undefined ? null : Number(limitRaw);
    if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit must be a positive integer");
    return { tasks, out, split, arms, replicates: integer("--replicates", 3), maxTurns: integer("--max-turns", 25), timeoutMs,
        model: get("--model") ?? "opencode-go/deepseek-v4-flash", thinking: get("--thinking") ?? "high", dryRun: has("--dry-run"),
        taskIds: get("--task-ids")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null, limit,
        openHoldout: has("--open-holdout"), freezeFile: get("--freeze-file") ?? null, piBin: get("--pi-bin") ?? "pi" };
}

export interface InspectSessionRecord {
    runId: string; taskId: string; family: InspectFamily; arm: string; replicate: number; promptSha256: string;
    selectorIdentity: InspectSelectorIdentity; identityOk: boolean; identityReason: string | null; provider: string | null;
    resolvedModel: string | null; thinkingResolved: string | null; contaminated: boolean; contaminationHit: string | null;
    infraFailure: TebInfraFailure | null; timedOut: boolean; turns: number; elapsedMs: number; error: string | null;
    excluded: boolean; exclusionReason: string | null; rerunRequired: boolean; gradedFailure: boolean;
    loadAverageStart: number | null; loadAverageEnd: number | null; highLoad: boolean;
}

function expectedIdentityFor(arm: InspectArm, surfaceIdentity: string): InspectSelectorIdentity {
    return {
        selectors: {
            general: arm.env?.["PI_SMARTREAD_AFFORDANCES"] === "1",
            inspect: arm.env?.["PI_SMARTREAD_INSPECT_AFFORDANCES"] === "1",
        },
        surfaceIdentity,
        variants: { lsp: "baseline", inspect: arm.name === "on" ? "inspect-bundle" : "baseline", grep: "baseline", guidance: arm.name === "on" ? "inspect-bundle" : "baseline", mcpInstructions: arm.name === "on" ? "inspect-bundle" : "baseline" },
        schemaHash: createHash("sha256").update(JSON.stringify(INSPECT_ANSWER_SHAPES)).digest("hex"),
        guidanceHash: createHash("sha256").update(`${INSPECT_INSTRUCTED_TEXT}\n${INSPECT_GENERIC_TEXT}`).digest("hex"),
    };
}

export interface RunInspectOptions {
    spawnFn?: PiSpawnFn;
    extensionPath?: string;
    /** Product-captured effective identity, captured after constructing each arm. */
    /** Frozen per-arm expectation; independent of session-reported identity. */
    expectedIdentityByArm?: Partial<Record<InspectArmName, InspectSelectorIdentity>>;
    idleLoadAverage?: number;
    loadAverage?: () => number;
}

export async function runInspectCli(args: InspectRunArgs, opts: RunInspectOptions = {}): Promise<{ runDir: string; manifestPath: string }> {
    const text = readFileSync(args.tasks, "utf8"), parsed = parseInspectJsonl(text);
    if (parsed.errors.length) throw new Error(`invalid task file: ${parsed.errors.slice(0, 5).join("; ")}`);
    if (args.split === "holdout" && (!args.openHoldout || !args.freezeFile || !existsSync(args.freezeFile))) throw new Error("holdout requires --open-holdout and --freeze-file");
    let tasks = parsed.tasks.filter((t) => t.split === args.split);
    if (args.taskIds) { const ids = new Set(args.taskIds); tasks = tasks.filter((t) => ids.has(t.id)); }
    if (args.limit !== null) tasks = tasks.slice(0, args.limit);
    const expectedIdentityByArm = new Map<InspectArmName, InspectSelectorIdentity>();
    if (!args.dryRun) {
        for (const task of tasks) {
            for (const arm of resolveInspectArms(args.arms, !task.negativeControl)) {
                const expected = opts.expectedIdentityByArm?.[arm.name];
                if (!expected || !expected.surfaceIdentity || expected.surfaceIdentity === "unavailable") {
                    throw new Error(`surface-identity-unavailable: missing frozen expectation for arm ${arm.name}`);
                }
                const expectedInspect = arm.name === "on";
                if (expected.selectors.general || expected.selectors.inspect !== expectedInspect || expected.selectors.invalid?.length) {
                    throw new Error(`invalid frozen selector expectation for arm ${arm.name}`);
                }
                expectedIdentityByArm.set(arm.name, expected);
            }
        }
    }
    const forbidden = collectHandoffBlacklist(parsed.tasks, args.split);
    for (const task of tasks) {
        const view = toInspectRunnerView(task);
        for (const arm of resolveInspectArms(args.arms, !task.negativeControl)) {
            const prompt = buildInspectTaskPrompt(view, arm);
            assertNoHoldoutExposure([task.prompt, task.scope, view.answerShape, arm.promptSuffix ?? "", prompt].join("\n"), [resolve(args.tasks), ...forbidden]);
        }
    }
    const extensionPath = opts.extensionPath ?? resolve(dirname(new URL(import.meta.url).pathname), "..", "..", "..", "src", "index.ts");
    const runId = `inspect-${Date.now()}-pid${process.pid}`, runDir = join(resolve(args.out), runId);
    mkdirSync(runDir, { recursive: true });
    const manifest = { runnerVersion: INSPECT_RUNNER_VERSION, runId, startedAt: new Date().toISOString(), split: args.split,
        taskFileSha256: sha256Hex(text), modelRequested: args.model, thinkingRequested: args.thinking, dryRun: args.dryRun,
        batchInvalidated: false, rerunList: [] as Array<{ taskId: string; arm: string; replicate: number; reason: string }>, sessions: [] as InspectSessionRecord[] };
    const manifestPath = join(runDir, "manifest.json"), flush = (): void => writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    flush();
    if (args.split === "holdout" && !args.dryRun) {
        const freeze = parseFreezeFile(readFileSync(args.freezeFile!, "utf8"));
        const taskSha = manifest.taskFileSha256;
        if (freeze.taskSha256 !== taskSha) throw new Error("freeze taskSha256 does not match task file");
        const forbidden = args.arms.filter((arm) => arm !== "off" && arm !== freeze.champion);
        if (forbidden.length) throw new Error(`holdout runs are restricted to off + frozen champion ${JSON.stringify(freeze.champion)}`);
        claimHoldoutOpening(args.freezeFile!, { champion: freeze.champion, taskSha256: taskSha, runId, openedAt: new Date().toISOString() });
    }
    for (const task of tasks) {
        const positive = !task.negativeControl;
        const arms = resolveInspectArms(args.arms, positive);
        const view = toInspectRunnerView(task);
        for (const arm of arms) for (let replicate = 0; replicate < args.replicates; replicate++) {
            const prompt = buildInspectTaskPrompt(view, arm), sessionDir = join(runDir, task.id, `${arm.name}-r${replicate}`);
            mkdirSync(sessionDir, { recursive: true });
            const expectedIdentity = expectedIdentityByArm.get(arm.name) ?? expectedIdentityFor(arm, "unavailable");
            const record: InspectSessionRecord = { runId, taskId: task.id, family: task.family, arm: arm.name, replicate,
                promptSha256: createHash("sha256").update(prompt).digest("hex"), selectorIdentity: expectedIdentity, identityOk: false,
                identityReason: "session not run", provider: null, resolvedModel: null, thinkingResolved: null, contaminated: false,
                contaminationHit: null, infraFailure: null, timedOut: false, turns: 0, elapsedMs: 0, error: null,
                excluded: false, exclusionReason: null, rerunRequired: false, gradedFailure: false,
                loadAverageStart: null, loadAverageEnd: null, highLoad: false };
            if (args.dryRun) {
                writeFileSync(join(sessionDir, "prompt.txt"), prompt);
                writeFileSync(join(sessionDir, "events.jsonl"), ""); writeFileSync(join(sessionDir, "stderr.txt"), "");
                manifest.sessions.push(record); flush(); continue;
            }
            const repoRoot = process.env["INSPECT_REPOS_DIR"] ?? join(process.env["HOME"] ?? tmpdir(), ".cache", "pi-smartread-bench", "teb", "repos");
            const checkout = join(repoRoot, task.repo), scratch = mkdtempSync(join(tmpdir(), `inspect-${process.pid}-`));
            const cwd = join(scratch, task.repo), eventLog = join(sessionDir, "events.jsonl"), stderrLog = join(sessionDir, "stderr.txt");
            let launchAttempted = false;
            let launchCompleted = false;
            try {
                if (!existsSync(checkout)) throw new Error(`pinned repo checkout not found: ${checkout}`);
                const head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
                if (head !== task.commit) throw new Error(`commit mismatch: checkout HEAD ${head} != task.commit ${task.commit}`);
                const status = execFileSync("git", ["-C", checkout, "status", "--porcelain", "--ignored"], { encoding: "utf8" });
                if (status.trim()) throw new Error(`pinned checkout not clean: ${status.trim()}`);
                cpSync(checkout, cwd, { recursive: true });
                const env = { ...process.env, PI_SMARTREAD_SKILL_SYNC: "0", PI_SMARTREAD_AFFORDANCES: "0", PI_SMARTREAD_INSPECT_AFFORDANCES: "0", ...(arm.env ?? {}), PI_SMARTREAD_SURFACE_IDENTITY_LOG: "1" } as Record<string, string>;
                const getLoadAverage = opts.loadAverage ?? (() => osLoadAverage());
                record.loadAverageStart = getLoadAverage();
                launchAttempted = true;
                const result = await launchPiSession({ piBin: args.piBin, args: buildPiArgs({ extensionPath: arm.extensionPath ?? extensionPath, model: args.model, thinking: args.thinking, tools: INSPECT_TOOL_ALLOWLIST, prompt }),
                    cwd, env, timeoutMs: args.timeoutMs, maxTurns: args.maxTurns, outJsonl: eventLog, outStderr: stderrLog, spawnFn: opts.spawnFn });
                launchCompleted = true;
                record.loadAverageEnd = getLoadAverage();
                record.highLoad = opts.idleLoadAverage !== undefined && (record.loadAverageStart > 2 * opts.idleLoadAverage || record.loadAverageEnd > 2 * opts.idleLoadAverage);
                record.timedOut = result.timedOut; record.turns = result.turns; record.elapsedMs = result.elapsedMs;
                const log = readFileSync(eventLog, "utf8"), stderr = readFileSync(stderrLog, "utf8"), identity = extractInspectSessionIdentity(log);
                record.provider = identity.provider; record.resolvedModel = identity.model; record.thinkingResolved = identity.thinking;
                const expected = expectedIdentityByArm.get(arm.name)!;
                let actual: InspectSelectorIdentity | null = null;
                let surfaceMismatch: string | null = null;
                try { actual = parseSurfaceIdentity(stderr); }
                catch (error) { surfaceMismatch = error instanceof Error ? error.message : "surface identity malformed"; }
                if (actual) {
                    record.selectorIdentity = actual;
                    surfaceMismatch = selectorIdentityMismatch(actual, expected);
                }
                const sessionIdentity = checkInspectSessionIdentity(identity, { model: args.model, thinking: args.thinking });
                record.identityOk = surfaceMismatch === null && sessionIdentity.ok;
                record.identityReason = surfaceMismatch ?? sessionIdentity.reason;
                record.infraFailure = classifyInfraFailure({ logText: log, stderrText: stderr, spawnError: result.spawnError, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, turnLimitHit: result.turnLimitHit });
                const goldPaths = collectGoldPathMarkers(task.gold);
                const contamination = scanLogForContamination(log, [resolve(args.tasks), ...goldPaths]);
                record.contaminated = contamination.contaminated; record.contaminationHit = contamination.hit;
                const finalValidity = sessionValidity({ identityMismatch: record.identityOk ? null : record.identityReason,
                    infraFailure: record.infraFailure, contaminated: record.contaminated, timedOut: record.timedOut });
                record.excluded = finalValidity.excluded; record.exclusionReason = finalValidity.exclusionReason;
                record.rerunRequired = finalValidity.rerunRequired; record.gradedFailure = finalValidity.gradedFailure;
            } catch (error) {
                record.error = error instanceof Error ? error.message : String(error);
                record.gradedFailure = true;
                if (launchAttempted && !launchCompleted) {
                    record.infraFailure = classifyInfraFailure({ logText: "", stderrText: record.error, spawnError: /spawn/i.test(record.error) ? record.error : null,
                        exitCode: /spawn/i.test(record.error) ? null : 1, signal: null, timedOut: false });
                }
                const catchValidity = sessionValidity({ identityMismatch: null, infraFailure: record.infraFailure, contaminated: false, timedOut: false, failed: true });
                record.excluded = catchValidity.excluded; record.exclusionReason = catchValidity.exclusionReason;
                record.rerunRequired = catchValidity.rerunRequired; record.gradedFailure = catchValidity.gradedFailure;
            }
            finally {
                const getLoadAverage = opts.loadAverage ?? (() => osLoadAverage());
                if (record.loadAverageEnd === null) record.loadAverageEnd = getLoadAverage();
                record.highLoad = opts.idleLoadAverage !== undefined && (record.loadAverageStart !== null && record.loadAverageStart > 2 * opts.idleLoadAverage || record.loadAverageEnd > 2 * opts.idleLoadAverage);
                rmSync(scratch, { recursive: true, force: true });
            }
            manifest.sessions.push(record); flush();
        }
    }
    const exclusions = summarizeExclusions(manifest.sessions);
    manifest.batchInvalidated = exclusions.batchInvalidated;
    manifest.rerunList = exclusions.rerunList.map((index) => {
        const session = manifest.sessions[index]!;
        return { taskId: session.taskId, arm: session.arm, replicate: session.replicate, reason: session.exclusionReason ?? "excluded" };
    });
    flush(); return { runDir, manifestPath };
}

function osLoadAverage(): number {
    return Number(loadavg()[0] ?? 0);
}

function main(): void {
    const args = parseInspectRunArgs(process.argv.slice(2));
    void runInspectCli(args).then(({ runDir }) => console.log(runDir)).catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();
