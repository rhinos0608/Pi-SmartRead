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
		ensureHashlineReady,
		formatContentBlock,
		measureText,
		pickDelimiter,
		stripHashlineAnchors,
		selectorToOffsetLimit,
			splitPathAndSelector,
			resolveReadPath,
			resolveWorkspacePath,
			formatRecoveryHint,
			WRAPPER_LINES,
	} from "./utils.js";
import { registerHandler, resolveUrl, isInternalUrl } from "./internal-url-router.js";
import { createIntentReadTool } from "./intent-read.js";
import { skillHandler } from "./skill-protocol.js";
import { memoryHandler } from "./memory-protocol.js";
import { graphHandler } from "./graph-protocol.js";
import {
	recordContiguous,
	resolveSessionKey,
} from "./file-read-cache.js";
import { summarizeCode, renderSummary, canSummarize } from "./code-summary.js";

const CHUNK_SIZE = 500;
const LARGE_REQUEST_THRESHOLD = 500;

const ReadManySchema = Type.Object({
	files: Type.Optional(Type.Array(
		Type.Object({
			path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
			offset: Type.Optional(Type.Number({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
			limit: Type.Optional(Type.Number({ minimum: 1, description: "Maximum number of lines to read" })),
		}),
		{
			minItems: 1,
			maxItems: 10000,
			description: "Files to read in the exact order listed (max 10000). Required unless query is set.",
		},
	)),
	query: Type.Optional(Type.String({ description: "Natural-language intent. When set, candidate files (from files, directory, or cwd) are ranked by hybrid BM25 + semantic relevance and only the most relevant are packed. Use when you know the goal but not the exact files." })),
	directory: Type.Optional(Type.String({ description: "Directory to scan for candidates (only valid with query; default: cwd)." })),
	topK: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: "Max files to pack when query is set (default: 20)." })),
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
	largeRequestWarning?: string;
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
	let intentTool: ToolDefinition | undefined;
	return {
		name: "read_files",
		label: "read_files",
		description: `Read several files in one call. With exact paths, e.g. { files: [{ path: "src/auth.ts" }, { path: "src/session.ts", offset: 40, limit: 80 }] }. With query: "your intent", candidate files are ranked by relevance and only the best are packed — use when you know the goal but not the exact files. Output is packed under ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)} using adaptive ordering while preserving rendered request order. Prefer read for one known file, search for exact text/code patterns, and repo_map for a repository overview.`,
		parameters: ReadManySchema,

		async execute(
			toolCallId: string,
			params: ReadManyInput,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
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
				}, signal, undefined, ctx);
			}
			if (params.directory || params.topK !== undefined) {
				throw new Error("directory/topK are only valid together with query");
			}
			if (!params.files || params.files.length === 0) {
				throw new Error("Provide files to read, or query to rank and read by intent");
			}

			// Ensure hashline engine is ready before processing reads
			await ensureHashlineReady();

			const readTool = readToolFactory(ctx.cwd);
	const fileDetails: ReadManyFileDetail[] = [];
	const candidates: FileCandidate[] = [];
	const largeRequest = params.files.length > LARGE_REQUEST_THRESHOLD;

	// Process files in chunks to avoid blocking the event loop on very large requests.
	chunkLoop: for (let chunkStart = 0; chunkStart < params.files.length; chunkStart += CHUNK_SIZE) {
		const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, params.files.length);
		for (let i = chunkStart; i < chunkEnd; i++) {
				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}

				const request = params.files[i]!;
				const { path: targetPath, selector } = splitPathAndSelector(request.path);
				// Internal URL routing: skill://, memory://, graph:// bypass disk reads.
				if (isInternalUrl(targetPath)) {
					const selArgs = selectorToOffsetLimit(selector);
					const startLine = selArgs.offset ?? request.offset ?? 1;
					let body: string;
					let ok = false;
					let err = "";
					try {
						const result = await resolveUrl(targetPath);
						body = result.text;
						ok = true;
					} catch (e) {
						err = e instanceof Error ? e.message : String(e);
						body = `[Error: ${err}]`;
					}
					const fullText = formatContentBlock(request.path, body, i + 1, {
						anchorBody: true,
						startLine,
					});
					candidates.push({
						index: i,
						path: targetPath,
						ok,
						fullText,
						fullMetrics: measureText(fullText),
						body,
						startLine,
					});
					fileDetails.push({
						path: targetPath,
						ok,
						error: ok ? undefined : err,
					});
					if (params.stopOnError && !ok) break;
					continue;
				}
				const resolvedPath = resolveWorkspacePath(ctx.cwd, resolveReadPath(targetPath));
				const selectorArgs = selectorToOffsetLimit(selector);
				const rawMode = selectorArgs.raw === true;
				const input: ReadToolInput = {
					path: resolvedPath,
					offset: selectorArgs.offset ?? request.offset,
					limit: selectorArgs.limit ?? request.limit,
				};

				try {
					const result = await readTool.execute(`${toolCallId}:${i}`, input, signal, undefined);
					const details = result.details as ReadToolDetails | undefined;
					const displayContent = (details as { displayContent?: { text?: string; startLine?: number } } | undefined)
						?.displayContent;

					const textChunks = result.content
						.filter((item): item is { type: "text"; text: string } => item.type === "text")
						.map((item) => item.text);
					const imageCount = result.content.filter((item) => item.type === "image").length;

					const renderedBody = displayContent?.text ?? textChunks.join("\n");
					const firstFewLines = renderedBody.split("\n", 5).join("\n");
					const alreadyAnchored = /^\d+[a-z]{0,2}\|/m.test(firstFewLines);
					let body = displayContent?.text ?? renderedBody;
					if (!body) {
						body =
							imageCount > 0
								? `[${imageCount} image attachment(s) omitted; use read on this file for image payload.]`
								: "[No text content returned]";
					} else if (imageCount > 0) {
						body += `\n[${imageCount} image attachment(s) omitted; use read on this file for image payload.]`;
					}

					// Track whether summarization was applied to prevent cache corruption
					let summaryApplied = false;

					// Try structural summarization for large full-file reads without a line selector
					if (!selector && !rawMode && body && body.length > 8192) {
						const bodyLines = body.split("\n").length;
						if (canSummarize(resolvedPath, body.length, bodyLines)) {
							try {
								const summary = await summarizeCode({ code: body, path: resolvedPath });
								if (summary.parsed && summary.elided) {
									const rendered = renderSummary(summary, resolvedPath);
									body = rendered.text;
									summaryApplied = true;
								}
							} catch { /* fall through to raw body */ }
						}
					}

					const startLine = displayContent?.startLine ?? selectorArgs.offset ?? request.offset ?? 1;
					const rawBody = alreadyAnchored ? stripHashlineAnchors(body) : body;
					const fullText = formatContentBlock(request.path, body, i + 1, {
						anchorBody: rawMode ? false : !alreadyAnchored,
						startLine,
					});
					candidates.push({
						index: i,
						path: resolvedPath,
						ok: true,
						fullText,
						fullMetrics: measureText(fullText),
						body: rawBody,
						startLine,
					});

					fileDetails.push({
						path: resolvedPath,
						ok: true,
						imageCount,
						truncation: details?.truncation,
					});
					// Record raw lines in the file-read cache for anchor-stale recovery.
					// Skip when summarization replaced body — summary lines would corrupt cache.
					if (!summaryApplied) {
						const sessionKey = resolveSessionKey(toolCallId);
						const rawLines = rawBody.split("\n");
						recordContiguous(sessionKey, resolvedPath, startLine, rawLines);
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const fullText = formatContentBlock(request.path, `[Error: ${message}]`, i + 1);
					candidates.push({
						index: i,
						path: resolvedPath,
						ok: false,
						fullText,
						fullMetrics: measureText(fullText),
					});

					fileDetails.push({
						path: resolvedPath,
						ok: false,
						error: message,
					});

					if (params.stopOnError) {
						break chunkLoop;
					}
				}
			}
			// Yield to event loop between chunks to avoid starving I/O on large requests.
			if (largeRequest && chunkStart + CHUNK_SIZE < params.files.length) {
				await new Promise((r) => setImmediate(r));
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
			let outputText = outputTruncation.content;

			// Build recovery hints for truncated/elided/omitted content
			const recoveryHints: string[] = [];

			// Hint for files omitted due to packing limits
			if (plan.omittedIndexes.length > 0) {
				recoveryHints.push(formatRecoveryHint("file", "", { type: "omitted", count: plan.omittedIndexes.length }));
				recoveryHints.push(`${plan.omittedIndexes.length} file(s) omitted by the output budget. Add query: "<your intent>" to rank files by relevance and pack the best ones instead.`);
			}

			// Hint for partial file content
			if (plan.partialSection !== undefined) {
				const partialCandidate = candidates[plan.partialSection.index];
				if (partialCandidate && partialCandidate.body) {
					const totalLines = partialCandidate.body.split("\n").length;
					const displayedLines = plan.partialSection.text.split("\n").length - WRAPPER_LINES;
					if (totalLines > displayedLines) {
						recoveryHints.push(
							formatRecoveryHint("file", partialCandidate.path, {
								type: "truncated",
								totalLines,
								displayedLines,
							}),
						);
					}
				}
			}

			// Hint for combined output truncation
			if (outputTruncation.truncated) {
				recoveryHints.push(
					formatRecoveryHint("output", "", {
						type: "truncated",
						totalLines: outputTruncation.totalLines,
						displayedLines: outputTruncation.outputLines,
					}),
				);
			}

			if (recoveryHints.length > 0) {
				outputText = outputText + "\n\n" + recoveryHints.join("\n");
			}

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
				...(largeRequest && { largeRequestWarning: `Large request (${params.files.length} files) processed in chunks of ${CHUNK_SIZE}.` }),
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

// Initialisation: register internal URL handlers.
export function initHandlers(): void {
	registerHandler(skillHandler);
	registerHandler(memoryHandler);
	registerHandler(graphHandler);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(createReadManyTool());
}