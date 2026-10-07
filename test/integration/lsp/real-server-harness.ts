/**
 * Shared opt-in harness for real language-server conformance (RS1/RS6/RS7).
 *
 * Gate: `PI_SMARTREAD_LSP_CONFORMANCE=1` (repo convention, see
 * docs/lsp-conformance.md §7). `PI_REAL_SERVER=1` accepted as alias.
 * Default `npm test` stays hermetic: suites `describe.skipIf(!enabled)`.
 * Binary missing => per-case `ctx.skip()` with reason, never counted as pass.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { LSPConnection } from "../../../src/lsp/lsp-connection.js";

export const REAL_LSP_ENABLED =
  process.env.PI_SMARTREAD_LSP_CONFORMANCE === "1" || process.env.PI_REAL_SERVER === "1";

export function resolveBinary(candidates: string[]): string | null {
  for (const c of candidates) {
    if (c.includes("/") && existsSync(c)) return c;
    try {
      const found = execFileSync("command", ["-v", c], { encoding: "utf-8" }).trim().split("\n")[0]?.trim();
      if (found && existsSync(found)) return found;
    } catch {
      /* not on PATH */
    }
  }
  // Fallback: manual PATH scan (command -v may be shell-specific).
  const dirs = (process.env.PATH ?? "").split(delimiter);
  for (const c of candidates) {
    if (c.includes("/")) continue;
    for (const d of dirs) {
      const p = join(d, c);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export const TS_BIN_CANDIDATES = ["typescript-language-server", "/opt/homebrew/bin/typescript-language-server"];

export interface TsProject {
  root: string;
  mainFile: string;
  errorFile: string;
  cleanup: () => void;
}

/** Minimal tsconfig + one clean file + one file with a type error (for push diagnostics). */
export function makeTsProject(prefix: string): TsProject {
  // realpath: os.tmpdir() is a symlink (/tmp -> /private/tmp) on macOS and the
  // server rejects didOpen URIs whose path spelling differs from the project root.
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, target: "es2020", module: "commonjs" }, include: ["*.ts"] }),
  );
  const mainFile = join(root, "main.ts");
  writeFileSync(mainFile, `export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport const answer = add(40, 2);\n`);
  const errorFile = join(root, "broken.ts");
  writeFileSync(errorFile, `export const notANumber: number = "definitely not a number";\n`);
  return { root, mainFile, errorFile, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export interface LiveServer {
  conn: LSPConnection;
  /** Call in afterEach: best-effort shutdown. */
  close: () => void;
}

/** Spawn a real server; caller owns close(). Throws on init failure (genuine FAIL). */
export async function startRealServer(opts: {
  command: string;
  args: string[];
  root: string;
  descriptorId?: string;
  sessionSettings?: unknown;
}): Promise<LiveServer> {
  const conn = new LSPConnection();
  conn.descriptorId = opts.descriptorId ?? "real-server-conformance";
  conn.name = opts.command.split("/").pop();
  conn.projectRoot = opts.root;
  if (opts.sessionSettings !== undefined) conn.sessionSettings = opts.sessionSettings;
  await conn.start(opts.command, opts.args, opts.root);
  return { conn, close: () => { try { conn.shutdown(); } catch { /* best effort */ } } };
}

/** Poll until cond() is true or ms elapses. Returns true when cond held. */
export async function pollFor(cond: () => boolean, ms: number, stepMs = 250): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}
