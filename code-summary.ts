/**
 * Structural code summaries using tree-sitter ASTs.
 *
 * When a file is too large to return in full, this module produces a
 * structural summary: function bodies, class bodies, interface bodies,
 * array/object literals, template strings, block comments, and import
 * runs are elided (replaced with line-range markers). The result is
 * a sequence of kept/elided segments the read tool renders compactly.
 *
 * Powered by the same @vscode/tree-sitter-wasm grammar infrastructure
 * used by ast-chunker.ts and grammar-loader.ts.
 */
import { formatRecoveryHint } from "./utils.js";

// ══════════════════════════════════════════════════════════════════
// Public types
// ══════════════════════════════════════════════════════════════════

/** Options for structural code summarization. */
export interface SummaryOptions {
	/** Source code text to summarize. */
	code: string
	/** File path used to infer language by extension. */
	path?: string
	/** Minimum total body-node lines before eliding (default 4). */
	minBodyLines?: number
	/** Minimum total comment lines before eliding a block comment (default 6). */
	minCommentLines?: number
}

/** A kept or elided span in the summary output. */
export interface SummarySegment {
	kind: "kept" | "elided"
	/** 1-based inclusive start line. */
	startLine: number
	/** 1-based inclusive end line. */
	endLine: number
	/** Verbatim text for kept segments; absent for elided segments. */
	text?: string
}

/** Full summary result. */
export interface SummaryResult {
	/** Canonical language name when parsing succeeded. */
	language?: string
	/** True when tree-sitter parsed without syntax errors. */
	parsed: boolean
	/** True when at least one elision span was emitted. */
	elided: boolean
	/** Total source lines. */
	totalLines: number
	/** Kept/elided segments in source order. */
	segments: SummarySegment[]
}

// ══════════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════════

const DEFAULT_MIN_BODY_LINES = 4
const DEFAULT_MIN_COMMENT_LINES = 6
/** Maximum source size to attempt summarizing (2MB). */
const MAX_SUMMARY_BYTES = 2 * 1024 * 1024
/** Maximum source lines to attempt summarizing. */
const MAX_SUMMARY_LINES = 20_000

// ══════════════════════════════════════════════════════════════════
// Node kind tables — language-specific node types that are elidable
// ══════════════════════════════════════════════════════════════════

const COMMENT_NODE_TYPES: Record<string, string[]> = {
	".ts": ["comment"],
	".tsx": ["comment"],
	".js": ["comment"],
	".jsx": ["comment"],
	".mjs": ["comment"],
	".cjs": ["comment"],
	".rs": ["block_comment"],
	".py": ["comment"],
	".go": ["comment"],
	".java": ["block_comment"],
	".c": ["comment"],
	".cpp": ["comment"],
	".h": ["comment"],
	".hpp": ["comment"],
	".rb": ["comment"],
	".php": ["comment"],
	".css": ["comment"],
	".swift": ["comment"],
	".kt": ["block_comment"],
	".scala": ["block_comment"],
	".lua": ["comment"],
	".bash": ["comment"],
	".sh": ["comment"],
}

