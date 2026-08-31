import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface ValidatedWorkspaceEdit {
    fileEdits: Array<{
        filePath: string;
        edits: Array<{
            range: { start: { line: number; character: number }; end: { line: number; character: number } };
            newText: string;
        }>;
    }>;
}

export interface ValidationError {
    code: string;
    message: string;
    filePath?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function tryCanonical(p: string): string | null {
    try {
        return realpathSync(p);
    } catch {
        return null;
    }
}

function isNonNegInt(n: unknown): boolean {
    return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

function comparePos(
    a: { line: number; character: number },
    b: { line: number; character: number },
): number {
    if (a.line !== b.line) return a.line - b.line;
    return a.character - b.character;
}

export function validateWorkspaceEdit(
    edit: unknown,
    opts?: { maxFiles?: number; maxEdits?: number; maxTotalBytes?: number },
): { ok: true; value: ValidatedWorkspaceEdit } | { ok: false; errors: ValidationError[] } {
    const maxFiles = opts?.maxFiles ?? 50;
    const maxEdits = opts?.maxEdits ?? 5000;
    const maxTotalBytes = opts?.maxTotalBytes ?? 10 * 1024 * 1024;

    const errors: ValidationError[] = [];

    if (!isPlainObject(edit)) {
        return { ok: false, errors: [{ code: "invalid_shape", message: "workspaceEdit must be an object" }] };
    }
    const obj = edit as Record<string, unknown>;

    // Reject resource operations at top level (raw LSP shape) — rename v1 only supports TextDocumentEdit
    // If input looks like raw WorkspaceEdit with documentChanges containing kind, reject.
    if (Array.isArray(obj.documentChanges)) {
        for (let i = 0; i < (obj.documentChanges as unknown[]).length; i++) {
            const dc = (obj.documentChanges as unknown[])[i] as Record<string, unknown>;
            if (dc && typeof dc === "object" && typeof (dc as Record<string, unknown>).kind === "string") {
                const kind = (dc as Record<string, unknown>).kind as string;
                if (kind === "create" || kind === "rename" || kind === "delete") {
                    errors.push({ code: "resource_operation", message: `documentChanges[${i}] is resource operation ${kind} (unsupported)` });
                }
            }
        }
        if (errors.length) return { ok: false, errors };
    }
    if (obj.changes !== undefined && !obj.fileEdits) {
        // If raw shape with changes but no fileEdits, treat as invalid shape for this validator
        // We still try to validate fileEdits below, will produce empty error
    }

    const fileEditsRaw = obj.fileEdits;
    if (!Array.isArray(fileEditsRaw)) {
        return { ok: false, errors: [{ code: "missing_fileEdits", message: "fileEdits must be an array" }] };
    }
    if (fileEditsRaw.length === 0) {
        return { ok: false, errors: [{ code: "empty_fileEdits", message: "fileEdits must be non-empty" }] };
    }
    if (fileEditsRaw.length > maxFiles) {
        return {
            ok: false,
            errors: [{ code: "max_files", message: `fileEdits length ${fileEditsRaw.length} exceeds maxFiles ${maxFiles}` }],
        };
    }

    const seenCanonical = new Set<string>();
    let totalEdits = 0;
    let totalBytes = 0;
    const validated: ValidatedWorkspaceEdit["fileEdits"] = [];

    for (let idx = 0; idx < fileEditsRaw.length; idx++) {
        const entry = fileEditsRaw[idx] as unknown;
        if (!isPlainObject(entry)) {
            errors.push({ code: "invalid_fileEdit", message: `fileEdits[${idx}] must be an object` });
            continue;
        }
        const e = entry as Record<string, unknown>;

        // Reject resource operations at fileEdit level
        if (typeof e.kind === "string" && (e.kind === "create" || e.kind === "rename" || e.kind === "delete")) {
            errors.push({ code: "resource_operation", message: `fileEdits[${idx}] is resource operation ${(e.kind as string)}` });
            continue;
        }

        const filePathRaw = e.filePath;
        if (typeof filePathRaw !== "string" || filePathRaw.length === 0) {
            errors.push({ code: "invalid_filePath", message: `fileEdits[${idx}].filePath must be non-empty string` });
            continue;
        }
        const filePath = filePathRaw as string;

        // Reject URIs with scheme other than file: and reject relative paths
        if (filePath.includes("://")) {
            // Allow only file://
            if (!filePath.startsWith("file://")) {
                errors.push({ code: "non_file_uri", message: `fileEdits[${idx}].filePath must be file URI or absolute path, got ${filePath}`, filePath });
                continue;
            } else {
                errors.push({ code: "uri_not_path", message: `fileEdits[${idx}].filePath must be absolute path not URI`, filePath });
                continue;
            }
        }
        if (filePath.includes("\0")) {
            errors.push({ code: "invalid_filePath", message: `fileEdits[${idx}].filePath must not contain NUL`, filePath });
            continue;
        }
        if (!isAbsolute(filePath)) {
            errors.push({ code: "relative_path", message: `fileEdits[${idx}].filePath must be absolute path`, filePath });
            continue;
        }

        const canonical = tryCanonical(filePath);
        if (canonical === null) {
            errors.push({ code: "path_not_found", message: `fileEdits[${idx}].filePath does not exist: ${filePath}`, filePath });
            continue;
        }
        if (seenCanonical.has(canonical)) {
            errors.push({ code: "duplicate_path", message: `duplicate canonical path ${canonical}`, filePath: canonical });
            continue;
        }
        seenCanonical.add(canonical);

        const editsRaw = e.edits;
        if (!Array.isArray(editsRaw)) {
            errors.push({ code: "invalid_edits", message: `fileEdits[${idx}].edits must be array`, filePath: canonical });
            continue;
        }
        if (editsRaw.length === 0) {
            errors.push({ code: "empty_edits", message: `fileEdits[${idx}].edits must be non-empty`, filePath: canonical });
            continue;
        }

        // Pre-validate each edit
        type NormEdit = { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string };
        const normEdits: NormEdit[] = [];
        for (let j = 0; j < editsRaw.length; j++) {
            const edRaw = editsRaw[j] as unknown;
            if (!isPlainObject(edRaw)) {
                errors.push({ code: "invalid_edit", message: `fileEdits[${idx}].edits[${j}] must be object`, filePath: canonical });
                continue;
            }
            const ed = edRaw as Record<string, unknown>;
            if (typeof ed.kind === "string" && (ed.kind === "create" || ed.kind === "rename" || ed.kind === "delete")) {
                errors.push({ code: "resource_operation", message: `fileEdits[${idx}].edits[${j}] is resource operation`, filePath: canonical });
                continue;
            }
            const rangeRaw = ed.range;
            const newTextRaw = ed.newText;
            if (!isPlainObject(rangeRaw)) {
                errors.push({ code: "invalid_range", message: `fileEdits[${idx}].edits[${j}].range must be object`, filePath: canonical });
                continue;
            }
            const r = rangeRaw as Record<string, unknown>;
            const startRaw = r.start;
            const endRaw = r.end;
            if (!isPlainObject(startRaw) || !isPlainObject(endRaw)) {
                errors.push({ code: "invalid_range", message: `fileEdits[${idx}].edits[${j}].range.start/end must be objects`, filePath: canonical });
                continue;
            }
            const sl = (startRaw as Record<string, unknown>).line;
            const sc = (startRaw as Record<string, unknown>).character;
            const el = (endRaw as Record<string, unknown>).line;
            const ec = (endRaw as Record<string, unknown>).character;
            if (!isNonNegInt(sl) || !isNonNegInt(sc) || !isNonNegInt(el) || !isNonNegInt(ec)) {
                errors.push({ code: "invalid_range", message: `fileEdits[${idx}].edits[${j}] line/character must be non-negative integers`, filePath: canonical });
                continue;
            }
            const start = { line: sl as number, character: sc as number };
            const end = { line: el as number, character: ec as number };
            // start must be <= end
            if (comparePos(start, end) > 0) {
                errors.push({ code: "invalid_range", message: `fileEdits[${idx}].edits[${j}] start must be <= end`, filePath: canonical });
                continue;
            }
            if (typeof newTextRaw !== "string") {
                errors.push({ code: "invalid_newText", message: `fileEdits[${idx}].edits[${j}].newText must be string`, filePath: canonical });
                continue;
            }
            const newText = newTextRaw as string;
            totalBytes += Buffer.byteLength(newText, "utf-8");
            normEdits.push({ range: { start, end }, newText });
        }

        totalEdits += normEdits.length;
        if (totalEdits > maxEdits) {
            return { ok: false, errors: [{ code: "max_edits", message: `total edits ${totalEdits} exceeds maxEdits ${maxEdits}` }] };
        }
        if (totalBytes > maxTotalBytes) {
            return { ok: false, errors: [{ code: "max_bytes", message: `total bytes ${totalBytes} exceeds maxTotalBytes ${maxTotalBytes}` }] };
        }

        // Check overlapping edits within same file
        if (normEdits.length > 1) {
            const sorted = [...normEdits].sort((a, b) => comparePos(a.range.start, b.range.start) || comparePos(a.range.end, b.range.end));
            for (let k = 0; k < sorted.length - 1; k++) {
                const curEnd = sorted[k]!.range.end;
                const nextStart = sorted[k + 1]!.range.start;
                if (comparePos(curEnd, nextStart) > 0) {
                    errors.push({ code: "overlapping_edits", message: `fileEdits[${idx}] has overlapping edits at indices ${k} and ${k + 1}`, filePath: canonical });
                    break;
                }
            }
            if (errors.some((er) => er.code === "overlapping_edits" && er.filePath === canonical)) {
                // don't push validated if overlapping
                continue;
            }
        }

        // Only push if no errors for this file entry
        const hasFileErrors = errors.some((er) => er.filePath === canonical);
        if (!hasFileErrors) {
            validated.push({ filePath: canonical, edits: normEdits });
        } else {
            // If errors for this file, don't add to validated, but continue collecting other files
            // If we already pushed errors, keep them
        }
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    // Final bounds check (already done incrementally, but re-check)
    if (validated.length === 0) {
        return { ok: false, errors: [{ code: "empty_validated", message: "no valid fileEdits after validation" }] };
    }

    return { ok: true, value: { fileEdits: validated } };
}
