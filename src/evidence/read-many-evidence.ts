import {
	canonicalizeWorkspaceRoot,
	hashSessionFilePath,
	inspectionIdFor,
	PROTOCOL_SCHEMA_VERSION,
	type InspectedResource,
	type InspectMode,
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
	/**
	 * Envelope mode. Defaults to `"path"` — existing `read`-paths call
	 * sites omit this and keep byte-identical behavior. Script mode passes
	 * `"query"` (contract.ts's already-permitted may-have-zero-resources bucket).
	 */
	readonly mode?: InspectMode;
	/**
	 * Dedupe policy for entries sharing a `resourceId`. Default
	 * `"first-wins"` (existing, tested `read` behavior). Script mode
	 * passes `"last-wins"`: the chronologically later envelope in
	 * iteration order overwrites the earlier one, so the merged envelope
	 * reflects the most recent observation of each resource (§6).
	 * Callers must insert envelopes in call-log completion order for
	 * `"last-wins"` to mean last-completed-wins.
	 */
	readonly dedupe?: "first-wins" | "last-wins";
}): WorkspaceEvidenceEnvelope | null {
	if (args.perFile.size === 0) return null;
	const sessionId = hashSessionFilePath(args.sessionFilePath);
	const canonicalWorkspaceRoot = canonicalizeWorkspaceRoot(args.cwd);
	const lastWins = args.dedupe === "last-wins";
	const indexByResourceId = new Map<string, number>();
	const mergedResources: InspectedResource[] = [];
	for (const env of args.perFile.values()) {
		for (const r of env.resources) {
			const existing = indexByResourceId.get(r.resourceId);
			if (existing === undefined) {
				indexByResourceId.set(r.resourceId, mergedResources.length);
				mergedResources.push(r);
			} else if (lastWins) {
				mergedResources[existing] = r;
			}
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
		mode: args.mode ?? "path",
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