const ELIDABLE_NODE_TYPES: Record<string, string[]> = {
	".ts": [
		"statement_block", "object", "array", "template_string",
		"class_body", "interface_body", "enum_body",
		"switch_body", "jsx_element", "jsx_self_closing_element",
	],
	".tsx": [
		"statement_block", "object", "array", "template_string",
		"class_body", "interface_body", "enum_body",
		"switch_body", "jsx_element", "jsx_self_closing_element",
	],
	".js": [
		"statement_block", "object", "array", "template_string",
		"class_body", "switch_body", "jsx_element",
	],
	".jsx": [
		"statement_block", "object", "array", "template_string",
		"class_body", "switch_body", "jsx_element",
	],
	".mjs": [
		"statement_block", "object", "array", "template_string",
		"class_body", "switch_body",
	],
	".cjs": [
		"statement_block", "object", "array", "template_string",
		"class_body", "switch_body",
	],
	".py": [
		"block", "dictionary", "list", "set", "string", "tuple",
		"argument_list", "parameters", "parenthesized_expression",
		"list_comprehension", "set_comprehension",
		"dictionary_comprehension", "generator_expression",
		"import_from_statement", "subscript",
	],
	".rs": [
		"block", "array_expression", "tuple_expression",
		"struct_expression", "match_block", "raw_string_literal",
		"declaration_list", "field_declaration_list",
		"ordered_field_declaration_list", "enum_variant_list",
		"where_clause", "use_list", "macro_definition", "token_tree",
	],
	".go": [
		"block", "composite_literal", "interpreted_string_literal",
		"raw_string_literal", "import_spec_list", "const_declaration",
		"var_declaration", "field_declaration_list",
		"interface_type", "expression_switch_statement",
		"type_switch_statement", "select_statement",
	],
	".java": [
		"block", "array_initializer", "class_body",
		"interface_body", "enum_body", "annotation_type_body",
		"constructor_body", "switch_block",
	],
	".c": [
		"compound_statement", "initializer_list", "string_literal",
		"field_declaration_list", "enumerator_list",
	],
	".cpp": [
		"compound_statement", "initializer_list", "string_literal",
		"field_declaration_list", "enumerator_list",
		"declaration_list", "raw_string_literal",
	],
	".h": [
		"compound_statement", "string_literal",
	],
	".hpp": [
		"compound_statement", "initializer_list", "string_literal",
		"field_declaration_list", "enumerator_list",
		"declaration_list", "raw_string_literal",
	],
	".rb": [
		"body_statement", "method", "do_block", "array", "hash",
		"block", "case", "heredoc_body",
	],
	".php": [
		"compound_statement", "array_creation_expression",
		"declaration_list", "enum_declaration_list",
		"match_block", "heredoc", "nowdoc",
	],
	".swift": [
		"function_body", "array_literal", "dictionary_literal",
		"multi_line_string_literal", "class_body",
		"protocol_body", "enum_class_body", "computed_property",
	],
	".css": ["block", "keyframe_block_list"],
	".elm": ["block", "list_expression", "object_expression", "case_match"],
	".bash": ["compound_statement", "if_statement", "case_statement", "do_group", "subshell", "array", "heredoc_body"],
	".sh": ["compound_statement", "if_statement", "case_statement", "do_group", "subshell", "array", "heredoc_body"],
	".lua": ["block", "table_constructor", "string"],
	".scala": ["block", "collection_literal", "template_body", "enum_body", "match_expression", "string"],
	".kt": ["function_body", "collection_literal", "multi_line_string_literal", "class_body", "enum_class_body", "when_expression", "import_list"],
}

const GROUPABLE_NODE_TYPES: Record<string, string[]> = {
	".ts": ["import_statement"],
	".tsx": ["import_statement"],
	".js": ["import_statement"],
	".jsx": ["import_statement"],
	".mjs": ["import_statement"],
	".cjs": ["import_statement"],
	".rs": ["use_declaration", "extern_crate_declaration"],
	".py": ["import_statement", "import_from_statement", "future_import_statement"],
	".go": ["import_declaration"],
	".java": ["import_declaration"],
	".c": ["preproc_include"],
	".cpp": ["preproc_include"],
	".h": ["preproc_include"],
	".hpp": ["preproc_include"],
	".php": ["namespace_use_declaration"],
	".swift": ["import_declaration"],
	".scala": ["import_declaration", "import"],
	".kt": [],
}

// ══════════════════════════════════════════════════════════════════
// Internal helpers
// ══════════════════════════════════════════════════════════════════

interface LineSpan {
	start: number
	end: number
}

function countLines(source: string): number {
	if (source.length === 0) return 0
	return Math.max(1, source.split("\n").length)
}

function getExt(filePath: string): string {
	const dot = filePath.lastIndexOf(".")
	if (dot === -1) return ""
	return filePath.slice(dot).toLowerCase()
}

function nodeStartLine(node: { startPosition: { row: number } }): number {
	return (node.startPosition.row & 0xffffffff) + 1
}

function nodeEndLine(node: { endPosition: { row: number; column: number } }): number {
	const pos = node.endPosition
	const row = (pos.column === 0 && pos.row > 0) ? pos.row - 1 : pos.row
	return (row & 0xffffffff) + 1
}

function nodeLineCount(node: { startPosition: { row: number }; endPosition: { row: number; column: number } }): number {
	return nodeEndLine(node) - nodeStartLine(node) + 1
}

// ══════════════════════════════════════════════════════════════════
// Core summarization
// ══════════════════════════════════════════════════════════════════

/**
 * Produce a structural summary of source code.
 *
 * Uses tree-sitter AST to identify elidable bodies, comments, and
 * import runs. Returns a list of kept/elided segments that render
 * compactly while preserving structural landmarks.
 */
