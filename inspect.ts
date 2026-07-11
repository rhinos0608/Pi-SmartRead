/**
 * Compute the inspect tool's `details.workspaceEvidence` envelope.
 *
 * - One explicit file/range.
 * - Hashes the session file path to derive a stable `sessionId`.
 * - Rejects absent/ephemeral session identity.
 * - Computes a deterministic `inspectionId` from session+workspace+resources.
 * - full-file resource carries full content sha256 + fresh=true.
 * - line-range resource MAY carry fullFileSha256 for inside-queue verification.
 * - Truncated output is never advertised as full-file.
 */
import { realpathSync, statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve as pathResolve } from "node:path";
import {
    PROTOCOL_SCHEMA_VERSION,
    hashSessionFilePath,
    inspectionIdFor,
    resourceIdFor,
    canonicalizeWorkspaceRoot,
    type WorkspaceEvidenceEnvelope,
    type InspectedResource,
} from "@rhinos0608/pi-workspace-protocol";

export interface ComputeInspectDetailsInput {
    readonly path: string;
    readonly cwd: string;
    readonly sessionFilePath: string;
    readonly offset?: number;
    readonly limit?: number;
}

export interface InspectDetails {
    readonly tool: "inspect";
    readonly workspaceEvidence: WorkspaceEvidenceEnvelope;
    /** Rendered file content for the model. Always raw text. */
    readonly contentText: string;
    readonly lineCount: number;
    readonly byteLength: number;
    readonly truncated: boolean;
}

function sha256OfString(s: string): string {
    return createHash("sha256").update(s, "utf8").digest("hex");
}

export function computeInspectDetails(input: ComputeInspectDetailsInput): InspectDetails {
    if (typeof input.sessionFilePath !== "string" || input.sessionFilePath.length === 0) {
        throw new Error("inspect requires a real session file path (in-memory/ephemeral identity is rejected)");
    }

    const cwd = realpathSync(input.cwd);
    const absolutePath = pathResolve(cwd, input.path);
    let canonicalFile: string;
    try {
        const stat = statSync(absolutePath);
        if (!stat.isFile()) {
            throw new Error(`inspect target is not a regular file: ${input.path}`);
        }
        canonicalFile = realpathSync(absolutePath);
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") {
            throw new Error(`file not found: ${input.path}`);
        }
        throw err;
    }

    const raw = readFileSync(canonicalFile);
    const fullContent = raw.toString("utf8");
    const fullFileSha256 = sha256OfString(fullContent);
    const allLines = fullContent.split("\n");
    const totalLines = allLines.length;
    const totalBytes = Buffer.byteLength(fullContent, "utf8");

    const canonicalRoot = canonicalizeWorkspaceRoot(cwd);
    const sessionId = hashSessionFilePath(input.sessionFilePath);

    // Determine resource kind/coverage
    const offset = input.offset;
    const limit = input.limit;
    const hasRange = typeof offset === "number" || typeof limit === "number";
    let resource: InspectedResource;
    let renderedLines: string[];
    let truncated = false;

    if (!hasRange) {
        resource = {
            resourceId: resourceIdFor({ canonicalPath: canonicalFile, kind: "full" }),
            canonicalPath: canonicalFile,
            kind: "full",
            coverage: "full-file",
            allowedRanges: [{ startLine: 1, endLine: totalLines }],
            fullFileSha256,
            fresh: true,
            byteLength: totalBytes,
            lineCount: totalLines,
        };
        renderedLines = allLines;
    } else {
        const startLine = Math.max(1, Math.floor(offset ?? 1));
        const endLine =
            typeof limit === "number" && Number.isInteger(limit) && limit > 0
                ? Math.min(totalLines, startLine + limit - 1)
                : totalLines;
        if (endLine < startLine) {
            throw new Error(`inspect: limit/offset produces an empty range (startLine=${startLine}, endLine=${endLine})`);
        }
        const slice = allLines.slice(startLine - 1, endLine).join("\n");
        // Did the user ask for a line-range? If so, we may still carry the full
        // sha256 to enable inside-queue verification, but the resource is
        // explicitly a range (coverage=line-range) and authorized only for the
        // requested lines.
        const rangeSliceSha = sha256OfString(slice);
        const rangeResourceId = resourceIdFor({
            canonicalPath: canonicalFile,
            kind: "range",
            range: { startLine, endLine },
        });
        // For the line-range case, fullFileSha256 is included so the inside-queue
        // check can verify the full content if the patch targets the whole file
        // (still a no-op for unauthorized coverage on a line-range resource).
        resource = {
            resourceId: rangeResourceId,
            canonicalPath: canonicalFile,
            kind: "range",
            coverage: "line-range",
            allowedRanges: [{ startLine, endLine }],
            fullFileSha256,
            fresh: true,
            byteLength: Buffer.byteLength(slice, "utf8"),
            lineCount: endLine - startLine + 1,
        };
        renderedLines = slice.split("\n");
        // Mark truncated if not full file
        truncated = startLine > 1 || endLine < totalLines;
        // Note: rangeSliceSha is intentionally unused; the range resource
        // carries the full file sha so patch can verify inside the queue.
        void rangeSliceSha;
    }

    const inspectionId = inspectionIdFor({
        sessionId,
        workspaceRoot: canonicalRoot,
        resources: [{ canonicalPath: canonicalFile, ...(resource.kind === "range" ? { range: { startLine: resource.allowedRanges[0]!.startLine, endLine: resource.allowedRanges[0]!.endLine } } : {}) }],
    });

    const envelope: WorkspaceEvidenceEnvelope = {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        inspectionId,
        sessionId,
        workspaceRoot: cwd,
        canonicalWorkspaceRoot: canonicalRoot,
        createdAt: new Date().toISOString(),
        resources: [resource],
    };

    const startLine = resource.allowedRanges[0]!.startLine;
    const contentText = renderedLines
        .map((line, i) => `${startLine + i}: ${line}`)
        .join("\n");

    return {
        tool: "inspect",
        workspaceEvidence: envelope,
        contentText,
        lineCount: resource.lineCount ?? renderedLines.length,
        byteLength: resource.byteLength ?? Buffer.byteLength(contentText, "utf8"),
        truncated,
    };
}
