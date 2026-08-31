import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { detectProjectLanguages } from "./lsp-bridge.js";
import { resolveLanguageServer } from "./language-intelligence-runtime.js";
import { isRootTrusted, trustRoot } from "./language-intelligence-config.js";
import { getDescriptorsForLanguage } from "./language-server-catalog.js";
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

export function registerLanguageIntelligenceCommand(pi: ExtensionAPI): void {
  if (typeof (pi as any)?.registerCommand !== "function") return;
  pi.registerCommand("lsp", {
    description: "Language intelligence — status/doctor/trust/restart (Phase 1)",
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
              lines.push(`${pad(lang, 12)} ${pad(did, 28)} missing (${(resolution as any).reasonCode ?? "unavailable"})`);
            }
          }
          if (more > 0) lines.push(`+${more} more`);
        }
        lines.push("warmup: enabled");
        lines.push("install mode: off (Phase 1 — no managed installs yet)");
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

      ctx.ui.notify(`Unknown subcommand: ${sub}. Available: status, doctor, trust, restart`, "warning");
    },
  });
}
