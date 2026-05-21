/**
 * Per-session file read cache for anchor-stale recovery.
 *
 * Stores what the model sees (rendered lines from read/search tools) so that
 * subsequent hashline-anchored edits can be validated against the snapshot
 * rather than live disk. This enables "what was I looking at?" recovery
 * without re-reading every file.
 *
 * Keyed by tool session so different sessions don't share snapshots.
 */

import { LruCache } from "./utils.js";

const MAX_PATHS_PER_SESSION = 30;

/**
 * A single cached file snapshot: Map<1-based line number, line content>.
 */
export type FileSnapshot = Map<number, string>;

/**
 * Sparse entry from search results: line number + matched content.
 */
export interface SearchMatchEntry {
	line: number;
	text: string;
}

interface SessionCache {
	snapshots: LruCache<FileSnapshot>;
}

/**
 * Get or create the per-session cache for a given session ID.
 */
function getSessionCache(sessionId: string): SessionCache {
	const map = _sessionCaches.get(sessionId);
	if (map) return map;

	const cache: SessionCache = {
		snapshots: new LruCache<FileSnapshot>(MAX_PATHS_PER_SESSION),
	};
	_sessionCaches.set(sessionId, cache);
	return cache;
}

// ── Module-level session map ──────────────────────────────────────────────────

const _sessionCaches = new Map<string, SessionCache>();

/**
 * Resolve a session key from a toolCallId or similar unique identifier.
 * Falls back to "default" if no session context is available.
 */
export function resolveSessionKey(toolCallId: string): string {
	// Strip the trailing numeric suffix if present (e.g., "abc:0" → "abc")
	const lastColon = toolCallId.lastIndexOf(":");
	if (lastColon > 0) {
		const prefix = toolCallId.slice(0, lastColon);
		// If the prefix is non-trivial, use it as the session key
		if (prefix.length > 0) return prefix;
	}
	return toolCallId;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a contiguous block of lines from a read tool result.
 *
 * @param sessionId   Unique session/tool-call identifier
 * @param absPath      Absolute file path
 * @param startLine    1-based line number of the first entry in `lines`
 * @param lines        Array of line contents (index 0 = line `startLine`)
 */
export function recordContiguous(
	sessionId: string,
	absPath: string,
	startLine: number,
	lines: string[],
): void {
	const cache = getSessionCache(sessionId);
	const existing = cache.snapshots.get(absPath);

	if (existing) {
		// Conflict detection: if any line in the new block differs from
		// the cached content at the same line numbers, the file has changed.
		// Invalidate the entire snapshot — the new read is now ground truth.
		for (let i = 0; i < lines.length; i++) {
			const lineNum = startLine + i;
			const cachedLine = existing.get(lineNum);
			if (cachedLine !== undefined && cachedLine !== lines[i]!) {
				// Content diverges — file changed since last snapshot.
				// Replace the entire snapshot with the new contiguous block.
				const newSnapshot = new Map<number, string>();
				for (let j = 0; j < lines.length; j++) {
					newSnapshot.set(startLine + j, lines[j]!);
				}
				cache.snapshots.set(absPath, newSnapshot);
				return;
			}
		}
		// No conflicts — extend the snapshot with any new line numbers.
		for (let i = 0; i < lines.length; i++) {
			const lineNum = startLine + i;
			if (!existing.has(lineNum)) {
				existing.set(lineNum, lines[i]!);
			}
		}
		return;
	}

	// No existing snapshot — create a new one.
	const snapshot = new Map<number, string>();
	for (let i = 0; i < lines.length; i++) {
		snapshot.set(startLine + i, lines[i]!);
	}
	cache.snapshots.set(absPath, snapshot);
}

/**
 * Record sparse search match results.
 *
 * @param sessionId   Unique session/tool-call identifier
 * @param absPath      Absolute file path
 * @param entries      Array of { line, text } entries
 */
export function recordSparse(
	sessionId: string,
	absPath: string,
	entries: SearchMatchEntry[],
): void {
	if (entries.length === 0) return;

	const cache = getSessionCache(sessionId);
	const existing = cache.snapshots.get(absPath);

	if (existing) {
		// Sparse records may span gaps — check each entry individually.
		for (const entry of entries) {
			const cachedLine = existing.get(entry.line);
			if (cachedLine !== undefined && cachedLine !== entry.text) {
				// Conflict detected — replace snapshot entirely.
				const newSnapshot = new Map<number, string>();
				for (const e of entries) {
					newSnapshot.set(e.line, e.text);
				}
				cache.snapshots.set(absPath, newSnapshot);
				return;
			}
		}
		// No conflicts — merge in new entries.
		for (const entry of entries) {
			if (!existing.has(entry.line)) {
				existing.set(entry.line, entry.text);
			}
		}
		return;
	}

	// No existing snapshot — create from sparse entries.
	const snapshot = new Map<number, string>();
	for (const entry of entries) {
		snapshot.set(entry.line, entry.text);
	}
	cache.snapshots.set(absPath, snapshot);
}

/**
 * Retrieve the cached snapshot for a file, or null if not in cache.
 *
 * @param sessionId   Unique session/tool-call identifier
 * @param absPath     Absolute file path
 * @returns The cached snapshot Map, or null if not found
 */
export function getSnapshot(
	sessionId: string,
	absPath: string,
): FileSnapshot | null {
	const cache = _sessionCaches.get(sessionId);
	if (!cache) return null;
	const snapshot = cache.snapshots.get(absPath);
	return snapshot ?? null;
}

/**
	* Invalidate (remove) the cached snapshot for a single path.
	*
	* @param sessionId   Unique session/tool-call identifier
	* @param absPath     Absolute file path
	*/
	export function invalidate(sessionId: string, absPath: string): void {
	const cache = _sessionCaches.get(sessionId);
	if (!cache) return;
	// Only remove the snapshot if it exists; don't treat a false return from
	// delete() (key not present) as a signal to clear the whole session.
	cache.snapshots.delete(absPath);
}

/**
 * Clear all cached snapshots for a session.
 *
 * @param sessionId   Unique session/tool-call identifier
 */
export function clearSession(sessionId: string): void {
	_sessionCaches.delete(sessionId);
}

/**
 * Test-only: clear ALL sessions. Not for production use.
 */
export function __test__clearAll(): void {
	_sessionCaches.clear();
}