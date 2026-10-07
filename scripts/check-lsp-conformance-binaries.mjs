#!/usr/bin/env node
/**
 * Preflight binary check for LSP conformance lanes RS2-RS5.
 *
 * Single place that pins exact toolchain versions. CI installs these
 * versions, then runs this script before vitest so a missing/unusable
 * binary fails early with version evidence instead of surfacing as
 * an honest skip inside the suite.
 *
 * Normal dev mode is unaffected: the real-server suites still skip
 * honestly when a binary is absent. Strict zero-skip enforcement lives
 * in the workflow (fails the lane when vitest reports any skip).
 *
 * Usage:
 *   node scripts/check-lsp-conformance-binaries.mjs --help
 *   node scripts/check-lsp-conformance-binaries.mjs --list
 *   node scripts/check-lsp-conformance-binaries.mjs --server pyright
 *   node scripts/check-lsp-conformance-binaries.mjs --server all [--json]
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

// Single pin table. Bump versions here; CI install steps must match.
const PINS = {
  pyright: {
    rs: "RS2",
    candidates: ["pyright", "pyright-langserver", "basedpyright-langserver"],
    versionArgs: ["--version"],
    pinned: "1.1.399",
    install: "npm install -g pyright@1.1.399",
    testFile: "test/integration/lsp/real-server-pyright.test.ts",
  },
  gopls: {
    rs: "RS3",
    candidates: ["gopls"],
    versionArgs: ["version"],
    pinned: "v0.19.1",
    install: "go install golang.org/x/tools/gopls@v0.19.1",
    testFile: "test/integration/lsp/real-server-gopls.test.ts",
  },
  "rust-analyzer": {
    rs: "RS4",
    candidates: ["rust-analyzer"],
    versionArgs: ["--version"],
    pinned: "1.83.0",
    install: "rustup toolchain install 1.83.0 --component rust-analyzer",
    testFile: "test/integration/lsp/real-server-rust-analyzer.test.ts",
  },
  clangd: {
    rs: "RS5",
    candidates: ["clangd", "clangd-19"],
    versionArgs: ["--version"],
    pinned: "19.1.1",
    install: "sudo apt-get install -y clangd-19 (pin 19.1.1)",
    testFile: "test/integration/lsp/real-server-clangd.test.ts",
  },
};

const SERVERS = Object.keys(PINS);

function resolveBinary(candidates) {
  const dirs = (process.env.PATH ?? "").split(delimiter);
  for (const c of candidates) {
    if (c.includes("/") && existsSync(c)) return c;
    for (const d of dirs) {
      const p = join(d, c);
      if (p && existsSync(p)) return p;
    }
  }
  return null;
}

function checkOne(name) {
  const pin = PINS[name];
  const binary = resolveBinary(pin.candidates);
  if (!binary) {
    return { server: name, rs: pin.rs, ok: false, binary: null, version: null,
      error: `absent from PATH (tried ${pin.candidates.join(", ")}). Install: ${pin.install}` };
  }
  let version = null;
  try {
    // Freshly installed native servers can cold-start slowly on busy hosted runners.
    // This is a usability/version check, not a latency assertion.
    version = execFileSync(binary, pin.versionArgs, { encoding: "utf-8", timeout: 45_000 }).trim().split("\n")[0];
  } catch (err) {
    return { server: name, rs: pin.rs, ok: false, binary, version: null,
      error: `unusable: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
  if (!version.includes(pin.pinned)) {
    return { server: name, rs: pin.rs, ok: false, binary, version,
      error: `version mismatch: got "${version}", pinned "${pin.pinned}". Install: ${pin.install}` };
  }
  return { server: name, rs: pin.rs, ok: true, binary, version, error: null };
}

function printHelp() {
  console.log(`check-lsp-conformance-binaries — RS2-RS5 preflight (fails early on absent/unusable/mismatched binary)

Usage:
  node scripts/check-lsp-conformance-binaries.mjs --help
  node scripts/check-lsp-conformance-binaries.mjs --list
  node scripts/check-lsp-conformance-binaries.mjs --server <name|all> [--json]

Servers: ${SERVERS.join(", ")}
Pins (single source of truth, see PINS in this file):`);
  for (const s of SERVERS) console.log(`  ${s} (${PINS[s].rs}): ${PINS[s].pinned} — ${PINS[s].install}`);
  console.log(`
Strict semantics (enforced by CI lane, not this script alone):
  absent -> FAIL, unusable -> FAIL, version mismatch -> FAIL.
  Unexpected vitest skip -> FAIL (workflow greps for skipped counts).
  Normal dev mode keeps honest ctx.skip() (no STRICT env needed locally).`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { printHelp(); process.exit(0); }
  if (args.includes("--list")) {
    for (const s of SERVERS) console.log(`${s} ${PINS[s].rs} pinned=${PINS[s].pinned} test=${PINS[s].testFile}`);
    process.exit(0);
  }
  let server = "all";
  const si = args.findIndex((a) => a === "--server");
  if (si !== -1) server = args[si + 1] ?? "all";
  const eq = args.find((a) => a.startsWith("--server="));
  if (eq) server = eq.split("=")[1];
  if (server !== "all" && !PINS[server]) {
    console.error(`Unknown server "${server}". Expected one of: ${[...SERVERS, "all"].join(", ")}`);
    process.exit(2);
  }
  const json = args.includes("--json");
  const names = server === "all" ? SERVERS : [server];
  const results = names.map(checkOne);
  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      if (r.ok) console.log(`ok ${r.rs}/${r.server}: ${r.binary} — ${r.version}`);
      else console.log(`FAIL ${r.rs}/${r.server}: ${r.error}`);
    }
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main();
