/**
 * AST symbol outline for large source files.
 *
 * When an unbounded `read({ path })` targets a supported source file above
 * a size threshold, this module produces a compact list of top-level and
 * nested declarations (signature + line range, no bodies) instead of
 * dumping the full file. Backed by the same web-tree-sitter WASM grammar
 * infrastructure as ast-chunker.ts/code-summary.ts — no external `ast-grep`
 * binary dependency.
 *
 * Returns null on unsupported languages or parse failures so the caller
 * falls back to the normal full-file read.
 */
import { loadGrammar, getSupportedExtensions } from "./grammar-loader.js";
import { NODE_TYPE_TO_SYMBOL_TYPE, getNameFromNode, type AstSymbolSpan } from "./ast-chunker.js";

// ── Config ───────────────────────────────────────────────────────

const DEFAULT_THRESHOLD_BYTES = 20_000;
const MAX_RENDERED_SYMBOLS = 300;

export interface AstOutlineConfig {
	readonly enabled: boolean;
	readonly thresholdBytes: number;
}

export function resolveAstOutlineConfig(env: Record<string, string | undefined> = process.env): AstOutlineConfig {
	const enabled = env.PI_SMARTREAD_AST_OUTLINE !== "0";
	const raw = env.PI_SMARTREAD_AST_OUTLINE_BYTES ? Number.parseInt(env.PI_SMARTREAD_AST_OUTLINE_BYTES, 10) : NaN;
	const thresholdBytes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_THRESHOLD_BYTES;
	return { enabled, thresholdBytes };
}

const supportedExtensionSet = new Set(getSupportedExtensions());

/** Cheap pre-check: does this extension have a symbol-kind table, without loading any grammar. */
export function outlineSupportsPath(filePath: string): boolean {
	const ext = extOf(filePath);
	return supportedExtensionSet.has(ext) && ext in EXT_KINDS;
}

function extOf(filePath: string): string {
	const dot = filePath.lastIndexOf(".");
	return dot === -1 ? "" : filePath.slice(dot).toLowerCase();
}

// ── Per-language declaration-node allowlist ─────────────────────
// Deliberately narrower than ast-chunker's SYMBOL_NODE_TYPES: excludes
// wrapper nodes (export_statement, variable_declarator, decorated_definition)
// that nest around one of these kinds and would otherwise show up twice.

const TS_KINDS = [
	"class_declaration", "abstract_class_declaration", "function_declaration",
	"interface_declaration", "type_alias_declaration", "enum_declaration",
	"method_definition", "lexical_declaration",
];
const JS_KINDS = ["class_declaration", "function_declaration", "method_definition", "lexical_declaration"];
const PY_KINDS = ["class_definition", "function_definition"];
const RS_KINDS = [
	"function_item", "struct_item", "enum_item", "impl_item", "trait_item",
	"mod_item", "const_item", "static_item", "type_item",
];
const GO_KINDS = ["function_declaration", "method_declaration", "type_declaration"];
const JAVA_KINDS = ["class_declaration", "interface_declaration", "enum_declaration", "method_declaration", "constructor_declaration"];
const C_KINDS = ["function_definition", "struct_specifier", "enum_specifier"];
const CPP_KINDS = [...C_KINDS, "class_specifier"];
const RUBY_KINDS = ["class", "module", "method", "singleton_method"];
const SH_KINDS = ["function_definition"];

const EXT_KINDS: Record<string, string[]> = {
	".ts": TS_KINDS, ".tsx": TS_KINDS, ".mts": TS_KINDS, ".cts": TS_KINDS,
	".js": JS_KINDS, ".jsx": JS_KINDS, ".mjs": JS_KINDS, ".cjs": JS_KINDS,
	".py": PY_KINDS,
	".rs": RS_KINDS,
	".go": GO_KINDS,
	".java": JAVA_KINDS,
	".c": C_KINDS, ".h": C_KINDS,
	".cpp": CPP_KINDS, ".hpp": CPP_KINDS,
	".rb": RUBY_KINDS,
	".sh": SH_KINDS, ".bash": SH_KINDS,
};

// ── Types ────────────────────────────────────────────────────────

export interface OutlineSymbol {
	readonly type: AstSymbolSpan["type"];
	readonly name: string;
	readonly signature: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly depth: number;
}

export interface AstOutlineResult {
	readonly language: string;
	readonly symbols: OutlineSymbol[];
	readonly totalLines: number;
}

// ── Extraction ───────────────────────────────────────────────────

function nodeStartLine(node: { startPosition: { row: number } }): number {
	return node.startPosition.row + 1;
}

