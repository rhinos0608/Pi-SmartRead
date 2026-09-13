/**
 * Shared fixtures for the grep-tool test split (P3.1).
 *
 * Provides the standard temp-workdir corpus plus makeCtx/makeOpts/runGrep
 * helpers so each split file stays focused on its own search layer.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGrepTool, type GrepToolOptions } from "../../src/grep-tool.js";

export function makeCtx(cwd: string) {
    return { cwd } as any;
}

export function makeOpts(overrides?: Partial<GrepToolOptions>): GrepToolOptions {
    return {
        getSessionFilePath: () => "/sessions/test-session.jsonl",
        ...overrides,
    };
}

/** Seeds the standard corpus every grep-tool split file expects. */
export function seedStandardWorkdir(workdir: string): void {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(
        join(workdir, "src", "auth.ts"),
        [
            "export function authenticate(req: Request, res: Response) {",
            "  const token = req.headers.authorization;",
            "  return validateToken(token);",
            "}",
            "",
            "export function validateToken(token: string): TokenPayload | null {",
            "  return { sub: 'user1' };",
            "}",
        ].join("\n"),
        "utf8",
    );
    writeFileSync(
        join(workdir, "src", "tokens.ts"),
        [
            "export interface TokenPayload {",
            "  sub: string;",
            "}",
            "",
            "export function createToken(payload: TokenPayload): string {",
            "  return JSON.stringify(payload);",
            "}",
        ].join("\n"),
        "utf8",
    );
    writeFileSync(
        join(workdir, "src", "db.ts"),
        [
            "export const DATABASE_URL = 'postgres://localhost/auth';",
            "export function connectDatabase() { return {}; }",
        ].join("\n"),
        "utf8",
    );
    // A large file with many named functions to test truncation
    const manyFns = Array.from({ length: 30 }, (_, i) =>
        `export function handler${i}(req: Request) { return ${i}; }`,
    ).join("\n");
    writeFileSync(join(workdir, "src", "handlers.ts"), manyFns, "utf8");
}

/** Executes one grep query with default opts and returns text + details. */
export async function runGrep(
    workdir: string,
    params: Record<string, unknown>,
    opts?: { id?: string; toolOpts?: Partial<GrepToolOptions> },
): Promise<{ text: string; details: any }> {
    const result = await createGrepTool(makeOpts(opts?.toolOpts)).execute(
        opts?.id ?? "t",
        params as any,
        undefined,
        undefined,
        makeCtx(workdir),
    );
    return {
        text: (result.content[0] as { text: string }).text,
        details: result.details as any,
    };
}
