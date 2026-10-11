/**
 * Per-tool SmartRead routing guidance.
 *
 * Single source of text for two delivery paths:
 * - Pi extension: each registered tool carries `promptSnippet` (one line in
 *   the Available tools section) and `promptGuidelines` (bullets appended to
 *   the Guidelines section while that tool is active). Look up by tool name
 *   via {@link getSmartReadToolGuidance}.
 * - Combined guide: {@link renderSmartReadToolGuide} composes the same
 *   per-tool data into the full "SmartRead Tool Guide" used by the MCP
 *   server instructions and the `smartread-tool-guide` MCP prompt.
 *
 * Every guideline bullet must make sense alone: Pi shows a tool's bullets
 * only while that tool is active, so no bullet may rely on another tool's
 * bullets for context.
 */

export const SMARTREAD_TOOL_GUIDE_TITLE = "SmartRead Tool Guide";

export interface SmartReadToolGuidance {
  /** One-line routing snippet for the Available tools section. */
  readonly snippet: string;
  /** 1-4 standalone guideline bullets for the Guidelines section. */
  readonly guidelines: readonly string[];
}

const READ_SNIPPET =
  "read returns already-known source content with strong workspace evidence — no discovery; use grep or find to locate content first.";

const READ_GUIDELINES = [
  "read takes exactly one selector: { path, offset?, limit? } for one known file, { paths: [...] } for several, or { symbol, offset?, limit? } for an already-known qualified symbol. read has no natural-language query mode.",
  "Only complete rendered read blocks provide strong evidence for patch; partial or omitted packed blocks are not authorized.",
  "Large supported source files read without offset/limit may return a compact AST outline instead of the full body, so use offset/limit or symbol for specific slices.",
] as const;

const GREP_SNIPPET =
  "grep discovers candidates across text, symbols, and concepts — start broad code discovery here.";

const GREP_GUIDELINES = [
  "grep discovers candidates with lexical/BM25/symbol/semantic layers and batch queries; use structural for AST-grep matching and graphFilter for graph-constrained discovery.",
  "Grep returns search-match evidence only, so read the source before editing it.",
] as const;

const FIND_SNIPPET = "find locates files and directories by glob, name fragment, or description.";

const FIND_GUIDELINES = [
  "find locates files and directories only — never line ranges (those stay in grep). For line-level content search inside files use grep instead.",
] as const;

const INSPECT_SNIPPET =
  "inspect analyzes aggregate structure/architecture of a known file or the repository — never raw content reads.";

const INSPECT_AFFORDANCE_GUIDANCE: SmartReadToolGuidance = {
  snippet: "inspect runs one isolated bounded structural view, optionally with source corroboration.",
  guidelines: [
    "Choose view overview, dependencies, architecture, change-review, or routes; change-review requires diff: unstaged, staged, or HEAD. The selected view must match file or directory mode and cannot be combined with analysis or script mode.",
    "Add gather: true to run bounded source checks for that view. Results report coverage, omissions, unresolved references, and heuristic limits; gathered relations are discovery only, not evidence that authorizes edits or proof of runtime architecture.",
    "Read cited source with focused read for strong evidence. Graph-dependent work that cannot meet bounds is unsupported; no full-graph fallback is used.",
  ],
};

const INSPECT_AFFORDANCE_MCP_GUIDANCE: SmartReadToolGuidance = {
  snippet: INSPECT_AFFORDANCE_GUIDANCE.snippet,
  guidelines: [
    ...INSPECT_AFFORDANCE_GUIDANCE.guidelines.slice(0, 2),
    "Use your host's file reader on cited source for strong evidence.",
  ],
};

const INSPECT_GUIDELINES = [
  "inspect analyzes aggregate structure/architecture: file mode gives dependencies/dependents, call graph, impact, dead code, routes, and quality signals; directory mode gives the ranked map, clusters, layers, service boundaries, and hotspots.",
  "Inspect does not expose LSP navigation or diagnostics: for compiler-known facts about an exact symbol/location use LSP instead.",
  "inspect { mode: 'script', script } composes a bounded dependent multi-hop investigation when later grep/read/LSP/graph calls depend on earlier results. Do not use script for a lookup that one direct tool call covers.",
] as const;

const LSP_SNIPPET =
  "LSP answers exact compiler/language-server semantic questions — the only path to safe rename/refactor proposals.";

const LSP_GUIDELINES = [
  "LSP { operation, ... } provides strict compiler/language-server semantics: definitions, declarations, references, implementations, hover, document/workspace symbols, type/call hierarchy, diagnostics, and refactor/code-action proposals; use it for exact compiler-known facts, and inspect for repository shape, architecture, impact, graph, or quality.",
  "Positions and ranges are 0-based in server.positionEncoding; route by exact server id, and an unavailable refusal is valid (the server may be absent).",
  "Discover code actions with codeActions using path, range, and optional context; resolve only with returned selection {actionId, sourceSha256} and the same path, range, routing, and context (preserve omitted context). Never pass a raw action or guess an ID, digest, or target.",
  "Discovery lists actions but does not select or apply them; resolve is a readonly preview. Rename, formatting, and resolved actions are proposals; only explicit applyProposal mutates via SmartEdit.",
] as const;

