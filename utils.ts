import fs from "node:fs";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@mariozechner/pi-coding-agent";

export const DELIMITER_WORDS = [
	"PINE",
	"MANGO",
	"ORBIT",
	"RAVEN",
	"CEDAR",
	"LOTUS",
	"EMBER",
	"NOVA",
	"DUNE",
	"KITE",
	"TIDAL",
	"QUARTZ",
	"ACORN",
	"BLAZE",
	"FJORD",
	"GLYPH",
	"HARBOR",
	"IVORY",
	"JUNIPER",
	"SIERRA",
	"UMBRA",
	"VIOLET",
	"WILLOW",
	"XENON",
	"YARROW",
	"ZEPHYR",
] as const;

export interface TextMetrics {
	bytes: number;
	lines: number;
}

export interface FileCandidate {
	index: number;
	path: string;
	ok: boolean;
	fullText: string;
	fullMetrics: TextMetrics;
	body?: string; // present for successful text/image-summary reads; used for partial rendering
	startLine?: number;
}

export interface PackedSection {
	index: number;
	text: string;
	metrics: TextMetrics;
}

export type PackingStrategy = "request-order" | "smallest-first" | "relevance-first";

export interface PackingPlan {
	strategy: PackingStrategy;
	fullIncluded: Set<number>;
	partialSection?: PackedSection;
	omittedIndexes: number[];
	usedBytes: number;
	usedLines: number;
	sectionCount: number;
	fullCount: number;
	fullSuccessCount: number;
}

export function coerceText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	if (typeof value === "object") {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
	return String(value);
}

export function measureText(text: string): TextMetrics {
	return {
		bytes: Buffer.byteLength(text, "utf-8"),
		lines: text.length === 0 ? 0 : text.split("\n").length,
	};
}

// ─── Hashline init tracking ─────────────────────────────────────────────

let _hashlineModule: typeof import("./hashline.js") | null = null;
let _hashlineInitPromise: Promise<void> | null = null;

/**
 * Initialize hashline engine. Must be called before prefixLinesWithAnchors
 * or formatContentBlock. Idempotent — safe to call multiple times.
 */
export async function ensureHashlineReady(): Promise<void> {
  if (_hashlineModule) return;
  if (!_hashlineInitPromise) {
    _hashlineInitPromise = (async () => {
      const mod = await import("./hashline.js");
      await mod.initHashline();
      _hashlineModule = mod;
    })();
  }
  await _hashlineInitPromise;
}

/**
 * Check if hashline engine is ready.
 */
export function isHashlineReady(): boolean {
  return _hashlineModule !== null;
}

/**
 * Get the hashline module (throws if not initialized).
 */
function __hashlineModule(): typeof import("./hashline.js") {
  if (!_hashlineModule) {
    throw new Error(
      "Hashline not initialized. Call ensureHashlineReady() before using hashline functions."
    );
  }
  return _hashlineModule;
}

export function createPathHash(path: string): string {
	// Deterministic tiny hash (no Node crypto dependency)
	let hash = 5381;
	for (let i = 0; i < path.length; i++) {
		hash = ((hash << 5) + hash + path.charCodeAt(i)) >>> 0;
	}
	return hash.toString(16).toUpperCase().padStart(6, "0").slice(0, 6);
}

export class LruCache<T> {
	private values = new Map<string, T>();

	constructor(readonly maxSize: number) {}

	get(key: string): T | undefined {
		const value = this.values.get(key);
		if (value === undefined) return undefined;
		this.values.delete(key);
		this.values.set(key, value);
		return value;
	}

	set(key: string, value: T): void {
		if (this.values.has(key)) {
			this.values.delete(key);
		}
		this.values.set(key, value);
		while (this.values.size > this.maxSize) {
			const oldest = this.values.keys().next().value;
			if (oldest === undefined) break;
			this.values.delete(oldest);
		}
	}

	delete(key: string): boolean {
		return this.values.delete(key);
	}

