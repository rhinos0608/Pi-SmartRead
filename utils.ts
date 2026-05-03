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

export function measureText(text: string): TextMetrics {
	return {
		bytes: Buffer.byteLength(text, "utf-8"),
		lines: text.length === 0 ? 0 : text.split("\n").length,
	};
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

/**
 * Prefix each line of body with a 1-based line number and pipe separator.
 * This produces hashline-compatible output that smart-edit can reference
 * in edits via the hashline format: { pos: '42|', end: '45|' }.
 *
 * Line-numbered format: "42|    return x;"
 * Empty lines keep the line number for positional reference.
 * The separator '|' is chosen to be single-token in BPE and visually clear.
 */
export function prefixLinesWithAnchors(body: string): string {
	const lines = body.split("\n");
	return lines.map((line, i) => {
		const lineNum = i + 1;
		return `${lineNum}|${line}`;
	}).join("\n");
}

/**
 * Format a content block with hashline-friendly line-number prefixes.
 *
 * Each line is prefixed with "LINE|" so the model can reference specific
 * lines in edits without reproducing text. Smart-edit's hashline edit
 * format supports "LINE|" anchors as an alternative to "LINE+HASH".
 */
export function formatContentBlock(path: string, body: string, index: number): string {
	const delimiter = pickDelimiter(path, index, body);
	const anchoredBody = prefixLinesWithAnchors(body);
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

export function buildPartialSection(candidate: FileCandidate, remainingLines: number, remainingBytes: number): string | undefined {
	if (!candidate.body) {
		return undefined;
	}

	// Wrapper adds 3 structural lines around body in `formatContentBlock`.
	let maxBodyLines = remainingLines - 3;
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

		const partialText = formatContentBlock(candidate.path, trunc.content, candidate.index + 1);
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