export async function summarizeCode(options: SummaryOptions): Promise<SummaryResult> {
	const { code, path, minBodyLines, minCommentLines } = options
	const totalLines = countLines(code)

	if (code.length === 0) {
		return { parsed: false, elided: false, totalLines, segments: [] }
	}

	if (code.length > MAX_SUMMARY_BYTES || totalLines > MAX_SUMMARY_LINES) {
		return { parsed: false, elided: false, totalLines, segments: [] }
	}

	const ext = path ? getExt(path) : ""
	if (!ext || !ELIDABLE_NODE_TYPES[ext]) {
		// Unsupported language — return full text as single kept segment
		return {
			parsed: false,
			elided: false,
			totalLines,
			segments: [{ kind: "kept", startLine: 1, endLine: totalLines, text: code }],
		}
	}

	let grammarInfo: any = null
	try {
		const gl = await import("./grammar-loader.js");
		grammarInfo = await gl.loadGrammar(ext);
	} catch {
		/* fall through */
	}
	if (!grammarInfo) {
		return {
			parsed: false,
			elided: false,
			totalLines,
			segments: [{ kind: "kept", startLine: 1, endLine: totalLines, text: code }],
		}
	}

	 
	const language = grammarInfo.language as any

	let tree: any = null
	let parserInstance: any = null
	try {
		const tsModule: any = (await import("web-tree-sitter")).default
		parserInstance = new tsModule()
		try {
			parserInstance.setLanguage(language)
		} catch {
			// Incompatible WASM language version — fall through to unparsed
			return {
				language: ext,
				parsed: false,
				elided: false,
				totalLines,
				segments: [{ kind: "kept", startLine: 1, endLine: totalLines, text: code }],
			}
		}
		tree = parserInstance.parse(code)

		if (tree.rootNode.hasError) {
			return {
				language: ext,
				parsed: false,
				elided: false,
				totalLines,
				segments: [{ kind: "kept", startLine: 1, endLine: totalLines, text: code }],
			}
		}

		const minBody = Math.max(2, minBodyLines ?? DEFAULT_MIN_BODY_LINES)
		const minComment = Math.max(4, minCommentLines ?? DEFAULT_MIN_COMMENT_LINES)
		const commentKinds = new Set(COMMENT_NODE_TYPES[ext] ?? [])
		const elidableKinds = new Set(ELIDABLE_NODE_TYPES[ext] ?? [])
		const groupableKinds = new Set(GROUPABLE_NODE_TYPES[ext] ?? [])

		const spans: LineSpan[] = []
		collectElisions(tree.rootNode, commentKinds, elidableKinds, groupableKinds, minBody, minComment, spans)
		const normalized = normalizeSpans(spans, totalLines)
		const segments = buildSegments(code, totalLines, normalized)

		return {
			language: ext,
			parsed: true,
			elided: normalized.length > 0,
			totalLines,
			segments,
		}
	} finally {
		if (tree) { try { tree.delete() } catch { /* ignore */ } }
		if (parserInstance) { try { parserInstance.delete() } catch { /* ignore */ } }
	}
}

function collectElisions(
	node: any,
	commentKinds: Set<string>,
	elidableKinds: Set<string>,
	groupableKinds: Set<string>,
	minBodyLines: number,
	minCommentLines: number,
	spans: LineSpan[],
): void {
	const totalLines = nodeLineCount(node)

	// Comments
	if (commentKinds.has(node.type)) {
		if (totalLines >= minCommentLines) {
			const start = nodeStartLine(node) + 2
			const end = nodeEndLine(node) - 1
			if (start <= end) spans.push({ start, end })
		}
		return
	}

	// Elidable bodies / literals
	if (elidableKinds.has(node.type) && totalLines >= minBodyLines) {
		const start = nodeStartLine(node) + 1
		const end = nodeEndLine(node) - 1
		if (start <= end) {
			spans.push({ start, end })
			return
		}
	}

	// Import run detection
	if (groupableKinds.size > 0 && node.children) {
		const children: any[] = Array.isArray(node.children) ? node.children
			: node.namedChildren ? [...node.namedChildren] : []

		let runFirst: any = null
		let runLast: any = null
		let runCount = 0

		for (const child of children) {
			if (groupableKinds.has(child.type)) {
				if (!runFirst) runFirst = child
				runLast = child
				runCount++
			} else {
				flushImportRun(runFirst, runLast, runCount, minBodyLines, spans)
				runFirst = null
				runLast = null
				runCount = 0
			}
		}
		flushImportRun(runFirst, runLast, runCount, minBodyLines, spans)
	}

	// Recurse into children
	const children: any[] = Array.isArray(node.children) ? node.children
		: node.namedChildren ? [...node.namedChildren] : []

	for (const child of children) {
		try {
			collectElisions(child, commentKinds, elidableKinds, groupableKinds, minBodyLines, minCommentLines, spans)
		} catch { /* skip malformed nodes */ }
	}
}