	get size(): number {
		return this.values.size;
	}

	clear(): void {
		this.values.clear();
	}
}

export function pickDelimiter(path: string, index: number, content: string): string {
	const word = DELIMITER_WORDS[index - 1] ?? `FILE${index}`;
	const hash = createPathHash(path);
	const base = `${word}_${index}_${hash}`;

	if (!content.includes(base)) {
		return base;
	}

	for (let attempt = 1; attempt <= 32; attempt++) {
		const candidate = `${base}_${attempt}`;
		if (!content.includes(candidate)) {
			return candidate;
		}
	}

	// Safety fallback: if 32 deterministic attempts fail, jump to a high-entropy random string
	// to prevent worst-case exhaustive loops.
	const randomSuffix = Math.random().toString(36).slice(2, 10).toUpperCase();
	return `${base}_${randomSuffix}`;
}

// ─── macOS Path Variant Resolution ──────────────────────────────────────

const NARROW_NO_BREAK_SPACE = "\u202F";
const CURLY_APOSTROPHE = "\u2019";

/**
 * Convert a path to NFD (decomposed) Unicode form.
 * macOS uses NFD for filenames, while many tools use NFC.
 */
export function tryNFDVariant(filePath: string): string {
	return filePath.normalize("NFD");
}

/**
 * Replace straight apostrophe with curly apostrophe (U+2019).
 * Some applications use curly quotes in filenames.
 */
