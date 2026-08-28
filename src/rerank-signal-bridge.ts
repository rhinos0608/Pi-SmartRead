/**
 * Narrow bridge: enrich RerankerInput candidates with AST-derived signals
 * (halsteadComplexity, astProfile, minHashProximity) from already-read file bodies.
 *
 * No disk reads — callers pass bodies from successfulFiles[].body.
 * Graceful degradation: parse failures or unsupported languages leave fields undefined.
 */

import { createRequire } from "node:module";
import { filenameToLang, type SupportedLanguage } from "./languages.js";
import {
  computeHalsteadLite,
  computeAstProfile,
  computeMinHashProximity,
  type ComplexityASTNode,
} from "./complexity-signals.js";
import type { RerankerInput } from "./rerank.js";

const require = createRequire(import.meta.url);

const AST_LANGS = new Set<SupportedLanguage>([
  "typescript",
  "tsx",
  "javascript",
  "python",
]);

const MAX_CANDIDATES = 20;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Convert a tree-sitter SyntaxNode to ComplexityASTNode (lightweight). */
function toComplexityNode(node: any): ComplexityASTNode {
  const children: ComplexityASTNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) children.push(toComplexityNode(child));
  }
  return { type: node.type, children: children.length > 0 ? children : undefined };
}

/**
 * Enrich reranker inputs with halsteadComplexity, astProfile, minHashProximity.
 *
 * - Parses each candidate's body with tree-sitter (from in-memory string, no disk reads).
 * - Only populates signals for supported languages (ts/js/py).
 * - minHashProximity is computed against the first successfully-parsed RRF-ranked candidate
 *   (deterministic reference choice).
 * - On parse failure or unsupported language, fields are left undefined (graceful degradation).
 */
export async function enrichRerankSignals(
  inputs: RerankerInput[],
  bodyByPath: Map<string, string>,
): Promise<RerankerInput[]> {
  const slice = inputs.slice(0, MAX_CANDIDATES);
  const rest = inputs.slice(MAX_CANDIDATES);

  const Parser = (await import("tree-sitter")).default;
  const parser = new Parser();

  // Pre-load grammars
  const grammarModules: Record<string, any> = {};
  for (const lang of AST_LANGS) {
    try {
      if (lang === "typescript" || lang === "tsx") {
        grammarModules[lang] = require("tree-sitter-typescript")[lang === "tsx" ? "tsx" : "typescript"];
      } else if (lang === "javascript") {
        grammarModules[lang] = require("tree-sitter-javascript");
      } else if (lang === "python") {
        grammarModules[lang] = require("tree-sitter-python");
      }
    } catch (grammarLoadErr) {
      // Grammar unavailable — language will be treated as unsupported
      void grammarLoadErr;
    }
  }

  // Track the first successfully-parsed candidate as reference
  let referenceAst: ComplexityASTNode | null = null;

  const enriched: RerankerInput[] = slice.map((input) => {
    const body = bodyByPath.get(input.path);
    if (!body) return input;

    const lang = filenameToLang(input.path);
    if (!lang || !AST_LANGS.has(lang)) return input;

    const grammar = grammarModules[lang];
    if (!grammar) return input;

    try {
      parser.setLanguage(grammar);
      const tree = parser.parse(body);
      const root = tree.rootNode;
      if (!root || root.hasError) return input;

      const complexityNode = toComplexityNode(root);

      // halsteadComplexity = volume (higher = more complex, penalised in reranker)
      const halstead = computeHalsteadLite(complexityNode);

      // astProfile = clamp((cyclomaticComplexity - 1) / 20, 0, 1)
      const profile = computeAstProfile(complexityNode);
      const astProfile = clamp((profile.cyclomaticComplexity - 1) / 20, 0, 1);

      // minHashProximity — first successful parse is the deterministic reference
      let minHashProximity: number | undefined;
      if (referenceAst) {
        minHashProximity = computeMinHashProximity(referenceAst, complexityNode);
      } else {
        referenceAst = complexityNode;
        // Self-proximity when no prior reference (should be ~1.0 but computed normally)
        minHashProximity = computeMinHashProximity(complexityNode, complexityNode);
      }

      return {
        ...input,
        halsteadComplexity: halstead.volume,
        astProfile,
        minHashProximity,
      };
    } catch (_parseErr) {
      // Parse failure: leave all fields undefined (graceful degradation)
      void _parseErr;
      return input;
    }
  });

  return [...enriched, ...rest];
}
