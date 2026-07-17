/**
 * Multi-signal complexity computation for the reranker.
 *
 * Pure, dependency-free functions that derive numeric signals from a
 * lightweight AST representation.  Used by WP-7 to expand reranking
 * beyond graph / temporal / proximity signals.
 *
 * Reuses shingle / MinHash primitives from near-clone.ts for
 * computeMinHashProximity.
 */

import {
  shingles,
  minHashSignature,
  jaccard,
} from "./near-clone.js";

// ── Generic AST node ──────────────────────────────────────────────

export interface ComplexityASTNode {
  /** Node type (e.g. "function_declaration", "binary_expression"). */
  type: string;
  /** Child nodes. */
  children?: ComplexityASTNode[];
}

// ── Halstead-lite ─────────────────────────────────────────────────

/** Operator and operand tokens recognised as language-level keywords. */
const OPERATORS = new Set([
  "+", "-", "*", "/", "%", "**",
  "==", "!=", "===", "!==", "<", ">", "<=", ">=",
  "&&", "||", "!",
  "&", "|", "^", "~", "<<", ">>", ">>>",
  "?", ":", "=",
  "+=", "-=", "*=", "/=", "%=",
  "++", "--",
  "in", "instanceof", "typeof", "void", "delete",
  "new", "throw", "return", "yield", "await",
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
  "try", "catch", "finally",
]);

function isOperator(node: ComplexityASTNode): boolean {
  return OPERATORS.has(node.type);
}

/** Identifier / literal types treated as operands. */
const OPERAND_TYPES = new Set([
  "identifier", "property_identifier", "shorthand_property_identifier",
  "type_identifier",
  "number", "integer", "string", "template_string", "true", "false",
  "null", "undefined", "regex",
]);

function isOperand(node: ComplexityASTNode): boolean {
  return OPERAND_TYPES.has(node.type);
}



function walkAll(node: ComplexityASTNode, visit: (n: ComplexityASTNode) => void): void {
  visit(node);
  if (node.children) {
    for (const child of node.children) walkAll(child, visit);
  }
}

export interface HalsteadResult {
  operandCount: number;
  operatorCount: number;
  vocabulary: number;
  volume: number;
}

/**
 * Lightweight Halstead metrics from a generic AST node tree.
 *
 * Operands and operators are classified heuristically from leaf node
 * types.  `volume` follows the classic Halstead formula:
 *   volume = N * log₂(V)   where N = n₁ + n₂, V = n₁_unique + n₂_unique.
 */
export function computeHalsteadLite(ast: ComplexityASTNode): HalsteadResult {
  const operators = new Set<string>();
  const operands = new Set<string>();
  let opCount = 0;
  let operCount = 0;

  walkAll(ast, (node) => {
    if (isOperator(node)) {
      opCount++;
      operators.add(node.type);
    } else if (isOperand(node)) {
      operCount++;
      operands.add(node.type);
    }
  });

  const n = opCount + operCount;
  const v = operators.size + operands.size;
  const volume = n > 0 && v > 1 ? n * Math.log2(v) : 0;

  return {
    operandCount: operCount,
    operatorCount: opCount,
    vocabulary: v,
    volume,
  };
}

// ── AST profile ───────────────────────────────────────────────────

export interface AstProfileResult {
  /** Maximum nesting depth (root = 0). */
  depth: number;
  /** Average branching factor across non-leaf nodes. */
  branchingFactor: number;
  /** Cyclomatic complexity (number of decision points + 1). */
  cyclomaticComplexity: number;
  /** Total number of AST nodes. */
  nodeCount: number;
}

const BRANCHING_TYPES = new Set([
  "if_statement",
  "for_statement", "for_in_statement", "for_of_statement",
  "while_statement", "do_statement",
  "case_clause", "switch_case",
  "conditional_expression", "ternary_expression",
  "catch_clause",
  "logical_expression",
]);

