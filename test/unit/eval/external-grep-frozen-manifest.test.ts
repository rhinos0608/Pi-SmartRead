/**
 * Frozen-manifest runs for the external grep benchmark (gap B):
 * --manifest loads a frozen dev/holdout manifest with integrity verification
 * (fail closed), runs --split dev without re-freezing, and refuses
 * --split holdout unless --open-holdout is also given.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    frozenSplitIds,
    loadFrozenManifest,
} from "../../../scripts/eval/external/grep/frozen-manifest.js";
import {
    buildDevHoldoutManifest,
    type DevHoldoutManifest,
} from "../../../scripts/eval/external/grep/sampling.js";
import type { BenchmarkInstance } from "../../../scripts/eval/external/grep/instance.js";

const tmpRoots: string[] = [];
afterEach(() => {
    for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function synth(id: string, repo: string): BenchmarkInstance {
    return {
        instanceId: id,
        dataset: "swe-bench-multilingual",
        repo,
        baseCommit: "0".repeat(40),
        title: `title ${id}`,
        body: `body ${id}`,
        goldFiles: [`src/${id}.ts`],
        goldHunks: [{ file: `src/${id}.ts`, ranges: [{ start: 1, end: 2 }] }],
        excludedFiles: [],
        language: "ts",
        split: "dev",
        license: "MIT",
    };
}

function manifestFile(manifest: DevHoldoutManifest): string {
    const dir = mkdtempSync(join(tmpdir(), "ext-grep-manifest-"));
    tmpRoots.push(dir);
    const path = join(dir, "external-grep-dev64-holdout32.json");
    writeFileSync(path, JSON.stringify(manifest, null, 2));
    return path;
}

function frozen(): DevHoldoutManifest {
    return buildDevHoldoutManifest({
        seed: "seed",
        datasets: [{ name: "d", revision: "r", license: "l" }],
        pilot: [synth("p-1", "org/pilot")],
        dev: [synth("d-1", "org/dev"), synth("d-2", "org/dev")],
        holdout: [synth("h-1", "org/hold")],
        exclusions: [],
        holdoutRepoNote: "note",
    });
}

describe("loadFrozenManifest", () => {
    it("loads a frozen manifest with verified integrity", () => {
        const path = manifestFile(frozen());
        const loaded = loadFrozenManifest(path);
        expect(loaded.dev.map((d) => d.id)).toEqual(["d-1", "d-2"]);
        expect(loaded.holdout.map((h) => h.id)).toEqual(["h-1"]);
        expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("fails closed on a tampered manifest", () => {
        const tampered = frozen();
        tampered.dev[0]!.baseCommit = "1".repeat(40);
        expect(() => loadFrozenManifest(manifestFile(tampered))).toThrow(/integrity/);
    });

    it("fails closed on a missing file", () => {
        expect(() => loadFrozenManifest(join(tmpdir(), "smartread-no-such-manifest.json")))
            .toThrow(/manifest/);
    });
});

describe("frozenSplitIds", () => {
    it("selects dev ids without re-freezing and without a warning", () => {
        const { ids, holdoutWarning } = frozenSplitIds(frozen(), "dev", { openHoldout: false });
        expect(ids).toEqual(["d-1", "d-2"]);
        expect(holdoutWarning).toBeNull();
    });

    it("refuses holdout without --open-holdout", () => {
        expect(() => frozenSplitIds(frozen(), "holdout", { openHoldout: false }))
            .toThrow(/refuses-holdout.*--open-holdout/);
    });

    it("opens holdout only with an explicit single-use warning", () => {
        const { ids, holdoutWarning } = frozenSplitIds(frozen(), "holdout", { openHoldout: true });
        expect(ids).toEqual(["h-1"]);
        expect(holdoutWarning).toMatch(/single-use/);
    });

    it("rejects unknown splits", () => {
        expect(() => frozenSplitIds(frozen(), "pilot", { openHoldout: false })).toThrow(/--split/);
    });
});