function nodeEndLine(node: { endPosition: { row: number; column: number } }): number {
	const pos = node.endPosition;
	const row = pos.column === 0 && pos.row > 0 ? pos.row - 1 : pos.row;
	return row + 1;
}

function signatureOf(nodeText: string): string {
	const first = nodeText.split("\n", 1)[0] ?? "";
	const brace = first.indexOf("{");
	const cut = brace >= 0 ? first.slice(0, brace) : first;
	return cut.replace(/\s*;\s*$/, "").trim().slice(0, 100);
}

/**
 * Build a symbol outline for source code, or null when the language is
 * unsupported, the grammar failed to load, the tree has parse errors, or
 * no symbols were found (all cases where a full-file read serves the
 * caller better than an empty/degraded outline).
 */
export async function buildAstOutline(content: string, filePath: string): Promise<AstOutlineResult | null> {
	const ext = extOf(filePath);
	const kinds = EXT_KINDS[ext];
	if (!kinds || content.length === 0) return null;

	const grammarInfo = await loadGrammar(ext).catch(() => null);
	if (!grammarInfo) return null;

	const kindSet = new Set(kinds);
	const totalLines = content.split("\n").length;

	let parserInstance: any = null;
	let tree: any = null;
	try {
		const ParserModule: any = (await import("web-tree-sitter")).default;
		if (!ParserModule) return null;
		parserInstance = new ParserModule();
		try {
			parserInstance.setLanguage(grammarInfo.language as any);
		} catch {
			return null; // incompatible WASM language version
		}
		tree = parserInstance.parse(content);
		const rootNode = tree.rootNode;
		if (rootNode.hasError) return null;

		type RawSpan = { type: AstSymbolSpan["type"]; name: string; signature: string; startLine: number; endLine: number };
		const raw: RawSpan[] = [];
		const cursor = rootNode.walk();
		while (true) {
			const node = cursor.currentNode;
			if (node && kindSet.has(node.type)) {
				const name = getNameFromNode(node);
				if (name) {
					raw.push({
						type: NODE_TYPE_TO_SYMBOL_TYPE[node.type] ?? "function",
						name,
						signature: signatureOf(node.text as string),
						startLine: nodeStartLine(node),
						endLine: nodeEndLine(node),
					});
				}
			}
			if (cursor.gotoFirstChild()) continue;
			if (cursor.gotoNextSibling()) continue;
			let reachedRoot = false;
			while (true) {
				if (!cursor.gotoParent()) { reachedRoot = true; break; }
				if (cursor.gotoNextSibling()) break;
			}
			if (reachedRoot) break;
		}

		if (raw.length === 0) return null;

		raw.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
		const symbols: OutlineSymbol[] = raw.map((s) => ({
			...s,
			depth: raw.filter((o) => o !== s && o.startLine <= s.startLine && s.endLine <= o.endLine && (o.startLine < s.startLine || s.endLine < o.endLine)).length,
		}));

		return { language: ext, symbols, totalLines };
	} catch {
		return null;
	} finally {
		if (tree) { try { tree.delete(); } catch { /* ignore */ } }
		if (parserInstance) { try { parserInstance.delete(); } catch { /* ignore */ } }
	}
}

// ── Rendering ────────────────────────────────────────────────────

export interface RenderedOutline {
	readonly text: string;
	/** 1-based declaration line numbers actually shown, one per rendered symbol. */
	readonly declarationLines: number[];
	readonly symbolCount: number;
	readonly renderedCount: number;
}

export function renderAstOutline(result: AstOutlineResult, filePath: string, byteLength: number): RenderedOutline {
	const shown = result.symbols.slice(0, MAX_RENDERED_SYMBOLS);
	const kb = Math.round(byteLength / 1024);
	const lines = shown.map((s) => `${"  ".repeat(s.depth)}${s.signature}  [${s.startLine}-${s.endLine}]`);
	const omitted = result.symbols.length - shown.length;
	const parts = [
		`Structural outline: ${filePath} (${result.symbols.length} symbols, ${result.totalLines} lines, ${kb}KB)`,
		"This is a compact AST outline, not the full file. Bodies are omitted.",
		"─".repeat(40),
		...lines,
		"─".repeat(40),
	];
	if (omitted > 0) parts.push(`… ${omitted} more symbols omitted.`);
	parts.push(
		`Use read({ path: "${filePath}", symbol: "<Name>" }) for one symbol's full source, ` +
		`or read({ path: "${filePath}", offset, limit }) for a specific line range.`,
	);
	return {
		text: parts.join("\n"),
		declarationLines: shown.map((s) => s.startLine),
		symbolCount: result.symbols.length,
		renderedCount: shown.length,
	};
}
