/**
 * Microagent system for Pi-SmartRead.
 *
 * Scans `.pi-smartread/microagents/` and `.openhands/microagents/` directories
 * for Markdown files with optional YAML frontmatter triggers.
 *
 * Design:
 *   - Non-blocking: parse failures log warnings, never throw
 *   - Cached per session (scan once on session_start)
 *   - Simple regex frontmatter parsing (no external YAML dependency)
 *   - Always-loaded agents get appended to system prompt on first turn
 *   - Query-matched agents available via getMatchingMicroagents()
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface MicroagentFrontmatter {
  triggers?: string[];
  name?: string;
  description?: string;
  alwaysLoad?: boolean;
}

export interface Microagent {
  name: string;
  sourcePath: string;
  frontmatter: MicroagentFrontmatter;
  content: string; // body content only (no frontmatter)
}

// ── Directory scanning ────────────────────────────────────────────────────────

/**
 * Directories to scan for microagents (in order of precedence).
 * If a microagent exists in multiple directories, the first match wins.
 */
const MICROAGENT_DIRS = [".pi-smartread/microagents", ".openhands/microagents"];

/**
 * Scan a single directory for microagent files.
 * Returns an array of Microagent objects parsed from `.md` files.
 */
function scanDirectory(dir: string): Microagent[] {
  const agents: Microagent[] = [];

  if (!existsSync(dir)) return agents;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;

    const filePath = path.join(dir, entry);

    // Skip symlinks to prevent arbitrary file injection
    try {
      const stat = lstatSync(filePath);
      if (stat.isSymbolicLink()) continue;
    } catch {
      continue;
    }

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      console.warn(`[SmartRead] Failed to read microagent file: ${filePath}`);
      continue;
    }

    const parsed = parseMicroagentFile(raw, filePath);
    if (parsed) {
      agents.push(parsed);
    }
  }

  return agents;
}

/**
 * Scan both microagent directories for all available microagents.
 *
 * Files from `.pi-smartread/microagents/` take precedence over
 * `.openhands/microagents/` for same-named agents (by sourcePath order).
 *
 * @param cwd - Root directory to scan from
 * @returns Array of discovered Microagent objects
 */
export function scanMicroagents(cwd: string): Microagent[] {
  const seen = new Set<string>();
  const agents: Microagent[] = [];

  for (const relDir of MICROAGENT_DIRS) {
    const dir = path.resolve(cwd, relDir);
    const fromDir = scanDirectory(dir);
    for (const agent of fromDir) {
      // Deduplicate by resolved sourcePath
      const resolved = path.resolve(agent.sourcePath);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        agents.push(agent);
      }
    }
  }

  return agents;
}

// ── Frontmatter parsing ───────────────────────────────────────────────────────

/** Regex to extract YAML frontmatter between --- delimiters */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Regex to parse simple key: value pairs (no nested structures) */
const FRONTMATTER_LINE_RE = /^(\w+):\s*(.*)$/;

/**
 * Parse YAML frontmatter using simple regex (no external parser).
 * Handles:
 *   - Scalar values: `key: value`
 *   - Arrays: `key:\n  - item1\n  - item2`
 *
 * Does NOT handle nested objects or complex YAML.
 */
function parseFrontmatter(raw: string): MicroagentFrontmatter {
  const fm: MicroagentFrontmatter = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Check for array item (indented with 2 spaces + dash)
    if (/^\s+-\s+/.test(line)) {
      const value = line.replace(/^\s+-\s+/, "").trim();
      if (value) {
        fm.triggers ??= [];
        fm.triggers.push(value);
      }
      continue;
    }

    const match = trimmed.match(FRONTMATTER_LINE_RE);
    if (match) {
      const [, key, rawValue] = match;
      const value = (rawValue ?? "").trim();

      switch (key) {
        case "name":
          fm.name = value;
          break;
        case "description":
          fm.description = value;
          break;
        case "alwaysLoad":
          fm.alwaysLoad = value === "true" || value === "yes" || value === "1";
          break;
        case "triggers":
          // Inline triggers: `triggers: [a, b, c]` or `triggers: a, b, c`
          const items = value.replace(/[[\]]/g, "").split(/,/).map((s) => s.trim()).filter(Boolean);
          if (items.length > 0) {
            fm.triggers = items;
          }
          break;
      }
    }
  }

  return fm;
}

/**
 * Parse a microagent file (Markdown with optional frontmatter).
 * Returns a Microagent object or null if parsing fails.
 */
function parseMicroagentFile(raw: string, sourcePath: string): Microagent | null {
  let frontmatter: MicroagentFrontmatter = {};
  let content = raw;

  const match = raw.match(FRONTMATTER_RE);
  if (match && match[1] !== undefined) {
    try {
      frontmatter = parseFrontmatter(match[1]);
      content = raw.slice(match[0].length);
    } catch {
      console.warn(`[SmartRead] Failed to parse frontmatter in: ${sourcePath}`);
      // Continue with empty frontmatter
    }
  }

  // Use filename as fallback name
  const name = frontmatter.name ?? path.basename(sourcePath, ".md");

  // Strip leading/trailing whitespace from content
  content = content.trim();

  if (!content) {
    console.warn(`[SmartRead] Empty microagent content: ${sourcePath}`);
    return null;
  }

  return {
    name,
    sourcePath,
    frontmatter,
    content,
  };
}

// ── Matching ─────────────────────────────────────────────────────────────────

/**
 * Check if a query matches a microagent's triggers.
 * Uses case-insensitive substring matching.
 */
function triggersMatch(triggers: string[] | undefined, query: string): boolean {
  if (!triggers || triggers.length === 0) return false;
  const lcQuery = query.toLowerCase();
  return triggers.some((trigger) => lcQuery.includes(trigger.toLowerCase()));
}

/**
 * Match microagents against a query string.
 *
 * Returns:
 *   - Always-loaded agents (always included)
 *   - Agents whose triggers match the query (case-insensitive substring)
 *
 * @param microagents - Array of microagents to filter
 * @param query - Query string to match against triggers
 * @returns Filtered array of matched microagents
 */
export function matchMicroagents(microagents: Microagent[], query: string): Microagent[] {
  return microagents.filter((agent) => {
    // Always include alwaysLoad agents
    if (agent.frontmatter.alwaysLoad) return true;
    // Otherwise match by triggers
    return triggersMatch(agent.frontmatter.triggers, query);
  });
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Render matched microagents into a string suitable for context injection.
 * Format:
 * ```
 * ## Microagent: <name>
 * <content>
 * ```
 *
 * @param matched - Array of matched microagents
 * @returns Rendered context string
 */
export function renderMicroagentContext(matched: Microagent[]): string {
  if (matched.length === 0) return "";

  const parts: string[] = [];
  for (const agent of matched) {
    parts.push(`## Microagent: ${agent.name}`);
    parts.push(agent.content);
    parts.push("");
  }

  return parts.join("\n");
}