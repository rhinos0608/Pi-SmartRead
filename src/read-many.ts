import { Type, type Static } from "@sinclair/typebox";
import type {
	ExtensionContext,
	ToolDefinition,
	TruncationResult,
} from "@mariozechner/pi-coding-agent";
import { createReadTool } from "@mariozechner/pi-coding-agent";
import {
	type FileCandidate,
	type PackingStrategy,
	buildPlan,
	buildPartialSection,
	createPathHash,
	ensureHashlineReady,
	formatContentBlock,
	measureText,
	pickDelimiter,
} from "./utils.js";
import { registerHandler } from "./internal-url-router.js";
import { createIntentReadTool } from "./intent-read.js";
import { skillHandler } from "./skill-protocol.js";
import { memoryHandler } from "./memory-protocol.js";
import { graphHandler } from "./graph-protocol.js";
import type { WorkspaceEvidenceEnvelope } from "@rhinos0608/pi-workspace-protocol";
import { sessionFileFromContext } from "./inspect-tool.js";
import { readBatchFiles, type BatchFileDetail } from "./read-many-reader.js";
import { packingHelp, planAndRender } from "./read-many-plan.js";
import {
	aggregateBatchEvidence,
	buildBatchWorkspaceEvidence,
} from "./read-many-evidence.js";

export { buildBatchWorkspaceEvidence };

/**
 * Options for {@link createReadManyTool}. Mirrors {@link WrapReadToolOptions}
 * so a single `publishInspection` callback can collect evidence from both
 * single-file reads (via `wrapBuiltinReadTool`) and batch reads.
 */
export interface ReadManyToolOptions {
	readonly publishInspection?: (
		envelope: WorkspaceEvidenceEnvelope,
		sessionFilePath: string,
		workspaceRoot: string,
	) => void;
}

const ReadManySchema = Type.Object({
	files: Type.Optional(Type.Array(
		Type.Object({
			path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
			offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
		}),
		{
			minItems: 1,
			maxItems: 100,
			description: "Files to read in the exact order listed (max 100). Required unless query is set.",
		},
	)),
	query: Type.Optional(Type.String({ description: "Natural-language intent. When set, candidate files (from files, directory, or cwd) are ranked by hybrid BM25 + semantic relevance and only the most relevant are packed. Use when you know the goal but not the exact files." })),
	directory: Type.Optional(Type.String({ description: "Directory to scan for candidates (only valid with query; default: cwd)." })),
	topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max files to pack when query is set (default: 20)." })),
	stopOnError: Type.Optional(Type.Boolean({ description: "Stop on first error (default false)" })),
});

type ReadManyInput = Static<typeof ReadManySchema>;

interface ReadManyDetails {
	processedCount: number;
	successCount: number;
	errorCount: number;
	files: BatchFileDetail[];
	packing: {
		strategy: PackingStrategy;
		switchedForCoverage: boolean;
		fullIncludedCount: number;
		fullIncludedSuccessCount: number;
		partialIncludedPath?: string;
		omittedPaths: string[];
	};
	reranking?: {
		status: "ok" | "off" | "failed_fallback";
		changedOrder: boolean;
		candidateCount: number;
	};
	combinedTruncation?: TruncationResult;
	/**
	 * Schema-3 batch envelope aggregating per-file evidence from the
	 * wrapped read tool. Mirrors inspect's `details.workspaceEvidence`
	 * contract so patch can authorise the same way it does for single reads.
	 * Absent when no per-file read produced a usable envelope (e.g., no
	 * real session file path).
	 */
	workspaceEvidence?: WorkspaceEvidenceEnvelope;
}

export function createReadManyTool(
	readToolFactory: typeof createReadTool = createReadTool,
	opts: ReadManyToolOptions = {},
): ToolDefinition {
	let intentTool: ToolDefinition | undefined;
	return {
		name: "read_files",
		label: "read_files",
		description: packingHelp(),
		parameters: ReadManySchema,

		async execute(
			toolCallId: string,
			params: ReadManyInput,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			if (params.query?.trim()) {
				const tool = intentTool ?? (intentTool = createIntentReadTool(readToolFactory));
				return tool.execute(toolCallId, {
					query: params.query,
					files: params.files,
					directory: params.directory,
					topK: params.topK,
					stopOnError: params.stopOnError,
					defaultToCwd: true,
				}, signal, onUpdate as never, ctx);
			}
			if (params.directory || params.topK !== undefined) {
				throw new Error("directory/topK are only valid together with query");
			}
			if (!params.files || params.files.length === 0) {
				throw new Error("Provide files to read, or query to rank and read by intent");
			}

			await ensureHashlineReady();
			const readTool = readToolFactory(ctx.cwd);
			const batch = await readBatchFiles({
				files: params.files,
				toolCallId,
				signal,
				onUpdate,
				cwd: ctx.cwd,
				readTool: readTool as unknown as Parameters<typeof readBatchFiles>[0]["readTool"],
				stopOnError: params.stopOnError,
			});
			const candidates: FileCandidate[] = batch.candidates;
			const rendered = planAndRender(candidates);
			const details: ReadManyDetails = {
				processedCount: batch.fileDetails.length,
				successCount: batch.fileDetails.filter((f) => f.ok).length,
				errorCount: batch.fileDetails.filter((f) => !f.ok).length,
				files: batch.fileDetails,
				packing: {
					strategy: rendered.plan.strategy,
					switchedForCoverage: rendered.switchedForCoverage,
					fullIncludedCount: rendered.plan.fullCount,
					fullIncludedSuccessCount: rendered.plan.fullSuccessCount,
					partialIncludedPath: rendered.partialIncludedPath,
					omittedPaths: rendered.plan.omittedIndexes.map((index) => candidates[index]!.path),
				},
				...(rendered.rerankingResult && { reranking: rendered.rerankingResult }),
				combinedTruncation: rendered.outputTruncation.truncated ? rendered.outputTruncation : undefined,
			};

			const sessionFilePath = sessionFileFromContext(ctx);
			const batchEvidence = aggregateBatchEvidence({
				cwd: ctx.cwd,
				sessionFilePath,
				perFile: batch.perFileEvidenceByIndex,
				fullIncluded: rendered.plan.fullIncluded,
				summarizedIndexes: batch.summarizedIndexes,
				outputTruncated: rendered.outputTruncation.truncated,
				publishInspection: opts.publishInspection,
			});
			if (batchEvidence) {
				details.workspaceEvidence = batchEvidence;
			}

			return {
				content: [{ type: "text", text: rendered.outputText }],
				details,
			};
		},
	} as unknown as ToolDefinition;
}

export const __test = {
	measureText,
	createPathHash,
	pickDelimiter,
	formatContentBlock,
	buildPartialSection,
	buildPlan,
};

// Initialisation: register internal URL handlers.
export function initHandlers(): void {
	registerHandler(skillHandler);
	registerHandler(memoryHandler);
	registerHandler(graphHandler);
}
