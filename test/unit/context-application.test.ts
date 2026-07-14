/**
 * Tests for context-application.ts — safety feature that replaces stale
 * tool results with placeholders in the context window before sending to LLM.
 */
import { describe, expect, it } from "vitest";
import {
  applyContextHygieneStaleContext,
} from "../../src/context-application.js";
import {
  buildStaleContextRecord,
  buildRetiredContextRecord,
  type ContextHygieneReport,
} from "../../src/context-hygiene.js";

describe("applyContextHygieneStaleContext", () => {
  describe("returns unchanged messages when no stale/retired records", () => {
    it("returns original messages array when empty", () => {
      const messages: any[] = [];
      const report: ContextHygieneReport = {
        eventCount: 0,
        resourceCount: 0,
        readReuse: [],
        mutationAfterRead: [],
        staleCandidates: [],
        retirementCandidates: [],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      expect(result).toBe(messages);
    });

    it("returns original messages when no stale candidates in report", () => {
      const messages = [
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
        },
      ];
      const report: ContextHygieneReport = {
        eventCount: 1,
        resourceCount: 1,
        readReuse: [],
        mutationAfterRead: [],
        staleCandidates: [],
        retirementCandidates: [],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      expect(result).toBe(messages);
      expect(result[0]!.content[0]!.text).toBe("file contents");
    });

    it("returns original messages when stale candidate has no originalResultId", () => {
      const messages = [
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
        },
      ];
      const report: ContextHygieneReport = {
        eventCount: 1,
        resourceCount: 1,
        readReuse: [],
        mutationAfterRead: [],
        staleCandidates: [
          {
            resourceKey: "file:/project/src/foo.ts",
            staleEventIds: [1],
            mutationEventId: 2,
            reason: "mutation-after-read",
            staleResults: [
              buildStaleContextRecord({
                originalTool: "read",
                staleResourceKeys: ["file:/project/src/foo.ts"],
                invalidatingMutationEventId: 2,
                // No originalResultId set
              }),
            ],
          },
        ],
        retirementCandidates: [],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      // Should fall back to original since no resultId to match
      expect(result[0]!.content[0]!.text).toBe("file contents");
    });
  });

  describe("masks stale read results", () => {
    it("replaces stale read result content with placeholder", () => {
      const messages = [
        {
          role: "toolResult",
          toolCallId: "call-read-1",
          toolName: "read",
          content: [{ type: "text", text: "original file contents" }],
        },
      ];
      const report: ContextHygieneReport = {
        eventCount: 2,
        resourceCount: 1,
        readReuse: [],
        mutationAfterRead: [
          { resourceKey: "file:/project/src/foo.ts", readEventIds: [1], mutationEventId: 2 },
        ],
        staleCandidates: [
          {
            resourceKey: "file:/project/src/foo.ts",
            staleEventIds: [1],
            mutationEventId: 2,
            reason: "mutation-after-read",
            staleResults: [
              buildStaleContextRecord({
                originalTool: "read",
                originalResultId: "call-read-1",
                staleResourceKeys: ["file:/project/src/foo.ts"],
                invalidatingMutationEventId: 2,
              }),
            ],
          },
        ],
        retirementCandidates: [],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      expect(result[0]!.content[0]!.text).toContain("Stale");
      expect(result[0]!.content[0]!.text).toContain("changed after this result");
    });

    it("only replaces when toolCallId matches originalResultId", () => {
      const messages = [
        {
          role: "toolResult",
          toolCallId: "call-read-1",
          toolName: "read",
          content: [{ type: "text", text: "original file contents" }],
        },
      ];
      const report: ContextHygieneReport = {
        eventCount: 2,
        resourceCount: 1,
        readReuse: [],
        mutationAfterRead: [],
        staleCandidates: [
          {
            resourceKey: "file:/project/src/foo.ts",
            staleEventIds: [1],
            mutationEventId: 2,
            reason: "mutation-after-read",
            staleResults: [
              buildStaleContextRecord({
                originalTool: "read",
                originalResultId: "call-read-1",
                staleResourceKeys: ["file:/project/src/foo.ts"],
                invalidatingMutationEventId: 2,
              }),
            ],
          },
        ],
        retirementCandidates: [],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      expect(result[0]!.content[0]!.text).toContain("Stale");
    });

    it("checks tool name matches originalTool", () => {
      const messages = [
        {
          role: "toolResult",
          toolCallId: "call-read-1",
          toolName: "read",
          content: [{ type: "text", text: "original file contents" }],
        },
      ];
      // Report says the stale result was for 'grep' but message has toolName='read'
      const report: ContextHygieneReport = {
        eventCount: 2,
        resourceCount: 1,
        readReuse: [],
        mutationAfterRead: [],
        staleCandidates: [
          {
            resourceKey: "file:/project/src/foo.ts",
            staleEventIds: [1],
            mutationEventId: 2,
            reason: "mutation-after-read",
            staleResults: [
              buildStaleContextRecord({
                originalTool: "grep", // Different tool
                originalResultId: "call-read-1",
                staleResourceKeys: ["file:/project/src/foo.ts"],
                invalidatingMutationEventId: 2,
              }),
            ],
          },
        ],
        retirementCandidates: [],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      // Should NOT mask since toolName mismatch
      expect(result[0]!.content[0]!.text).toBe("original file contents");
    });

    it("adds contextHygieneStale to details", () => {
      const messages = [
        {
          role: "toolResult",
          toolCallId: "call-read-1",
          toolName: "read",
          content: [{ type: "text", text: "original file contents" }],
          details: { originalDetail: "preserved" },
        },
      ];
      const report: ContextHygieneReport = {
        eventCount: 2,
        resourceCount: 1,
        readReuse: [],
        mutationAfterRead: [],
        staleCandidates: [
          {
            resourceKey: "file:/project/src/foo.ts",
            staleEventIds: [1],
            mutationEventId: 2,
            reason: "mutation-after-read",
            staleResults: [
              buildStaleContextRecord({
                originalTool: "read",
                originalResultId: "call-read-1",
                staleResourceKeys: ["file:/project/src/foo.ts"],
                invalidatingMutationEventId: 2,
              }),
            ],
          },
        ],
        retirementCandidates: [],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      expect(result[0]!.details).toBeDefined();
      expect((result[0]! as any).details.contextHygieneStale).toBeDefined();
      expect((result[0]! as any).details.originalDetail).toBe("preserved");
    });
  });

  describe("masks stale search/grep results", () => {
    it("replaces stale search result", () => {
      const messages = [
        {
          role: "toolResult",
          toolCallId: "call-search-1",
          toolName: "search",
          content: [{ type: "text", text: "search results" }],
        },
      ];
      const report: ContextHygieneReport = {
        eventCount: 2,
        resourceCount: 1,
        readReuse: [],
        mutationAfterRead: [],
        staleCandidates: [
          {
            resourceKey: "file:/project/src/foo.ts",
            staleEventIds: [1],
            mutationEventId: 2,
            reason: "mutation-after-read",
            staleResults: [
              buildStaleContextRecord({
                originalTool: "search",
                originalResultId: "call-search-1",
                staleResourceKeys: ["file:/project/src/foo.ts"],
                invalidatingMutationEventId: 2,
              }),
            ],
          },
        ],
        retirementCandidates: [],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      expect(result[0]!.content[0]!.text).toContain("Stale");
      expect(result[0]!.content[0]!.text).toContain("grep");
    });

    it("replaces stale grep result", () => {
      const messages = [
        {
          role: "toolResult",
          toolCallId: "call-grep-1",
          toolName: "grep",
          content: [{ type: "text", text: "grep matches" }],
        },
      ];
      const report: ContextHygieneReport = {
        eventCount: 2,
        resourceCount: 1,
        readReuse: [],
        mutationAfterRead: [],
        staleCandidates: [
          {
            resourceKey: "file:/project/src/foo.ts",
            staleEventIds: [1],
            mutationEventId: 2,
            reason: "mutation-after-read",
            staleResults: [
              buildStaleContextRecord({
                originalTool: "grep",
                originalResultId: "call-grep-1",
                staleResourceKeys: ["file:/project/src/foo.ts"],
                invalidatingMutationEventId: 2,
              }),
            ],
          },
        ],
        retirementCandidates: [],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      expect(result[0]!.content[0]!.text).toContain("Stale");
    });
  });

  describe("masks stale SmartRead retrieval results", () => {
    it.each([
      "read_files",
      "symbol",
      "repo_map",
    ])("replaces stale %s result", (toolName) => {
      const messages = [
        {
          role: "toolResult",
          toolCallId: `call-${toolName}`,
          toolName,
          content: [{ type: "text", text: `${toolName} results` }],
        },
      ];
      const report: ContextHygieneReport = {
        eventCount: 2,
        resourceCount: 1,
        readReuse: [],
        mutationAfterRead: [],
        staleCandidates: [
          {
            resourceKey: "file:/project/src/foo.ts",
            staleEventIds: [1],
            mutationEventId: 2,
            reason: "mutation-after-read",
            staleResults: [
              buildStaleContextRecord({
                originalTool: toolName,
                originalResultId: `call-${toolName}`,
                staleResourceKeys: ["file:/project/src/foo.ts"],
                invalidatingMutationEventId: 2,
              }),
            ],
          },
        ],
        retirementCandidates: [],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      expect(result[0]!.content[0]!.text).toContain("Stale");
    });
  });

  describe("masks retired bash results", () => {
    it("replaces retired bash result content with placeholder", () => {
      const messages = [
        {
          role: "toolResult",
          toolCallId: "call-bash-1",
          toolName: "bash",
          content: [{ type: "text", text: "original command output" }],
        },
      ];
      const report: ContextHygieneReport = {
        eventCount: 2,
        resourceCount: 1,
        readReuse: [],
        mutationAfterRead: [],
        staleCandidates: [],
        retirementCandidates: [
          {
            resourceKey: "command:vcs:git status",
            eventIds: [1],
            supersededByEventId: 2,
            reason: "command-rerun",
            retiredResults: [
              buildRetiredContextRecord({
                originalTool: "bash",
                originalResultId: "call-bash-1",
                retiredResourceKeys: ["command:vcs:git status"],
                supersededByEventId: 2,
                reason: "command-rerun",
              }),
            ],
          },
        ],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      expect(result[0]!.content[0]!.text).toContain("Retired");
      expect(result[0]!.content[0]!.text).toContain("Superseded");
    });

    it("checks tool name matches for retired records", () => {
      const messages = [
        {
          role: "toolResult",
          toolCallId: "call-bash-1",
          toolName: "bash",
          content: [{ type: "text", text: "original command output" }],
        },
      ];
      const report: ContextHygieneReport = {
        eventCount: 2,
        resourceCount: 1,
        readReuse: [],
        mutationAfterRead: [],
        staleCandidates: [],
        retirementCandidates: [
          {
            resourceKey: "command:vcs:git status",
            eventIds: [1],
            supersededByEventId: 2,
            reason: "command-rerun",
            retiredResults: [
              buildRetiredContextRecord({
                originalTool: "read", // Wrong tool — bash != read
                originalResultId: "call-bash-1",
                retiredResourceKeys: ["command:vcs:git status"],
                supersededByEventId: 2,
                reason: "command-rerun",
              }),
            ],
          },
        ],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      expect(result[0]!.content[0]!.text).toBe("original command output");
    });

    it("adds contextHygieneRetired to details", () => {
      const messages = [
        {
          role: "toolResult",
          toolCallId: "call-bash-1",
          toolName: "bash",
          content: [{ type: "text", text: "original command output" }],
          details: {},
        },
      ];
      const report: ContextHygieneReport = {
        eventCount: 2,
        resourceCount: 1,
        readReuse: [],
        mutationAfterRead: [],
        staleCandidates: [],
        retirementCandidates: [
          {
            resourceKey: "command:vcs:git status",
            eventIds: [1],
            supersededByEventId: 2,
            reason: "command-rerun",
            retiredResults: [
              buildRetiredContextRecord({
                originalTool: "bash",
                originalResultId: "call-bash-1",
                retiredResourceKeys: ["command:vcs:git status"],
                supersededByEventId: 2,
                reason: "command-rerun",
              }),
            ],
          },
        ],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      expect((result[0]! as any).details.contextHygieneRetired).toBeDefined();
    });
  });

  describe("non-toolResult messages are skipped", () => {
    it("does not modify user messages", () => {
      const messages = [
        { role: "user", content: "read the file" },
        {
          role: "toolResult",
          toolCallId: "call-read-1",
          toolName: "read",
          content: [{ type: "text", text: "original" }],
        },
      ];
      const report: ContextHygieneReport = {
        eventCount: 2,
        resourceCount: 1,
        readReuse: [],
        mutationAfterRead: [],
        staleCandidates: [
          {
            resourceKey: "file:/project/src/foo.ts",
            staleEventIds: [1],
            mutationEventId: 2,
            reason: "mutation-after-read",
            staleResults: [
              buildStaleContextRecord({
                originalTool: "read",
                originalResultId: "call-read-1",
                staleResourceKeys: ["file:/project/src/foo.ts"],
                invalidatingMutationEventId: 2,
              }),
            ],
          },
        ],
        retirementCandidates: [],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      expect(result[0]!.content).toBe("read the file");
      expect((result[1]!.content as any)[0]!.text).toContain("Stale");
    });

    it("does not modify assistant messages", () => {
      const messages = [
        { role: "assistant", content: "I'll read the file" },
        {
          role: "toolResult",
          toolCallId: "call-read-1",
          toolName: "read",
          content: [{ type: "text", text: "original" }],
        },
      ];
      const report: ContextHygieneReport = {
        eventCount: 2,
        resourceCount: 1,
        readReuse: [],
        mutationAfterRead: [],
        staleCandidates: [
          {
            resourceKey: "file:/project/src/foo.ts",
            staleEventIds: [1],
            mutationEventId: 2,
            reason: "mutation-after-read",
            staleResults: [
              buildStaleContextRecord({
                originalTool: "read",
                originalResultId: "call-read-1",
                staleResourceKeys: ["file:/project/src/foo.ts"],
                invalidatingMutationEventId: 2,
              }),
            ],
          },
        ],
        retirementCandidates: [],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      expect(result[0]!.content).toBe("I'll read the file");
    });

    it("does not modify toolResult messages with missing toolCallId", () => {
      const messages = [
        {
          role: "toolResult",
          // No toolCallId
          toolName: "read",
          content: [{ type: "text", text: "original" }],
        },
      ];
      const report: ContextHygieneReport = {
        eventCount: 1,
        resourceCount: 1,
        readReuse: [],
        mutationAfterRead: [],
        staleCandidates: [
          {
            resourceKey: "file:/project/src/foo.ts",
            staleEventIds: [1],
            mutationEventId: 2,
            reason: "mutation-after-read",
            staleResults: [
              buildStaleContextRecord({
                originalTool: "read",
                originalResultId: "call-read-1",
                staleResourceKeys: ["file:/project/src/foo.ts"],
                invalidatingMutationEventId: 2,
              }),
            ],
          },
        ],
        retirementCandidates: [],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      expect(result[0]!.content[0]!.text).toBe("original");
    });
  });

  describe("handles multiple messages", () => {
    it("masks multiple stale results from same report", () => {
      const messages = [
        {
          role: "toolResult",
          toolCallId: "call-read-1",
          toolName: "read",
          content: [{ type: "text", text: "foo.ts contents" }],
        },
        {
          role: "toolResult",
          toolCallId: "call-read-2",
          toolName: "read",
          content: [{ type: "text", text: "bar.ts contents" }],
        },
      ];
      const report: ContextHygieneReport = {
        eventCount: 4,
        resourceCount: 2,
        readReuse: [],
        mutationAfterRead: [],
        staleCandidates: [
          {
            resourceKey: "file:/project/src/foo.ts",
            staleEventIds: [1],
            mutationEventId: 2,
            reason: "mutation-after-read",
            staleResults: [
              buildStaleContextRecord({
                originalTool: "read",
                originalResultId: "call-read-1",
                staleResourceKeys: ["file:/project/src/foo.ts"],
                invalidatingMutationEventId: 2,
              }),
            ],
          },
          {
            resourceKey: "file:/project/src/bar.ts",
            staleEventIds: [3],
            mutationEventId: 4,
            reason: "mutation-after-read",
            staleResults: [
              buildStaleContextRecord({
                originalTool: "read",
                originalResultId: "call-read-2",
                staleResourceKeys: ["file:/project/src/bar.ts"],
                invalidatingMutationEventId: 4,
              }),
            ],
          },
        ],
        retirementCandidates: [],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      expect(result[0]!.content[0]!.text).toContain("Stale");
      expect(result[1]!.content[0]!.text).toContain("Stale");
    });

    it("returns same array reference when nothing changed", () => {
      const messages = [
        {
          role: "toolResult",
          toolCallId: "call-read-1",
          toolName: "read",
          content: [{ type: "text", text: "original" }],
        },
      ];
      const report: ContextHygieneReport = {
        eventCount: 1,
        resourceCount: 1,
        readReuse: [],
        mutationAfterRead: [],
        staleCandidates: [],
        retirementCandidates: [],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      expect(result).toBe(messages);
    });

    it("returns new array when changes occurred", () => {
      const messages = [
        {
          role: "toolResult",
          toolCallId: "call-read-1",
          toolName: "read",
          content: [{ type: "text", text: "original" }],
        },
      ];
      const report: ContextHygieneReport = {
        eventCount: 2,
        resourceCount: 1,
        readReuse: [],
        mutationAfterRead: [],
        staleCandidates: [
          {
            resourceKey: "file:/project/src/foo.ts",
            staleEventIds: [1],
            mutationEventId: 2,
            reason: "mutation-after-read",
            staleResults: [
              buildStaleContextRecord({
                originalTool: "read",
                originalResultId: "call-read-1",
                staleResourceKeys: ["file:/project/src/foo.ts"],
                invalidatingMutationEventId: 2,
              }),
            ],
          },
        ],
        retirementCandidates: [],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      expect(result).not.toBe(messages);
    });
  });

  describe("deduplication by resultId", () => {
    it("keeps record with higher invalidatingMutationEventId when same resultId appears twice", () => {
      const messages = [
        {
          role: "toolResult",
          toolCallId: "call-read-1",
          toolName: "read",
          content: [{ type: "text", text: "original" }],
        },
      ];
      // Simulate two mutation events invalidating the same read result
      const report: ContextHygieneReport = {
        eventCount: 3,
        resourceCount: 1,
        readReuse: [],
        mutationAfterRead: [],
        staleCandidates: [
          {
            resourceKey: "file:/project/src/foo.ts",
            staleEventIds: [1],
            mutationEventId: 2,
            reason: "mutation-after-read",
            staleResults: [
              buildStaleContextRecord({
                originalTool: "read",
                originalResultId: "call-read-1",
                staleResourceKeys: ["file:/project/src/foo.ts"],
                invalidatingMutationEventId: 2,
              }),
            ],
          },
          {
            resourceKey: "file:/project/src/foo.ts",
            staleEventIds: [1],
            mutationEventId: 3, // Later mutation
            reason: "mutation-after-read",
            staleResults: [
              buildStaleContextRecord({
                originalTool: "read",
                originalResultId: "call-read-1",
                staleResourceKeys: ["file:/project/src/foo.ts"],
                invalidatingMutationEventId: 3,
              }),
            ],
          },
        ],
        retirementCandidates: [],
      };
      const result = applyContextHygieneStaleContext(messages, report);
      // Should have been masked
      expect(result[0]!.content[0]!.text).toContain("Stale");
    });
  });
});