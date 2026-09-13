import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { detectProjectLanguages } from "./lsp-bridge.js";
import { resolveLanguageServer } from "./language-intelligence-runtime.js";
import { isRootTrusted, trustRoot, loadConfig, setInstallMode } from "./language-intelligence-config.js";
import { getDescriptorsForLanguage, LANGUAGE_SERVER_CATALOG } from "./language-server-catalog.js";
import { invalidateResolvedServerCacheForRoot, evictManagerForRoot } from "./lsp-bridge.js";
import { join } from "node:path";

const MAX_LIST = 20;

const EXT_FOR_LANG: Record<string, string> = {
  typescript: ".ts", typescriptreact: ".tsx", javascript: ".js", javascriptreact: ".jsx",
  python: ".py", rust: ".rs", go: ".go", c: ".c", cpp: ".cpp", csharp: ".cs",
  java: ".java", php: ".php", bash: ".sh", shellscript: ".sh",
  json: ".json", yaml: ".yaml", html: ".html", css: ".css", lua: ".lua", ruby: ".rb",
};

function dummyForLanguage(lang: string, root: string): string {
  const ext = EXT_FOR_LANG[lang] ?? ".txt";
  return join(root, `__probe__${ext}`);
}

function capList<T>(arr: T[]): { shown: T[]; more: number } {
  if (arr.length <= MAX_LIST) return { shown: arr, more: 0 };
  return { shown: arr.slice(0, MAX_LIST), more: arr.length - MAX_LIST };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function resolveManagedCandidate(serverArg: string): { descriptorId: string; managedInstall: { packageName: string; version: string; bin: string } } | null {
  const lower = serverArg.toLowerCase();
  // try descriptor id first
  const byId = LANGUAGE_SERVER_CATALOG.find((d) => d.id.toLowerCase() === lower);
  if (byId) {
    for (const cand of byId.commandCandidates ?? []) {
      if (cand.managedInstall) return { descriptorId: byId.id, managedInstall: cand.managedInstall };
    }
    return null;
  }
  // try language id
  const descs = getDescriptorsForLanguage(lower);
  for (const desc of descs) {
    for (const cand of desc.commandCandidates ?? []) {
      if (cand.managedInstall) return { descriptorId: desc.id, managedInstall: cand.managedInstall };
    }
  }
  return null;
}

function hasManagedCandidate(lang: string): boolean {
  const descs = getDescriptorsForLanguage(lang);
  return descs.some((d) => (d.commandCandidates ?? []).some((c) => !!c.managedInstall));
}

export function registerLanguageIntelligenceCommand(pi: ExtensionAPI): void {
  if (typeof (pi as any)?.registerCommand !== "function") return;
  pi.registerCommand("lsp", {
    description: "Language intelligence — status/doctor/trust/restart/install/update/uninstall (Phase 3)",
    handler: async (args: string, ctx: any) => {
      const root: string = ctx.cwd ?? process.cwd();
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = (tokens[0] ?? "").toLowerCase();

      if (!sub || sub === "status") {
        const info = detectProjectLanguages(root);
        const { shown: detected, more } = capList(info.detectedLanguages);
        const lines: string[] = [];
        lines.push(`Language Intelligence — ${root}`);
        if (detected.length === 0) {
          lines.push("(no languages detected)");
        } else {
          for (const lang of detected) {
            const dummy = dummyForLanguage(lang, root);
            let resolution: ReturnType<typeof resolveLanguageServer>;
            try { resolution = resolveLanguageServer(dummy, root); } catch { resolution = { status: "degraded", languageId: lang, reasonCode: "executable-missing", message: "resolve error", attemptedDescriptorIds: [], fallback: "text" } as any; }
            if (resolution.status === "available") {
              lines.push(`${pad(lang, 12)} ${pad(resolution.descriptorId, 28)} available (${resolution.tier})`);
            } else {
              const desc = getDescriptorsForLanguage(lang);
              const did = desc[0]?.id ?? "—";
              const hint = hasManagedCandidate(lang) ? ` (run /lsp install ${desc.find((d: any)=>(d.commandCandidates ?? []).some((c: any)=>c.managedInstall))?.id ?? lang} to install)` : "";
              lines.push(`${pad(lang, 12)} ${pad(did, 28)} missing (${(resolution as any).reasonCode ?? "unavailable"})${hint}`);
            }
          }
          if (more > 0) lines.push(`+${more} more`);
        }
        lines.push("warmup: enabled");
        const mode = loadConfig().installMode ?? "off";
        lines.push(`install mode: ${mode}`);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "doctor") {
        const langFilter = tokens[1]?.toLowerCase();
        const info = detectProjectLanguages(root);
        let langs: string[];
        if (langFilter) {
          langs = [langFilter];
        } else {
          const c = capList(info.detectedLanguages);
          langs = c.shown;
          // if many, still cap — suffix handled below
        }
        if (langs.length === 0) langs = info.detectedLanguages.slice(0, MAX_LIST);
        const moreLangs = !langFilter && info.detectedLanguages.length > MAX_LIST ? info.detectedLanguages.length - MAX_LIST : 0;
        const trusted = isRootTrusted(root);
        const lines: string[] = [];
        lines.push(`Doctor — ${root}`);
        lines.push(`trusted: ${trusted}`);
        const mode = loadConfig().installMode ?? "off";
        lines.push(`install mode: ${mode}`);
        if (langs.length === 0) {
          lines.push("(no languages to diagnose)");
        }
        for (const lang of langs) {
          const descs = getDescriptorsForLanguage(lang);
          const { shown, more } = capList(descs.map((d) => d.id));
          const dummy = dummyForLanguage(lang, root);
          let resolution: ReturnType<typeof resolveLanguageServer>;
          try { resolution = resolveLanguageServer(dummy, root); } catch (e: any) {
            resolution = { status: "degraded", languageId: lang, reasonCode: "executable-missing", message: String(e?.message ?? e), attemptedDescriptorIds: shown, fallback: "text" } as any;
          }
          lines.push(`- ${lang}`);
          lines.push(`  descriptors: ${shown.length ? shown.join(", ") : "(none)"}${more ? ` +${more} more` : ""}`);
          if (resolution.status === "available") {
            lines.push(`  tier: ${resolution.tier} (${resolution.descriptorId} → ${resolution.executable})`);
          } else {
            const r: any = resolution;
            lines.push(`  tier: degraded (${r.reasonCode ?? "unknown"})`);
            if (r.message) lines.push(`  reason: ${r.message}`);
            if (r.fallback) lines.push(`  fallback: ${r.fallback}`);
            if (hasManagedCandidate(lang)) {
              const hintId = descs.find((d) => (d.commandCandidates ?? []).some((c: any) => c.managedInstall))?.id ?? lang;
              lines.push(`  hint: run /lsp install ${hintId} to install`);
            }
          }
        }
        if (moreLangs > 0) lines.push(`+${moreLangs} more languages`);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "trust") {
        const target = tokens[1] ?? root;
        trustRoot(target);
        invalidateResolvedServerCacheForRoot(target);
        await evictManagerForRoot(target);
        // also invalidate/evict using realpath variant if different (trustRoot canonicalizes)
        try {
          const { realpathSync } = await import("node:fs");
          const canon = realpathSync(target);
          if (canon !== target) {
            invalidateResolvedServerCacheForRoot(canon);
            await evictManagerForRoot(canon);
          }
        } catch { /* ignore */ }
        ctx.ui.notify(`Trusted ${target}. Language servers will be re-resolved on next use.`, "info");
        return;
      }

      if (sub === "restart") {
        const serverId = tokens[1];
        await evictManagerForRoot(root);
        if (serverId) {
          ctx.ui.notify(`Restarted manager for ${root} (requested server: ${serverId} — whole manager restarted)`, "info");
        } else {
          ctx.ui.notify(`Restarted manager for ${root}`, "info");
        }
        return;
      }

      if (sub === "install") {
        const arg = tokens[1];
        if (!arg) {
          ctx.ui.notify(`Usage: /lsp install <server> | /lsp install auto`, "warning");
          return;
        }
        if (arg.toLowerCase() === "auto") {
          setInstallMode("auto");
          const info = detectProjectLanguages(root);
          const installed: string[] = [];
          const skipped: string[] = [];
          const failed: string[] = [];
          const { installServer } = await import("./language-intelligence-installer.js");
          for (const lang of info.detectedLanguages) {
            const dummy = dummyForLanguage(lang, root);
            let res: ReturnType<typeof resolveLanguageServer>;
            try { res = resolveLanguageServer(dummy, root); } catch { res = { status: "degraded", languageId: lang, reasonCode: "executable-missing", message: "", attemptedDescriptorIds: [], fallback: "text" } as any; }
            if (res.status === "available") continue;
            const managed = resolveManagedCandidate(lang);
            if (!managed) { skipped.push(lang); continue; }
            const r = await installServer(managed.managedInstall);
            if (r.ok) installed.push(managed.descriptorId);
            else failed.push(`${managed.descriptorId}: ${r.error}`);
          }
          const parts: string[] = ["Enabled auto-install mode."];
          if (installed.length) parts.push(`Installed: ${installed.join(", ")}.`);
          if (skipped.length) parts.push(`Skipped (no managed install available): ${skipped.join(", ")}.`);
          if (failed.length) parts.push(`Failed: ${failed.join("; ")}.`);
          if (!installed.length && !skipped.length && !failed.length) parts.push("No languages to install.");
          invalidateResolvedServerCacheForRoot(root);
          await evictManagerForRoot(root);
          ctx.ui.notify(parts.join(" "), "info");
          return;
        }
        const managed = resolveManagedCandidate(arg);
        if (!managed) {
          ctx.ui.notify(`No managed install available for \"${arg}\"`, "warning");
          return;
        }
        const { installServer } = await import("./language-intelligence-installer.js");
        const r = await installServer(managed.managedInstall);
        if (r.ok) {
          invalidateResolvedServerCacheForRoot(root);
          await evictManagerForRoot(root);
          ctx.ui.notify(`Installed ${managed.descriptorId} → ${r.binPath}`, "info");
        } else {
          ctx.ui.notify(`Failed to install ${managed.descriptorId}: ${r.error}`, "error");
        }
        return;
      }

      if (sub === "update") {
        const arg = tokens[1];
        if (!arg) {
          ctx.ui.notify(`Usage: /lsp update <server> | /lsp update --all`, "warning");
          return;
        }
        const { updateServer, isServerInstalled } = await import("./language-intelligence-installer.js");
        if (arg === "--all") {
          const results: string[] = [];
          for (const desc of LANGUAGE_SERVER_CATALOG) {
            for (const cand of desc.commandCandidates ?? []) {
              if (!cand.managedInstall) continue;
              const { packageName, version } = cand.managedInstall;
              if (!isServerInstalled(packageName, version)) continue;
              const r = await updateServer(cand.managedInstall);
              results.push(r.ok ? `${desc.id}: updated → ${r.binPath}` : `${desc.id}: failed — ${r.error}`);
              break; // one candidate per descriptor
            }
          }
          if (results.length === 0) ctx.ui.notify("No managed servers installed to update.", "info");
          else {
            const anySuccess = results.some((l) => !l.includes("failed"));
            if (anySuccess) {
              invalidateResolvedServerCacheForRoot(root);
              await evictManagerForRoot(root);
            }
            ctx.ui.notify(results.join("\n"), results.some((l) => l.includes("failed")) ? "warning" : "info");
          }
          return;
        }
        const managed = resolveManagedCandidate(arg);
        if (!managed) {
          ctx.ui.notify(`No managed install available for \"${arg}\"`, "warning");
          return;
        }
        const r = await updateServer(managed.managedInstall);
        if (r.ok) {
          invalidateResolvedServerCacheForRoot(root);
          await evictManagerForRoot(root);
          ctx.ui.notify(`Updated ${managed.descriptorId} → ${r.binPath}`, "info");
        } else {
          ctx.ui.notify(`Failed to update ${managed.descriptorId}: ${r.error}`, "error");
        }
        return;
      }

      if (sub === "uninstall") {
        const arg = tokens[1];
        if (!arg) {
          ctx.ui.notify(`Usage: /lsp uninstall <server>`, "warning");
          return;
        }
        const managed = resolveManagedCandidate(arg);
        if (!managed) {
          ctx.ui.notify(`No managed install found for \"${arg}\"`, "warning");
          return;
        }
        const { uninstallServer } = await import("./language-intelligence-installer.js");
        const r = await uninstallServer(managed.managedInstall.packageName);
        if (r.ok) {
          invalidateResolvedServerCacheForRoot(root);
          await evictManagerForRoot(root);
          ctx.ui.notify(`Uninstalled ${managed.descriptorId}`, "info");
        } else {
          ctx.ui.notify(`Failed to uninstall ${managed.descriptorId}: ${r.error}`, "error");
        }
        return;
      }

      ctx.ui.notify(`Unknown subcommand: ${sub}. Available: status, doctor, trust, restart, install, update, uninstall`, "warning");
    },
  });
}
