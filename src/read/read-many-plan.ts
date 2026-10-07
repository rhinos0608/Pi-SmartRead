import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import {
	type FileCandidate,
	type PackingStrategy,
	buildPlan,
	type PackingPlan,
	formatRecoveryHint,
	WRAPPER_LINES,
} from "../utils.js";

export interface PackingChoice {
	readonly plan: PackingPlan;
	readonly rerankingResult:
		| { status: "ok" | "off" | "failed_fallback"; changedOrder: boolean; candidateCount: number }
		| undefined;
}

export interface PackedOutput extends PackingChoice {
	readonly outputText: string;
	readonly outputTruncation: TruncationResult;
	readonly partialIncludedPath: string | undefined;
	readonly switchedForCoverage: boolean;
}

export function packingHelp(): string {
	return `Read several files in one call. With exact paths, pass { files: [{ path, offset?, limit? }] }; with query: "your intent", candidate files are ranked by relevance and only the best are packed — use when you know the goal but not the exact files. Output is packed under ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)} using adaptive ordering while preserving rendered request order. Prefer read for one known file, search for exact text/code patterns, and repo_map for a repository overview.`;
}

function scoreLocation(pathLower: string): number {
	if (pathLower.includes("/src/") || pathLower.startsWith("src/")) return 3.0;
	if (pathLower.includes("/lib/") || pathLower.startsWith("lib/")) return 2.0;
	if (pathLower.includes("/app/") || pathLower.startsWith("app/")) return 1.5;
	if (pathLower.includes("/components/") || pathLower.includes("/pages/")) return 1.0;
	return 0;
}

function scoreExtension(path: string): number {
	if (/\.(tsx?|jsx?|mjs|cjs)$/i.test(path)) return 2.0;
	if (/\.(py|rs|go|java|rb|php)$/i.test(path)) return 1.5;
	return 0;
}

function inDir(normalized: string, dir: string): boolean {
	return normalized.includes(`/${dir}/`) || normalized.startsWith(`${dir}/`);
}

function scorePenalty(pathLower: string): number {
	const normalized = pathLower.replace(/\\/g, "/");
	if (inDir(normalized, "node_modules") || inDir(normalized, "dist") || inDir(normalized, "build")) return -5.0;
	let penalty = 0;
	if (inDir(normalized, "test") || inDir(normalized, "tests")) penalty -= 1.0;
	if (inDir(normalized, "spec") || inDir(normalized, "__tests__")) penalty -= 1.0;
	if (normalized.includes(".config.") || normalized.includes(".test.") || normalized.includes(".spec.")) penalty -= 1.0;
	return penalty;
}

function scoreDepth(pathLower: string): number {
	return Math.min(2.0, pathLower.split("/").length * 0.25);
}

/** Structural relevance: core source up, config/test/build output down. */
export function computeFileRelevance(candidates: FileCandidate[], index: number): number {
	const c = candidates[index]!;
	if (!c.ok) return -1;
	const pathLower = c.path.toLowerCase();
	return 2.0 + scoreLocation(pathLower) + scoreExtension(c.path) + scorePenalty(pathLower) + scoreDepth(pathLower);
}

function orderBySize(candidates: FileCandidate[], requestOrder: number[]): number[] {
	return [...requestOrder].sort((a, b) => {
		const sizeDelta = candidates[a]!.fullMetrics.bytes - candidates[b]!.fullMetrics.bytes;
		if (sizeDelta !== 0) return sizeDelta;
		const lineDelta = candidates[a]!.fullMetrics.lines - candidates[b]!.fullMetrics.lines;
		if (lineDelta !== 0) return lineDelta;
		return a - b;
	});
}

function orderByRelevance(candidates: FileCandidate[], requestOrder: number[]): number[] {
	return [...requestOrder].sort((a, b) => {
		const d = computeFileRelevance(candidates, b) - computeFileRelevance(candidates, a);
		if (d !== 0) return d;
		return a - b;
	});
}

/** Pick strategy fitting most complete successful files; render stays in request order. */
export function choosePackingPlan(candidates: FileCandidate[]): PackingChoice {
	const requestOrder = candidates.map((_, i) => i);
	const requestPlan = buildPlan("request-order", requestOrder, candidates);
	const smallestPlan = buildPlan("smallest-first", orderBySize(candidates, requestOrder), candidates);
	const relevancePlan = buildPlan("relevance-first", orderByRelevance(candidates, requestOrder), candidates);
	if (relevancePlan.fullSuccessCount > requestPlan.fullSuccessCount && relevancePlan.fullSuccessCount > smallestPlan.fullSuccessCount) {
		return { plan: relevancePlan, rerankingResult: { status: "ok", changedOrder: true, candidateCount: candidates.length } };
	}
	if (smallestPlan.fullSuccessCount > requestPlan.fullSuccessCount) {
		return { plan: smallestPlan, rerankingResult: undefined };
	}
	return { plan: requestPlan, rerankingResult: undefined };
}

