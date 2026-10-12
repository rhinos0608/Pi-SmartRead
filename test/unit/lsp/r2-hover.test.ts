import { describe, expect, it } from "vitest";
import {
  extractHoverType,
  type NormalizedHover,
} from "../../../src/lsp/lsp-response-normalizer.js";
import { executeLspOperation, type ExecutorConnection } from "../../../src/lsp/lsp-executor.js";
import { investigateAffordanceTarget } from "../../../src/lsp/affordance-investigate.js";
import type { AffordanceExecContext } from "../../../src/lsp/affordance-contract.js";

function hover(...values: string[]): NormalizedHover {
  return { contents: values.map((value) => ({ kind: "markdown" as const, value })) };
}

describe("extractHoverType", () => {
  it("strips the alias banner prefix but keeps the import line", () => {
    expect(extractHoverType(
      hover("```typescript\n(alias) interface Foo\nimport Foo\n```"),
    )).toBe("interface Foo\nimport Foo");
  });

  it("keeps a const function type after the kind prefix", () => {
    expect(extractHoverType(
      hover("```typescript\n(property) const onClick: (e: MouseEvent) => void\n```"),
    )).toBe("const onClick: (e: MouseEvent) => void");
  });

  it("reads the first overload signature and ignores the overloads note", () => {
    expect(extractHoverType(
      hover(
        "```typescript\n(function) foo(a: string): void\n```",
        "(+2 overloads)",
      ),
    )).toBe("foo(a: string): void");
  });

  it("strips an inline overloads prefix to the signature below it", () => {
    expect(extractHoverType(
      hover("```typescript\n(+3 overloads)\nfoo(a: string): void\n```"),
    )).toBe("foo(a: string): void");
  });

  it("strips the method prefix from class members", () => {
    expect(extractHoverType(
      hover("```typescript\n(method) Server.start(port: number): void\n```"),
    )).toBe("Server.start(port: number): void");
  });

  it("keeps multi-line signatures intact", () => {
    expect(extractHoverType(
      hover("```typescript\nfunction foo(\n  a: string,\n  b: number,\n): void\n```"),
    )).toBe("function foo(\n  a: string,\n  b: number,\n): void");
  });

  it("passes through Python-style hover text", () => {
    expect(extractHoverType(
      hover("```python\ndef connect(dsn: str) -> Connection\n```"),
    )).toBe("def connect(dsn: str) -> Connection");
  });

  it("passes through Go-style hover text", () => {
    expect(extractHoverType(
      hover("```go\nfunc Listen(addr string) error\n```"),
    )).toBe("func Listen(addr string) error");
  });

  it("accepts untagged fences", () => {
    expect(extractHoverType(hover("```\nfoo: number\n```"))).toBe("foo: number");
  });

  it("does not strip a bare parenthesized function type", () => {
    expect(extractHoverType(
      hover("```typescript\n(a: string) => void\n```"),
    )).toBe("(a: string) => void");
  });

  it("omits the field for prose without fences", () => {
    expect(extractHoverType(
      hover("Does things.\n\nMore docs about things."),
    )).toBeNull();
  });

  it("omits the field for an empty fence", () => {
    expect(extractHoverType(hover("```typescript\n```"))).toBeNull();
    expect(extractHoverType({ contents: [] })).toBeNull();
  });

  it("never throws on malformed input", () => {
    expect(extractHoverType(null as unknown as NormalizedHover)).toBeNull();
    expect(extractHoverType({} as unknown as NormalizedHover)).toBeNull();
    expect(extractHoverType({ contents: [{ kind: "markdown", value: 42 }] } as unknown as NormalizedHover)).toBeNull();
  });
});

const ALIAS_RAW = {
  contents: [{ language: "typescript", value: "(alias) interface Foo\nimport Foo" }],
};

function hoverConn(): ExecutorConnection {
  return {
    descriptorId: "ts",
    name: "ts-server",
    languageId: "typescript",
    languageIds: ["typescript"],
    projectRoot: "/repo",
    getNegotiatedEncoding: () => "utf-16",
    getCapabilityRegistry: () => ({ can: () => true }),
    request: async () => ALIAS_RAW,
  };
}

describe("executor r2 hover", () => {
  it("adds the plain-text type alongside unchanged raw contents", async () => {
    const env = await executeLspOperation(
      { operation: "hover", path: "a.ts", position: { line: 0, character: 0 } },
      { getManager: () => ({ getServer: async () => hoverConn() }), cwd: "/repo", r2: true },
    );
    expect(env.status).toBe("ok");
    const result = env.result as { contents: unknown[]; type: string };
    expect(result.contents).toEqual([
      { kind: "markdown", value: "```typescript\n(alias) interface Foo\nimport Foo\n```" },
    ]);
    expect(result.type).toBe("interface Foo\nimport Foo");
  });

  it("leaves the baseline hover result byte-identical", async () => {
    const env = await executeLspOperation(
      { operation: "hover", path: "a.ts", position: { line: 0, character: 0 } },
      { getManager: () => ({ getServer: async () => hoverConn() }), cwd: "/repo" },
    );
    expect(env.status).toBe("ok");
    expect(env.result).toEqual({
      contents: [
        { kind: "markdown", value: "```typescript\n(alias) interface Foo\nimport Foo\n```" },
      ],
    });
    expect(env.result).not.toHaveProperty("type");
  });
});

describe("investigate type in r2", () => {
  function ctxFor(r2: boolean): AffordanceExecContext {
    return {
      root: "/repo",
      budget: { maxCandidates: 100, maxRequests: 6, deadlineMs: 15000 },
      ...(r2 ? { r2: true as const } : {}),
      exec: (async () => ({
        status: "ok",
        operation: "hover",
        method: "textDocument/hover",
        server: { descriptorId: "s", name: "s", languageId: "typescript", projectRoot: "/repo", positionEncoding: "utf-16" as const },
        result: {
          contents: [{ kind: "markdown", value: "```typescript\n(alias) interface Foo\nimport Foo\n```" }],
        },
        meta: { truncated: false },
      })) as AffordanceExecContext["exec"],
    };
  }

  it("adds the type field to the type-task value", async () => {
    const out = await investigateAffordanceTarget(
      { operation: "investigate", task: "type", path: "/repo/a.ts", position: { line: 0, character: 0 } },
      ctxFor(true),
    );
    const result = out.result as { task: string; value: Array<{ type?: string }> };
    expect(result.task).toBe("type");
    expect(result.value[0]!.type).toBe("interface Foo\nimport Foo");
  });

  it("keeps the round-1 type projection without the field", async () => {
    const out = await investigateAffordanceTarget(
      { operation: "investigate", task: "type", path: "/repo/a.ts", position: { line: 0, character: 0 } },
      ctxFor(false),
    );
    const result = out.result as { task: string; value: Array<Record<string, unknown>> };
    expect(result.task).toBe("type");
    expect(result.value[0]).not.toHaveProperty("type");
  });
});
