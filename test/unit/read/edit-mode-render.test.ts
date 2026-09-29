import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ensureHashlineReady,
  formatContentBlock,
  prefixLinesForEditMode,
  prefixLinesWithAnchors,
  stripHashlineAnchors,
} from "../../../src/utils.js";
import { applyTextEnrichment } from "../../../src/read/hook-enrich.js";
import { createReadManyTool } from "../../../src/read/read-many.js";
import { createActivationState } from "../../../src/extension-lifecycle.js";

beforeAll(async () => {
  await ensureHashlineReady();
});

describe("edit-mode render: prefixLinesForEditMode", () => {
  it("text mode renders N| prefixes with correct start offsets", () => {
    expect(prefixLinesForEditMode("a\nb", 20, "text")).toBe("20|a\n21|b");
    expect(prefixLinesForEditMode("only", 1, "text")).toBe("1|only");
  });

  it("hashline mode is byte-identical to prefixLinesWithAnchors", () => {
    const body = "alpha\nbeta\ngamma";
    expect(prefixLinesForEditMode(body, 5, "hashline")).toBe(prefixLinesWithAnchors(body, 5));
    expect(prefixLinesForEditMode(body, 1, "hashline")).toBe(prefixLinesWithAnchors(body, 1));
  });

  it("defaults to hashline rendering", () => {
    const body = "x\ny";
    expect(prefixLinesForEditMode(body, 1)).toBe(prefixLinesWithAnchors(body, 1));
  });
});

describe("edit-mode render: stripHashlineAnchors pins both dialects", () => {
  it("strips text N| prefixes", () => {
    expect(stripHashlineAnchors("20|a\n21|b")).toBe("a\nb");
  });

  it("strips hashline Nab| prefixes", () => {
    expect(stripHashlineAnchors("20ab|a\n21cd|b")).toBe("a\nb");
  });
});

describe("edit-mode render: formatContentBlock", () => {
  it("text mode renders N| body with start offset", () => {
    const block = formatContentBlock("/tmp/file.txt", "line 20\nline 21", 3, {
      startLine: 20,
      editMode: "text",
    });
    const bodyLines = block.split("\n").slice(2, -1);
    expect(bodyLines).toEqual(["20|line 20", "21|line 21"]);
  });

  it("hashline mode stays byte-identical to the default", () => {
    const body = "line 20\nline 21";
    const opts = { startLine: 20 } as const;
    expect(formatContentBlock("/tmp/file.txt", body, 3, { ...opts, editMode: "hashline" })).toBe(
      formatContentBlock("/tmp/file.txt", body, 3, opts),
    );
  });
});

describe("edit-mode render: applyTextEnrichment", () => {
  it("text mode anchors with N| prefixes", () => {
    const result = { content: [{ type: "text", text: "a\nb" }], details: {} };
    applyTextEnrichment(result, 7, [], "text");
    expect(result.content[0]!.text).toBe("7|a\n8|b");
  });

  it("hashline mode matches prefixLinesWithAnchors", () => {
    const result = { content: [{ type: "text", text: "a\nb" }], details: {} };
    applyTextEnrichment(result, 7, [], "hashline");
    expect(result.content[0]!.text).toBe(prefixLinesWithAnchors("a\nb", 7));
  });

  it("skips anchoring when content already carries N| prefixes", () => {
    const result = { content: [{ type: "text", text: "7|a\n8|b" }], details: {} };
    applyTextEnrichment(result, 7, [], "text");
    expect(result.content[0]!.text).toBe("7|a\n8|b");
  });
});

describe("edit-mode render: read-many batch path follows the mode", () => {
  function stubBatchTool(opts: { editMode?: "text" | "hashline" } = {}) {
    const readTool = {
      execute: async () => ({
        content: [{ type: "text", text: "a\nb" }],
        details: { displayContent: { text: "a\nb", startLine: 1 } },
      }),
    };
    return createReadManyTool(() => readTool as any, opts);
  }

  async function runStubBatch(editModeOpts: { editMode?: "text" | "hashline" }, callId: string): Promise<string> {
    const result = await stubBatchTool(editModeOpts).execute(
      callId,
      { files: [{ path: "/a.txt" }] },
      undefined,
      undefined,
      { cwd: "/" } as any,
    );
    return (result.content[0] as any).text as string;
  }

  it("text mode renders N| prefixes", async () => {
    expect(await runStubBatch({ editMode: "text" }, "call-text")).toContain("\n1|a\n2|b\n");
  });

  it("default (hashline) output keeps Nab| anchors", async () => {
    expect(await runStubBatch({}, "call-hash")).toMatch(/\n1[a-z]{2}\|a\n2[a-z]{2}\|b\n/);
  });
});

describe("edit-mode render: activation resolves the mode once", () => {
  const ENV_KEYS = ["PI_EDIT_MODE", "SMART_EDIT_USE_HASHLINE_EDITING", "SMART_EDIT_HASHLINE_EXPERIMENTAL"];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults to text when no env is set", () => {
    expect(createActivationState().editMode).toBe("text");
  });

  it("honours PI_EDIT_MODE=hashline", () => {
    process.env.PI_EDIT_MODE = "hashline";
    expect(createActivationState().editMode).toBe("hashline");
  });

  it("honours PI_EDIT_MODE=text", () => {
    process.env.PI_EDIT_MODE = "text";
    expect(createActivationState().editMode).toBe("text");
  });
});
