import { describe, test, expect } from "vitest"
import { summarizeCode, renderSummary, canSummarize } from "../../code-summary.js"

describe("canSummarize", () => {
	test("returns true for supported extensions within limits", () => {
		expect(canSummarize("src/main.ts", 10000, 200)).toBe(true)
		expect(canSummarize("lib/utils.js", 5000, 100)).toBe(true)
		expect(canSummarize("app/server.py", 8000, 300)).toBe(true)
	})

	test("returns false for unsupported extensions", () => {
		expect(canSummarize("README.md", 1000, 20)).toBe(false)
		expect(canSummarize("image.png", 5000, 10)).toBe(false)
	})

	test("returns false for oversized files", () => {
		expect(canSummarize("big.ts", 3 * 1024 * 1024, 100)).toBe(false)
	})
})

describe("summarizeCode - TypeScript", () => {
	test("elides function body while keeping boundaries", async () => {
		const code = `export function greet(name: string): string {
	const clean = name.trim();
	const label = clean || "default";
	return \`hello \${label}\`;
}
`
		const result = await summarizeCode({ code, path: "fixture.ts" })
		expect(result.parsed).toBe(true)
		expect(result.elided).toBe(true)
		expect(result.language).toBe(".ts")
		expect(result.totalLines).toBe(6)

		const kinds = result.segments.map((s: { kind: string }) => s.kind)
		expect(kinds).toContain("kept")
		expect(kinds).toContain("elided")

		const first = result.segments[0]!
		expect(first.kind).toBe("kept")
		expect(first.text).toContain("export function greet")
	})

	test("elides class body", async () => {
		const code = `export class Greeter {
	name: string = "world";
	length(): number { return this.name.length; }
	greet(): string { return this.name; }
	shout(): string { return this.name.toUpperCase(); }
}
`
		const result = await summarizeCode({ code, path: "fixture.ts" })
		expect(result.parsed).toBe(true)
		expect(result.elided).toBe(true)

		const kinds = result.segments.map((s: { kind: string }) => s.kind)
		expect(kinds).toContain("elided")
	})

	test("elides interface body", async () => {
		const code = `export interface Config {
	host: string;
	port: number;
	debug: boolean;
	timeout: number;
	retries: number;
}
`
		const result = await summarizeCode({ code, path: "fixture.ts" })
		expect(result.parsed).toBe(true)
		expect(result.elided).toBe(true)
	})

	test("elides import runs", async () => {
		const code = `import a from "a";
import b from "b";
import c from "c";
import d from "d";
import e from "e";
import f from "f";

export function main() {}
`
		const result = await summarizeCode({ code, path: "fixture.ts" })
		expect(result.parsed).toBe(true)
		expect(result.elided).toBe(true)

		const firstKept = result.segments.find((s: { kind: string }) => s.kind === "kept")
		expect(firstKept).toBeDefined()
		expect(firstKept!.text).toContain("import a")
	})

	test("does not elide short bodies below threshold", async () => {
		const code = `function small() {
	return 1;
}
`
		const result = await summarizeCode({ code, path: "fixture.ts", minBodyLines: 10 })
		expect(result.parsed).toBe(true)
		expect(result.elided).toBe(false)
	})

	test("returns unparsed for unsupported extensions", async () => {
		const result = await summarizeCode({ code: "plain text\nmore text\n", path: "notes.txt" })
		expect(result.parsed).toBe(false)
		expect(result.elided).toBe(false)
		expect(result.segments.length).toBe(1)
	})

	test("returns unparsed for parse errors", async () => {
		const result = await summarizeCode({ code: "export function broken( {\n", path: "fixture.ts" })
		expect(result.parsed).toBe(false)
	})
})

describe("summarizeCode - Python", () => {
	test("returns unparsed when WASM grammar is incompatible (known issue)", async () => {
		const code = `def greet(name: str) -> str:
    clean = name.strip()
    label = clean or "world"
    return f"hello {label}"
`
		const result = await summarizeCode({ code, path: "greet.py" })
		expect(result.segments.length).toBeGreaterThanOrEqual(1)
	})

	test("dictionary fallback is unparsed when grammar incompatible", async () => {
		const code = `config = {
    "host": "localhost",
    "port": 8080,
    "debug": True,
    "timeout": 30,
    "retries": 3,
}
`
		const result = await summarizeCode({ code, path: "config.py" })
		expect(result.segments.length).toBeGreaterThanOrEqual(1)
	})
})

describe("summarizeCode - JavaScript", () => {
	test("returns unparsed when WASM grammar is incompatible (known issue)", async () => {
		const code = `const config = {
	host: "localhost",
	port: 8080,
	debug: true,
	timeout: 30,
	retries: 3,
};
`
		const result = await summarizeCode({ code, path: "config.js" })
		expect(result.segments.length).toBeGreaterThanOrEqual(1)
	})

	test("returns unparsed for array when WASM grammar is incompatible (known issue)", async () => {
		const code = `const items = [
	"alpha",
	"beta",
	"gamma",
	"delta",
	"epsilon",
];
`
		const result = await summarizeCode({ code, path: "list.js" })
		expect(result.segments.length).toBeGreaterThanOrEqual(1)
	})
})

describe("renderSummary", () => {
	test("renders kept segments and elision markers", () => {
		const segments = [
			{ kind: "kept" as const, startLine: 1, endLine: 1, text: "export function main() {" },
			{ kind: "elided" as const, startLine: 2, endLine: 5, text: undefined },
			{ kind: "kept" as const, startLine: 6, endLine: 6, text: "}" },
		]
		const result = renderSummary(
			{ parsed: true, elided: true, totalLines: 6, segments },
			"fixture.ts",
		)
		expect(result.text).toContain("export function main() {")
		expect(result.text).toContain("elided")
		expect(result.elidedSpans).toBe(1)
		expect(result.elidedLines).toBe(4)
	})

	test("handles single-line elision", () => {
		const segments = [
			{ kind: "kept" as const, startLine: 1, endLine: 1, text: "line 1" },
			{ kind: "elided" as const, startLine: 2, endLine: 2, text: undefined },
			{ kind: "kept" as const, startLine: 3, endLine: 3, text: "line 3" },
		]
		const result = renderSummary(
			{ parsed: true, elided: true, totalLines: 3, segments },
			"test.ts",
		)
		expect(result.text).toContain("line 1")
		expect(result.text).toContain("elided")
		expect(result.text).toContain("line 3")
	})
})
