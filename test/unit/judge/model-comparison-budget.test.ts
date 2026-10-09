import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
    CAMPAIGN_PLANNING_TARGET_USD,
    CAMPAIGN_TOTAL_CAP_USD,
    MODEL_INPUT_RATE_PER_M_USD,
    VERIFIED_PRIOR_SEED,
    admitCampaignAttempt,
    campaignRemainingUsd,
    loadCampaignLedger,
    migrateCampaignLedgerCap,
    requestReserveUsd,
    seedCampaignLedger,
    settleCampaignAttempt,
    verifyLegacyCanonicalSidecar,
    voidCampaignAttempt,
    writePrivateArtifact,
    writePrivateFileExclusive,
} from "../../../scripts/eval/judge/model-comparison-budget.js";

const JEV = "~typesafe/jev-latest";
const PPLX = "perplexity/pplx-decider-v1.1-27b";
const LUNA = "openai/gpt-6-luna-decisions";

function freshRoot(): string {
    // Canonical (realpath) fixture root: resolves the macOS /var->/private/var
    // alias so the ancestor-symlink rejection below is exercised only by the
    // test's own malicious link, never by the platform temp alias.
    return realpathSync(mkdtempSync(join(tmpdir(), "campaign-ledger-test-")));
}

// Injected directory open/fsync EIO seam: the ledger's directory durability
// open is the only openSync(..., "r") call in the module (ledger/lock/tmp
// files all use "wx"), so failing "r" opens faults exactly the directory
// durability path and nothing else. fsyncSync is left real.
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        openSync: ((path: unknown, flags: unknown, mode: unknown) => {
            if (flags === "r" && (globalThis as Record<string, unknown>).__campaignLedgerDirOpenFail) {
                const err = new Error(`Injected directory open EIO for test: ${String(path)}`) as NodeJS.ErrnoException;
                err.code = "EIO";
                throw err;
            }
            return (actual.openSync as (...args: unknown[]) => number)(path, flags, mode);
        }) as typeof actual.openSync,
    };
});

function unlinkIfExists(p: string): void {
    try {
        unlinkSync(p);
    } catch {
        /* absent is fine */
    }
}

describe("requestReserveUsd (context-window x official-rate ceiling)", () => {
    it("bounds each requested model and fails closed on unknown models", () => {
        expect(requestReserveUsd(JEV)).toBeCloseTo((32_000 * 0.042) / 1_000_000, 12);
        expect(requestReserveUsd(PPLX)).toBeCloseTo((262_144 * 0.04) / 1_000_000, 12);
        expect(requestReserveUsd(LUNA)).toBeCloseTo((1_050_000 * 0.1) / 1_000_000, 12);
        expect(() => requestReserveUsd("mystery/model")).toThrow(/Cannot bound reserve/);
    });

    it("prices the PPLX arm at v1.1's real rate but keeps the v1 reserve floor (Amendment A2)", () => {
        // v1.1 catalog price re-verified 2026-10-09: $0.00000002/token = $0.02/M.
        expect(MODEL_INPUT_RATE_PER_M_USD[PPLX]).toBe(0.02);
        // The per-attempt reservation stays at the withdrawn v1 rate (0.04):
        // (262_144 x 0.04) / 1e6, the conservative reserve-rate bound.
        expect(requestReserveUsd(PPLX)).toBeCloseTo((262_144 * 0.04) / 1_000_000, 12);
        expect(requestReserveUsd(PPLX)).toBeGreaterThan((262_144 * MODEL_INPUT_RATE_PER_M_USD[PPLX]!) / 1_000_000);
    });
});

