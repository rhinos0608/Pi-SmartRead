import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJudgeSettings, writeJudgeSettings } from "../../../src/judge/judge-settings.js";

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

describe("judge-settings", () => {
    it("defaults to off when missing", () => {
        const home = mkdtempSync(join(tmpdir(), "judge-settings-"));
        expect(readJudgeSettings(home).mode).toBe("off");
    });

    it("tolerates corrupt content", () => {
        const home = mkdtempSync(join(tmpdir(), "judge-settings-"));
        const dir = join(home, ".pi", "agent");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "smartread-judge.json"), "{oops", "utf-8");
        expect(readJudgeSettings(home).mode).toBe("off");
    });

    it("writes atomically with no tmp residue", () => {
        const home = mkdtempSync(join(tmpdir(), "judge-settings-"));
        const next = writeJudgeSettings("cloud", home);
        expect(next.mode).toBe("cloud");
        const p = join(home, ".pi", "agent", "smartread-judge.json");
        expect(existsSync(p)).toBe(true);
        expect(JSON.parse(readFileSync(p, "utf-8")).mode).toBe("cloud");
        expect(readJudgeSettings(home).mode).toBe("cloud");
    });

    it("resolves the settings directory from PI_CODING_AGENT_DIR when set", () => {
        const home = mkdtempSync(join(tmpdir(), "judge-settings-home-"));
        const agentDir = mkdtempSync(join(tmpdir(), "judge-agentdir-"));
        process.env.PI_CODING_AGENT_DIR = agentDir;
        writeJudgeSettings("local", home);
        expect(existsSync(join(agentDir, "smartread-judge.json"))).toBe(true);
        expect(existsSync(join(home, ".pi", "agent", "smartread-judge.json"))).toBe(false);
        expect(readJudgeSettings(home).mode).toBe("local");
    });
});