export function tryCurlyQuoteVariant(filePath: string): string {
	return filePath.replace(/'/g, CURLY_APOSTROPHE);
}

/**
 * Replace the space before AM/PM with a narrow no-break space (U+202F).
 * macOS screenshots use this pattern: "Screenshot YYYY-MM-DD at HH.MM AM/PM"
 * where the space before AM/PM is a narrow no-break space.
 */
export function tryMacOSScreenshotPath(filePath: string): string {
	// Match space followed by AM or PM at end of string or followed by .png/.jpg/etc
	return filePath.replace(/ (AM|PM)(?=[^\w]|$)/g, `${NARROW_NO_BREAK_SPACE}$1`);
}

/**
 * Check if a path exists on disk (file or directory).
 */
function pathExists(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Try multiple path variants and return the first one that exists on disk.
 * Order: original, NFD variant, curly quote variant, macOS screenshot variant.
 */
export function resolvePathWithFallbacks(filePath: string): string {
	// Original path
	if (pathExists(filePath)) {
		return filePath;
	}

	// NFD variant (for macOS decomposed Unicode)
	const nfdPath = tryNFDVariant(filePath);
	if (nfdPath !== filePath && pathExists(nfdPath)) {
		return nfdPath;
	}

	// Curly quote variant
	const curlyPath = tryCurlyQuoteVariant(filePath);
	if (curlyPath !== filePath && pathExists(curlyPath)) {
		return curlyPath;
	}

	// macOS screenshot variant (narrow no-break space before AM/PM)
	const screenshotPath = tryMacOSScreenshotPath(filePath);
	if (screenshotPath !== filePath && pathExists(screenshotPath)) {
		return screenshotPath;
	}

	// Fallback to original
	return filePath;
}

/**
 * Validate and resolve a path with macOS fallbacks.
 * Throws on empty path or path traversal attempts.
 * Returns the resolved path (first variant that exists on disk).
 */
export function resolveReadPath(path: string): string {
	validatePath(path);
	return resolvePathWithFallbacks(path);
}

export function validatePath(path: string): void {
	if (!path || !path.trim()) {
		throw new Error("File path must not be empty");
	}
	for (const segment of path.replace(/\\/g, "/").split("/")) {
		if (segment === "..") {
			throw new Error(`Path traversal not allowed: ${path}`);
		}
	}
}

const FILE_LINE_RANGE_RE = /^(.*?)(?::(.+))$/;
const URL_LIKE_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;

export function isUrlLikePath(rawPath: string): boolean {
	return URL_LIKE_RE.test(rawPath);
}

export function splitPathAndSelector(rawPath: string): { path: string; selector?: string } {
	if (!rawPath) {
		return { path: rawPath };
	}
	if (isUrlLikePath(rawPath)) {
		return { path: rawPath };
	}
	const match = FILE_LINE_RANGE_RE.exec(rawPath);
	if (!match) {
		return { path: rawPath };
	}
	return { path: match[1]!, selector: match[2] };
}

export function selectorToOffsetLimit(selector?: string): { offset?: number; limit?: number; raw?: boolean } {
	const parsed = parseMultiRangeSelector(selector);
	if (parsed.ranges.length === 0 && !parsed.raw) {
		return {};
	}
	if (parsed.raw && parsed.ranges.length === 0) {
		return { raw: true };
	}
	// Use the first range for backward compatibility
	const range = parsed.ranges[0];
	if (!range) {
		return {};
	}
	return {
		offset: range.start,
		limit: range.end - range.start + 1,
		raw: parsed.raw,
	};
}

export function selectorToStartLine(selector?: string, fallback = 1): number {
	const { offset } = selectorToOffsetLimit(selector);
	return offset ?? fallback;
}

// ─── Multi-range Selector Parsing ───────────────────────────────────────

/**
 * A single line range with inclusive start and end.
 */
export interface LineRange {
	start: number;
	end: number; // inclusive
}

/**
 * Parsed selector with merged ranges and optional raw mode.
 */
export interface ParsedSelector {
	ranges: LineRange[];
	raw?: boolean;
}

/**
 * Parse a multi-range selector string into structured ranges.
 *
 * Supported formats:
 *   - `1-50` → single range
 *   - `1-50,960-973` → multiple ranges (comma-separated)
 *   - `1-` → start to EOF
 *   - `1+10` → start + count (equivalent to 1-10)
 *   - `raw` → raw mode, no ranges
 *   - `1-50:raw` or `raw:1-50` → range + raw mode combined
 *
 * Ranges are sorted by start line and overlapping/adjacent ranges are merged.
 */
export function parseMultiRangeSelector(selector?: string): ParsedSelector {
	if (!selector || selector.trim() === "") {
		return { ranges: [] };
	}

	let raw = false;
	let rangePart = selector;

	// Handle compound selectors: raw:X or X:raw or raw:X:Y
	const parts = selector.split(":");
	for (const part of parts) {
		const trimmed = part.trim().toLowerCase();
		if (trimmed === "raw") {
			raw = true;
		} else if (trimmed) {
			rangePart = part;
		}
	}

	// Handle bare "raw" case
	if (rangePart.trim() === "" || rangePart.trim() === "raw") {
		return { ranges: [], raw };
	}

	// Split by comma to get individual range specs
	const rangeSpecs = rangePart.split(",");
	const parsedRanges: LineRange[] = [];

	for (const spec of rangeSpecs) {
		const trimmed = spec.trim();
		if (!trimmed) continue;

		// Try N-M format (start-end)
		const dashMatch = /^(\d+)-(\d+)$/.exec(trimmed);
		if (dashMatch) {
			const start = Number(dashMatch[1]);
			const end = Number(dashMatch[2]);
			if (start >= 1 && end >= start) {
				parsedRanges.push({ start, end });
			}
			continue;
		}

		// Try N- format (start to EOF)
		const openEndedMatch = /^(\d+)-$/.exec(trimmed);
		if (openEndedMatch) {
			const start = Number(openEndedMatch[1]);
			if (start >= 1) {
				// EOF is represented as end: Infinity (will be resolved when applying)
				parsedRanges.push({ start, end: Infinity });
			}
			continue;
		}

		// Try N+M format (start + count)
		const countMatch = /^(\d+)\+(\d+)$/.exec(trimmed);
		if (countMatch) {
			const start = Number(countMatch[1]);
			const count = Number(countMatch[2]);
			if (start >= 1 && count >= 1) {
				parsedRanges.push({ start, end: start + count - 1 });
			}
			continue;
		}

		// Try N format (single line)
		const singleMatch = /^(\d+)$/.exec(trimmed);
		if (singleMatch) {
			const start = Number(singleMatch[1]);
			if (start >= 1) {
				parsedRanges.push({ start, end: start });
			}
			continue;
		}
	}

	// Sort and merge overlapping/adjacent ranges
	const merged = mergeRanges(parsedRanges);

	return { ranges: merged, raw };
}

/**
 * Merge overlapping and adjacent ranges.
 */
function mergeRanges(ranges: LineRange[]): LineRange[] {
	if (ranges.length <= 1) {
		return ranges;
	}

	// Sort by start position
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	const merged: LineRange[] = [];

	let current: LineRange = { start: sorted[0]!.start, end: sorted[0]!.end };
	for (let i = 1; i < sorted.length; i++) {
		const next = sorted[i]!;
		// Merge if overlapping or adjacent (end >= start - 1)
		if (current.end >= next.start - 1) {
			current.end = Math.max(current.end, next.end);
		} else {
			merged.push(current);
			current = { start: next.start, end: next.end };
		}
	}
	merged.push(current);

	return merged;
}

/**
 * Resolve multi-range content from full text.
 *
 * Extracts content from specified ranges and joins them with elision markers.
 * Lines outside the specified ranges are replaced with elision markers.
 *
 * @param fullText - The complete file content
 * @param selector - Parsed selector with ranges and raw flag
 * @returns Content with elision markers for omitted sections
 */
export function resolveMultiRangeContent(fullText: string, selector: ParsedSelector): string {
	if (selector.ranges.length === 0) {
		return fullText;
	}

	const lines = fullText.split("\n");
	const totalLines = lines.length;
	const result: string[] = [];

	// Normalize ranges: replace Infinity with actual line count
	const normalizedRanges = selector.ranges.map((r) => ({
		start: r.start,
		end: r.end === Infinity ? totalLines : r.end,
	}));

	// Sort ranges for sequential processing
	const sortedRanges = [...normalizedRanges].sort((a, b) => a.start - b.start);

	let currentLine = 1;

	for (const range of sortedRanges) {
		const rangeStart = Math.max(1, range.start);
		const rangeEnd = Math.min(totalLines, range.end);

		// Add elision marker if there's a gap before this range
		if (currentLine < rangeStart && currentLine <= totalLines) {
			const omittedCount = rangeStart - currentLine;
			if (omittedCount === 1) {
				result.push("... (1 line omitted)");
			} else {
				result.push(`... (${omittedCount} lines omitted)`);
			}
		}

		// Add lines within range (only if range is valid)
		if (rangeStart <= rangeEnd && rangeStart <= totalLines) {
			const startIdx = Math.max(0, rangeStart - 1);
			const endIdx = Math.min(totalLines, rangeEnd);
			for (let i = startIdx; i < endIdx; i++) {
				result.push(lines[i] ?? "");
			}
			currentLine = rangeEnd + 1;
		} else if (rangeStart > totalLines) {
			// Range starts beyond file - no lines to add, just update currentLine
			currentLine = rangeStart;
		}
	}

	// Add trailing elision marker for lines after the last processed range
	if (currentLine <= totalLines) {
		const omittedCount = totalLines - currentLine + 1;
		if (omittedCount === 1) {
			result.push("... (1 line omitted)");
		} else {
			result.push(`... (${omittedCount} lines omitted)`);
		}
	}

	return result.join("\n");
}

/**
 * Prefix each line of body with a hashline 'LINE+ID|' prefix.
 *
 * Produces format: "42ab|    return x;" where "42" is the line number
 * and "ab" is a xxHash32-based bigram (BPE single-token).
 *
 * Compatible with Pi-SmartEdit's hashline edit format.
 * Requires ensureHashlineReady() to be called first (throws if not).
 */
export function prefixLinesWithAnchors(body: string, startLine = 1): string {
	const { formatHashLine } = __hashlineModule();
	const lines = body.split("\n");
	return lines.map((line, i) => {
		const lineNum = startLine + i;
		return formatHashLine(lineNum, line);
	}).join("\n");
}

export function stripHashlineAnchors(body: string): string {
	return body
		.split("\n")
		.map((line) => line.replace(/^\d+[a-z]{0,2}\|/, ""))
		.join("\n");
}

/**
 * Format a content block with hashline-anchored line prefixes.
 *
 * Each line is prefixed with "LINE+ID|" so the model can reference specific
 * lines via hashline-anchored edits. Requires ensureHashlineReady() first.
 */
// formatContentBlock wraps body with @path line, <<'DELIM' header, and DELIM footer = 3 wrapper lines
// Keep WRAPPER_LINES in sync with this format.
export const WRAPPER_LINES = 3;

export function formatContentBlock(
	path: string,
	body: string,
	index: number,
	options?: { anchorBody?: boolean; startLine?: number },
): string {
	const delimiter = pickDelimiter(path, index, body);
	const anchorBody = options?.anchorBody ?? true;
	const anchoredBody = anchorBody ? prefixLinesWithAnchors(body, options?.startLine ?? 1) : body;
	return `@${path}\n<<'${delimiter}'\n${anchoredBody}\n${delimiter}`;
}

export function canFitSection(
	state: { usedBytes: number; usedLines: number; sectionCount: number },
	metrics: TextMetrics,
): boolean {
	const sepBytes = state.sectionCount > 0 ? 2 : 0; // "\n\n"
	const sepLines = state.sectionCount > 0 ? 1 : 0;
	return (
		state.usedBytes + sepBytes + metrics.bytes <= DEFAULT_MAX_BYTES &&
		state.usedLines + sepLines + metrics.lines <= DEFAULT_MAX_LINES
	);
}

export function addSection(
	state: { usedBytes: number; usedLines: number; sectionCount: number },
	metrics: TextMetrics,
): void {
	const sepBytes = state.sectionCount > 0 ? 2 : 0;
	const sepLines = state.sectionCount > 0 ? 1 : 0;
	state.usedBytes += sepBytes + metrics.bytes;
	state.usedLines += sepLines + metrics.lines;
	state.sectionCount += 1;
}

export interface ElidedSpans {
	count: number;
	lines: number;
}

/**
 * Format a recovery hint for truncated/elided content.
 *
 * @param entityLabel - Label for the entity (e.g., "file", "files")
 * @param path - Path to the file/entity
 * @param options - Either truncatedLines or elidedSpans, not both
 */
export function formatRecoveryHint(
	entityLabel: string,
	path: string,
	options:
		| { type: "truncated"; totalLines: number; displayedLines: number }
		| { type: "elided"; spans: ElidedSpans }
		| { type: "omitted"; count: number },
): string {
	if (options.type === "truncated") {
		const { totalLines, displayedLines } = options;
		if (totalLines <= displayedLines) {
			return `[${entityLabel} complete]`;
		}
		const truncatedLines = totalLines - displayedLines;
		const nextOffset = displayedLines + 1;
		if (truncatedLines === 1) {
			return `[1 more line in ${entityLabel} ${path}; read ${path}:${nextOffset} to continue]`;
		}
		return `[${truncatedLines} more lines in ${entityLabel} ${path}; read ${path}:${nextOffset} to continue]`;
	}

	if (options.type === "elided") {
		const { count, lines } = options.spans;
		const regionWord = count === 1 ? "region" : "regions";
		const lineWord = lines === 1 ? "line" : "lines";
		if (count === 0) {
			return `[${entityLabel} complete]`;
		}
		return `[${count} elided ${regionWord} across ${lines} ${lineWord}; read ${path}:raw or a line range like ${path}:1-9999 for verbatim content]`;
	}

	// options.type === "omitted"
	const { count } = options;
	if (count === 0) {
		return "";
	}
	const fileWord = count === 1 ? "file" : "files";
	return `[${count} ${fileWord} omitted; use smaller limits or read files individually]`;
}

export function buildPartialSection(candidate: FileCandidate, remainingLines: number, remainingBytes: number): string | undefined {
	if (!candidate.body) {
		return undefined;
	}

	// Wrapper adds WRAPPER_LINES structural lines around body in `formatContentBlock`.
	let maxBodyLines = remainingLines - WRAPPER_LINES;
	if (maxBodyLines < 1 || remainingBytes < 32) {
		return undefined;
	}

	let maxBodyBytes = Math.max(1, remainingBytes - 96); // reserve room for wrapper + delimiter

	for (let attempt = 0; attempt < 16; attempt++) {
		const trunc = truncateHead(candidate.body, {
			maxLines: maxBodyLines,
			maxBytes: maxBodyBytes,
		});

		if (!trunc.content) {
			return undefined;
		}

		const partialText = formatContentBlock(candidate.path, trunc.content, candidate.index + 1, {
			startLine: candidate.startLine ?? 1,
		});
		const metrics = measureText(partialText);

		if (metrics.lines <= remainingLines && metrics.bytes <= remainingBytes) {
			return partialText;
		}

		if (metrics.lines > remainingLines && maxBodyLines > 1) {
			maxBodyLines = Math.max(1, maxBodyLines - (metrics.lines - remainingLines));
		}
		if (metrics.bytes > remainingBytes && maxBodyBytes > 1) {
			maxBodyBytes = Math.max(1, maxBodyBytes - (metrics.bytes - remainingBytes) - 8);
		}
	}

	return undefined;
}

export function buildPlan(strategy: PackingStrategy, order: number[], candidates: FileCandidate[]): PackingPlan {
	const state = { usedBytes: 0, usedLines: 0, sectionCount: 0 };
	const fullIncluded = new Set<number>();
	let fullSuccessCount = 0;

	for (const index of order) {
		const candidate = candidates[index]!;
		if (canFitSection(state, candidate.fullMetrics)) {
			addSection(state, candidate.fullMetrics);
			fullIncluded.add(index);
			if (candidate.ok) {
				fullSuccessCount += 1;
			}
		} else if (strategy === "request-order") {
			// Strict request-order behavior: once a full block doesn't fit, stop full-block packing.
			break;
		}
	}

	let partialSection: PackedSection | undefined;
	for (let index = 0; index < candidates.length; index++) {
		if (fullIncluded.has(index)) {
			continue;
		}

		const sepBytes = state.sectionCount > 0 ? 2 : 0;
		const sepLines = state.sectionCount > 0 ? 1 : 0;
		const remainingBytes = DEFAULT_MAX_BYTES - state.usedBytes - sepBytes;
		const remainingLines = DEFAULT_MAX_LINES - state.usedLines - sepLines;

		if (remainingBytes <= 0 || remainingLines <= 0) {
			break;
		}

		const partialText = buildPartialSection(candidates[index]!, remainingLines, remainingBytes);
		if (!partialText) {
			continue;
		}

		const metrics = measureText(partialText);
		partialSection = { index, text: partialText, metrics };
		addSection(state, metrics);
		break;
	}

	const omittedIndexes: number[] = [];
	for (let i = 0; i < candidates.length; i++) {
		if (fullIncluded.has(i) || partialSection?.index === i) {
			continue;
		}
		omittedIndexes.push(i);
	}

	return {
		strategy,
		fullIncluded,
		partialSection,
		omittedIndexes,
		usedBytes: state.usedBytes,
		usedLines: state.usedLines,
		sectionCount: state.sectionCount,
		fullCount: fullIncluded.size,
		fullSuccessCount,
	};
}