describe("campaign ledger (persistent, atomic admission, refunding settlement)", () => {
    it("seeds the verified prior (6 attempts, $0.000255476) exactly once", () => {
        const root = freshRoot();
        const first = seedCampaignLedger(root);
        expect(first.attempts).toBe(6);
        expect(first.campaignUsedUsd).toBeCloseTo(0.000255476, 12);
        expect(first.seed).toEqual(VERIFIED_PRIOR_SEED);
        // Re-seeding never resets seeded charges.
        const { attemptId } = admitCampaignAttempt(root, JEV);
        settleCampaignAttempt(root, attemptId, 0.00001);
        const before = loadCampaignLedger(root).campaignUsedUsd;
        const reseed = seedCampaignLedger(root);
        expect(reseed.campaignUsedUsd).toBeCloseTo(before, 12);
        expect(reseed.attempts).toBeGreaterThan(6);
    });

    it("admits BEFORE the attempt and refunds unused reserve on cheap settlement", () => {
        const root = freshRoot();
        seedCampaignLedger(root);
        const before = loadCampaignLedger(root).campaignUsedUsd;
        const reserve = requestReserveUsd(JEV);
        const { attemptId } = admitCampaignAttempt(root, JEV);
        const admitted = loadCampaignLedger(root);
        expect(admitted.campaignUsedUsd).toBeCloseTo(before + reserve, 12);
        expect(admitted.inFlight.map((a) => a.id)).toContain(attemptId);
        // Settle below reserve: the unused reserve is refunded exactly.
        const settled = settleCampaignAttempt(root, attemptId, 0.00001);
        expect(settled.inFlight).toHaveLength(0);
        expect(settled.campaignUsedUsd).toBeCloseTo(before + 0.00001, 12);
        expect(settled.actualSpentUsd).toBeCloseTo(before + 0.00001, 12);
    });

    it("UNKNOWN actuals retain the reserve and flip costComplete", () => {
        const root = freshRoot();
        seedCampaignLedger(root);
        const { attemptId } = admitCampaignAttempt(root, PPLX);
        const admitted = loadCampaignLedger(root).campaignUsedUsd;
        const settled = settleCampaignAttempt(root, attemptId, undefined);
        expect(settled.costComplete).toBe(false);
        expect(settled.campaignUsedUsd).toBeCloseTo(admitted, 12);
        // UNKNOWN survives a restart (reload): reserve never refunded.
        const reloaded = loadCampaignLedger(root);
        expect(reloaded.costComplete).toBe(false);
        expect(reloaded.campaignUsedUsd).toBeCloseTo(admitted, 12);
        expect(reloaded.settled).toHaveLength(1);
        expect(reloaded.settled[0]?.status).toBe("unknown");
    });

    it("actual-over-reserve halts further admissions but keeps the charge", () => {
        const root = freshRoot();
        seedCampaignLedger(root);
        const { attemptId } = admitCampaignAttempt(root, JEV);
        const over = settleCampaignAttempt(root, attemptId, 999);
        expect(over.reserveBreached).toBe(true);
        expect(over.campaignUsedUsd).toBeGreaterThan(CAMPAIGN_TOTAL_CAP_USD);
        expect(() => admitCampaignAttempt(root, JEV)).toThrow(/halted/);
    });

    it("independent $10 exhaustion regression: cheap-actual flow fits, concurrent full reserves exhaust", () => {
        const root = freshRoot();
        seedCampaignLedger(root, { attempts: 0, actualCostUsd: 0, note: "test: empty campaign" });
        let admitted = 0;
        for (let i = 0; i < 675; i++) {
            const { attemptId } = admitCampaignAttempt(root, JEV);
            settleCampaignAttempt(root, attemptId, 0.00001);
            admitted++;
        }
        expect(admitted).toBe(675);
        expect(loadCampaignLedger(root).campaignUsedUsd).toBeCloseTo(675 * 0.00001, 12);
        // But full reserves held simultaneously exhaust the cap:
        // floor(10 / 0.105) = 95 concurrent Luna reserves; the 96th is rejected.
        const root2 = freshRoot();
        seedCampaignLedger(root2, { attempts: 0, actualCostUsd: 0, note: "test: empty campaign" });
        let held = 0;
        let rejection: string | undefined;
        for (let i = 0; i < 675; i++) {
            try {
                admitCampaignAttempt(root2, LUNA);
                held++;
            } catch (err) {
                rejection = String(err);
                break;
            }
        }
        expect(rejection).toMatch(/cap exceeded/i);
        expect(held).toBe(95);
        expect(loadCampaignLedger(root2).campaignUsedUsd).toBeCloseTo(95 * 0.105, 9);
    });

    it("multi-process counterexample: a busy lock blocks, sequential admits lose nothing", () => {
        const root = freshRoot();
        seedCampaignLedger(root);
        // Simulate a second process holding the lock: busy must BLOCK.
        writeFileSync(join(root, "campaign-ledger.lock"), "other-process-nonce");
        expect(() => admitCampaignAttempt(root, JEV)).toThrow(/busy/);
        // Stale/unknown locks are never auto-deleted: still blocked.
        expect(() => admitCampaignAttempt(root, JEV)).toThrow(/busy/);
        // No lost update: after the holder leaves, both admits persist.
        unlinkSync(join(root, "campaign-ledger.lock"));
        const a = admitCampaignAttempt(root, JEV);
        const b = admitCampaignAttempt(root, JEV);
        expect(a.attemptId).not.toBe(b.attemptId);
        const ledger = loadCampaignLedger(root);
        expect(ledger.inFlight.map((r) => r.id)).toEqual(expect.arrayContaining([a.attemptId, b.attemptId]));
        expect(ledger.attempts).toBe(6 + 2);
        expect(ledger.campaignUsedUsd).toBeCloseTo(0.000255476 + 2 * requestReserveUsd(JEV), 12);
        voidCampaignAttempt(root, a.attemptId);
        voidCampaignAttempt(root, b.attemptId);
        expect(loadCampaignLedger(root).campaignUsedUsd).toBeCloseTo(0.000255476, 12);
    });

    it("double settlement and unknown ids throw (no buried/double charge)", () => {
        const root = freshRoot();
        seedCampaignLedger(root);
        const { attemptId } = admitCampaignAttempt(root, JEV);
        settleCampaignAttempt(root, attemptId, 0.00001);
        expect(() => settleCampaignAttempt(root, attemptId, 0.00001)).toThrow(/Unknown campaign attempt/);
        expect(() => settleCampaignAttempt(root, "no-such-id", 1)).toThrow(/Unknown campaign attempt/);
        expect(() => voidCampaignAttempt(root, attemptId)).toThrow(/Unknown campaign attempt/);
        expect(() => settleCampaignAttempt(root, attemptId, Number.NaN)).toThrow(/Invalid actual cost/);
    });

    it("corrupted ledger JSON fails closed before any admission", () => {
        const badJson = freshRoot();
        seedCampaignLedger(badJson);
        writeFileSync(join(badJson, "campaign-ledger.json"), "{not json");
        expect(() => loadCampaignLedger(badJson)).toThrow(/invalid JSON/i);
        expect(() => admitCampaignAttempt(badJson, JEV)).toThrow(/invalid JSON/i);

        const badVersion = freshRoot();
        seedCampaignLedger(badVersion);
        writeFileSync(join(badVersion, "campaign-ledger.json"), JSON.stringify({ version: 2, capUsd: CAMPAIGN_TOTAL_CAP_USD }));
        expect(() => loadCampaignLedger(badVersion)).toThrow(/version/);

        // Tampered totals (campaignUsedUsd reset to 0) are rejected.
        const badTotals = freshRoot();
        seedCampaignLedger(badTotals);
        const totalsPath = join(badTotals, "campaign-ledger.json");
        const good = JSON.parse(readFileSync(totalsPath, "utf-8")) as Record<string, unknown>;
        good["campaignUsedUsd"] = 0;
        writeFileSync(totalsPath, JSON.stringify(good));
        expect(() => admitCampaignAttempt(badTotals, JEV)).toThrow(/inconsistent/);

        // Tampered cap is rejected.
        const badCap = freshRoot();
        seedCampaignLedger(badCap);
        const capPath = join(badCap, "campaign-ledger.json");
        const goodCap = JSON.parse(readFileSync(capPath, "utf-8")) as Record<string, unknown>;
        goodCap["capUsd"] = 999;
        writeFileSync(capPath, JSON.stringify(goodCap));
        expect(() => loadCampaignLedger(badCap)).toThrow(/capUsd/);
    });

    it("symlinked root is rejected", () => {
        const root = freshRoot();
        // Canonical tmp base: the platform /var alias must not be judged.
        const link = join(realpathSync(tmpdir()), `campaign-ledger-link-${process.pid}`);
        unlinkIfExists(link);
        symlinkSync(root, link);
        try {
            expect(() => seedCampaignLedger(link)).toThrow(/symlink/i);
        } finally {
            unlinkIfExists(link);
        }
    });

    it("symlinked ancestor is rejected with zero link-target mutation", () => {
        const base = freshRoot();
        const realParent = join(base, "real");
        mkdirSync(realParent);
        const linkParent = join(base, "parent-link");
        symlinkSync(realParent, linkParent);
        const root = join(linkParent, "campaign");
        expect(() => seedCampaignLedger(root)).toThrow(/symlink/i);
        expect(() => admitCampaignAttempt(root, JEV)).toThrow(/symlink/i);
        // Zero link-target mutation: the link is intact and the target gained nothing.
        expect(lstatSync(linkParent).isSymbolicLink()).toBe(true);
        expect(readlinkSync(linkParent)).toBe(realParent);
        expect(existsSync(join(realParent, "campaign"))).toBe(false);
        // No over-rejection: a missing nested path under a genuine directory is fine.
        seedCampaignLedger(join(base, "fresh-nest", "campaign"));
    });

    it("RED: higher symlinked ancestor above a regular directory is rejected", () => {
        // Nearest-existing-ancestor-only checks pass this layout: the
        // nearest existing ancestor (real-dir) is a genuine directory while
        // a higher component (evil-link) is a symlink. ALL-ancestor
        // rejection must still refuse it with zero target mutation.
        const base = freshRoot();
        const target = join(base, "target");
        mkdirSync(target);
        const evilLink = join(base, "evil-link");
        symlinkSync(target, evilLink);
        const realSub = join(target, "real-dir");
        mkdirSync(realSub);
        const root = join(evilLink, "real-dir", "campaign");
        expect(() => seedCampaignLedger(root)).toThrow(/symlink/i);
        expect(() => admitCampaignAttempt(root, JEV)).toThrow(/symlink/i);
        // Zero target mutation: nothing created under the link target or base.
        expect(lstatSync(evilLink).isSymbolicLink()).toBe(true);
        expect(existsSync(join(target, "real-dir", "campaign"))).toBe(false);
        expect(existsSync(join(target, "campaign.json"))).toBe(false);
    });

    it("injected directory open/fsync EIO fails admission before any wire, keeps the reservation, cleans its own lock", () => {
        const root = freshRoot();
        seedCampaignLedger(root);
        const before = loadCampaignLedger(root).campaignUsedUsd;
        const reserve = requestReserveUsd(JEV);
        (globalThis as Record<string, unknown>).__campaignLedgerDirOpenFail = true;
        try {
            // Throws (no attemptId escapes): the caller never reaches the wire.
            expect(() => admitCampaignAttempt(root, JEV)).toThrow(/EIO|directory|fsync/i);
        } finally {
            (globalThis as Record<string, unknown>).__campaignLedgerDirOpenFail = false;
        }
        // Lock cleanup ownership intact: only our own nonce is released, never deleted blindly.
        expect(existsSync(join(root, "campaign-ledger.lock"))).toBe(false);
        // The already-renamed ledger is retained conservatively: the reserve
        // stays on the books (fail-closed cap) instead of being silently dropped.
        const retained = loadCampaignLedger(root);
        expect(retained.campaignUsedUsd).toBeCloseTo(before + reserve, 12);
        expect(retained.inFlight).toHaveLength(1);
        // The retained reservation was never sent anywhere: void it to restore books.
        voidCampaignAttempt(root, retained.inFlight[0]?.id as string);
        expect(loadCampaignLedger(root).campaignUsedUsd).toBeCloseTo(before, 12);
        // Ledger still usable afterwards (no corrupted state, no foreign lock harm).
        const { attemptId } = admitCampaignAttempt(root, JEV);
        voidCampaignAttempt(root, attemptId);
        expect(loadCampaignLedger(root).campaignUsedUsd).toBeCloseTo(before, 12);
    });

    it("reports remaining budget under the $10 campaign cap", () => {
        const root = freshRoot();
        seedCampaignLedger(root, { attempts: 0, actualCostUsd: 0, note: "test: empty campaign" });
        admitCampaignAttempt(root, LUNA);
        expect(campaignRemainingUsd(loadCampaignLedger(root))).toBeCloseTo(10 - 0.105, 12);
    });

    it("fixes the cap at $10 and the advisory planning target at $2", () => {
        expect(CAMPAIGN_TOTAL_CAP_USD).toBe(10);
        expect(CAMPAIGN_PLANNING_TARGET_USD).toBe(2);
        expect(CAMPAIGN_PLANNING_TARGET_USD).toBeLessThan(CAMPAIGN_TOTAL_CAP_USD);
    });

    it("admits past the advisory $2 planning target up to the $10 hard cap", () => {
        const root = freshRoot();
        seedCampaignLedger(root, { attempts: 0, actualCostUsd: 0, note: "test: empty campaign" });
        // 20 concurrent Luna reserves = $2.10: spend exceeds the advisory
        // target, yet admission must continue while it fits the hard cap.
        for (let i = 0; i < 20; i++) admitCampaignAttempt(root, LUNA);
        let used = loadCampaignLedger(root).campaignUsedUsd;
        expect(used).toBeGreaterThan(CAMPAIGN_PLANNING_TARGET_USD);
        admitCampaignAttempt(root, JEV);
        used = loadCampaignLedger(root).campaignUsedUsd;
        expect(used).toBeGreaterThan(CAMPAIGN_PLANNING_TARGET_USD);
        expect(used).toBeLessThanOrEqual(CAMPAIGN_TOTAL_CAP_USD);
        expect(campaignRemainingUsd(loadCampaignLedger(root))).toBeCloseTo(CAMPAIGN_TOTAL_CAP_USD - used, 12);
    });

    it("rejects a persisted cap-3 ledger fail-closed", () => {
        const root = freshRoot();
        seedCampaignLedger(root);
        const ledgerPath = join(root, "campaign-ledger.json");
        const persisted = JSON.parse(readFileSync(ledgerPath, "utf-8")) as Record<string, unknown>;
        persisted["capUsd"] = 3;
        writeFileSync(ledgerPath, JSON.stringify(persisted));
        expect(() => loadCampaignLedger(root)).toThrow(/capUsd 3 != required 10/);
        expect(() => admitCampaignAttempt(root, JEV)).toThrow(/capUsd 3 != required 10/);
        expect(() => seedCampaignLedger(root)).toThrow(/capUsd 3 != required 10/);
    });

    it("migrates only cap under lock, preserving fields and creating private receipt and backup", () => {
        const root = freshRoot();
        seedCampaignLedger(root);
        const ledgerPath = join(root, "campaign-ledger.json");
        const originalBytes = readFileSync(ledgerPath, "utf-8");
        const before = JSON.parse(originalBytes) as Record<string, unknown>;
        before["capUsd"] = 3;
        writeFileSync(ledgerPath, JSON.stringify(before, null, 2) + "\n");
        const sourceBytes = readFileSync(ledgerPath, "utf-8");
        const expectedOther = JSON.parse(sourceBytes) as Record<string, unknown>;
        delete expectedOther["capUsd"];
        expect(() => loadCampaignLedger(root)).toThrow(/required 10/);
        const migrated = migrateCampaignLedgerCap(root, { fromCapUsd: 3, toCapUsd: 10, authorization: "approved $10 cap" });
        const afterBytes = readFileSync(ledgerPath, "utf-8");
        const after = JSON.parse(afterBytes) as Record<string, unknown>;
        expect(after["capUsd"]).toBe(10);
        delete after["capUsd"];
        expect(after).toEqual(expectedOther);
        expect(migrated).toEqual(loadCampaignLedger(root));
        expect(JSON.parse(readFileSync(join(root, "campaign-ledger.pre-cap-migration.json"), "utf-8"))).toEqual(before);
        const receiptPath = join(root, "campaign-ledger.cap-migration.json");
        const receipt = JSON.parse(readFileSync(receiptPath, "utf-8")) as Record<string, unknown>;
        expect(receipt).toMatchObject({ from: 3, to: 10, authorization: "approved $10 cap", campaignUsedUsd: migrated.campaignUsedUsd, actualSpentUsd: migrated.actualSpentUsd });
        expect(receipt["preSha256"]).toBe(createHash("sha256").update(sourceBytes).digest("hex"));
        expect(receipt["postSha256"]).toBe(createHash("sha256").update(afterBytes).digest("hex"));
        expect(lstatSync(receiptPath).mode & 0o777).toBe(0o600);
        expect(lstatSync(join(root, "campaign-ledger.pre-cap-migration.json")).mode & 0o777).toBe(0o600);
        expect(() => migrateCampaignLedgerCap(root, { fromCapUsd: 3, toCapUsd: 10, authorization: "approved" })).toThrow(/capUsd 10 != required 3/);
        expect(readFileSync(ledgerPath, "utf-8")).toBe(afterBytes);
    });

    it("refuses invalid cap directions, wrong target, in-flight attempts, breaches, and existing artifacts", () => {
        const root = freshRoot();
        seedCampaignLedger(root);
        expect(() => migrateCampaignLedgerCap(root, { fromCapUsd: 10, toCapUsd: 10, authorization: "approved" })).toThrow(/raise/);
        expect(() => migrateCampaignLedgerCap(root, { fromCapUsd: 3, toCapUsd: 9, authorization: "approved" })).toThrow(/target/);
        expect(() => migrateCampaignLedgerCap(root, { fromCapUsd: 3, toCapUsd: 10, authorization: " " })).toThrow(/authorization/);
        const ledgerPath = join(root, "campaign-ledger.json");
        const { attemptId } = admitCampaignAttempt(root, JEV);
        const inFlight = JSON.parse(readFileSync(ledgerPath, "utf-8")) as Record<string, unknown>;
        inFlight["capUsd"] = 3;
        writeFileSync(ledgerPath, JSON.stringify(inFlight));
        expect(() => migrateCampaignLedgerCap(root, { fromCapUsd: 3, toCapUsd: 10, authorization: "approved" })).toThrow(/in-flight/);
        expect(attemptId).toBeTruthy();

        const breachedRoot = freshRoot();
        seedCampaignLedger(breachedRoot);
        const breachedPath = join(breachedRoot, "campaign-ledger.json");
        const breached = JSON.parse(readFileSync(breachedPath, "utf-8")) as Record<string, unknown>;
        breached["capUsd"] = 3;
        breached["reserveBreached"] = true;
        writeFileSync(breachedPath, JSON.stringify(breached));
        expect(() => migrateCampaignLedgerCap(breachedRoot, { fromCapUsd: 3, toCapUsd: 10, authorization: "approved" })).toThrow(/reserve breach/);

        const occupiedRoot = freshRoot();
        seedCampaignLedger(occupiedRoot);
        const occupiedPath = join(occupiedRoot, "campaign-ledger.json");
        const occupied = JSON.parse(readFileSync(occupiedPath, "utf-8")) as Record<string, unknown>;
        occupied["capUsd"] = 3;
        writeFileSync(occupiedPath, JSON.stringify(occupied));
        writeFileSync(join(occupiedRoot, "campaign-ledger.pre-cap-migration.json"), "occupied");
        expect(() => migrateCampaignLedgerCap(occupiedRoot, { fromCapUsd: 3, toCapUsd: 10, authorization: "approved" })).toThrow(/overwrite/);

        const receiptRoot = freshRoot();
        seedCampaignLedger(receiptRoot);
        const receiptLedgerPath = join(receiptRoot, "campaign-ledger.json");
        const receiptLedger = JSON.parse(readFileSync(receiptLedgerPath, "utf-8")) as Record<string, unknown>;
        receiptLedger["capUsd"] = 3;
        writeFileSync(receiptLedgerPath, JSON.stringify(receiptLedger));
        writeFileSync(join(receiptRoot, "campaign-ledger.cap-migration.json"), "occupied");
        expect(() => migrateCampaignLedgerCap(receiptRoot, { fromCapUsd: 3, toCapUsd: 10, authorization: "approved" })).toThrow(/overwrite/);
    });
});

