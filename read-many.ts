import { Type, type Static } from "@sinclair/typebox";
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
	buildPlan,
	buildPartialSection,
	createPathHash,
	formatContentBlock,
	measureText,
	pickDelimiter,
	validatePath,
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
			maxItems: 20,
			description: "Files to read in the exact order listed (max 20)",
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
	reranking?: {
		status: "ok" | "off" | "failed_fallback";
		changedOrder: boolean;
		candidateCount: number;
	};
	combinedTruncation?: TruncationResult;
}

export function createReadManyTool(readToolFactory: typeof createReadTool = createReadTool): ToolDefinition {
	return {
		name: "read_multiple_files",
		label: "read_multiple_files",
		description: `Read multiple files in one call with per-file offset/limit. Combined output uses per-file heredoc blocks (DICT_N_HASH); image attachments are summarized in text. Under combined output limits (${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}), packing is adaptive: request-order by default, trying smallest-first then relevance-first when they fit more complete successful files. Rendered section order stays original.`,
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

				const request = params.files[i]!;
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

			// Phase 5: compute structural relevance for each candidate file
			// Used when output exceeds limits — prefers core source files over peripheral ones.
			function computeFileRelevance(index: number): number {
				const c = candidates[index]!;
				if (!c.ok) return -1;
				const pathLower = c.path.toLowerCase();
				let score = 2.0;
				// Core source directories boost
				if (pathLower.includes("/src/") || pathLower.startsWith("src/")) score += 3.0;
				if (pathLower.includes("/lib/") || pathLower.startsWith("lib/")) score += 2.0;
				if (pathLower.includes("/app/") || pathLower.startsWith("app/")) score += 1.5;
				if (pathLower.includes("/components/") || pathLower.includes("/pages/")) score += 1.0;
				// Source code extensions boost
				if (/\.(tsx?|jsx?|mjs|cjs)$/i.test(c.path)) score += 2.0;
				else if (/\.(py|rs|go|java|rb|php)$/i.test(c.path)) score += 1.5;
				// Config/build/test files deboost
				if (pathLower.includes("/test/") || pathLower.includes("/tests/")) score -= 1.0;
				if (pathLower.includes("/spec/") || pathLower.includes("/__tests__/")) score -= 1.0;
				if (pathLower.includes(".config.") || pathLower.includes(".test.") || pathLower.includes(".spec.")) score -= 1.0;
				if (pathLower.includes("/node_modules/") || pathLower.includes("/dist/") || pathLower.includes("/build/")) score -= 5.0;
				// Path depth: deeper = more specific = more relevant
				const depth = pathLower.split("/").length;
				score += Math.min(2.0, depth * 0.25);
				return score;
			}

			const requestOrder = candidates.map((_, i) => i);
			const smallestFirstOrder = [...requestOrder].sort((a, b) => {
				const sizeDelta = candidates[a]!.fullMetrics.bytes - candidates[b]!.fullMetrics.bytes;
				if (sizeDelta !== 0) return sizeDelta;
				const lineDelta = candidates[a]!.fullMetrics.lines - candidates[b]!.fullMetrics.lines;
				if (lineDelta !== 0) return lineDelta;
				return a - b;
			});
			const relevanceOrder = [...requestOrder].sort((a, b) => {
				const d = computeFileRelevance(b) - computeFileRelevance(a);
				if (d !== 0) return d;
				return a - b;
			});

			const requestPlan = buildPlan("request-order", requestOrder, candidates);
			const smallestPlan = buildPlan("smallest-first", smallestFirstOrder, candidates);
			const relevancePlan = buildPlan("relevance-first", relevanceOrder, candidates);

			// Pick the strategy that fits the most complete successful files.
			// Smallest-first is preferred over relevance-first when they tie,
			// since smallest-first is the proven content-maximizing strategy.
			let plan = requestPlan;
			let rerankingResult: { status: "ok" | "off" | "failed_fallback"; changedOrder: boolean; candidateCount: number } | undefined;

			if (relevancePlan.fullSuccessCount > plan.fullSuccessCount && relevancePlan.fullSuccessCount > smallestPlan.fullSuccessCount) {
				plan = relevancePlan;
				rerankingResult = { status: "ok", changedOrder: true, candidateCount: candidates.length };
			} else if (smallestPlan.fullSuccessCount > plan.fullSuccessCount) {
				plan = smallestPlan;
			}

			const sections: string[] = [];
			for (let i = 0; i < candidates.length; i++) {
				if (plan.fullIncluded.has(i)) {
					sections.push(candidates[i]!.fullText);
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

			const switchedForCoverage = plan.strategy !== "request-order";

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
					omittedPaths: plan.omittedIndexes.map((index) => candidates[index]!.path),
				},
				...(rerankingResult && { reranking: rerankingResult }),
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
