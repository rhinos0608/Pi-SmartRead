/**
 * Shared ContextGraph lifecycle (owning module).
 *
 * Module-level singleton. Built lazily on first access. Rebuilt when
 * the watcher marks it dirty. Passed to inspect/grep via DI — never
 * imported into hook.ts to avoid cycles.
 *
 * Two accessors:
 *  - getSharedContextGraph(): synchronous, returns the instance without
 *    awaiting a build. Kept for direct/internal tests and non-graph paths.
 *  - getSharedContextGraphAsync(): awaits a successful buildContextGraph()
 *    (including the call graph) before returning. Registered public runtime
 *    tools (grep graphFilter, inspect graph-dependent params) MUST use this
 *    so they never receive an unbuilt graph. Concurrent callers coalesce on
 *    a single build promise; a failed build stays retryable/dirty and the
 *    shared instance is only replaced after a successful rebuild.
 */
import { ContextGraph } from "./context-graph.js";

let sharedContextGraph: ContextGraph | null = null;
let sharedContextGraphRoot: string | null = null;
let sharedContextGraphBuilt = false;
// Invalidation revision: bumped by invalidateSharedGraph() whenever the
// workspace mutates (watcher event, successful write/edit/graph_mutate).
let graphRevision = 0;
// Revision of the workspace state that the currently shared graph reflects.
// -1 until the first successful build. A graph is only fresh for a caller
// when graphRevision === sharedGraphRevision (the mutation was included).
let sharedGraphRevision = -1;
// In-flight build chain. A single tail promise; a rebuild triggered while a
// build is running is chained after it, so concurrent callers coalesce onto
// identical required builds but a mutation invalidating a mid-flight build
// still produces a graph rebuilt after the mutation.
let buildTail: Promise<void> | null = null;
let buildTailRoot: string | null = null;
// Cap on chained rebuild attempts per getSharedContextGraphAsync call: a
// mutation storm must not rebuild forever. After the cap, the most recently
// built graph is returned even if a newer revision exists.
const MAX_GRAPH_BUILD_ATTEMPTS = 3;

/**
 * Mark the shared graph stale because the workspace changed. Any graph built
 * before this call no longer reflects current state and will be rebuilt on the
 * next graph-dependent request. Safe to call while a build is in flight: the
 * in-flight build is not promoted (its revision is stale) and a rebuild is
 * chained after it.
 */
export function invalidateSharedGraph(): void {
  graphRevision++;
}

/**
 * Read-only access to the monotonic workspace revision. Bumped by every
 * workspace mutation (watcher event, successful write/edit/graph_mutate).
 * Consumed by grep's no-index BM25 corpus cache to decide when a cached
 * corpus is stale. A single global monotonic counter is used (not per-root):
 * a mutation anywhere bumps it for every root, which causes only extra cache
 * misses (never stale corpus data), keeping the graph invalidation semantics
 * unchanged.
 */
export function getWorkspaceRevision(): number {
  return graphRevision;
}

/**
 * Synchronous peek at the shared ContextGraph for a root, returning it only
 * when it has actually been built for that root (never triggering a build).
 * Null when unbuilt or built for a different root. Lets no-index grep reuse
 * the structural symbol index without eagerly building the graph.
 */
export function getSharedContextGraphIfBuilt(root: string): ContextGraph | null {
  return sharedContextGraphBuilt && sharedContextGraphRoot === root ? sharedContextGraph : null;
}

/**
 * Get or create the shared ContextGraph for the given root.
 * When dirty is true, forces a full rebuild.
 *
 * Synchronous — does NOT await buildContextGraph(). Use
 * getSharedContextGraphAsync() from registered runtime tools.
 */
export function getSharedContextGraph(
    root: string,
    dirty?: boolean,
): ContextGraph {
    if (!sharedContextGraph || sharedContextGraphRoot !== root || dirty) {
        sharedContextGraph = new ContextGraph(root);
        sharedContextGraphRoot = root;
        sharedContextGraphBuilt = false;
    }
    return sharedContextGraph;
}

/**
 * Get the shared ContextGraph for the given root, awaiting a successful
 * buildContextGraph({ includeCalls: true }) before returning. Concurrent
 * callers coalesce onto identical required builds. A build invalidated
 * mid-flight (a mutation arrived while it was building) is NOT promoted and a
 * rebuild is chained after it, so callers never receive a graph built before a
 * mutation that is still marked fresh. A failed build throws (caller stays
 * retryable/dirty) and the shared instance is only swapped after success.
 */
export async function getSharedContextGraphAsync(
    root: string,
    dirty?: boolean,
): Promise<ContextGraph> {
    // An explicit dirty request forces a rebuild regardless of current state.
    if (dirty) invalidateSharedGraph();
    const requiredRevision = graphRevision;
    let buildAttempts = 0;
    for (;;) {
        // Fast path: a built graph that already covers the required revision.
        if (sharedContextGraphBuilt && sharedContextGraphRoot === root && sharedGraphRevision >= requiredRevision) {
            return sharedContextGraph!;
        }
        // Coalesce onto an in-flight build for this root, then re-evaluate.
        if (buildTail && buildTailRoot === root) {
            const tail = buildTail;
            try { await tail; } catch { /* retryable: loop schedules a rebuild */ }
            if (buildTail === tail) { buildTail = null; buildTailRoot = null; }
            continue;
        }
        // Cap reached: return the most recently built graph even when a newer
        // revision is pending (a mutation storm must not rebuild forever).
        if (buildAttempts >= MAX_GRAPH_BUILD_ATTEMPTS) {
            if (sharedContextGraph && sharedContextGraphRoot === root) return sharedContextGraph;
            // No graph ever built — fall through to one final build below.
        }
        // Chain a build after any existing tail. It targets the latest
        // revision at the moment it actually starts building.
        buildTailRoot = root;
        const prev = buildTail;
        const tailPromise = (async () => {
            if (prev) { try { await prev; } catch { /* retryable */ } }
            const startRevision = graphRevision;
            const candidate = new ContextGraph(root);
            await candidate.buildContextGraph({ includeCalls: true });
            // Promote only if no mutation invalidated the build mid-flight.
            if (graphRevision === startRevision) {
                sharedContextGraph = candidate;
                sharedContextGraphRoot = root;
                sharedContextGraphBuilt = true;
                sharedGraphRevision = startRevision;
            }
        })();
        buildTail = tailPromise;
        try {
            await tailPromise;
            buildAttempts++;
        } catch (err) {
            // Failed build: keep the previous graph, remain retryable/dirty.
            // Clear the built flag only when the shared graph no longer covers
            // the current revision — an earlier chained build may have already
            // promoted a valid current graph.
            if (sharedGraphRevision < graphRevision) {
                sharedContextGraphBuilt = false;
            }
            throw err;
        }
        // Loop re-evaluates; if invalidated mid-build, a rebuild is chained.
    }
}

/** Dispose the shared ContextGraph (for test isolation / shutdown). */
export function resetSharedContextGraph(): void {
    sharedContextGraph = null;
    sharedContextGraphRoot = null;
    sharedContextGraphBuilt = false;
    graphRevision = 0;
    sharedGraphRevision = -1;
    buildTail = null;
    buildTailRoot = null;
}
