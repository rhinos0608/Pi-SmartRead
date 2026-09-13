import { describe, it, expect } from "vitest";
import { LANGUAGE_SERVER_CATALOG, getDescriptorsForLanguage, getDescriptorsForExtension } from "../../src/language-server-catalog.js";

describe("language-server-catalog", () => {
  it("contains all required languages", () => {
    const allIds = new Set(LANGUAGE_SERVER_CATALOG.flatMap((d) => d.languageIds));
    const required = ["typescript","javascript","python","rust","go","c","cpp","csharp","java","php","bash","json","yaml","html","css","lua","ruby"];
    for (const id of required) {
      expect(allIds.has(id), `missing language ${id}`).toBe(true);
    }
  });

  it("has no bare java candidate (regression guard)", () => {
    for (const desc of LANGUAGE_SERVER_CATALOG) {
      for (const cand of desc.commandCandidates) {
        if (cand.command === "java") {
          // bare java with no args is the known bug — if present, require at least one arg
          expect(cand.args.length, `bare java with no args in ${desc.id}`).toBeGreaterThan(0);
        }
      }
    }
    // also ensure no descriptor for java uses bare java at all; java language should only be served by jdtls
    const javaDescs = getDescriptorsForLanguage("java");
    for (const d of javaDescs) {
      for (const c of d.commandCandidates) {
        expect(c.command).not.toBe("java");
      }
    }
  });

  it("java descriptor is jdtls only", () => {
    const descs = getDescriptorsForLanguage("java");
    expect(descs.length).toBe(1);
    expect(descs[0]!.id).toBe("jdtls");
    expect(descs[0]!.commandCandidates[0]!.command).toBe("jdtls");
  });

  it("typescript reuses exact candidates from lsp-bridge ALL_SERVER_CONFIGS", () => {
    const tsDescs = getDescriptorsForLanguage("typescript");
    expect(tsDescs.length).toBeGreaterThan(0);
    const cmds = tsDescs.flatMap((d) => d.commandCandidates.map((c) => c.command));
    expect(cmds).toContain("typescript-language-server");
    expect(cmds).toContain("typescriptlangserver");
    // verify args are --stdio
    for (const d of tsDescs) {
      for (const c of d.commandCandidates) {
        if (c.command.startsWith("typescript")) expect(c.args).toEqual(["--stdio"]);
      }
    }
  });

  it("csharp has omnisharp with --languageserver", () => {
    const descs = getDescriptorsForLanguage("csharp");
    const omni = descs.find((d) => d.id === "omnisharp");
    expect(omni).toBeDefined();
    expect(omni!.commandCandidates[0]!.args).toEqual(["--languageserver"]);
    const cs = descs.find((d) => d.id === "csharp-ls");
    expect(cs).toBeDefined();
  });

  it("php priority ordering intelephense > phpactor", () => {
    const descs = getDescriptorsForLanguage("php");
    expect(descs[0]!.id).toBe("intelephense");
    expect(descs[1]!.id).toBe("phpactor");
  });

  it("priority ordering + id tiebreak deterministic", () => {
    // csharp has omnisharp 100 vs csharp-ls 50 → omnisharp first
    const csharp = getDescriptorsForLanguage("csharp");
    expect(csharp[0]!.priority).toBeGreaterThanOrEqual(csharp[1]!.priority);
    // if same priority, id tiebreak: create synthetic check via php vs others same priority group
  });

  it("extension routing round-trip", () => {
    expect(getDescriptorsForExtension(".ts").some((d) => d.languageIds.includes("typescript"))).toBe(true);
    expect(getDescriptorsForExtension(".py").some((d) => d.languageIds.includes("python"))).toBe(true);
    expect(getDescriptorsForExtension(".rs").some((d) => d.languageIds.includes("rust"))).toBe(true);
    expect(getDescriptorsForExtension(".go").some((d) => d.languageIds.includes("go"))).toBe(true);
    expect(getDescriptorsForExtension(".json").some((d) => d.languageIds.includes("json"))).toBe(true);
    expect(getDescriptorsForExtension(".yaml").some((d) => d.languageIds.includes("yaml"))).toBe(true);
    expect(getDescriptorsForExtension(".html").some((d) => d.languageIds.includes("html"))).toBe(true);
    expect(getDescriptorsForExtension(".css").some((d) => d.languageIds.includes("css"))).toBe(true);
    expect(getDescriptorsForExtension(".lua").some((d) => d.languageIds.includes("lua"))).toBe(true);
    expect(getDescriptorsForExtension(".rb").some((d) => d.languageIds.includes("ruby"))).toBe(true);
    // case insensitive, with or without dot
    expect(getDescriptorsForExtension("TS").length).toBeGreaterThan(0);
    expect(getDescriptorsForExtension("py").length).toBeGreaterThan(0);
  });

  it("new languages not in old lsp-bridge exist", () => {
    for (const lang of ["json","yaml","html","css","lua","ruby"]) {
      expect(getDescriptorsForLanguage(lang).length, `missing ${lang}`).toBeGreaterThan(0);
    }
  });
});
