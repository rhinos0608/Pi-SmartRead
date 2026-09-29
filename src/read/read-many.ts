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
} from "../utils.js";
import { registerHandler } from "../protocols/internal-url-router.js";
import { skillHandler } from "../protocols/skill-protocol.js";
import { memoryHandler } from "../protocols/memory-protocol.js";
import { graphHandler } from "../protocols/graph-protocol.js";
import type { EditMode, WorkspaceEvidenceEnvelope } from "@rhinos0608/pi-workspace-protocol";
import { sessionFileFromContext } from "../inspect/inspect-tool.js";
import { readBatchFiles, type BatchFileDetail } from "./read-many-reader.js";
import { packingHelp, planAndRender } from "./read-many-plan.js";
import {
	aggregateBatchEvidence,
	buildBatchWorkspaceEvidence,
} from "../evidence/read-many-evidence.js";

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
	/** Edit dialect resolved once at activation; defaults to hashline. */
	readonly editMode?: EditMode;
}

const ReadManySchema = Type.Object({
	files: Type.Array(
		Type.Object({
			path: Type.String({ description: "Known path to the file to read (relative or absolute)." }),
			offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line number to start reading from." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read." })),
		}, { additionalProperties: false }),
		{
			minItems: 1,
			maxItems: 100,
			description: "Known files to read in the exact order listed (max 100).",
		},
	),
	stopOnError: Type.Optional(Type.Boolean({ description: "Stop on first error (default false)." })),
}, {
	additionalProperties: false,
	description: "Batch read for already-known file paths only. Use grep to discover files/text, LSP for compiler-backed semantic relationships, and inspect for structural or architectural analysis.",
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
			const raw = params as unknown as Record<string, unknown>;
			for (const key of Object.keys(raw)) {
				if (key !== "files" && key !== "stopOnError") {
					throw new Error(`read_files param "${key}" is not supported`);
				}
			}
			if (!Array.isArray(params.files) || params.files.length === 0) {
				throw new Error("Provide files to read");
			}

			const editMode = opts.editMode ?? "hashline";
			if (editMode !== "text") {
				await ensureHashlineReady();
			}
			const readTool = readToolFactory(ctx.cwd);
			const batch = await readBatchFiles({
				files: params.files,
				toolCallId,
				signal,
				onUpdate,
				cwd: ctx.cwd,
				readTool: readTool as unknown as Parameters<typeof readBatchFiles>[0]["readTool"],
				stopOnError: params.stopOnError,
				editMode,
			});
			const candidates: FileCandidate[] = batch.candidates;
			const rendered = planAndRender(candidates, editMode);
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
