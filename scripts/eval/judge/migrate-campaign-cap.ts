import { readFileSync } from "node:fs";
import { defaultCampaignRoot, migrateCampaignLedgerCap } from "./model-comparison-budget.js";

const apply = process.argv.includes("--apply");
const unknown = process.argv.slice(2).filter((arg) => arg !== "--apply");
if (unknown.length > 0) throw new Error(`Unknown arguments: ${unknown.join(" ")}`);
const root = defaultCampaignRoot();
const ledgerPath = `${root}/campaign-ledger.json`;
const current = JSON.parse(readFileSync(ledgerPath, "utf-8")) as { capUsd?: unknown; campaignUsedUsd?: unknown; actualSpentUsd?: unknown };
const plan = { ledgerPath, fromCapUsd: current.capUsd, toCapUsd: 10, campaignUsedUsd: current.campaignUsedUsd, actualSpentUsd: current.actualSpentUsd };
if (!apply) {
    process.stdout.write(`${JSON.stringify({ action: "planned-only", ...plan }, null, 2)}\n`);
} else {
    const ledger = migrateCampaignLedgerCap(root, {
        fromCapUsd: 3,
        toCapUsd: 10,
        authorization: "Owner-authorized spend cap of $10 (2026-10-09)",
    });
    process.stdout.write(`${JSON.stringify({ action: "applied", capUsd: ledger.capUsd, campaignUsedUsd: ledger.campaignUsedUsd, actualSpentUsd: ledger.actualSpentUsd }, null, 2)}\n`);
}
