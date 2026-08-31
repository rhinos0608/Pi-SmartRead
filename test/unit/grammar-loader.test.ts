import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock web-tree-sitter so loadGrammar doesn't need real WASM runtime.
// Real WASM files exist on disk at node_modules/@vscode/tree-sitter-wasm/wasm/.
vi.mock("web-tree-sitter", () => ({
	default: {
		init: vi.fn(async () => {}),
		Language: {
			load: vi.fn(async () => ({ mockLanguage: true })),
		},
	},
}));

import { getSupportedExtensions, loadGrammar, clearGrammarCache, resetParser } from "../../src/grammar-loader.js";

describe("grammar-loader", () => {
	beforeEach(() => {
		clearGrammarCache();
		resetParser();
	});

	it("getSupportedExtensions includes new csharp/php/cpp-alias extensions", () => {
		const exts = getSupportedExtensions();
		for (const ext of [".cs", ".php", ".cc", ".cxx", ".hxx", ".hh"]) {
			expect(exts, `missing ${ext}`).toContain(ext);
		}
		// Also still includes originals
		for (const ext of [".ts", ".js", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp", ".rb", ".css", ".sh"]) {
			expect(exts).toContain(ext);
		}
	});

	it("loadGrammar resolves correct WASM filename for new extensions", async () => {
		const cases: Array<[string, string]> = [
			[".cs", "tree-sitter-c-sharp.wasm"],
			[".php", "tree-sitter-php.wasm"],
			[".cc", "tree-sitter-cpp.wasm"],
			[".cxx", "tree-sitter-cpp.wasm"],
			[".hxx", "tree-sitter-cpp.wasm"],
			[".hh", "tree-sitter-cpp.wasm"],
		];
		for (const [ext, wasmFile] of cases) {
			const info = await loadGrammar(ext);
			expect(info, `loadGrammar(${ext}) should succeed`).not.toBeNull();
			expect(info!.wasmFile).toBe(wasmFile);
			expect(info!.extension).toBe(ext);
			clearGrammarCache();
			resetParser();
		}
	});

	it("loadGrammar still resolves original cpp extensions correctly", async () => {
		for (const ext of [".cpp", ".hpp"]) {
			const info = await loadGrammar(ext);
			expect(info).not.toBeNull();
			expect(info!.wasmFile).toBe("tree-sitter-cpp.wasm");
			clearGrammarCache();
			resetParser();
		}
	});

	it("loadGrammar returns null for unsupported extensions", async () => {
		expect(await loadGrammar(".ini")).toBeNull();
		expect(await loadGrammar(".ps1")).toBeNull();
		expect(await loadGrammar(".md")).toBeNull();
		expect(await loadGrammar(".unknown")).toBeNull();
	});

	it("does NOT add ini/powershell/regex mappings", () => {
		const exts = getSupportedExtensions();
		expect(exts).not.toContain(".ini");
		expect(exts).not.toContain(".ps1");
		expect(exts).not.toContain(".psm1");
	});

	// Outline consistency: ast-outline EXT_KINDS should support same new extensions
	it("outline supports new extensions via grammar-loader parity", async () => {
		const { outlineSupportsPath } = await import("../../src/ast-outline.js");
		for (const ext of [".cs", ".php", ".cc", ".cxx", ".hh", ".hxx"]) {
			expect(outlineSupportsPath(`foo${ext}`), `outline should support ${ext}`).toBe(true);
		}
		// ini/powershell/regex should NOT be supported as outline
		expect(outlineSupportsPath("foo.ini")).toBe(false);
		expect(outlineSupportsPath("foo.ps1")).toBe(false);
	});
});
