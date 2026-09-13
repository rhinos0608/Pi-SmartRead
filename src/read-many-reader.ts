import { realpathSync, statSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { ReadToolDetails, ReadToolInput } from "@mariozechner/pi-coding-agent";
import type { WorkspaceEvidenceEnvelope } from "@rhinos0608/pi-workspace-protocol";
import {
	type FileCandidate,
	ensureHashlineReady,
	formatContentBlock,
	measureText,
	selectorToOffsetLimit,
	splitPathAndSelector,
	resolveReadPath,
	stripHashlineAnchors,
} from "./utils.js";
import { isInternalUrl, resolveUrl } from "./internal-url-router.js";
import { recordContiguous, resolveSessionKey } from "./file-read-cache.js";
import { canSummarize, renderSummary, summarizeCode } from "./code-summary.js";

export interface BatchFileRequest {
	readonly path: string;
	readonly offset?: number;
	readonly limit?: number;
}

export interface BatchFileDetail {
	path: string;
	ok: boolean;
	error?: string;
	imageCount?: number;
	truncation?: ReadToolDetails["truncation"];
}

export interface BatchReadResult {
	readonly candidates: FileCandidate[];
	readonly fileDetails: BatchFileDetail[];
	readonly perFileEvidenceByIndex: Map<number, WorkspaceEvidenceEnvelope>;
	readonly summarizedIndexes: Set<number>;
}

export interface BatchReadTool {
	execute(
		toolCallId: string,
		input: ReadToolInput,
		signal: AbortSignal | undefined,
		onUpdate: never,
	): Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
}

interface BatchReadArgs {
	readonly files: readonly BatchFileRequest[];
	readonly toolCallId: string;
	readonly signal: AbortSignal | undefined;
	readonly onUpdate: unknown;
	readonly cwd: string;
	readonly readTool: BatchReadTool;
	readonly stopOnError?: boolean;
}

interface SingleFileOutcome {
	readonly candidate: FileCandidate;
	readonly detail: BatchFileDetail;
	readonly evidence?: WorkspaceEvidenceEnvelope;
	readonly summarized: boolean;
	readonly resolvedPath?: string;
	readonly startLine?: number;
	readonly rawBody?: string;
}

interface DiskInput {
	readonly targetPath: string;
	readonly selector: string | undefined;
	readonly resolvedPath: string;
	readonly rawMode: boolean;
	readonly input: ReadToolInput & { __smartReadSelector?: string };
	readonly startLineFallback: number | undefined;
}

/**
 * Direct canonical resolver for explicit file paths in batch/paths context.
 *
 * Bypasses the workspace boundary / allowed-root layer: explicit reads
 * must succeed for paths outside cwd and outside PI_SMARTREAD_ALLOWED_ROOT
 * (permission is handled externally).
 */
export function resolveExplicitFile(cwd: string, requestedPath: string): string {
	if (!requestedPath || !requestedPath.trim()) {
		throw new Error("Path must not be empty");
	}
	const absolutePath = pathResolve(cwd, requestedPath);
	let stat;
	try {
		stat = statSync(absolutePath);
	} catch {
		return absolutePath;
	}
	if (!stat.isFile()) {
		throw new Error(`Path is not a regular file: ${requestedPath}`);
	}
	try {
		return realpathSync(absolutePath);
	} catch {
		return absolutePath;
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

async function readInternalUrl(request: BatchFileRequest, index: number): Promise<SingleFileOutcome> {
	const { path: targetPath, selector } = splitPathAndSelector(request.path);
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
	const fullText = formatContentBlock(request.path, body, index + 1, {
		anchorBody: true,
		startLine,
	});
	const candidate: FileCandidate = {
		index,
		path: targetPath,
		ok,
		fullText,
		fullMetrics: measureText(fullText),
		body,
		startLine,
	};
	const detail: BatchFileDetail = { path: targetPath, ok, error: ok ? undefined : err };
	return { candidate, detail, summarized: false };
}

function buildDiskInput(cwd: string, request: BatchFileRequest): DiskInput {
	const { path: targetPath, selector } = splitPathAndSelector(request.path);
	const resolvedPath = resolveExplicitFile(cwd, resolveReadPath(targetPath));
	const selectorArgs = selectorToOffsetLimit(selector);
	const rawMode = selectorArgs.raw === true;
	const input: ReadToolInput & { __smartReadSelector?: string } = {
		path: resolvedPath,
		offset: selectorArgs.offset ?? request.offset,
		limit: selectorArgs.limit ?? request.limit,
	};
	if (selector) {
		Object.defineProperty(input, "__smartReadSelector", {
			value: selector,
			enumerable: false,
		});
	}
	return { targetPath, selector, resolvedPath, rawMode, input, startLineFallback: selectorArgs.offset ?? request.offset };
}

function withImageNote(renderedBody: string, imageCount: number): string {
	if (!renderedBody) {
		return imageCount > 0
			? `[${imageCount} image attachment(s) omitted; use read on this file for image payload.]`
			: "[No text content returned]";
	}
	return imageCount > 0 ? `${renderedBody}\n[${imageCount} image attachment(s) omitted; use read on this file for image payload.]` : renderedBody;
}

async function maybeSummarize(resolvedPath: string, body: string, selector: string | undefined, rawMode: boolean): Promise<{ body: string; summarized: boolean }> {
	if (selector || rawMode || !body || body.length <= 8192) {
		return { body, summarized: false };
	}
	if (!canSummarize(resolvedPath, body.length, body.split("\n").length)) {
		return { body, summarized: false };
	}
	try {
		const summary = await summarizeCode({ code: body, path: resolvedPath });
		if (!summary.parsed || !summary.elided) {
			return { body, summarized: false };
		}
		return { body: renderSummary(summary, resolvedPath).text, summarized: true };
	} catch {
		return { body, summarized: false };
	}
}

interface DiskParts {
	readonly details: ReadToolDetails | undefined;
	readonly displayText: string | undefined;
	readonly startLineFromTool: number | undefined;
	readonly contextFooter: string | undefined;
	readonly evidence: WorkspaceEvidenceEnvelope | undefined;
	readonly imageCount: number;
	readonly renderedBody: string;
}

function extractDiskParts(result: { content: Array<{ type: string; text?: string }>; details?: unknown }): DiskParts {
	const details = result.details as ReadToolDetails | undefined;
	const displayContent = (details as { displayContent?: { text?: string; startLine?: number } } | undefined)?.displayContent;
	const contextFooter = (details as { contextFooter?: string } | undefined)?.contextFooter;
	const evidence = (details as { workspaceEvidence?: WorkspaceEvidenceEnvelope } | undefined)?.workspaceEvidence;
	const textChunks = result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text);
	const imageCount = result.content.filter((item) => item.type === "image").length;
	const renderedBody = displayContent?.text ?? textChunks.join("\n");
	return { details, displayText: displayContent?.text, startLineFromTool: displayContent?.startLine, contextFooter, evidence, imageCount, renderedBody };
}

async function readDiskFile(args: BatchReadArgs, request: BatchFileRequest, index: number): Promise<SingleFileOutcome> {
	const disk = buildDiskInput(args.cwd, request);
	const result = await args.readTool.execute(
		`${args.toolCallId}:${index}`,
		disk.input,
		args.signal,
		args.onUpdate as never,
	);
	const parts = extractDiskParts(result);
	const details = parts.details;
	const contextFooter = parts.contextFooter;
	const perFileEvidence = parts.evidence;
	const imageCount = parts.imageCount;
	const renderedBody = parts.renderedBody;
	const alreadyAnchored = /^\d+[a-z]{0,2}\|/m.test(renderedBody.split("\n", 5).join("\n"));
	const withImages = withImageNote(parts.displayText ?? renderedBody, imageCount);
	const summarized = await maybeSummarize(disk.resolvedPath, withImages, disk.selector, disk.rawMode);
	const startLine = parts.startLineFromTool ?? disk.startLineFallback ?? 1;
	const rawBody = alreadyAnchored ? stripHashlineAnchors(summarized.body) : summarized.body;
	const fullText = formatContentBlock(request.path, summarized.body, index + 1, {
		anchorBody: disk.rawMode ? false : !alreadyAnchored,
		startLine,
	}) + (disk.rawMode || !contextFooter ? "" : contextFooter);
	const candidate: FileCandidate = {
		index,
		path: disk.targetPath,
		ok: true,
		fullText,
		fullMetrics: measureText(fullText),
		body: rawBody,
		startLine,
	};
	const detail: BatchFileDetail = { path: disk.targetPath, ok: true, imageCount, truncation: details?.truncation };
	return { candidate, detail, evidence: perFileEvidence, summarized: summarized.summarized, resolvedPath: disk.resolvedPath, startLine, rawBody };
}

function readSingleFailure(request: BatchFileRequest, targetPath: string, index: number, error: unknown): SingleFileOutcome {
	const message = error instanceof Error ? error.message : String(error);
	const fullText = formatContentBlock(request.path, `[Error: ${message}]`, index + 1);
	const candidate: FileCandidate = {
		index,
		path: targetPath,
		ok: false,
		fullText,
		fullMetrics: measureText(fullText),
	};
	return { candidate, detail: { path: targetPath, ok: false, error: message }, summarized: false };
}

interface CommitState {
	readonly toolCallId: string;
	readonly candidates: FileCandidate[];
	readonly fileDetails: BatchFileDetail[];
	readonly perFileEvidenceByIndex: Map<number, WorkspaceEvidenceEnvelope>;
	readonly summarizedIndexes: Set<number>;
}

function commitOutcome(state: CommitState, outcome: SingleFileOutcome, index: number): void {
	state.candidates.push(outcome.candidate);
	state.fileDetails.push(outcome.detail);
	if (outcome.evidence) {
		state.perFileEvidenceByIndex.set(index, outcome.evidence);
	}
	if (outcome.summarized) {
		state.summarizedIndexes.add(index);
		return;
	}
	if (outcome.resolvedPath === undefined || outcome.rawBody === undefined || outcome.startLine === undefined) {
		return;
	}
	recordContiguous(resolveSessionKey(state.toolCallId), outcome.resolvedPath, outcome.startLine, outcome.rawBody.split("\n"));
}

/** Read every requested file: internal URLs via router, disk paths via wrapped read tool. */
export async function readBatchFiles(args: BatchReadArgs): Promise<BatchReadResult> {
	await ensureHashlineReady();
	const fileDetails: BatchFileDetail[] = [];
	const candidates: FileCandidate[] = [];
	const perFileEvidenceByIndex = new Map<number, WorkspaceEvidenceEnvelope>();
	const summarizedIndexes = new Set<number>();

	for (let i = 0; i < args.files.length; i++) {
		throwIfAborted(args.signal);
		const request = args.files[i]!;
		const { path: targetPath } = splitPathAndSelector(request.path);
		if (isInternalUrl(targetPath)) {
			const outcome = await readInternalUrl(request, i);
			candidates.push(outcome.candidate);
			fileDetails.push(outcome.detail);
			if (args.stopOnError && !outcome.candidate.ok) break;
			continue;
		}
		try {
			const outcome = await readDiskFile(args, request, i);
			commitOutcome({ toolCallId: args.toolCallId, candidates, fileDetails, perFileEvidenceByIndex, summarizedIndexes }, outcome, i);
		} catch (error) {
			const failure = readSingleFailure(request, targetPath, i, error);
			candidates.push(failure.candidate);
			fileDetails.push(failure.detail);
			if (args.stopOnError) break;
		}
	}
	return { candidates, fileDetails, perFileEvidenceByIndex, summarizedIndexes };
}
