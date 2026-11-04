#!/usr/bin/env node
/**
 * Manual skill-sync entry point:
 * `node --import tsx scripts/install-skills.ts [--dry-run] [--target <dir>]`
 *
 * Calls the same `syncSmartReadSkills` core as the session_start hook —
 * no duplicated logic. Never touches the real home directory unless the
 * resolved default target is used explicitly.
 */

import { resolveDefaultSkillsTargetDir, syncSmartReadSkills } from "../src/runtime/skill-sync.js";

function parseArgs(argv: string[]): { dryRun: boolean; target: string | undefined } {
  let dryRun = false;
  let target: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--target") {
      const next = argv[i + 1];
      if (!next) {
        console.error("error: --target requires a directory argument");
        process.exit(2);
      }
      target = next;
      i++;
    } else {
      console.error(`error: unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return { dryRun, target };
}

const { dryRun, target } = parseArgs(process.argv.slice(2));
const targetDir = target ?? resolveDefaultSkillsTargetDir();
const report = syncSmartReadSkills({ targetDir, dryRun });

if (dryRun) console.log("(dry run — no changes written)");
console.log(JSON.stringify({ targetDir, ...report }, null, 2));

const failed = report.errors.length > 0;
process.exit(failed ? 1 : 0);
