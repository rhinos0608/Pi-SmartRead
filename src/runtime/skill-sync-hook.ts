/**
 * Session wiring for skill sync — runs the bundled-skills sync once per
 * process on `session_start` (non-blocking, never throws) and emits a
 * single summary notification when anything changed or needs attention.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { syncSmartReadSkills, type SkillSyncReport } from "./skill-sync.js";

let syncedThisProcess = false;

function isInteresting(report: SkillSyncReport): boolean {
  return (
    report.installed.length > 0 ||
    report.updated.length > 0 ||
    report.removed.length > 0 ||
    report.skippedModified.length > 0 ||
    report.errors.length > 0
  );
}

function summarizeReport(report: SkillSyncReport): string {
  const parts: string[] = [];
  if (report.installed.length > 0) parts.push(`installed ${report.installed.join(", ")}`);
  if (report.updated.length > 0) parts.push(`updated ${report.updated.join(", ")}`);
  if (report.removed.length > 0) parts.push(`removed ${report.removed.join(", ")}`);
  if (report.skippedModified.length > 0) {
    parts.push(
      `left untouched (you edited them; delete to re-sync): ${report.skippedModified.join(", ")}`,
    );
  }
  if (report.errors.length > 0) {
    // Summarise counts, not stack traces: the full messages stay in logs.
    parts.push(
      `hit ${report.errors.length} error${report.errors.length === 1 ? "" : "s"} (check logs for details)`,
    );
  }
  return `[SmartRead] skills sync: ${parts.join("; ")}`;
}

export function registerSkillSync(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (syncedThisProcess) return;
    syncedThisProcess = true;
    // Non-blocking: never delay or fail session startup.
    void Promise.resolve()
      .then(() => syncSmartReadSkills())
      .then((report) => {
        if (!isInteresting(report)) return;
        try {
          ctx?.ui?.notify?.(summarizeReport(report), "info");
        } catch {
          /* UI is best-effort (headless hosts may throw) */
        }
      })
      .catch(() => {
        /* sync errors are collected in the report; never throw */
      });
  });
}

/** Reset the once-per-process guard (tests only). */
export function resetSkillSyncForTests(): void {
  syncedThisProcess = false;
}
