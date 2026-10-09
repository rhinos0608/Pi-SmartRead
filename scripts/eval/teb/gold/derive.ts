#!/usr/bin/env node
/**
 * TEB gold-derivation CLI for task authors. Derives a JSON gold candidate
 * + agreement class for one anchor; it does NOT author tasks.
 *
 * Usage:
 *   node --import tsx scripts/eval/teb/gold/derive.ts \
 *     --repo <owner__name> --family <f> --anchor <path:line:col> \
 *     [--subpath <p>] [--scope <s>] [--dts-target] [--live-server]
 *
 * Reads ~/.cache/pi-smartread-bench/teb/repos.json for the checkout root
 * and pinned commit. The compiler cross-check always runs. The pinned
 * language server runs only with --live-server (slow: project-load wait);
 * without it, server-side fields are null and agreement is reported as
 * "compiler-only (server not run)".
 *
 * Families: definition | all-references | implementations | callers |
 *   type-of-symbol | direct-importers | package-exports.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { classifySetAgreement, compilerCheck, directImporters, packageEntryFiles } from "./compiler-check.js";
import { deriveServerGold, parseAnchor } from "./server-labels.js";
import type { AgreementClass } from "./normalize.js";

type Family =
    | "definition"
    | "all-references"
    | "implementations"
    | "callers"
    | "type-of-symbol"
    | "direct-importers"
    | "package-exports";

const FAMILIES: Family[] = [
    "definition",
    "all-references",
    "implementations",
    "callers",
    "type-of-symbol",
    "direct-importers",
    "package-exports",
];

interface ReposJson {
    reposDir: string;
    repos: Array<{ owner: string; name: string; commit: string; tag?: string }>;
    languageServer?: { typescript?: string; version?: string };
}

function loadRepos(): ReposJson {
    const p = join(homedir(), ".cache", "pi-smartread-bench", "teb", "repos.json");
    return JSON.parse(readFileSync(p, "utf-8")) as ReposJson;
}

function parseArgs(argv: string[]): {
    repo: string;
    family: Family;
    anchor: string;
    subpath: string;
    scope: string;
    dtsTarget: boolean;
    liveServer: boolean;
    loadWaitMs: number;
} {
    const get = (flag: string): string | undefined => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const repo = get("--repo") ?? "";
    const familyRaw = get("--family") ?? "";
    const anchor = get("--anchor") ?? "";
    if (!repo || !familyRaw || !anchor) {
        throw new Error("usage: derive.ts --repo <owner__name> --family <f> --anchor <path:line:col> [--subpath p] [--scope s] [--dts-target] [--live-server]");
    }
    if (!FAMILIES.includes(familyRaw as Family)) throw new Error(`unknown family: ${familyRaw} (want ${FAMILIES.join("|")})`);
    parseAnchor(anchor);
    return {
        repo,
        family: familyRaw as Family,
        anchor,
        subpath: get("--subpath") ?? "",
        scope: get("--scope") ?? "",
        dtsTarget: argv.includes("--dts-target"),
        liveServer: argv.includes("--live-server"),
        loadWaitMs: Number(get("--load-wait-ms") ?? 8000),
    };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const manifest = loadRepos();
    const [owner, name] = args.repo.split("__");
    const pin = manifest.repos.find((r) => r.owner === owner && r.name === name);
    if (!pin) throw new Error(`repo not in repos.json: ${args.repo}`);
    const checkout = realpathSync(resolve(manifest.reposDir.replace(/^~/, homedir()), `${owner}__${name}`));
    const root = args.subpath ? join(checkout, args.subpath) : checkout;
    if (!existsSync(root)) throw new Error(`task root missing: ${root}`);
    const a = parseAnchor(args.anchor);
    const anchorAbs = { path: a.path, line: a.line, character: a.character };

    const out: Record<string, unknown> = {
        repo: args.repo,
        commit: pin.commit,
        subpath: args.subpath,
        family: args.family,
        anchor: args.anchor,
        scope: args.scope,
        derivation: `derive.ts ${process.argv.slice(2).join(" ")} @ ${pin.commit}`,
        languageServerPinned: manifest.languageServer ?? null,
    };

    if (args.family === "direct-importers") {
        out.importers = directImporters(root, a.path);
        out.agreement = "agree";
        out.note = "structural family: exhaustive depth-1 import scan from source; labeler review required (§6.3)";
        console.log(JSON.stringify(out, null, 2));
        return;
    }
    if (args.family === "package-exports") {
        out.entryFiles = packageEntryFiles(root);
        out.agreement = "agree";
        out.note = "structural family: package.json exports/main/types enumeration; labeler review required (§6.3)";
        console.log(JSON.stringify(out, null, 2));
        return;
    }

    // Semantic families: compiler cross-check always runs.
    const cc = compilerCheck(root, anchorAbs, { scope: args.scope, dtsTarget: args.dtsTarget });
    out.typescriptVersion = cc.typescriptVersion;
    out.typescriptResolvedFrom = cc.resolvedFrom;
    out.compiler = { definition: cc.definition, references: cc.references, implementations: cc.implementations };

    if (!args.liveServer) {
        out.server = null;
        out.agreement = "compiler-only (server not run)";
        out.note = "re-run with --live-server for the pinned-server half; callers/type-of-symbol independent checks are labeler textual passes (§6.1)";
        console.log(JSON.stringify(out, null, 2));
        return;
    }

    const server = await deriveServerGold(root, args.anchor, { scope: args.scope, dtsTarget: args.dtsTarget, loadWaitMs: args.loadWaitMs });
    out.server = server;
    let agreement: AgreementClass;
    if (args.family === "definition") agreement = classifySetAgreement(server.definition, cc.definition);
    else if (args.family === "all-references") agreement = classifySetAgreement(server.references, cc.references, { declaration: cc.definition });
    else if (args.family === "implementations") agreement = classifySetAgreement(server.implementations, cc.implementations);
    else agreement = "adjudicated"; // callers / type-of-symbol: no compiler equivalent; labeler pass decides
    if (!server.referencesBounded && args.family === "all-references") {
        out.referencesBounded = false;
        out.note = "REJECT or split: >40 in-scope references (§1.1.4)";
    }
    out.agreement = agreement;
    if (agreement !== "agree") out.note = "divergence goes to the third adjudicator with a non-empty note (§6.1)";
    console.log(JSON.stringify(out, null, 2));
}

await main();
