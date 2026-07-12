/**
 * Path-mode workspace-evidence builder — shared by the `inspect` tool's
 * path mode and the wrapped builtin `read` tool. Dependency-free by
 * design: importing this module must never pull in the search/symbol
 * engines (avoids the search-tool → hook import cycle).
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

export interface PathEvidenceInput {
    readonly path: string;
    readonly offset?: number;
    readonly limit?: number;
    readonly cwd: string;
    readonly sessionFilePath: string;
}

export interface PathEvidenceResult {
    readonly workspaceEvidence: WorkspaceEvidenceEnvelope;
    readonly contentText: string;
    /** Raw (unnumbered) attested slice. Full file content for full-file coverage. */
    readonly sliceText: string;
    readonly lineCount: number;
    readonly totalLines: number;
    readonly byteLength: number;
    readonly truncated: boolean;
}

function sha256OfString(s: string): string {
    return createHash("sha256").update(s, "utf8").digest("hex");
}

function requirePositiveInt(v: number | undefined, name: string): void {
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
        throw new Error(`evidence: ${name} must be a positive integer (got ${v})`);
    }
}

export function computePathEvidence(input: PathEvidenceInput): PathEvidenceResult {
    if (typeof input.sessionFilePath !== "string" || input.sessionFilePath.length === 0) {
        throw new Error(
            "evidence requires a real session file path (in-memory/ephemeral identity is rejected)",
        );
    }
    requirePositiveInt(input.offset, "offset");
    requirePositiveInt(input.limit, "limit");

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

    const offset = input.offset;
    const limit = input.limit;
    const hasRange = typeof offset === "number" || typeof limit === "number";
    let resource: InspectedResource;
    let renderedLines: string[];
    let sliceText: string;
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
        sliceText = fullContent;
    } else {
        const startLine = Math.max(1, Math.floor(offset ?? 1));
        const endLine =
            typeof limit === "number"
                ? Math.min(totalLines, startLine + limit - 1)
                : totalLines;
        if (endLine < startLine) {
            throw new Error(
                `inspect: limit/offset produces an empty range (startLine=${startLine}, endLine=${endLine})`,
            );
        }
        const slice = allLines.slice(startLine - 1, endLine).join("\n");
        const rangeResourceId = resourceIdFor({
            canonicalPath: canonicalFile,
            kind: "range",
            range: { startLine, endLine },
        });
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
        sliceText = slice;
        truncated = startLine > 1 || endLine < totalLines;
    }

    const inspectionId = inspectionIdFor({
        sessionId,
        workspaceRoot: canonicalRoot,
        resources: [
            {
                canonicalPath: canonicalFile,
                ...(resource.kind === "range"
                    ? {
                          range: {
                              startLine: resource.allowedRanges[0]!.startLine,
                              endLine: resource.allowedRanges[0]!.endLine,
                          },
                      }
                    : {}),
            },
        ],
    });

    const envelope: WorkspaceEvidenceEnvelope = {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        inspectionId,
        sessionId,
        workspaceRoot: cwd,
        canonicalWorkspaceRoot: canonicalRoot,
        createdAt: new Date().toISOString(),
        resources: [resource],
        mode: "path",
    };

    const startLine = resource.allowedRanges[0]!.startLine;
    const contentText = renderedLines
        .map((line, i) => `${startLine + i}: ${line}`)
        .join("\n");

    return {
        workspaceEvidence: envelope,
        contentText,
        sliceText,
        lineCount: resource.lineCount ?? renderedLines.length,
        totalLines,
        byteLength: resource.byteLength ?? Buffer.byteLength(contentText, "utf8"),
        truncated,
    };
}