const LSP_AFFORDANCE_GUIDANCE: SmartReadToolGuidance = {
  snippet: "LSP resolves exact declaration-name anchors or compiler-known locations.",
  guidelines: [
    "For supported navigation operations, provide symbol and optional path XOR position; an explicit path scopes an exact declaration lookup, while pathless symbols are discovery-only and never auto-dispatched.",
    "investigate accepts one flat task: definition, type, references, implementations, or callers. Check ambiguous_anchor, anchor_search_incomplete, stale_anchor, and anchor_invalid_path; resolution is bounded to 100 candidates, 6 requests, and 15 seconds.",
    'Examples: {operation:"investigate",task:"callers",symbol:"start",path:"src/server.ts"}; {operation:"investigate",task:"type",path:"src/server.ts",position:{line:12,character:4}}.',
    "For code actions, use the exact returned actionId and sourceSha256 in selection; resolve with the same path, range, optional context, and routing as discovery. Omitted context stays omitted; never send a raw action or guess an identifier, digest, or target.",
    "Discovery lists actions but does not select one. Resolution is a readonly preview without trusted SmartEdit staging; use explicit applyProposal for an available staged proposal. On unavailable refusal the server may be absent; do not infer it. Positions are 0-based in server.positionEncoding.",
  ],
};

const SKILL_SNIPPET = "skill discovers and reads reusable agent workflow skills.";

const SKILL_GUIDELINES = ["skill: discover and read reusable agent workflow skills."] as const;

export const SMARTREAD_TOOL_GUIDANCE: Record<string, SmartReadToolGuidance> = {
  read: { snippet: READ_SNIPPET, guidelines: READ_GUIDELINES },
  grep: { snippet: GREP_SNIPPET, guidelines: GREP_GUIDELINES },
  find: { snippet: FIND_SNIPPET, guidelines: FIND_GUIDELINES },
  inspect: { snippet: INSPECT_SNIPPET, guidelines: INSPECT_GUIDELINES },
  LSP: { snippet: LSP_SNIPPET, guidelines: LSP_GUIDELINES },
  skill: { snippet: SKILL_SNIPPET, guidelines: SKILL_GUIDELINES },
};

/** Tool names with per-tool guidance, in combined-guide render order. */
export const SMARTREAD_GUIDED_TOOLS = ["read", "grep", "find", "inspect", "LSP", "skill"] as const;

export type SmartReadGuidedTool = (typeof SMARTREAD_GUIDED_TOOLS)[number];

/** Look up per-tool guidance by tool name; undefined when no guidance exists. */
export function getSmartReadToolGuidance(toolName: string, affordances = false, inspectAffordances = false, hostReader = false): SmartReadToolGuidance | undefined {
  if (toolName === "LSP" && affordances) return LSP_AFFORDANCE_GUIDANCE;
  if (toolName === "inspect" && inspectAffordances) return hostReader ? INSPECT_AFFORDANCE_MCP_GUIDANCE : INSPECT_AFFORDANCE_GUIDANCE;
  return SMARTREAD_TOOL_GUIDANCE[toolName];
}

const GUIDE_LEAD =
  "Tool split: grep discovers candidates, read returns already-known source content, inspect analyzes aggregate structure/architecture, and LSP answers exact compiler/language-server semantic questions. Only complete rendered read blocks provide strong evidence for patch:";

const GUIDE_CLOSING =
  "Prefer narrow params. Large unbounded source reads may return a compact AST outline instead of the full source body, so use offset/limit or symbol for specific slices. After code changes, re-run the reads/inspects/LSP checks that informed decisions.";

function guideSection(toolName: string, guidance: SmartReadToolGuidance): string[] {
  const body = [guidance.snippet, ...guidance.guidelines].join(" ");
  return [`- ${toolName}: ${body}`];
}

const TOOL_GUIDE_LINES: string[] = [
  GUIDE_LEAD,
  ...SMARTREAD_GUIDED_TOOLS.flatMap((toolName) =>
    guideSection(toolName, SMARTREAD_TOOL_GUIDANCE[toolName]!),
  ),
  GUIDE_CLOSING,
];

export function renderSmartReadToolGuide(task?: string, affordances = false, inspectAffordances = false, hostReader = false): string {
  const trimmedTask = task?.trim();
  const taskLine = trimmedTask ? [`Task: ${trimmedTask}`, ""] : [];
  const lines = affordances || inspectAffordances
    ? [...SMARTREAD_GUIDED_TOOLS.flatMap((toolName) => guideSection(toolName, getSmartReadToolGuidance(toolName, affordances, inspectAffordances, hostReader)!))]
    : TOOL_GUIDE_LINES.slice(1, -1);
  const lead = affordances ? GUIDE_LEAD.replace("LSP answers exact compiler/language-server semantic questions", "LSP resolves exact declarations and compiler-known locations") : GUIDE_LEAD;
  return [...taskLine, lead, ...lines, GUIDE_CLOSING].join("\n");
}
