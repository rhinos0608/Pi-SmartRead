import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync as realRenameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MANAGED_MARKER,
  resolveDefaultSkillsTargetDir,
  syncSmartReadSkills,
} from "../../../src/runtime/skill-sync.js";
import { registerSkillSync, resetSkillSyncForTests } from "../../../src/runtime/skill-sync-hook.js";

let roots: string[] = [];

function makeSource(skills: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "smartread-skill-src-"));
  roots.push(dir);
  for (const [name, body] of Object.entries(skills)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), body);
  }
  return dir;
}

function makeTarget(): string {
  const dir = mkdtempSync(join(tmpdir(), "smartread-skill-tgt-"));
  roots.push(dir);
  return join(dir, "skills");
}

const SKILL_A = "---\nname: skill-a\ndescription: Skill A.\n---\n# A\n";
const SKILL_B = "---\nname: skill-b\ndescription: Skill B.\n---\n# B\n";

beforeEach(() => {
  roots = [];
  delete process.env.PI_SMARTREAD_SKILL_SYNC;
});

afterEach(() => {
  delete process.env.PI_SMARTREAD_SKILL_SYNC;
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("syncSmartReadSkills", () => {
  it("installs fresh skills with marker files", () => {
    const source = makeSource({ "skill-a": SKILL_A, "skill-b": SKILL_B });
    const target = makeTarget();
    const report = syncSmartReadSkills({ sourceDir: source, targetDir: target, version: "1.0.0" });
    expect(report.installed.sort()).toEqual(["skill-a", "skill-b"]);
    expect(report.errors).toEqual([]);
    for (const name of ["skill-a", "skill-b"]) {
      expect(readFileSync(join(target, name, "SKILL.md"), "utf-8")).toContain(name);
      const marker = JSON.parse(readFileSync(join(target, name, MANAGED_MARKER), "utf-8")) as {
        package: string;
        version: string;
      };
      expect(marker.package).toBe("pi-smartread");
      expect(marker.version).toBe("1.0.0");
    }
  });

  it("is idempotent on re-run (all unchanged)", () => {
    const source = makeSource({ "skill-a": SKILL_A });
    const target = makeTarget();
    syncSmartReadSkills({ sourceDir: source, targetDir: target, version: "1.0.0" });
    const second = syncSmartReadSkills({ sourceDir: source, targetDir: target, version: "1.0.0" });
    expect(second.unchanged).toEqual(["skill-a"]);
    expect(second.installed).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.errors).toEqual([]);
  });

  it("leaves unmanaged target dirs alone", () => {
    const source = makeSource({ "skill-a": SKILL_A });
    const target = makeTarget();
    mkdirSync(join(target, "skill-a"), { recursive: true });
    writeFileSync(join(target, "skill-a", "SKILL.md"), "user content\n");
    const report = syncSmartReadSkills({ sourceDir: source, targetDir: target, version: "1.0.0" });
    expect(report.skippedUnmanaged).toEqual(["skill-a"]);
    expect(readFileSync(join(target, "skill-a", "SKILL.md"), "utf-8")).toBe("user content\n");
  });

  it("skips user-edited managed copies", () => {
    const source = makeSource({ "skill-a": SKILL_A });
    const target = makeTarget();
    syncSmartReadSkills({ sourceDir: source, targetDir: target, version: "1.0.0" });
    appendFileSync(join(target, "skill-a", "SKILL.md"), "user edit\n");
    const report = syncSmartReadSkills({ sourceDir: source, targetDir: target, version: "1.0.0" });
    expect(report.skippedModified).toEqual(["skill-a"]);
    expect(readFileSync(join(target, "skill-a", "SKILL.md"), "utf-8")).toContain("user edit");
  });

  it("updates unmodified copies when the source changes", () => {
    const source = makeSource({ "skill-a": SKILL_A });
    const target = makeTarget();
    syncSmartReadSkills({ sourceDir: source, targetDir: target, version: "1.0.0" });
    writeFileSync(join(source, "skill-a", "SKILL.md"), `${SKILL_A}\nMore docs.\n`);
    const report = syncSmartReadSkills({ sourceDir: source, targetDir: target, version: "1.1.0" });
    expect(report.updated).toEqual(["skill-a"]);
    expect(readFileSync(join(target, "skill-a", "SKILL.md"), "utf-8")).toContain("More docs.");
  });

  it("removes managed copies of dropped skills but keeps edited ones", () => {
    const source = makeSource({ "skill-a": SKILL_A, "skill-b": SKILL_B });
    const target = makeTarget();
    syncSmartReadSkills({ sourceDir: source, targetDir: target, version: "1.0.0" });
    appendFileSync(join(target, "skill-b", "SKILL.md"), "user edit\n");
    rmSync(join(source, "skill-a"), { recursive: true });
    rmSync(join(source, "skill-b"), { recursive: true });
    mkdirSync(join(source, "skill-a"), { recursive: true });
    writeFileSync(join(source, "skill-a", "SKILL.md"), SKILL_A);
    // skill-b dropped from source; skill-b target copy is user-edited.
    const report = syncSmartReadSkills({
      sourceDir: source,
      targetDir: target,
      version: "1.0.0",
    });
    // skill-a still shipped: unchanged; skill-b dropped but edited: skipped.
    expect(report.unchanged).toEqual(["skill-a"]);
    expect(report.skippedModified).toEqual(["skill-b"]);
    expect(readFileSync(join(target, "skill-b", "SKILL.md"), "utf-8")).toContain("user edit");
  });

  it("removes unmodified managed copies of dropped skills", () => {
    const source = makeSource({ "skill-a": SKILL_A, "skill-b": SKILL_B });
    const target = makeTarget();
    syncSmartReadSkills({ sourceDir: source, targetDir: target, version: "1.0.0" });
    rmSync(join(source, "skill-b"), { recursive: true });
    const report = syncSmartReadSkills({ sourceDir: source, targetDir: target, version: "1.0.0" });
    expect(report.removed).toEqual(["skill-b"]);
    expect(report.unchanged).toEqual(["skill-a"]);
  });

  it("records the skill name in the marker and never removes a renamed copy", () => {
    const source = makeSource({ "skill-a": SKILL_A });
    const target = makeTarget();
    syncSmartReadSkills({ sourceDir: source, targetDir: target, version: "1.0.0" });
    const marker = JSON.parse(readFileSync(join(target, "skill-a", MANAGED_MARKER), "utf-8")) as {
      package: string;
      skill: string;
    };
    expect(marker.package).toBe("pi-smartread");
    expect(marker.skill).toBe("skill-a");
    // A user copying a managed skill to customise it under a new name keeps
    // a marker that must no longer authorize anything.
    cpSync(join(target, "skill-a"), join(target, "skill-a-custom"), { recursive: true });
    rmSync(join(source, "skill-a"), { recursive: true });
    const report = syncSmartReadSkills({ sourceDir: source, targetDir: target, version: "1.0.0" });
    expect(report.removed).toEqual(["skill-a"]);
    expect(report.removed).not.toContain("skill-a-custom");
    expect(existsSync(join(target, "skill-a-custom", "SKILL.md"))).toBe(true);
  });

  it("restores the old dir when moving the staged dir into place fails", () => {
    const source = makeSource({ "skill-a": SKILL_A });
    const target = makeTarget();
    syncSmartReadSkills({ sourceDir: source, targetDir: target, version: "1.0.0" });
    writeFileSync(join(source, "skill-a", "SKILL.md"), `${SKILL_A}\nMore docs.\n`);
    let renames = 0;
    const report = syncSmartReadSkills({
      sourceDir: source,
      targetDir: target,
      version: "1.1.0",
      fs: {
        renameSync: ((from: string, to: string) => {
          renames += 1;
          // Fail only the move-into-place (second rename); the move-aside
          // and the restore must go through the real fs.
          if (renames === 2) throw new Error("injected move-into-place failure");
          realRenameSync(from, to);
        }) as typeof realRenameSync,
      },
    });
    expect(report.updated).toEqual([]);
    expect(report.errors).toHaveLength(1);
    // The skill is never left missing: old content intact, no aside leftovers.
    expect(readFileSync(join(target, "skill-a", "SKILL.md"), "utf-8")).toBe(SKILL_A);
    expect(readdirSync(target).sort()).toEqual(["skill-a"]);
  });

  it("never deletes a pre-existing aside path it did not create", () => {
    const source = makeSource({ "skill-a": SKILL_A });
    const target = makeTarget();
    syncSmartReadSkills({ sourceDir: source, targetDir: target, version: "1.0.0" });
    // Decoys matching the legacy aside name and the aside prefix.
    const legacyAside = join(target, `skill-a.smartread-old-${process.pid}`);
    mkdirSync(legacyAside, { recursive: true });
    writeFileSync(join(legacyAside, "SENTINEL.md"), "user data\n");
    const prefixDecoy = join(target, ".smartread-old-decoy");
    mkdirSync(prefixDecoy, { recursive: true });
    writeFileSync(join(prefixDecoy, "SENTINEL.md"), "user data\n");
    writeFileSync(join(source, "skill-a", "SKILL.md"), `${SKILL_A}\nMore docs.\n`);
    const report = syncSmartReadSkills({ sourceDir: source, targetDir: target, version: "1.1.0" });
    expect(report.updated).toEqual(["skill-a"]);
    expect(report.errors).toEqual([]);
    expect(readFileSync(join(legacyAside, "SENTINEL.md"), "utf-8")).toBe("user data\n");
    expect(readFileSync(join(prefixDecoy, "SENTINEL.md"), "utf-8")).toBe("user data\n");
  });

  it("emits a notice when the sync reports errors", async () => {
    resetSkillSyncForTests();
    try {
      // Point the agent dir at a regular file so the skills target is unusable.
      const agentFile = join(tmpdir(), `smartread-agent-file-${process.pid}-${Date.now()}`);
      writeFileSync(agentFile, "not a dir\n");
      roots.push(agentFile);
      vi.stubEnv("PI_CODING_AGENT_DIR", agentFile);
      const notify = vi.fn();
      let handler: ((event: unknown, ctx: unknown) => void) | undefined;
      registerSkillSync({
        on: (_event: string, cb: (event: unknown, ctx: unknown) => void) => {
          handler = cb;
        },
      } as never);
      expect(handler).toBeDefined();
      handler?.({}, { ui: { notify } });
      await vi.waitFor(() => {
        expect(notify).toHaveBeenCalledTimes(1);
      });
      expect(String(notify.mock.calls[0]?.[0])).toMatch(/error/i);
    } finally {
      vi.unstubAllEnvs();
      resetSkillSyncForTests();
    }
  });

  it("follows a symlinked target root once instead of refusing", () => {
    const source = makeSource({ "skill-a": SKILL_A });
    const real = mkdtempSync(join(tmpdir(), "smartread-skill-real-"));
    roots.push(real);
    const link = join(tmpdir(), `smartread-skill-link-${process.pid}-${Date.now()}`);
    symlinkSync(real, link);
    roots.push(link);
    const report = syncSmartReadSkills({ sourceDir: source, targetDir: link, version: "1.0.0" });
    expect(report.errors).toEqual([]);
    expect(report.installed).toEqual(["skill-a"]);
    // The follow is recorded; the skill lands in the real dir.
    expect(report.canonicalTarget).toBe(realpathSync(real));
    expect(readFileSync(join(real, "skill-a", "SKILL.md"), "utf-8")).toContain("skill-a");
    rmSync(link, { force: true });
  });

  it("a root symlink swap after realpath capture cannot redirect removal", () => {
    const source = makeSource({ "skill-a": SKILL_A });
    const real = mkdtempSync(join(tmpdir(), "smartread-skill-real-"));
    roots.push(real);
    const target = join(real, "skills");
    syncSmartReadSkills({ sourceDir: source, targetDir: target, version: "1.0.0" });
    // Drop the skill from the source so this sync takes the removal path.
    rmSync(join(source, "skill-a"), { recursive: true });
    const other = mkdtempSync(join(tmpdir(), "smartread-skill-other-"));
    roots.push(other);
    writeFileSync(join(other, "SENTINEL.md"), "user data\n");
    const link = join(tmpdir(), `smartread-skill-swap-${process.pid}-${Date.now()}`);
    symlinkSync(target, link);
    roots.push(link);
    const report = syncSmartReadSkills({
      sourceDir: source,
      targetDir: link,
      version: "1.0.0",
      fs: {
        realpathSync: ((p: string) => {
          const canonical = realpathSync(p);
          // Attack: swap the configured root for a symlink to another dir
          // after the one-time realpath capture.
          rmSync(link, { force: true });
          symlinkSync(other, link);
          return canonical;
        }) as typeof realpathSync,
      },
    });
    expect(report.removed).toEqual(["skill-a"]);
    expect(report.errors).toEqual([]);
    // The other dir is untouched; removal happened under the canonical root.
    expect(readdirSync(other)).toEqual(["SENTINEL.md"]);
    expect(readFileSync(join(other, "SENTINEL.md"), "utf-8")).toBe("user data\n");
    expect(existsSync(join(target, "skill-a"))).toBe(false);
    rmSync(link, { force: true });
  });

  it("does nothing when opted out via PI_SMARTREAD_SKILL_SYNC=0", () => {
    const source = makeSource({ "skill-a": SKILL_A });
    const target = makeTarget();
    process.env.PI_SMARTREAD_SKILL_SYNC = "0";
    const report = syncSmartReadSkills({ sourceDir: source, targetDir: target, version: "1.0.0" });
    expect(report).toEqual({
      installed: [],
      updated: [],
      removed: [],
      skippedUnmanaged: [],
      skippedModified: [],
      unchanged: [],
      errors: [],
    });
  });

  it("dry-run reports without writing", () => {
    const source = makeSource({ "skill-a": SKILL_A });
    const target = makeTarget();
    const report = syncSmartReadSkills({
      sourceDir: source,
      targetDir: target,
      version: "1.0.0",
      dryRun: true,
    });
    expect(report.installed).toEqual(["skill-a"]);
  });

  it("resolves the default target under the agent dir", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", join(tmpdir(), "custom-agent-dir"));
    expect(resolveDefaultSkillsTargetDir()).toBe(join(tmpdir(), "custom-agent-dir", "skills"));
    vi.unstubAllEnvs();
    expect(resolveDefaultSkillsTargetDir()).toBe(join(homedir(), ".pi", "agent", "skills"));
  });
});
