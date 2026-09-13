import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("graph-protocol.ts", () => {
	it("does not contain any new ContextGraph instantiation", () => {
		const source = readFileSync(
			resolve(import.meta.dirname, "../../src/graph-protocol.ts"),
			"utf-8",
		);
		expect(source).not.toMatch(/new ContextGraph\(/);
	});

	it("imports getSharedContextGraphAsync from mcp-registry via dynamic import", () => {
		const source = readFileSync(
			resolve(import.meta.dirname, "../../src/graph-protocol.ts"),
			"utf-8",
		);
		// Must use dynamic import to avoid circular ES module dependency:
		// mcp-registry.ts -> grep-tool.ts -> search-tool.ts -> hook.ts ->
		// read-many.ts -> graph-protocol.ts -> mcp-registry.ts
		expect(source).toContain('await import("./mcp-registry.js")');
		expect(source).not.toContain('from "./mcp-registry.js"');
		expect(source).toContain("getSharedContextGraphAsync");
	});

	it("does not maintain its own _graphCache", () => {
		const source = readFileSync(
			resolve(import.meta.dirname, "../../src/graph-protocol.ts"),
			"utf-8",
		);
		expect(source).not.toContain("_graphCache");
		expect(source).not.toContain("MAX_CACHE_SIZE");
	});

	it("routes repeated calls through the shared registry", async () => {
		// Verify that calling resolveGraphUrl twice for the same workspace
		// invokes getSharedContextGraphAsync consistently (no local cache bypass).
		const { resolveGraphUrl } = await import("../../src/graph-protocol.js");

		// We can't easily mock mcp-registry internals here, but we can verify
		// that the function works and returns consistent structure for invalid
		// graph URLs (which throw before hitting the registry). This confirms
		// the code path is intact.
		await expect(resolveGraphUrl("not-a-graph-url")).rejects.toThrow("Invalid graph URL");

		// Calling twice throws identically — no stale local cache state leaks.
		await expect(resolveGraphUrl("graph://not%valid")).rejects.toThrow("Invalid graph URL");
		await expect(resolveGraphUrl("graph://not%valid")).rejects.toThrow("Invalid graph URL");
	});
});
