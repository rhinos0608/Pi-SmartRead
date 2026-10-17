/**
 * Fake driver worker for synthetic supervisor tests (no engine/network).
 *
 * Reads the same WorkerConfig JSON the real worker takes, speaks the same
 * `@@DRIVER <json>` marker protocol, and appends the same fsync'd
 * checkpoint records. Behavior comes from FAKE_PLAN_JSON env:
 *
 *   { "setups": { "<instanceId>": "ok"|"hang"|"hang-once"|"busy"|"exclude" },
 *     "queries": { "<pairKey>": "ok"|"hang"|"torn-crash"|"exit-crash" },
 *     "spawnIgnorer": true,            // spawn a SIGTERM-ignoring grandchild
 *     "status": { "<pairKey>": "<status>" } }
 *
 * "hang-once" hangs a setup only when no setup-kill is checkpointed yet
 * (so the retry succeeds). Queries are never retried after a kill, so a
 * hanging query hangs every attempt until the supervisor kills it.
 */

import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

// The real worker takes its config as JSON on stdin (no --config FILE);
// the fake worker mirrors that boundary. Any argv is rejected.
if (process.argv.length > 2) {
    console.error(`fake worker: unknown argument: ${process.argv[2]}`);
    process.exit(2);
}
let stdinText = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdinText += chunk;
if (stdinText === "") {
    console.error("fake worker: empty stdin");
    process.exit(1);
}
const config = JSON.parse(stdinText);
const plan = JSON.parse(process.env.FAKE_PLAN_JSON ?? "{}");
const checkpointPath = config.checkpointPath;
// Synthetic snapshot metadata stays beneath the harness-owned state root
// (no child-created tmpdir, which a watchdog kill could leave behind).
const snapshotRootFor = (instanceId) => {
    if (typeof config.stateRoot === "string" && config.stateRoot !== "") {
        return join(config.stateRoot, "snapshots", instanceId);
    }
    return join(dirname(checkpointPath), "..", "snapshots", instanceId);
};
const pairKey = (instanceId, formulation) => JSON.stringify([instanceId, formulation]);

function load() {
    const outcomes = new Map();
    const excluded = new Set();
    const setupKills = {};
    let text = "";
    try {
        text = readFileSync(checkpointPath, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") return { outcomes, excluded, setupKills };
        throw error;
    }
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (let i = 0; i < lines.length; i++) {
        const isLast = i === lines.length - 1;
        let record;
        try {
            record = JSON.parse(lines[i]);
        } catch {
            if (isLast) continue;
            throw new Error(`fake worker: corrupt checkpoint line ${i + 1}`);
        }
        if (record.kind === "outcome") outcomes.set(record.pair, record.outcome);
        else if (record.kind === "excluded") excluded.add(record.instanceId);
        else if (record.kind === "setup-kill") setupKills[record.instanceId] = (setupKills[record.instanceId] ?? 0) + 1;
    }
    return { outcomes, excluded, setupKills };
}

function append(record) {
    // Mirrors driver-checkpoint.ts: truncate a torn tail before appending
    // so a resumed writer never buries a partial line mid-file.
    let existing = "";
    try {
        existing = readFileSync(checkpointPath, "utf8");
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    const line = `${JSON.stringify(record)}\n`;
    if (existing !== "" && !existing.endsWith("\n")) {
        const idx = existing.lastIndexOf("\n");
        const repaired = idx === -1 ? "" : existing.slice(0, idx + 1);
        writeFileSync(checkpointPath, repaired + line, { mode: 0o600 });
        return;
    }
    const fd = openSync(checkpointPath, "a", 0o600);
    try {
        writeSync(fd, line);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

function marker(m) {
    process.stdout.write(`@@DRIVER ${JSON.stringify(m)}\n`);
}

const sleepForever = () => new Promise(() => {
    // An unresolved promise alone does not keep the event loop alive;
    // the interval does (and dies with the process group on kill).
    setInterval(() => {}, 1000);
});
const spinMs = (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        for (let i = 0; i < 200000; i++) {
            // burn CPU
        }
    }
};

const fakeOutcome = (instanceId, formulation) => ({
    instanceId,
    formulation,
    status: plan.status?.[pairKey(instanceId, formulation)] ?? "ok",
    rankedFiles: [`src/${instanceId}.ts`],
    goldRanks: [],
    successAt5: true,
    recallAt5: 1,
    mrr: 1,
    hunkOverlapAt5: 0,
    overTokenCap: false,
    renderedTokens: 10,
    elapsedMs: 5,
    topEngine: null,
    shownCards: [],
    routing: null,
});

async function main() {
    for (const instance of config.instances) {
        const mine = config.formulations.filter((f) => config.assignedPairs.includes(pairKey(instance.instanceId, f)));
        if (mine.length === 0) continue;
        let state = load();
        if (mine.every((f) => state.outcomes.has(pairKey(instance.instanceId, f)))) continue;
        if (state.excluded.has(instance.instanceId)) continue;
        if ((state.setupKills[instance.instanceId] ?? 0) >= 2) continue;
        const setupPlan = plan.setups?.[instance.instanceId] ?? "ok";
        marker({ phase: "setup-start", instanceId: instance.instanceId });
        const kills = state.setupKills[instance.instanceId] ?? 0;
        if (setupPlan === "hang" || (setupPlan === "hang-once" && kills === 0)) {
            if (plan.spawnIgnorer === true) {
                spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"], { stdio: "ignore" });
            }
            await sleepForever();
            return;
        }
        if (setupPlan === "busy") spinMs(600);
        if (setupPlan === "exclude") {
            append({
                v: 1,
                kind: "excluded",
                instanceId: instance.instanceId,
                exclusion: {
                    instanceId: instance.instanceId,
                    reason: "missing-at-base",
                    missing: ["src/gone.ts"],
                    stage: "materialize",
                    root: snapshotRootFor(instance.instanceId),
                    createdFresh: false,
                },
            });
            marker({ phase: "setup-end", instanceId: instance.instanceId, excluded: true });
            continue;
        }
        append({
            v: 1,
            kind: "attempt",
            attempt: { instanceId: instance.instanceId, root: snapshotRootFor(instance.instanceId), stage: "materialize", outcome: "success", createdFresh: true },
        });
        marker({ phase: "setup-end", instanceId: instance.instanceId });
        for (const formulation of mine) {
            const pair = pairKey(instance.instanceId, formulation);
            state = load();
            if (state.outcomes.has(pair)) continue;
            const queryPlan = plan.queries?.[pair] ?? "ok";
            marker({ phase: "query-start", pair, instanceId: instance.instanceId, formulation });
            if (queryPlan === "hang") {
                if (plan.spawnIgnorer === true) {
                    spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"], { stdio: "ignore" });
                }
                await sleepForever();
                return;
            }
            if (queryPlan === "torn-crash" || (queryPlan === "torn-crash-once" && config.launchIndex === 1)) {
                const fd = openSync(checkpointPath, "a", 0o600);
                try {
                    writeSync(fd, '{"v":1,"kind":"outcome","pair":');
                    fsyncSync(fd);
                } finally {
                    closeSync(fd);
                }
                process.exit(1);
            }
            if (queryPlan === "exit-crash") process.exit(1);
            marker({ phase: "query-end", pair, instanceId: instance.instanceId, formulation });
            append({ v: 1, kind: "outcome", pair, outcome: fakeOutcome(instance.instanceId, formulation) });
        }
    }
}

main().then(
    () => process.exit(0),
    () => process.exit(1),
);
