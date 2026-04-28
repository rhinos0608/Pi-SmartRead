import { Type, type Static } from "typebox";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadToolDetails,
	ReadToolInput,
	ToolDefinition,
	TruncationResult,
} from "@mariozechner/pi-coding-agent";
import {
	createReadTool,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import {
	type FileCandidate,
	type PackingStrategy,
	type PackingPlan,
	type TextMetrics,
	buildPlan,
	formatContentBlock,
	measureText,
	validatePath,
} from "./utils.js";
import {
	buildPartialSection,
	createPathHash,
	pickDelimiter,
} from "./utils.js";

const ReadManySchema = Type.Object({
	files: Type.Array(
		Type.Object({
			path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
			offset: Type.Optional(Type.Number({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
			limit: Type.Optional(Type.Number({ minimum: 1, description: "Maximum number of lines to read" })),
		}),
		{
			minItems: 1,
			maxItems: 5,
			description: "Files to read in the exact order listed (max 5)",
		},
	),
	stopOnError: Type.Optional(Type.Boolean({ description: "Stop on first error (default false)" })),
});

type ReadManyInput = Static<typeof ReadManySchema>;

interface ReadManyFileDetail {
	path: string;
	ok: boolean;
	error?: string;
	imageCount?: number;
	truncation?: ReadToolDetails["truncation"];
}

interface ReadManyDetails {
	processedCount: number;
	successCount: number;
	errorCount: number;
	files: ReadManyFileDetail[];
	packing: {
		strategy: PackingStrategy;
		switchedForCoverage: boolean;
		fullIncludedCount: number;
		fullIncludedSuccessCount: number;
		partialIncludedPath?: string;
		omittedPaths: string[];
	};
	combinedTruncation?: TruncationResult;
}

export function createReadManyTool(readToolFactory: typeof createReadTool = createReadTool): ToolDefinition {
	return {
		name: "read_many",
		label: "read_many",
		description: `Read multiple files in one call with per-file offset/limit. Combined output uses per-file heredoc blocks (DICT_N_HASH); image attachments are summarized in text. Under combined output limits (${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}), packing is adaptive: strict request-order by default, switching to smallest-first only when it includes more complete successful files, while rendered section order stays original.`,
		parameters: ReadManySchema,

		async execute(
			toolCallId: string,
			params: ReadManyInput,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const readTool = readToolFactory(ctx.cwd);
			const fileDetails: ReadManyFileDetail[] = [];
			const candidates: FileCandidate[] = [];

			for (let i = 0; i < params.files.length; i++) {
				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}

				const request = params.files[i];
				validatePath(request.path);
				const input: ReadToolInput = {
					path: request.path,
					offset: request.offset,
					limit: request.limit,
				};

				try {
					const result = await readTool.execute(`${toolCallId}:${i}`, input, signal, undefined);
					const details = result.details as ReadToolDetails | undefined;

					const textChunks = result.content
						.filter((item): item is { type: "text"; text: string } => item.type === "text")
						.map((item) => item.text);
					const imageCount = result.content.filter((item) => item.type === "image").length;

					let body = textChunks.join("\n");
					if (!body) {
						body =
							imageCount > 0
								? `[${imageCount} image attachment(s) omitted; use read on this file for image payload.]`
								: "[No text content returned]";
					} else if (imageCount > 0) {
						body += `\n[${imageCount} image attachment(s) omitted; use read on this file for image payload.]`;
					}

					const fullText = formatContentBlock(request.path, body, i + 1);
					candidates.push({
						index: i,
						path: request.path,
						ok: true,
						fullText,
						fullMetrics: measureText(fullText),
						body,
					});

					fileDetails.push({
						path: request.path,
						ok: true,
						imageCount,
						truncation: details?.truncation,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const fullText = formatContentBlock(request.path, `[Error: ${message}]`, i + 1);
					candidates.push({
						index: i,
						path: request.path,
						ok: false,
						fullText,
						fullMetrics: measureText(fullText),
					});

					fileDetails.push({
						path: request.path,
						ok: false,
						error: message,
					});

					if (params.stopOnError) {
						break;
					}
				}
			}

			const requestOrder = candidates.map((_, i) => i);
			const smallestFirstOrder = [...requestOrder].sort((a, b) => {
				const sizeDelta = candidates[a].fullMetrics.bytes - candidates[b].fullMetrics.bytes;
				if (sizeDelta !== 0) {
					return sizeDelta;
				}
				const lineDelta = candidates[a].fullMetrics.lines - candidates[b].fullMetrics.lines;
				if (lineDelta !== 0) {
					return lineDelta;
				}
				return a - b;
			});

			const requestPlan = buildPlan("request-order", requestOrder, candidates);
			const smallestPlan = buildPlan("smallest-first", smallestFirstOrder, candidates);
			const switchedForCoverage = smallestPlan.fullSuccessCount > requestPlan.fullSuccessCount;
			const plan = switchedForCoverage ? smallestPlan : requestPlan;

			const sections: string[] = [];
			for (let i = 0; i < candidates.length; i++) {
				if (plan.fullIncluded.has(i)) {
					sections.push(candidates[i].fullText);
				} else if (plan.partialSection?.index === i) {
					sections.push(plan.partialSection.text);
				}
			}

			const plannedOutputText = sections.join("\n\n");
			const outputTruncation = truncateHead(plannedOutputText, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const outputText = outputTruncation.content;

			let partialIncludedPath: string | undefined;
			if (plan.partialSection !== undefined) {
				const c = candidates[plan.partialSection.index];
				if (c === undefined) {
					throw new Error(`Internal: partialSection.index ${plan.partialSection.index} out of bounds`);
				}
				partialIncludedPath = c.path;
			}

			const details: ReadManyDetails = {
				processedCount: fileDetails.length,
				successCount: fileDetails.filter((f) => f.ok).length,
				errorCount: fileDetails.filter((f) => !f.ok).length,
				files: fileDetails,
				packing: {
					strategy: plan.strategy,
					switchedForCoverage,
					fullIncludedCount: plan.fullCount,
					fullIncludedSuccessCount: plan.fullSuccessCount,
					partialIncludedPath,
					omittedPaths: plan.omittedIndexes.map((index) => candidates[index].path),
				},
				combinedTruncation: outputTruncation.truncated ? outputTruncation : undefined,
			};

			return {
				content: [{ type: "text", text: outputText }],
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

export default function (pi: ExtensionAPI) {
	pi.registerTool(createReadManyTool());
}
