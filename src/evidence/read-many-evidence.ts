import {
	canonicalizeWorkspaceRoot,
	hashSessionFilePath,
	inspectionIdFor,
	PROTOCOL_SCHEMA_VERSION,
	type InspectedResource,
	type WorkspaceEvidenceEnvelope,
} from "@rhinos0608/pi-workspace-protocol";

/**
 * Merge per-file workspace evidence envelopes into a single schemaVersion-3
 * batch envelope. The merged `inspectionId` is recomputed across the combined
 * resource set so downstream patch calls can address the batch with one
 * reference instead of N.
 *
 * Resources are de-duplicated by `resourceId`. The `sessionId` /
 * `canonicalWorkspaceRoot` come from the live session/cwd of the call.
 */
export function buildBatchWorkspaceEvidence(args: {
	readonly cwd: string;
	readonly sessionFilePath: string;
	readonly perFile: ReadonlyMap<number, WorkspaceEvidenceEnvelope>;
}): WorkspaceEvidenceEnvelope | null {
	if (args.perFile.size === 0) return null;
	const sessionId = hashSessionFilePath(args.sessionFilePath);
	const canonicalWorkspaceRoot = canonicalizeWorkspaceRoot(args.cwd);
	const seenResourceIds = new Set<string>();
	const mergedResources: InspectedResource[] = [];
	for (const env of args.perFile.values()) {
		for (const r of env.resources) {
			if (seenResourceIds.has(r.resourceId)) continue;
			seenResourceIds.add(r.resourceId);
			mergedResources.push(r);
		}
	}
	if (mergedResources.length === 0) return null;
	const inspectionId = inspectionIdFor({
		sessionId,
		workspaceRoot: canonicalWorkspaceRoot,
		resources: mergedResources.map((r) => {
			const first = r.allowedRanges[0];
			return {
				canonicalPath: r.canonicalPath,
				...(r.kind === "range" && first
					? { range: { startLine: first.startLine, endLine: first.endLine } }
					: {}),
			};
		}),
	});
	return {
		schemaVersion: PROTOCOL_SCHEMA_VERSION,
		inspectionId,
		sessionId,
		workspaceRoot: args.cwd,
		canonicalWorkspaceRoot,
		createdAt: new Date().toISOString(),
		resources: mergedResources,
		mode: "path",
	};
}

/**
 * Aggregate per-file evidence into one batch envelope.
 *
 * Only complete file blocks actually rendered receive authority. Partial
 * blocks are excluded because their packed window is derived after the
 * original read; no authority is safer than overstated authority.
 * Summarized blocks are excluded (summary lines differ from file bytes).
 * When combined output was truncated, nothing is authorized.
 */
export function aggregateBatchEvidence(args: {
	readonly cwd: string;
	readonly sessionFilePath: string | null;
	readonly perFile: ReadonlyMap<number, WorkspaceEvidenceEnvelope>;
	readonly fullIncluded: ReadonlySet<number>;
	readonly summarizedIndexes: ReadonlySet<number>;
	readonly outputTruncated: boolean;
	readonly publishInspection?: (
		envelope: WorkspaceEvidenceEnvelope,
		sessionFilePath: string,
		workspaceRoot: string,
	) => void;
}): WorkspaceEvidenceEnvelope | null {
	if (!args.sessionFilePath) return null;
	const renderedEvidence = new Map<number, WorkspaceEvidenceEnvelope>();
	if (!args.outputTruncated) {
		for (const index of args.fullIncluded) {
			if (args.summarizedIndexes.has(index)) continue;
			const evidence = args.perFile.get(index);
			if (evidence) renderedEvidence.set(index, evidence);
		}
	}
	const batchEvidence = buildBatchWorkspaceEvidence({
		cwd: args.cwd,
		sessionFilePath: args.sessionFilePath,
		perFile: renderedEvidence,
	});
	if (batchEvidence) {
		try {
			args.publishInspection?.(
				batchEvidence,
				args.sessionFilePath,
				batchEvidence.canonicalWorkspaceRoot,
			);
		} catch {
			// publish is best-effort; swallow
		}
	}
	return batchEvidence;
}
