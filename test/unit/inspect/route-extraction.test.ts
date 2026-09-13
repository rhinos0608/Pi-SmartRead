/**
 * Tests for route-extraction — HTTP route pattern matching.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { extractRoutes, scanRoutes } from "../../src/route-extraction.js";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "routes-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

// ── Express routes ────────────────────────────────────────────────

describe("extractRoutes — Express", () => {
  it("extracts app.get/post routes", () => {
    const fp = join(workdir, "routes.ts");
    writeFileSync(fp, `
import express from 'express';
const app = express();
app.get("/api/users", listUsers);
app.post("/api/users", createUser);
app.delete("/api/users/:id", deleteUser);
`);
    const routes = extractRoutes(fp);
    expect(routes).toHaveLength(3);
    expect(routes[0]!.method).toBe("GET");
    expect(routes[0]!.path).toBe("/api/users");
    expect(routes[0]!.handler).toBe("listUsers");
    expect(routes[1]!.method).toBe("POST");
    expect(routes[2]!.method).toBe("DELETE");
  });

  it("extracts fastify routes", () => {
    const fp = join(workdir, "fastify.ts");
    writeFileSync(fp, `
fastify.get("/health", healthCheck);
fastify.put("/config", updateConfig);
`);
    const routes = extractRoutes(fp);
    expect(routes).toHaveLength(2);
    expect(routes[0]!.method).toBe("GET");
    expect(routes[0]!.path).toBe("/health");
    expect(routes[1]!.method).toBe("PUT");
  });

  it("extracts router routes", () => {
    const fp = join(workdir, "router.ts");
    writeFileSync(fp, `
router.get("/items", getItems);
router.patch("/items/:id", patchItem);
`);
    const routes = extractRoutes(fp);
    expect(routes).toHaveLength(2);
    expect(routes[0]!.method).toBe("GET");
    expect(routes[1]!.method).toBe("PATCH");
  });
});

// ── Next.js App Router ────────────────────────────────────────────

describe("extractRoutes — Next.js App Router", () => {
  it("extracts GET/POST exports from app/**/route.ts", () => {
    const appDir = join(workdir, "app", "api");
    mkdirSync(appDir, { recursive: true });
    const fp = join(appDir, "route.ts");
    writeFileSync(fp, `
export async function GET(request: Request) {
  return Response.json({ ok: true });
}
export async function POST(request: Request) {
  return Response.json({ created: true });
}
`);
    const routes = extractRoutes(fp);
    expect(routes).toHaveLength(2);
    expect(routes[0]!.method).toBe("GET");
    expect(routes[0]!.file).toBe(fp);
    expect(routes[1]!.method).toBe("POST");
  });
});

// ── Next.js Pages Router ──────────────────────────────────────────

describe("extractRoutes — Next.js Pages Router", () => {
  it("extracts default handler from pages/api/", () => {
    const pagesDir = join(workdir, "pages", "api");
    mkdirSync(pagesDir, { recursive: true });
    const fp = join(pagesDir, "webhook.ts");
    writeFileSync(fp, `
export default function handler(req, res) {
  res.status(200).json({ ok: true });
}
`);
    const routes = extractRoutes(fp);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.method).toBe("ANY");
    expect(routes[0]!.path).toBe("/api/webhook");
    expect(routes[0]!.handler).toBe("handler");
  });

  it("does not match non-api pages files", () => {
    const pagesDir = join(workdir, "pages");
    mkdirSync(pagesDir, { recursive: true });
    const fp = join(pagesDir, "index.tsx");
    writeFileSync(fp, `export default function Home() {}`);
    const routes = extractRoutes(fp);
    expect(routes).toHaveLength(0);
  });
});

// ── tRPC ──────────────────────────────────────────────────────────

describe("extractRoutes — tRPC", () => {
  it("extracts .query() and .mutation() routes", () => {
    const fp = join(workdir, "trpc.ts");
    writeFileSync(fp, `
const userRouter = router({
  getById: publicProcedure.query(async ({ input }) => {}),
  create: publicProcedure.mutation(async ({ input }) => {}),
});
`);
    const routes = extractRoutes(fp);
    expect(routes).toHaveLength(2);
    const query = routes.find((r) => r.handler === "getById");
    expect(query).toBeDefined();
    expect(query!.method).toBe("GET");
    expect(query!.path).toBe("/trpc/getById");
    const mutation = routes.find((r) => r.handler === "create");
    expect(mutation).toBeDefined();
    expect(mutation!.method).toBe("POST");
  });
});

// ── scanRoutes (directory) ────────────────────────────────────────

describe("scanRoutes", () => {
  it("recursively scans directory for routes", () => {
    mkdirSync(join(workdir, "src", "api"), { recursive: true });
    writeFileSync(join(workdir, "src", "api", "users.ts"), `
app.get("/api/users", listUsers);
app.post("/api/users", createUser);
`);
    writeFileSync(join(workdir, "src", "api", "items.ts"), `
app.get("/api/items", getItems);
`);

    const routes = scanRoutes(workdir);
    expect(routes).toHaveLength(3);
  });

  it("skips node_modules", () => {
    mkdirSync(join(workdir, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(workdir, "node_modules", "dep", "index.ts"), `
app.get("/hack", handler);
`);
    const routes = scanRoutes(workdir);
    expect(routes).toHaveLength(0);
  });

  it("returns empty for nonexistent directory", () => {
    expect(scanRoutes("/nonexistent/path")).toEqual([]);
  });

  it("handles empty directory", () => {
    expect(scanRoutes(workdir)).toEqual([]);
  });
});

// ── Edge cases ────────────────────────────────────────────────────

describe("extractRoutes — edge cases", () => {
  it("returns empty for nonexistent file", () => {
    expect(extractRoutes("/nonexistent/file.ts")).toEqual([]);
  });

  it("returns empty for file with no routes", () => {
    const fp = join(workdir, "plain.ts");
    writeFileSync(fp, `export const x = 1;\n`);
    expect(extractRoutes(fp)).toEqual([]);
  });
});
