import { describe, expect, it } from "vitest";
import { createIntentReadTool } from "../../../src/read/intent-read.js";
import { ensureHashlineReady } from "../../../src/utils.js";
import { makeEmbedder, setupIntentReadEnv } from "./intent-read-helpers.js";

setupIntentReadEnv();

function makeEnvelopeFor(path: string, resourceId: string) {
	return {
		schemaVersion: 4,
		inspectionId: "0".repeat(64),
		sessionId: "deadbeef".repeat(8),
		workspaceRoot: "/",
		canonicalWorkspaceRoot: "/",
		createdAt: new Date().toISOString(),
		mode: "path",
		resources: [
			{
				resourceId,
				canonicalPath: path,
				kind: "full",
				coverage: "full-file",
				allowedRanges: [{ startLine: 1, endLine: 1 }],
				fullFileSha256: "a".repeat(64),
				fresh: true,
			},
		],
	};
}

function makeEvidenceReadTool(map: Record<string, unknown>) {
	return {
		execute: async (_id: string, input: { path: string }) => {
			const val = map[input.path];
			if (val === undefined) throw new Error(`No stub for: ${input.path}`);
			if (val instanceof Error) throw val;
			return val;
		},
	};
}

describe("intent_read: batch workspace evidence", () => {
	it("attaches a batch envelope covering fully-included files", async () => {
		await ensureHashlineReady();
		const envA = makeEnvelopeFor("/alpha", "a".repeat(64));
		const envB = makeEnvelopeFor("/b", "b".repeat(64));
		const readTool = makeEvidenceReadTool({
			"/alpha": {
				content: [{ type: "text", text: "authentication logic here" }],
				details: { workspaceEvidence: envA },
			},
			"/b": {
				content: [{ type: "text", text: "authentication helpers here" }],
				details: { workspaceEvidence: envB },
			},
		});
		const tool = createIntentReadTool(
			(() => readTool) as any,
			makeEmbedder([
				[1, 0],
				[1, 0],
				[1, 0],
			]) as any,
		);
		const ctx = {
			cwd: "/",
			sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
		} as any;
		const result = await tool.execute(
			"call-intent-ev-1",
			{ query: "authentication", files: [{ path: "/alpha" }, { path: "/b" }] },
			undefined,
			undefined,
			ctx,
		);
		const details = result.details as any;
		expect(details.packing.fullIncludedCount).toBeGreaterThan(0);
		const batch = details.workspaceEvidence;
		expect(batch).toBeDefined();
		expect(batch.schemaVersion).toBe(4);
		const ids = batch.resources.map((r: any) => r.canonicalPath).sort();
		expect(ids).toEqual(["/alpha", "/b"]);
		expect(batch.inspectionId).toMatch(/^[0-9a-f]{64}$/);
	});

	it("omits the envelope when no per-file evidence is emitted", async () => {
		await ensureHashlineReady();
		const readTool = makeEvidenceReadTool({
			"/alpha": { content: [{ type: "text", text: "authentication logic here" }] },
		});
		const tool = createIntentReadTool(
			(() => readTool) as any,
			makeEmbedder([
				[1, 0],
				[1, 0],
			]) as any,
		);
		const ctx = {
			cwd: "/",
			sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
		} as any;
		const result = await tool.execute(
			"call-intent-ev-2",
			{ query: "authentication", files: [{ path: "/alpha" }] },
			undefined,
			undefined,
			ctx,
		);
		expect((result.details as any).workspaceEvidence).toBeUndefined();
	});
});