describe("writePrivateFileExclusive (no overwrite, no swallowed chmod)", () => {
    it("refuses to overwrite an existing permissive file", () => {
        const root = freshRoot();
        const path = join(root, "report.json");
        writeFileSync(path, "old");
        chmodSync(path, 0o644);
        expect(() => writePrivateFileExclusive(path, "new")).toThrow(/Refusing to overwrite/);
        expect(readFileSync(path, "utf-8")).toBe("old");
    });

    it("refuses symlinked output", () => {
        const root = freshRoot();
        const target = join(root, "real.json");
        writeFileSync(target, "x");
        const link = join(root, "link.json");
        symlinkSync(target, link);
        expect(() => writePrivateFileExclusive(link, "new")).toThrow(/symlink/i);
    });

    it("writes 0600 plus an exact-bytes sidecar, and refuses second write", () => {
        const root = freshRoot();
        const path = join(root, "report.json");
        const { outPath, sidecarPath, byteHash } = writePrivateArtifact(path, '{"a":1}\n');
        expect(outPath).toBe(path);
        expect(lstatSync(path).mode & 0o777).toBe(0o600);
        expect(lstatSync(sidecarPath).mode & 0o777).toBe(0o600);
        expect(readFileSync(sidecarPath, "utf-8").startsWith(byteHash)).toBe(true);
        expect(() => writePrivateArtifact(path, '{"a":2}\n')).toThrow(/Refusing to overwrite/);
    });
});

