/**
 * Real ESM chokidar integration test for file-watcher.
 *
 * The child process runs under `node --import tsx` and imports a temporary
 * copy of file-watcher.ts. Its module-local node_modules contains a tiny CJS
 * chokidar implementation, so this exercises Node's real createRequire
 * resolution without depending on the host's native watcher limits or on
 * Vitest's module mocker.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const CHILD_SCRIPT = String.raw`
import { startWatching } from "./src/file-watcher.ts";

const root = process.env["WATCH_ROOT"];
const dirty = [];
const warnings = [];
const origWarn = console.warn;
console.warn = (msg) => { warnings.push(String(msg)); };
const stop = startWatching(root, (paths) => { dirty.push(...paths); }, { mode: "chokidar", debounceMs: 0 });

await new Promise((resolve) => setTimeout(resolve, 100));
stop();
console.warn = origWarn;
process.stdout.write(JSON.stringify({ dirty, warnings }) + "\n");
`;

function runChild(cwd: string, root: string): Promise<{ dirty: string[]; warnings: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      ["--import", join(ROOT, "node_modules/tsx/dist/loader.mjs"), "--input-type=module", "--eval", CHILD_SCRIPT],
      {
        cwd,
        env: { ...process.env, VITEST: "", NODE_ENV: "development", WATCH_ROOT: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    const timeout = setTimeout(() => child.kill(), 10_000);
    child.stdout.on("data", (data) => { out += data; });
    child.stderr.on("data", (data) => { err += data; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      try {
        if (code !== 0) throw new Error(`child exited ${code}: ${err}`);
        resolve(JSON.parse(out.trim()));
      } catch {
        reject(new Error(`Child produced no valid JSON. stdout=${out} stderr=${err}`));
      }
    });
  });
}

describe("file-watcher real ESM chokidar load", () => {
  it("loads a resolvable chokidar module via createRequire", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "fw-esm-"));
    const sourceDir = join(fixtureRoot, "src");
    const chokidarDir = join(fixtureRoot, "node_modules", "chokidar");
    const watchedRoot = join(fixtureRoot, "workspace");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(chokidarDir, { recursive: true });
    mkdirSync(watchedRoot, { recursive: true });
    writeFileSync(join(fixtureRoot, "package.json"), JSON.stringify({ type: "module" }));
    copyFileSync(join(ROOT, "src/file-watcher.ts"), join(sourceDir, "file-watcher.ts"));
    writeFileSync(
      join(chokidarDir, "package.json"),
      JSON.stringify({ name: "chokidar", version: "0.0.0", main: "index.cjs" }),
    );
    writeFileSync(
      join(chokidarDir, "index.cjs"),
      [
        "const { EventEmitter } = require('node:events');",
        "const { join } = require('node:path');",
        "exports.watch = (root) => {",
        "  const watcher = new EventEmitter();",
        "  watcher.close = async () => {};",
        "  process.nextTick(() => watcher.emit('change', join(root, 'probe.txt')));",
        "  return watcher;",
        "};",
        "",
      ].join("\n"),
    );

    try {
      const result = await runChild(fixtureRoot, watchedRoot);
      expect(result.warnings.some((warning) => warning.includes("chokidar not installed"))).toBe(false);
      expect(result.dirty).toContain("probe.txt");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 20_000);
});
