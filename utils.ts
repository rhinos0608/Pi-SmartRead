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

export function buildLineSet(content: string): Set<string> {
	const lines = content.split("\n");
	const set = new Set<string>();
	for (const line of lines) {
		set.add(line.replace(/\r$/, ""));
	}
	return set;
}

export function pickDelimiter(path: string, index: number, content: string): string {
	const lineSet = buildLineSet(content);
	const word = DELIMITER_WORDS[index - 1] ?? `FILE${index}`;
	const hash = createPathHash(path);
	const base = `${word}_${index}_${hash}`;

	if (!lineSet.has(base)) {
		return base;
	}

	for (let attempt = 1; attempt <= 256; attempt++) {
		const candidate = `${base}_${attempt}`;
		if (!lineSet.has(candidate)) {
			return candidate;
		}
	}

	// Safety fallback: keep deriving deterministic candidates until one is guaranteed free.
	const fallbackBase = `${base}_${content.length.toString(36).toUpperCase()}`;
	if (!lineSet.has(fallbackBase)) {
		return fallbackBase;
	}

	for (let suffix = 1; suffix <= 10_000; suffix++) {
		const candidate = `${fallbackBase}_${suffix}`;
		if (!lineSet.has(candidate)) {
			return candidate;
		}
	}

	throw new Error(
		`pickDelimiter: could not find a unique delimiter for "${path}" after exhaustive search. ` +
		"File content contains an unusual density of delimiter-like strings.",
	);
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

export function formatContentBlock(path: string, body: string, index: number): string {
	const delimiter = pickDelimiter(path, index, body);
	return `@${path}\n<<'${delimiter}'\n${body}\n${delimiter}`;
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