/** Render full + partial sections in request order. */
function renderSections(candidates: FileCandidate[], plan: PackingPlan): string[] {
	const sections: string[] = [];
	for (let i = 0; i < candidates.length; i++) {
		if (plan.fullIncluded.has(i)) {
			sections.push(candidates[i]!.fullText);
			continue;
		}
		if (plan.partialSection?.index === i) {
			sections.push(plan.partialSection.text);
		}
	}
	return sections;
}

function partialHint(candidates: FileCandidate[], plan: PackingPlan): string | undefined {
	if (plan.partialSection === undefined) return undefined;
	const partialCandidate = candidates[plan.partialSection.index];
	if (!partialCandidate?.body) return undefined;
	const totalLines = partialCandidate.body.split("\n").length;
	const displayedLines = plan.partialSection.text.split("\n").length - WRAPPER_LINES;
	if (totalLines <= displayedLines) return undefined;
	return formatRecoveryHint("file", partialCandidate.path, { type: "truncated", totalLines, displayedLines });
}

function buildRecoveryHints(candidates: FileCandidate[], plan: PackingPlan, outputTruncation: TruncationResult): string[] {
	const hints: string[] = [];
	if (plan.omittedIndexes.length > 0) {
		hints.push(formatRecoveryHint("file", "", { type: "omitted", count: plan.omittedIndexes.length }));
		hints.push(`${plan.omittedIndexes.length} file(s) omitted by the output budget. Add query: "<your intent>" to rank files by relevance and pack the best ones instead.`);
	}
	const hint = partialHint(candidates, plan);
	if (hint) hints.push(hint);
	if (outputTruncation.truncated) {
		hints.push(formatRecoveryHint("output", "", { type: "truncated", totalLines: outputTruncation.totalLines, displayedLines: outputTruncation.outputLines }));
	}
	return hints;
}

function resolvePartialPath(candidates: FileCandidate[], plan: PackingPlan): string | undefined {
	if (plan.partialSection === undefined) return undefined;
	const c = candidates[plan.partialSection.index];
	if (c === undefined) {
		throw new Error(`Internal: partialSection.index ${plan.partialSection.index} out of bounds`);
	}
	return c.path;
}

function assembledSize(content: string, hintText: string): { lines: number; bytes: number } {
	if (hintText.length === 0) {
		return { lines: content === "" ? 0 : content.split("\n").length, bytes: Buffer.byteLength(content, "utf8") };
	}
	// `${content}\n\n${hints}` adds one blank separator line and two separator bytes.
	const contentLines = content === "" ? 0 : content.split("\n").length;
	return {
		lines: contentLines + 1 + hintText.split("\n").length,
		bytes: Buffer.byteLength(content, "utf8") + 2 + Buffer.byteLength(hintText, "utf8"),
	};
}

/** Render full + partial sections in request order, truncate combined output, add recovery hints. */
export function planAndRender(candidates: FileCandidate[]): PackedOutput {
	const { plan, rerankingResult } = choosePackingPlan(candidates);
	const sectionsText = renderSections(candidates, plan).join("\n\n");
	// Reserve hint space before truncation so the final assembly (content +
	// hints) stays within the documented line/byte budgets. Iterate: each
	// pass reserves the previous pass's hint footprint, then rebuilds hints
	// against the re-truncated content until the assembly fits.
	let maxLines = DEFAULT_MAX_LINES;
	let maxBytes = DEFAULT_MAX_BYTES;
	let outputTruncation = truncateHead(sectionsText, { maxLines, maxBytes });
	let recoveryHints = buildRecoveryHints(candidates, plan, outputTruncation);
	for (let i = 0; i < 4; i++) {
		if (recoveryHints.length === 0) break;
		const hintText = recoveryHints.join("\n");
		const size = assembledSize(outputTruncation.content, hintText);
		if (size.lines <= DEFAULT_MAX_LINES && size.bytes <= DEFAULT_MAX_BYTES) break;
		maxLines = Math.max(1, DEFAULT_MAX_LINES - (hintText.split("\n").length + 1));
		maxBytes = Math.max(1, DEFAULT_MAX_BYTES - (Buffer.byteLength(hintText, "utf8") + 2));
		outputTruncation = truncateHead(sectionsText, { maxLines, maxBytes });
		recoveryHints = buildRecoveryHints(candidates, plan, outputTruncation);
	}
	const outputText = recoveryHints.length > 0 ? `${outputTruncation.content}\n\n${recoveryHints.join("\n")}` : outputTruncation.content;
	return {
		plan,
		rerankingResult,
		outputText,
		outputTruncation,
		partialIncludedPath: resolvePartialPath(candidates, plan),
		switchedForCoverage: plan.strategy !== "request-order",
	};
}

export type { PackingStrategy };
