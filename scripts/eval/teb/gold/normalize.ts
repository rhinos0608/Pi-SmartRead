/**
 * TEB gold-derivation helpers: types + pinned hover type-string normaliser.
 *
 * The normaliser here is the pinned §5 normaliser: labelers pin
 * `normalized` + both flags per task, and `grade.ts` (sibling owner)
 * imports this implementation rather than carrying a copy.
 */
export interface TebGoldLocation {
    /** Repo-relative path from the task subpath root. */
    path: string;
    /** 1-based line of the symbol start. */
    line: number;
    /** 1-based column of the symbol start. */
    character: number;
}

export interface TypeNormalization {
    arrayRewrite: boolean;
    dropUndefined: boolean;
}

export type AgreementClass = "agree" | "server-only" | "compiler-only" | "adjudicated";

/**
 * Pinned §5 type-string normaliser. Extract the first fenced code block
 * with language typescript/ts (else the first fenced block, else the raw
 * string); strip the fence; drop a leading `(alias …)` / `(property …)`
 * qualifier line when present; collapse whitespace runs and trim. Then
 * apply the per-task flags: Array<X> ≡ X[] rewrite, `| undefined` drop.
 */
export function normalizeTypeString(raw: string, flags: TypeNormalization): string {
    let body = raw;
    const fencedTs = /```(?:typescript|ts)\s*\n([\s\S]*?)```/i.exec(raw);
    if (fencedTs) {
        body = fencedTs[1] ?? "";
    } else {
        const fencedAny = /```[^\n]*\n([\s\S]*?)```/.exec(raw);
        if (fencedAny) body = fencedAny[1] ?? "";
    }
    const lines = body.split("\n");
    // Strip a leading `(alias …)` / `(property …)` qualifier prefix from the
    // first line (hover renders e.g. `(alias) class QueryClient`); drop the
    // line if only the qualifier was there.
    if (lines.length > 0) {
        lines[0] = (lines[0] ?? "").replace(/^\s*\((?:alias|property)\b[^)]*\)\s*/, "");
        if (lines[0]?.trim() === "") lines.shift();
    }
    let out = lines.join("\n").replace(/\s+/g, " ").trim();
    if (flags.arrayRewrite) {
        out = out.replace(/Array<([^<>]+)>/g, "$1[]");
    }
    if (flags.dropUndefined) {
        out = out
            .replace(/\s*\|\s*undefined\b/g, "")
            .replace(/\bundefined\s*\|\s*/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }
    return out;
}
