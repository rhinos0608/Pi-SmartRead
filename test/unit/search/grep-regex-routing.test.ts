/**
 * Grep regex-routing tests (TDD for auto-regex fix).
 *
 * Natural-language prose with parentheses or isolated .* must reach the
 * smart cascade; compact regex syntax must still auto-route to regex;
 * the forced `regex` param must be strict with no silent fallback.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepTool } from "../../../src/search/grep-tool.js";
import { disposeSemanticIndexes } from "../../../src/indexing/semantic-index-registry.js";
import { makeCtx, makeOpts, seedStandardWorkdir } from "../../helpers/grep-tool-fixtures.js";

let workdir: string;

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "grep-regex-routing-")));
    seedStandardWorkdir(workdir);
    writeFileSync(
        join(workdir, "src", "login.ts"),
        [
            "export function handleLogin(req: Request) { return handleAuth(req); }",
            "export function handleAuth(req: Request) { return true; }",
        ].join("\n"),
        "utf8",
    );
});

afterEach(() => {
    disposeSemanticIndexes();
    rmSync(workdir, { recursive: true, force: true });
});

async function run(params: Record<string, unknown>) {
    const result = await createGrepTool(makeOpts()).execute(
        "t-routing",
        params as any,
        undefined,
        undefined,
        makeCtx(workdir),
    );
    return {
        text: (result.content[0] as { text: string }).text,
        details: result.details as any,
    };
}

describe("grep regex routing — prose stays smart", () => {
    it("full issue body with parenthetical and isolated .* reaches the smart cascade", async () => {
        const body = [
            "Login fails when the token expires",
            "",
            "Calling handleLogin (the main entry point) returns null instead of retrying.",
            "The token .* should be refreshed before giving up.",
        ].join("\n");
        const { details, text } = await run({ pattern: body });
        expect(details.engines).not.toContain("regex");
        expect(details.routing.mode).toBe("smart");
        // Fixture hits: smart cascade must find handleLogin/handleAuth content.
        expect(details.totalHits).toBeGreaterThan(0);
        expect(text).toContain("src/login.ts");
    });

    it("one-line parenthesised prose reaches the smart cascade", async () => {
        const { details } = await run({ pattern: "handleLogin (the main entry point) returns null" });
        expect(details.engines).not.toContain("regex");
        expect(details.routing.mode).toBe("smart");
        expect(details.routing.reason).toMatch(/prose_group/);
    });

    it("multi-word prose with isolated .* is ambiguous, not regex", async () => {
        const { details } = await run({ pattern: "the token .* should be refreshed" });
        expect(details.engines).not.toContain("regex");
        expect(details.routing.mode).toBe("smart");
    });
});

describe("grep regex routing — compact syntax stays regex", () => {
    it.each([
        "^export ",
        "(group)",
        "foo(bar|baz)",
        "handle(Auth|Login)",
        "foo\\dbar",
        "foo.*bar",
        "foo.+bar",
        "foo[abc]",
        "a{2}",
    ])("auto-routes %s to regex", async (pattern) => {
        const { details } = await run({ pattern, path: "src/login.ts" });
        expect(details.engines).toContain("regex");
        expect(details.routing.mode).toBe("regex");
        expect(details.routing.reason).toBe("auto_regex");
    });

    it("forced regex with zero matches stays zero (no fallback)", async () => {
        const { details } = await run({ pattern: "zzz_no_match_xyz", regex: true });
        expect(details.totalHits).toBe(0);
        expect(details.engines).toEqual(["regex"]);
        expect(details.routing.mode).toBe("regex");
    });

    it("forced invalid regex is a caller error", async () => {
        await expect(run({ pattern: "foo((", regex: true })).rejects.toThrow();
    });

    it("regex+literal conflict is a caller error", async () => {
        await expect(run({ pattern: "foo", regex: true, literal: true })).rejects.toThrow();
    });

    it("literal:true alone forces substring", async () => {
        const { details } = await run({ pattern: "browser|registerTool", literal: true });
        expect(details.engines).toEqual(["lexical"]);
        expect(details.routing.mode).toBe("literal");
        expect(details.routing.reason).toBe("forced_literal");
    });
});

describe("grep regex routing — bracketed prose prefixes stay smart", () => {
    it("issue-title prose with a bracket prefix is text, not a character class", async () => {
        const { details } = await run({ pattern: "[Bug]: login fails when token expires" });
        expect(details.routing.mode).toBe("smart");
        expect(details.routing.reason).toBe("auto_declined_prose_class");
        expect(details.engines).not.toContain("regex");
    });

    it("compact bracket syntax still auto-routes to regex", async () => {
        for (const pattern of ["foo[0-9]+", "[A-Z]\\w+"]) {
            const { details } = await run({ pattern, path: "src/login.ts" });
            expect(details.routing.mode).toBe("regex");
            expect(details.routing.reason).toBe("auto_regex");
            expect(details.engines).toContain("regex");
        }
    });

    it("regex:true still forces bracketed prose to regex", async () => {
        const { details } = await run({ pattern: "[Bug]: login fails when token expires", regex: true });
        expect(details.routing.mode).toBe("regex");
        expect(details.routing.reason).toBe("forced_regex");
    });
});

describe("grep regex routing — terminal anchor backslash parity", () => {
    it("escaped terminal $ (odd backslashes) stays smart", async () => {
        const { details } = await run({ pattern: "foo\\$", path: "src/login.ts" });
        expect(details.routing.mode).toBe("smart");
        expect(details.engines).not.toContain("regex");
    });

    it("escaped backslash then anchor (even backslashes) routes to regex", async () => {
        const { details } = await run({ pattern: "foo\\\\$", path: "src/login.ts" });
        expect(details.routing.mode).toBe("regex");
        expect(details.engines).toContain("regex");
    });

    it("leading ^ is an anchor and routes to regex", async () => {
        const { details } = await run({ pattern: "^foo", path: "src/login.ts" });
        expect(details.routing.mode).toBe("regex");
    });
});

describe("grep regex routing — routing-note rendering (D22)", () => {
    it("plain NL smart routing renders no note but keeps routing details", async () => {
        const { details, text } = await run({ pattern: "login fails when token expires" });
        expect(details.routing.mode).toBe("smart");
        expect(details.routing.reason).toBe("auto_literal");
        expect(details.routing.note).toBeUndefined();
        expect(text).not.toMatch(/No regex syntax detected/);
    });

    it("declined apparent regex syntax still renders a note", async () => {
        const { details, text } = await run({ pattern: "handleLogin (the main entry point) returns null" });
        expect(details.routing.mode).toBe("smart");
        expect(details.routing.reason).toMatch(/auto_declined_/);
        expect(typeof details.routing.note).toBe("string");
        expect(text).toMatch(/auto-detect declined/);
    });
});

describe("grep regex routing — auto-regex zero-hit fallback to smart cascade (C1)", () => {
    const NL_WITH_ASIDE = "token validation fails when the header is missing (SSR)";

    it("NL query with a parenthesised aside falls back to the smart cascade", async () => {
        const { details, text } = await run({ pattern: NL_WITH_ASIDE });
        expect(details.routing.mode).toBe("smart");
        expect(details.routing.reason).toBe("auto_regex_fallback");
        expect(details.totalHits).toBeGreaterThan(0);
        expect(text).toContain("regex auto-route found nothing; showing smart-cascade results");
    });

    it("explicit regex:true never falls back", async () => {
        const { details, text } = await run({ pattern: NL_WITH_ASIDE, regex: true });
        expect(details.routing.mode).toBe("regex");
        expect(details.routing.reason).toBe("forced_regex");
        expect(details.totalHits).toBe(0);
        expect(text).not.toContain("smart-cascade results");
    });

    it("explicit literal:true never falls back", async () => {
        const { details, text } = await run({ pattern: NL_WITH_ASIDE, literal: true });
        expect(details.routing.mode).toBe("literal");
        expect(details.totalHits).toBe(0);
        expect(text).not.toContain("smart-cascade results");
    });

    it("single-token compact regex with zero hits does not fall back", async () => {
        const { details } = await run({ pattern: "zzz.*qqq", path: "src/login.ts" });
        expect(details.routing.mode).toBe("regex");
        expect(details.routing.reason).toBe("auto_regex");
        expect(details.totalHits).toBe(0);
    });
});

describe("grep regex routing — surface", () => {
    it("single details identify routing and declined syntax renders a note", async () => {
        const { details, text } = await run({ pattern: "handleLogin (the main entry point) returns null" });
        expect(details.routing.mode).toBe("smart");
        expect(typeof details.routing.reason).toBe("string");
        expect(text).toMatch(/literal|regex|smart|auto-detect/i);
    });

    it("batch details and output expose per-query routing", async () => {
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t-batch-routing",
            {
                queries: [
                    { pattern: "handleLogin (the main entry point)" },
                    { pattern: "^export " },
                ],
            } as any,
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const details = result.details as any;
        expect(details.queryResults).toHaveLength(2);
        expect(details.queryResults[0].routing.mode).toBe("smart");
        expect(details.queryResults[1].routing.mode).toBe("regex");
        const text = (result.content[0] as { text: string }).text;
        expect(text).toMatch(/regex|literal|smart/i);
    });
});