function flushImportRun(
	first: any,
	last: any,
	count: number,
	minBodyLines: number,
	spans: LineSpan[],
): void {
	if (count < 2) return
	if (!first || !last) return
	const firstStart = nodeStartLine(first)
	const lastStart = nodeStartLine(last)
	const lastEnd = nodeEndLine(last)
	const spanLines = lastEnd - firstStart + 1
	if (spanLines < minBodyLines) return
	const start = firstStart + 1
	const end = lastStart - 1
	if (start <= end) spans.push({ start, end })
}

function normalizeSpans(spans: LineSpan[], totalLines: number): LineSpan[] {
	spans = spans.filter(s => s.start <= s.end && s.start <= totalLines)
	for (const s of spans) s.end = Math.min(s.end, totalLines)
	spans.sort((a, b) => a.start - b.start)

	const merged: LineSpan[] = []
	for (const span of spans) {
		const last = merged[merged.length - 1]
		if (last && span.start <= last.end + 1) {
			last.end = Math.max(last.end, span.end)
		} else {
			merged.push({ ...span })
		}
	}
	return merged
}

function buildSegments(source: string, totalLines: number, spans: LineSpan[]): SummarySegment[] {
	if (totalLines === 0) return []
	const sourceLines = source.split("\n")
	const elidedSet = new Set<number>()
	for (const span of spans) {
		for (let i = span.start; i <= span.end; i++) elidedSet.add(i)
	}

	const segments: SummarySegment[] = []
	let currentKind: "kept" | "elided" | null = null
	let currentStart = 1
	let currentLines: string[] = []

	for (let lineNum = 1; lineNum <= totalLines; lineNum++) {
		const isElided = elidedSet.has(lineNum)
		const kind: "kept" | "elided" = isElided ? "elided" : "kept"

		if (currentKind !== null && currentKind !== kind) {
			segments.push({
				kind: currentKind,
				startLine: currentStart,
				endLine: lineNum - 1,
				text: currentKind === "kept" ? currentLines.join("\n") : undefined,
			})
			currentStart = lineNum
			currentLines = []
		}
		currentKind = kind
		if (!isElided) {
			currentLines.push(sourceLines[lineNum - 1] ?? "")
		}
	}

	if (currentKind !== null) {
		segments.push({
			kind: currentKind,
			startLine: currentStart,
			endLine: totalLines,
			text: currentKind === "kept" ? currentLines.join("\n") : undefined,
		})
	}

	return segments
}

// ══════════════════════════════════════════════════════════════════
// Rendering
// ══════════════════════════════════════════════════════════════════

/**
 * Render a summary result to a display string suitable for the model.
 *
 * Kept segments are concatenated verbatim. Elided segments are replaced
 * with concise markers. The output includes a recovery hint telling the
 * model how to retrieve the full file.
 */
export function renderSummary(
	result: SummaryResult,
	filePath: string,
): { text: string; elidedSpans: number; elidedLines: number } {
	const parts: string[] = []
	let elidedSpans = 0
	let elidedLines = 0

	for (const seg of result.segments) {
		if (seg.kind === "kept") {
			parts.push(seg.text ?? "")
		} else {
			elidedSpans++
			const lines = seg.endLine - seg.startLine + 1
			elidedLines += lines
			if (lines === 1) {
				parts.push(`  /* line ${seg.startLine} elided */`)
			} else if (lines <= 3) {
				parts.push(`  /* lines ${seg.startLine}-${seg.endLine} elided */`)
			} else {
				parts.push(`  /* … lines ${seg.startLine}-${seg.endLine} elided … */`)
			}
		}
	}

	let text = parts.join("\n")

	if (elidedSpans > 0) {
		const hint = formatRecoveryHint(filePath, filePath, {
			type: "elided",
			spans: { count: elidedSpans, lines: elidedLines },
		})
		text = `${text}\n\n${hint}`
	}

	return { text, elidedSpans, elidedLines }
}

/**
 * Check if code can be summarized (has a supported grammar and is
 * within size limits).
 */
export function canSummarize(filePath: string, codeSize: number, codeLines: number): boolean {
	const ext = getExt(filePath)
	if (!ext || !ELIDABLE_NODE_TYPES[ext]) return false
	if (codeSize > MAX_SUMMARY_BYTES) return false
	if (codeLines > MAX_SUMMARY_LINES) return false
	return true
}