function computeDepth(node: ComplexityASTNode, current: number): number {
  let maxDepth = current;
  if (node.children) {
    for (const child of node.children) {
      const d = computeDepth(child, current + 1);
      if (d > maxDepth) maxDepth = d;
    }
  }
  return maxDepth;
}

function countBranching(node: ComplexityASTNode): { decisions: number; nonLeaf: number } {
  let decisions = 0;
  let nonLeaf = 0;

  function walk(n: ComplexityASTNode): void {
    if (n.children && n.children.length > 0) {
      nonLeaf++;
      if (BRANCHING_TYPES.has(n.type)) decisions++;
      for (const child of n.children) walk(child);
    }
  }
  walk(node);
  return { decisions, nonLeaf };
}

function countNodes(node: ComplexityASTNode): number {
  let count = 1;
  if (node.children) {
    for (const child of node.children) count += countNodes(child);
  }
  return count;
}

/**
 * Structural profile of an AST: depth, branching, cyclomatic complexity, node count.
 */
export function computeAstProfile(ast: ComplexityASTNode): AstProfileResult {
  const depth = computeDepth(ast, 0);
  const nodeCount = countNodes(ast);
  const { decisions, nonLeaf } = countBranching(ast);
  let totalChildren = 0;
  function countAvgChildren(n: ComplexityASTNode): void {
    if (n.children && n.children.length > 0) {
      totalChildren += n.children.length;
      for (const child of n.children) countAvgChildren(child);
    }
  }
  countAvgChildren(ast);

  return {
    depth,
    branchingFactor: nonLeaf > 0 ? totalChildren / nonLeaf : 0,
    cyclomaticComplexity: decisions + 1,
    nodeCount,
  };
}

// ── MinHash proximity ─────────────────────────────────────────────

/**
 * Structural similarity score (0.0–1.0) between two AST node trees
 * using shingle sets of AST node-type sequences + MinHash Jaccard estimation.
 *
 * Reuses `shingles`, `minHashSignature`, and `jaccard` from near-clone.ts.
 */
export function computeMinHashProximity(
  sourceAst: ComplexityASTNode,
  candidateAst: ComplexityASTNode,
): number {
  const sourceTokens = flattenNodeTypes(sourceAst);
  const candidateTokens = flattenNodeTypes(candidateAst);

  if (sourceTokens.length === 0 && candidateTokens.length === 0) return 1;
  if (sourceTokens.length === 0 || candidateTokens.length === 0) return 0;

  const sourceShingles = shingles(sourceTokens, 3);
  const candidateShingles = shingles(candidateTokens, 3);

  if (sourceShingles.size === 0 && candidateShingles.size === 0) return 1;
  if (sourceShingles.size === 0 || candidateShingles.size === 0) return 0;

  // Use MinHash signatures for efficient Jaccard estimation
  const sourceSig = minHashSignature(sourceShingles, 64);
  const candidateSig = minHashSignature(candidateShingles, 64);

  // Count matching hash positions
  let matches = 0;
  for (let i = 0; i < sourceSig.length; i++) {
    if (sourceSig[i] === candidateSig[i]) matches++;
  }

  // MinHash Jaccard estimate
  const minHashEstimate = matches / sourceSig.length;

  // Blend with exact Jaccard on shingle sets for better accuracy on small ASTs
  const exactJaccard = jaccard(sourceShingles, candidateShingles);

  // Weight: 70% MinHash estimate, 30% exact Jaccard (MinHash is faster on large sets)
  return 0.7 * minHashEstimate + 0.3 * exactJaccard;
}

/** Flatten AST into a sequence of node types (for shingling). */
function flattenNodeTypes(node: ComplexityASTNode): string[] {
  const types: string[] = [];
  function walk(n: ComplexityASTNode): void {
    types.push(n.type);
    if (n.children) {
      for (const child of n.children) walk(child);
    }
  }
  walk(node);
  return types;
}
