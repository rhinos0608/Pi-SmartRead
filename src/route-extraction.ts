/**
 * HTTP route extraction for common Node.js frameworks.
 *
 * Detects route registrations via regex pattern matching:
 * - Express: app.get/post/put/delete/patch(path, handler)
 * - Fastify: fastify.get/post/.../...(path, handler)
 * - Next.js App Router: export async function GET/POST/... in route.ts
 * - Next.js Pages Router: export default function handler in pages/api/
 * - tRPC: .query() / .mutation() on router definitions
 *
 * Dependency-free — uses only Node.js built-in fs/path.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, extname } from "node:path";

// ── Types ─────────────────────────────────────────────────────────

export interface RouteInfo {
  method: string;
  path: string;
  file: string;
  line: number;
  handler: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────

function readFileSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function extractHandlerName(source: string, afterIndex: number): string | null {
  const after = source.slice(afterIndex, afterIndex + 200);
  const handlerMatch = after.match(/,\s*(?:async\s+)?(?:function\s+)?(\w+)/);
  return handlerMatch?.[1] ?? null;
}

// ── Express / Fastify ─────────────────────────────────────────────

function extractExpressFastifyRoutes(source: string, filePath: string): RouteInfo[] {
  const results: RouteInfo[] = [];
  const pattern =
    /(?:app|fastify|router|server|api)\s*\.\s*(get|post|put|delete|patch|options|head)\s*\(\s*(['"`])([^'"`]+)\2/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const method = match[1]!.toUpperCase();
    const path = match[3]!;
    const handler = extractHandlerName(source, match.index + match[0].length);
    const line = lineOf(source, match.index);
    results.push({ method, path, file: filePath, line, handler });
  }

  return results;
}

// ── Next.js App Router ────────────────────────────────────────────

function extractNextAppRouterRoutes(source: string, filePath: string): RouteInfo[] {
  const results: RouteInfo[] = [];
  const pattern = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const method = match[1]!;
    const line = lineOf(source, match.index);
    const routePath = inferNextRoutePath(filePath);
    results.push({ method, path: routePath, file: filePath, line, handler: null });
  }

  return results;
}

function inferNextRoutePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");

  // App Router: /app/api/health/route.ts → /api/health
  const appMatch = normalized.match(/(?:^|\/)app(\/.+?)\/?route\.[mc]?tsx?$/);
  if (appMatch?.[1]) return appMatch[1];

  // Pages Router: /pages/api/webhook.ts → /api/webhook
  const pagesMatch = normalized.match(/(?:^|\/)pages(\/.+?)\.[mc]?tsx?$/);
  if (pagesMatch?.[1]) return pagesMatch[1];

  return "/";
}

// ── Next.js Pages Router ──────────────────────────────────────────

function extractNextPagesRouterRoutes(source: string, filePath: string): RouteInfo[] {
  const results: RouteInfo[] = [];
  const normalized = filePath.replace(/\\/g, "/");

  // Only match files in pages/api/ directories
  if (!/\/pages\/api\//.test(normalized)) return results;

  const pattern = /export\s+default\s+(?:async\s+)?(?:function\s+)?(\w*)\s*\(/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const routePath = inferNextRoutePath(filePath);
    const handler = match[1] || "handler";
    const line = lineOf(source, match.index);
    results.push({ method: "ANY", path: routePath, file: filePath, line, handler });
  }

  return results;
}

// ── tRPC ──────────────────────────────────────────────────────────

function extractTRPCRoutes(source: string, filePath: string): RouteInfo[] {
  const results: RouteInfo[] = [];

  // .query("name", ...) / .mutation("name", ...)
  const procPattern = /\.(\w+)\s*\(\s*(['"`])([^'"`]+)\2/g;
  let match: RegExpExecArray | null;
  while ((match = procPattern.exec(source)) !== null) {
    const opName = match[1]!;
    if (opName !== "query" && opName !== "mutation") continue;

    const name = match[3]!;
    const method = opName === "query" ? "GET" : "POST";
    const line = lineOf(source, match.index);
    results.push({
      method,
      path: `/trpc/${name}`,
      file: filePath,
      line,
      handler: name,
    });
  }

  // name: publicProcedure.query(...) pattern
  const namedPattern = /(\w+)\s*:\s*\w+Procedure\s*\.\s*(query|mutation)\s*\(/g;
  while ((match = namedPattern.exec(source)) !== null) {
    const name = match[1]!;
    const opType = match[2]!;
    const method = opType === "query" ? "GET" : "POST";
    const line = lineOf(source, match.index);
    const isDupe = results.some((r) => r.line === line && r.handler === name);
    if (!isDupe) {
      results.push({ method, path: `/trpc/${name}`, file: filePath, line, handler: name });
    }
  }

  return results;
}

// ── Main API ──────────────────────────────────────────────────────

/**
 * Extract HTTP route registrations from a single file.
 * @param filePath - Absolute or relative path to the source file.
 */
export function extractRoutes(filePath: string): RouteInfo[] {
  const source = readFileSafe(filePath);
  if (source === null) return [];

  return [
    ...extractExpressFastifyRoutes(source, filePath),
    ...extractNextAppRouterRoutes(source, filePath),
    ...extractNextPagesRouterRoutes(source, filePath),
    ...extractTRPCRoutes(source, filePath),
  ];
}

// ── Directory scan ────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", "dist", "build",
  ".pi-smartread", ".pi", "__pycache__", ".turbo", "coverage",
]);

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"]);

/**
 * Recursively scan a directory for HTTP route registrations.
 */
export function scanRoutes(dirPath: string): RouteInfo[] {
  const resolved = resolve(dirPath);
  if (!existsSync(resolved)) return [];
  return scanDir(resolved, resolved);
}

function scanDir(dirAbs: string, rootAbs: string): RouteInfo[] {
  const results: RouteInfo[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dirAbs);
  } catch {
    return [];
  }

  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const absPath = join(dirAbs, name);

    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      results.push(...scanDir(absPath, rootAbs));
    } else if (stat.isFile() && SOURCE_EXTS.has(extname(absPath).toLowerCase())) {
      const relPath = relative(rootAbs, absPath).replace(/\\/g, "/");
      const routes = extractRoutes(absPath);
      for (const r of routes) {
        r.file = relPath;
      }
      results.push(...routes);
    }
  }

  return results;
}
