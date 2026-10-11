/**
 * D46 cold-start receipt tests: the ownership receipt must record EVERY
 * canonical checkout root checked and EVERY planned deletion target BEFORE
 * execution. An empty `deleted` list alone proves nothing — only
 * checkedRoots + planned + refused bound the claim. Unproved roots fail
 * closed and planning never deletes; deletion happens ONLY under an
 * ownership-proven (owned state root + canonical snapshot marker) root.
 */
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    coldStartRuntimeCaches,
    deleteOwnedColdStartTargets,
    planColdStartRuntimeCaches,
    proveColdStartOwnership,
    tryCanonicalD46,
    type D46RunArgs,
} from "../../../scripts/eval/d46/run.js";
import { ensureOwnedStateRoot, SNAPSHOT_COMMIT_MARKER } from "../../../scripts/eval/external/grep/repos.js";
import type { D46ColdStartReceipt } from "../../../scripts/eval/d46/schema.js";

const tmpRoots: string[] = [];
afterEach(() => {
    for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    tmpRoots.push(dir);
    return dir;
}

const noGit = { lsFiles: () => "" };

function buildReceipt(args: {
    checkedRoots: string[];
    planned: string[];
    deleted: string[];
    skippedTracked: string[];
    refused?: { root: string; reason: string }[];
}): D46ColdStartReceipt {
    return {
        deleted: args.deleted,
        skippedTracked: args.skippedTracked,
        count: args.deleted.length,
        checkedRoots: args.checkedRoots,
        planned: args.planned,
        refused: args.refused ?? [],
    };
}

describe("planColdStartRuntimeCaches ownership bounds", () => {
    it("records a canonical root and plans the untracked cache dir without deleting", () => {
        const checkout = tempDir("d46-cold-receipt-");
        const cache = join(checkout, ".pi-smartread");
        mkdirSync(cache, { recursive: true });
        writeFileSync(join(cache, "index.json"), "{}");
        const plan = planColdStartRuntimeCaches(checkout, noGit);
        expect(plan.error).toBeNull();
        expect(plan.root).toBe(realpathSync(checkout));
        expect(plan.toDelete).toEqual([".pi-smartread"]);
        // Planning is read-only: the cache dir still exists with its file.
        const receipt = buildReceipt({
            checkedRoots: [plan.root],
            planned: plan.toDelete.map((p) => `${plan.root}/${p}`),
            deleted: [],
            skippedTracked: plan.skippedTracked,
        });
        expect(receipt.checkedRoots).toEqual([realpathSync(checkout)]);
        expect(receipt.planned).toEqual([`${realpathSync(checkout)}/.pi-smartread`]);
        expect(receipt.count).toBe(0);
    });

    it("empty toDelete with an unresolvable checkout is an error, not a cold proof", () => {
        const missing = join(tempDir("d46-cold-missing-"), "nope");
        const plan = planColdStartRuntimeCaches(missing, noGit);
        expect(plan.error).toMatch(/cannot resolve checkout/);
        expect(plan.toDelete).toEqual([]);
        // A receipt built from this plan must carry the error state, never a
        // clean cold claim: checkedRoots records the attempted root.
        expect(plan.root).toBe(missing);
    });

    it("fails closed on git failure with nothing planned and nothing deleted", () => {
        const checkout = tempDir("d46-cold-gitfail-");
        const cache = join(checkout, ".pi-smartread");
        mkdirSync(cache, { recursive: true });
        const plan = planColdStartRuntimeCaches(checkout, {
            lsFiles: () => {
                throw new Error("git down");
            },
        });
        expect(plan.error).toMatch(/cannot list tracked files/);
        expect(plan.toDelete).toEqual([]);
        expect(plan.skippedTracked).toEqual([]);
    });

    it("refuses symlinked cache dirs instead of warming past them", () => {
        const checkout = tempDir("d46-cold-symlink-");
        const outside = tempDir("d46-cold-outside-");
        symlinkSync(outside, join(checkout, ".pi-smartread"));
        const plan = planColdStartRuntimeCaches(checkout, noGit);
        expect(plan.error).toMatch(/refuses-symlink/);
        expect(plan.toDelete).toEqual([]);
    });
});

describe("receipt helpers", () => {
    it("tryCanonicalD46 returns null for missing paths (never throws the run)", () => {
        expect(tryCanonicalD46(join(tempDir("d46-cold-canon-"), "nope"))).toBeNull();
        const dir = tempDir("d46-cold-canon-ok-");
        expect(tryCanonicalD46(dir)).toBe(realpathSync(dir));
    });

    it("selection cohort args keep pointing at caller-owned roots", () => {
        // The existing cohort-dir + manifest reposDir controls are the owned
        // path: no new D46 flag is needed for selection runs.
        const cohort: Pick<D46RunArgs, "split" | "cohortDir"> = { split: "selection", cohortDir: "/tmp/owned-cohort" };
        expect(cohort.cohortDir).toBe("/tmp/owned-cohort");
    });
});

const CANONICAL_SHA = "1".repeat(40);

/** Owned fixture: a NOT-YET-EXISTING child state root freshly claimed by
 *  ensureOwnedStateRoot (ownership marker, private mode), with a marked
 *  checkout inside it under a NON-managed subdir — so only D46's own
 *  containment + marker proof can ever gate deletion here. */
function ownedCheckoutFixture(prefix: string): { stateRoot: string; checkout: string } {
    const parent = tempDir(prefix);
    const stateRoot = join(parent, "owned-state");
    ensureOwnedStateRoot(stateRoot);
    const checkout = join(stateRoot, "d46-checkouts", "o__r");
    mkdirSync(join(checkout, "src"), { recursive: true });
    writeFileSync(join(checkout, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(join(checkout, SNAPSHOT_COMMIT_MARKER), CANONICAL_SHA);
    return { stateRoot: realpathSync(stateRoot), checkout };
}

describe("ownership-gated cold start", () => {
    it("owned+marked root: deletes only runtime-cache entries, never the repo or marker", () => {
        const { stateRoot, checkout } = ownedCheckoutFixture("d46-owned-delete-");
        mkdirSync(join(checkout, ".pi-smartread", "cache"), { recursive: true });
        writeFileSync(join(checkout, ".pi-smartread", "cache", "x.bin"), "x");
        const cold = coldStartRuntimeCaches(checkout, noGit);
        expect(cold.error).toBeNull();
        expect(cold.refused).toEqual([]);
        expect(cold.stateRoot).toBe(stateRoot);
        expect(cold.deleted).toEqual([".pi-smartread"]);
        expect(cold.planned).toEqual([`${realpathSync(checkout)}/.pi-smartread`]);
        expect(existsSync(join(checkout, ".pi-smartread"))).toBe(false);
        // The repo itself, its source, and the completion marker all survive.
        expect(existsSync(join(checkout, "src", "app.ts"))).toBe(true);
        expect(existsSync(join(checkout, SNAPSHOT_COMMIT_MARKER))).toBe(true);
    });

    it("non-owned root: nothing deleted, explicit refusal recorded", () => {
        const checkout = tempDir("d46-cold-foreign-");
        mkdirSync(join(checkout, ".pi-smartread", "cache"), { recursive: true });
        writeFileSync(join(checkout, ".pi-smartread", "cache", "x.bin"), "x");
        const cold = coldStartRuntimeCaches(checkout, noGit);
        expect(cold.error).toBeNull();
        expect(cold.deleted).toEqual([]);
        expect(cold.stateRoot).toBeNull();
        expect(cold.refused).toHaveLength(1);
        expect(cold.refused[0]?.root).toBe(realpathSync(checkout));
        expect(cold.refused[0]?.reason).toMatch(/no owned state root contains/);
        expect(existsSync(join(checkout, ".pi-smartread", "cache", "x.bin"))).toBe(true);
    });

    it("symlinked cache entry: refused at the deletion guard, link target untouched", () => {
        const { checkout } = ownedCheckoutFixture("d46-owned-symlink-");
        const outside = tempDir("d46-owned-link-outside-");
        writeFileSync(join(outside, "keep.txt"), "keep");
        mkdirSync(join(checkout, ".pi-smartread"), { recursive: true });
        writeFileSync(join(checkout, ".pi-smartread", "i.json"), "{}");
        const plan = planColdStartRuntimeCaches(checkout, noGit);
        expect(plan.error).toBeNull();
        expect(plan.toDelete).toEqual([".pi-smartread"]);
        // Swap AFTER planning (TOCTOU): the cache entry becomes a symlink.
        rmSync(join(checkout, ".pi-smartread"), { recursive: true, force: true });
        symlinkSync(outside, join(checkout, ".pi-smartread"));
        const ownership = proveColdStartOwnership(checkout);
        if (!ownership.ok) throw new Error(`expected ownership proof: ${ownership.reason}`);
        const removal = deleteOwnedColdStartTargets(ownership, plan);
        expect(removal.error).toBeNull();
        expect(removal.deleted).toEqual([]);
        expect(removal.refused).toHaveLength(1);
        expect(removal.refused[0]?.root).toBe(ownership.root);
        expect(removal.refused[0]?.reason).toMatch(/symlink/);
        expect(existsSync(join(outside, "keep.txt"))).toBe(true);
        expect(existsSync(join(checkout, ".pi-smartread"))).toBe(true);
    });

    it("root outside the owned state root via a symlink alias: refused, nothing deleted", () => {
        const parent = tempDir("d46-alias-parent-");
        const stateRoot = join(parent, "owned-state");
        ensureOwnedStateRoot(stateRoot);
        const outside = join(parent, "outside-checkout");
        mkdirSync(join(outside, ".pi-smartread", "cache"), { recursive: true });
        writeFileSync(join(outside, ".pi-smartread", "cache", "x.bin"), "x");
        writeFileSync(join(outside, SNAPSHOT_COMMIT_MARKER), CANONICAL_SHA);
        // The alias physically resolves OUTSIDE the owned state root, so the
        // physical (realpath) walk must find no owned ancestor.
        const alias = join(stateRoot, "alias-checkout");
        symlinkSync(outside, alias);
        const proof = proveColdStartOwnership(alias);
        expect(proof.ok).toBe(false);
        if (!proof.ok) expect(proof.reason).toMatch(/no owned state root contains/);
        const cold = coldStartRuntimeCaches(alias, noGit);
        expect(cold.error).toBeNull();
        expect(cold.deleted).toEqual([]);
        expect(cold.refused).toHaveLength(1);
        expect(cold.refused[0]?.root).toBe(realpathSync(outside));
        expect(existsSync(join(outside, ".pi-smartread", "cache", "x.bin"))).toBe(true);
    });

    it("receipt completeness: every examined root appears in checkedRoots with planned/deleted or refused", () => {
        const { checkout: owned } = ownedCheckoutFixture("d46-complete-owned-");
        mkdirSync(join(owned, ".pi-smartread", "cache"), { recursive: true });
        writeFileSync(join(owned, ".pi-smartread", "cache", "x.bin"), "x");
        const foreign = tempDir("d46-complete-foreign-");
        mkdirSync(join(foreign, ".pi"), { recursive: true });
        writeFileSync(join(foreign, ".pi", "x.json"), "{}");

        const ownedRun = coldStartRuntimeCaches(owned, noGit);
        const foreignRun = coldStartRuntimeCaches(foreign, noGit);
        const examined = [realpathSync(owned), realpathSync(foreign)].sort();
        const receipt = buildReceipt({
            checkedRoots: examined,
            planned: [...ownedRun.planned, ...foreignRun.planned],
            deleted: ownedRun.deleted.map((rel) => `${realpathSync(owned)}/${rel}`),
            skippedTracked: [...ownedRun.skippedTracked, ...foreignRun.skippedTracked],
            refused: [...ownedRun.refused, ...foreignRun.refused],
        });

        expect(receipt.checkedRoots).toEqual(examined);
        // Every examined root carries an outcome: refused, or planned (and
        // here the owned plan was also deleted, the foreign plan refused).
        for (const root of receipt.checkedRoots) {
            const covered =
                receipt.refused.some((r) => r.root === root) ||
                receipt.planned.some((p) => p.startsWith(`${root}/`));
            expect(covered).toBe(true);
        }
        expect(receipt.refused.map((r) => r.root)).toEqual([realpathSync(foreign)]);
        expect(receipt.planned).toContain(`${realpathSync(foreign)}/.pi`);
        expect(receipt.planned).toContain(`${realpathSync(owned)}/.pi-smartread`);
        for (const p of receipt.planned) expect(examined.some((r) => p.startsWith(`${r}/`))).toBe(true);
        expect(receipt.deleted).toEqual([`${realpathSync(owned)}/.pi-smartread`]);
        expect(receipt.count).toBe(1);
        expect(existsSync(join(foreign, ".pi", "x.json"))).toBe(true);
        expect(existsSync(join(owned, ".pi-smartread"))).toBe(false);
    });
});
