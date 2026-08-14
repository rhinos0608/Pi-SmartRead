/**
 * Architectural layer derivation from import patterns and naming conventions.
 *
 * Classifies files into layers:
 * - controller: route registrations, handlers, controllers
 * - service: business logic (.service.ts, *Service naming)
 * - repository: data access (.repo.ts, .dao.ts, DB/ORM imports)
 * - model: type definitions, interfaces, schemas, enums
 * - utility: helper functions, shared utilities
 *
 * Dependency-free — pure heuristic module.
 */
import { basename } from "node:path";

// ── Types ─────────────────────────────────────────────────────────

export interface LayerMap {
  layers: Map<string, string[]>;
  unclassified: string[];
}

// ── Layer Heuristics ──────────────────────────────────────────────

interface LayerRule {
  layer: string;
  filePatterns: RegExp[];
  namePatterns: RegExp[];
  importHints: RegExp[];
  weight: number;
}

const LAYER_RULES: LayerRule[] = [
  {
    layer: "controller",
    filePatterns: [
      /(?:routes?|routers?|handlers?|controllers?|middleware)\.[mc]?tsx?$/i,
      /\/(?:routes?|handlers?|controllers?|api)\//i,
    ],
    namePatterns: [
      /(?:Route|Router|Handler|Controller|Middleware)$/i,
    ],
    importHints: [
      /(?:express|fastify|koa|hono|next\/server)/i,
    ],
    weight: 10,
  },
  {
    layer: "service",
    filePatterns: [
      /(?:service|svc)\.[mc]?tsx?$/i,
      /\/(?:services?|biz)\//i,
    ],
    namePatterns: [
      /(?:Service|Svc)$/i,
    ],
    importHints: [],
    weight: 8,
  },
  {
    layer: "repository",
    filePatterns: [
      /(?:repo|repository|dao|dal|gateway)\.[mc]?tsx?$/i,
      /\/(?:repos?|repositories?|dal|gateways?|data)\//i,
    ],
    namePatterns: [
      /(?:Repo|Repository|Dao|Dal|Gateway)$/i,
    ],
    importHints: [
      /(?:knex|prisma|typeorm|sequelize|mongoose|drizzle|better-sqlite|sqlite)/i,
    ],
    weight: 9,
  },
  {
    layer: "model",
    filePatterns: [
      /(?:model|schema|types?|interfaces?|entity|entities)\.[mc]?tsx?$/i,
      /\/(?:models?|schemas?|types?|entities?)\//i,
    ],
    namePatterns: [
      /(?:Model|Schema|Entity|Interface)$/i,
    ],
    importHints: [],
    weight: 6,
  },
  {
    layer: "utility",
    filePatterns: [
      /(?:util|helper|helpers?|common|shared|lib)\.[mc]?tsx?$/i,
      /\/(?:utils?|helpers?|common|shared|lib|helpers)\//i,
    ],
    namePatterns: [
      /(?:Util|Helper|Helpers|Common)$/i,
    ],
    importHints: [],
    weight: 4,
  },
];

// ── Classification ────────────────────────────────────────────────

function classifyFile(
  filePath: string,
  _importEdges: Array<{ from: string; to: string }>,
  importHintsForFile: Set<string>,
): { layer: string; score: number } | null {
  const base = basename(filePath);
  const baseNoExt = base.replace(/\.[mc]?tsx?$/i, "");

  let bestLayer: string | null = null;
  let bestScore = 0;

  for (const rule of LAYER_RULES) {
    let score = 0;

    // File path pattern match
    for (const pat of rule.filePatterns) {
      if (pat.test(filePath)) {
        score += rule.weight;
        break;
      }
    }

    // Name pattern match
    for (const pat of rule.namePatterns) {
      if (pat.test(baseNoExt)) {
        score += rule.weight;
        break;
      }
    }

    // Import hint match: check if imports from this file contain
    // framework-specific packages
    if (rule.importHints.length > 0) {
      for (const hint of rule.importHints) {
        for (const imp of importHintsForFile) {
          if (hint.test(imp)) {
            score += rule.weight * 0.5;
            break;
          }
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestLayer = rule.layer;
    }
  }

  if (bestLayer && bestScore > 0) {
    return { layer: bestLayer, score: bestScore };
  }
  return null;
}

// ── Package Specifier Extraction ────────────────────────────────

/**
 * Regex matching ES/CJS import specifiers in source text.
 * Captures the specifier string (group 1) from import/require/export statements.
 */
const IMPORT_SPECIFIER_RE = /(?:import\s+(?:[\w$*\s{},]+\s+from\s+)?["']([^"'\n\r]+)["']|import\s*\(["']([^"'\n\r]+)["']\)|(?:const|let|var)\s+(?:\{[\w\s$,]+\}|\[[\w\s$,]+\]|[\w$]+)\s*=\s*require\(["']([^"'\n\r]+)["']\)|export\s+(?:[\w$*\s{},]+\s+from\s+)["']([^"'\n\r]+)["'])/g;

/**
 * Extract bare package specifiers from raw source text.
 * Filters out relative/absolute path imports (those starting with `.` or `/`).
 */
export function extractPackageSpecifiers(source: string): Set<string> {
  const packages = new Set<string>();
  let m: RegExpExecArray | null;
  IMPORT_SPECIFIER_RE.lastIndex = 0;
  while ((m = IMPORT_SPECIFIER_RE.exec(source)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec && !spec.startsWith(".") && !spec.startsWith("/")) {
      // Extract the top-level package name (e.g. "express" from "express/lib/router")
      const pkg = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0]!;
      packages.add(pkg);
    }
  }
  return packages;
}

// ── Main API ──────────────────────────────────────────────────────

/**
 * Derive architectural layers from import edges and file paths.
 * @param importEdges - Directed import edges ({from, to}).
 * @param filePaths - All file paths in the directory scope.
 * @param rawImportsByFile - Optional per-file raw import specifier strings
 *   (e.g. from scanning source files). Used for import-hint matching when
 *   importEdges only contain resolved local paths.
 * @returns LayerMap with classified layers and unclassified files.
 */
export function deriveLayers(
  importEdges: Array<{ from: string; to: string }>,
  filePaths: string[],
  rawImportsByFile?: Map<string, Set<string>>,
): LayerMap {
  // Build per-file import targets for hint matching
  const importsByFile = new Map<string, Set<string>>();
  for (const { from, to } of importEdges) {
    if (!importsByFile.has(from)) importsByFile.set(from, new Set());
    importsByFile.get(from)!.add(to);
  }

  const layers = new Map<string, string[]>();
  const unclassified: string[] = [];

  for (const fp of filePaths) {
    // Merge edge-derived targets with raw package specifiers for hint matching
    const importHints = new Set<string>(importsByFile.get(fp) ?? []);
    const rawSpecs = rawImportsByFile?.get(fp);
    if (rawSpecs) {
      for (const s of rawSpecs) importHints.add(s);
    }
    const result = classifyFile(fp, importEdges, importHints);

    if (result) {
      if (!layers.has(result.layer)) layers.set(result.layer, []);
      layers.get(result.layer)!.push(fp);
    } else {
      unclassified.push(fp);
    }
  }

  return { layers, unclassified };
}