describe("verifyLegacyCanonicalSidecar (historical provenance, read-only)", () => {
    it("verifies synthetic canonical sidecars and rejects changed inputs", () => {
        const root = freshRoot();
        const artifact = join(root, "artifact.json");
        const sidecar = `${artifact}.sha256`;
        const bytes = '{\n  "a": 1\n}\n';
        const canonical = createHash("sha256").update(JSON.stringify(JSON.parse(bytes))).digest("hex");
        writeFileSync(artifact, bytes);
        writeFileSync(sidecar, `${canonical}  ${artifact}\n`);
        const proof = verifyLegacyCanonicalSidecar(artifact, sidecar);
        expect(proof.sidecarMatchesCanonical).toBe(true);
        expect(proof.canonicalDigest).toBe(canonical);
        expect(proof.byteDigest).not.toBe(canonical);
        writeFileSync(artifact, '{\n  "a": 2\n}\n');
        expect(verifyLegacyCanonicalSidecar(artifact, sidecar).sidecarMatchesCanonical).toBe(false);
        writeFileSync(artifact, bytes);
        writeFileSync(sidecar, `${"0".repeat(64)}  ${artifact}\n`);
        expect(verifyLegacyCanonicalSidecar(artifact, sidecar).sidecarMatchesCanonical).toBe(false);
        unlinkIfExists(sidecar);
        expect(() => verifyLegacyCanonicalSidecar(artifact, sidecar)).toThrow();
    });

    it.skipIf(process.env.PI_SMARTREAD_PRIVATE_ARTIFACT_AUDIT !== "1")("the two 2026-10-07 private sidecars match the ORIGINAL compact-canonical digest, not file bytes", () => {
        const dir = "/var/folders/n1/w_721hvs2tsc0l0hpf37wnwm0000gn/T/";
        const cases = [
            { artifact: `${dir}judge-model-comparison-2026-10-07T17-30-25-596Z.json`, canonical: "e73f5de56501be808fceb59059e6dca7debabf2350126b7cfdf3b0cdec69f6a2", bytes: "d0416423a1264a0a8ac3c2bf7f4ecf55af6b0cb72b017fd8da3b168c55505af5" },
            { artifact: `${dir}judge-model-comparison-2026-10-07T17-30-33-052Z.json`, canonical: "0bb01ec4c83fe69ee941ca9f5d5bb7d0cef6e91c9a59d7759e42d82657439bf3", bytes: "638f18ab1752b964e25398991ccd8a1a42f62cce507dc4c3e1348df568f7b65a" },
        ];
        for (const c of cases) {
            const proof = verifyLegacyCanonicalSidecar(c.artifact, `${c.artifact}.sha256`);
            expect(proof.sidecarMatchesCanonical).toBe(true);
            expect(proof.canonicalDigest).toBe(c.canonical);
            expect(proof.byteDigest).toBe(c.bytes);
            expect(proof.canonicalDigest).not.toBe(proof.byteDigest);
        }
    });
});
