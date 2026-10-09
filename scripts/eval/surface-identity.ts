export interface SurfaceIdentity {
    selectors: { general: boolean; inspect: boolean; invalid?: string[] };
    variants: { lsp: string; inspect: string; grep: string; guidance: string; mcpInstructions: string; note?: string };
    surfaceIdentity: string;
    schemaHash: string;
    guidanceHash: string;
}

export class SurfaceIdentityError extends Error {
    constructor(readonly code: "missing" | "duplicate" | "malformed") {
        super(`surface-identity-${code}`);
        this.name = "SurfaceIdentityError";
    }
}

const PREFIX = "[pi-smartread:surface-identity] ";
const HASH = /^[a-f\d]{64}$/;

export function parseSurfaceIdentity(stderr: string): SurfaceIdentity {
    const lines = stderr.split(/\r?\n/).filter((line) => line.startsWith(PREFIX));
    if (lines.length === 0) throw new SurfaceIdentityError("missing");
    if (lines.length !== 1) throw new SurfaceIdentityError("duplicate");
    try {
        const value: unknown = JSON.parse(lines[0]!.slice(PREFIX.length));
        if (!isIdentity(value)) throw new Error("invalid identity");
        return value;
    } catch {
        throw new SurfaceIdentityError("malformed");
    }
}

function isIdentity(value: unknown): value is SurfaceIdentity {
    if (!isRecord(value) || !exactKeys(value, ["selectors", "variants", "surfaceIdentity", "schemaHash", "guidanceHash"])) return false;
    if (!isRecord(value.selectors) || !("general" in value.selectors) || !("inspect" in value.selectors) || !Object.keys(value.selectors).every((key) => ["general", "inspect", "invalid"].includes(key))) return false;
    const selectors = value.selectors;
    if (typeof selectors.general !== "boolean" || typeof selectors.inspect !== "boolean") return false;
    if (selectors.invalid !== undefined && (!Array.isArray(selectors.invalid) || !selectors.invalid.every((item) => typeof item === "string" && !containsAbsolutePath(item)))) return false;
    if (!isRecord(value.variants)) return false;
    const variants = value.variants;
    if (!["lsp", "inspect", "grep", "guidance", "mcpInstructions"].every((key) => typeof variants[key] === "string")) return false;
    if (!Object.keys(variants).every((key) => ["lsp", "inspect", "grep", "guidance", "mcpInstructions", "note"].includes(key))) return false;
    if (variants.note !== undefined && typeof variants.note !== "string") return false;
    if (typeof value.surfaceIdentity !== "string" || !HASH.test(value.surfaceIdentity) || typeof value.schemaHash !== "string" || !HASH.test(value.schemaHash) || typeof value.guidanceHash !== "string" || !HASH.test(value.guidanceHash)) return false;
    return !containsAbsolutePath(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
    return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function containsAbsolutePath(value: unknown): boolean {
    if (typeof value === "string") return /(?:^|[=\s"'])\/(?!\/)[^\s"']*/.test(value) || /^[A-Za-z]:\\/.test(value);
    if (Array.isArray(value)) return value.some(containsAbsolutePath);
    if (isRecord(value)) return Object.values(value).some(containsAbsolutePath);
    return false;
}
