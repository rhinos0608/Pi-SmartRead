/**
 * FS Scan Cache — TTL-based cache for file-system scans shared across tools.
 *
 * Problem: tools like search, find, and read_files each call findSrcFiles()
 * independently, causing redundant directory traversals on every invocation.
 *
 * Solution: a TTL-gated LRU cache keyed on (root, gitignore-rules-hash, typeFilter).
 * - Default TTL: 1000ms (configurable via FS_SCAN_CACHE_TTL_MS)
 * - Empty-result fast recheck: 200ms (FS_SCAN_EMPTY_RECHECK_MS)
 * - Max 16 entries (FS_SCAN_CACHE_MAX_ENTRIES)
 * - LRU eviction when capacity is reached
 *
 * On write/edit tool calls, callers should invoke invalidatePath(target) so that
 * scans covering the mutated path are removed from the cache.
 */

import { resolve } from "node:path"

// ── Config ─────────────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = parseInt(
	process.env["FS_SCAN_CACHE_TTL_MS"] ?? "1000",
	10,
)
const DEFAULT_EMPTY_RECHECK_MS = parseInt(
	process.env["FS_SCAN_EMPTY_RECHECK_MS"] ?? "200",
	10,
)
const DEFAULT_MAX_ENTRIES = parseInt(
	process.env["FS_SCAN_CACHE_MAX_ENTRIES"] ?? "16",
	10,
)

// ── Types ───────────────────────────────────────────────────────────────────

export interface FsScanCacheOptions {
	/** Time-to-live for cache entries in milliseconds. Default: 1000 */
	ttlMs?: number
	/**
	 * For empty results, re-check sooner than ttlMs to catch rapid file changes.
	 * Default: 200
	 */
	emptyRecheckMs?: number
	/** Maximum number of cache entries before LRU eviction. Default: 16 */
	maxEntries?: number
}

interface CacheEntry<T> {
	data: T
	createdAt: number
	accessCount: number // tracks access for LRU ordering
}

// ── Cache core ─────────────────────────────────────────────────────────────

class TtlLruCache<T> {
	private values = new Map<string, CacheEntry<T>>()

	constructor(readonly maxSize: number) {}

	get(key: string): T | undefined {
		const entry = this.values.get(key)
		if (entry === undefined) return undefined
		// Bump access count for LRU ordering
		entry.accessCount++
		// Move to end (most recently used)
		this.values.delete(key)
		this.values.set(key, entry)
		return entry.data
	}

	set(key: string, value: T): void {
		if (this.values.has(key)) {
			this.values.delete(key)
		}
		this.values.set(key, {
			data: value,
			createdAt: Date.now(),
			accessCount: 0,
		})
		while (this.values.size > this.maxSize) {
			// Evict least recently used (lowest access count, oldest)
			let lruKey: string | undefined
			let lruScore = Infinity
			let lruCreatedAt = Infinity
			for (const [k, e] of this.values) {
				const score = e.accessCount
				const createdAt = e.createdAt
				if (score < lruScore || (score === lruScore && createdAt < lruCreatedAt)) {
					lruScore = score
					lruCreatedAt = createdAt
					lruKey = k
				}
			}
			if (lruKey === undefined) break
			this.values.delete(lruKey)
		}
	}

	has(key: string): boolean {
		return this.values.has(key)
	}

	delete(key: string): boolean {
		return this.values.delete(key)
	}

	/** Remove all entries whose resolved root path is at or under targetPath. */
	deleteMatching(predicate: (key: string) => boolean): number {
		let removed = 0
		for (const key of [...this.values.keys()]) {
			if (predicate(key)) {
				this.values.delete(key)
				removed++
			}
		}
		return removed
	}

	clear(): void {
		this.values.clear()
	}

	get size(): number {
		return this.values.size
	}

	entries(): IterableIterator<[string, CacheEntry<T>]> {
		return this.values[Symbol.iterator]()
	}
}

// ── FsScanCache ─────────────────────────────────────────────────────────────

/**
 * Runtime guard: confirm a value is a non-null array.
 * Defends against runtime type-bypass/casting (T extends unknown[] is a compile-time
 * constraint only — objects passed through `as` casts or from JS callers bypass it).
 */
function isArrayResult<T>(value: T): value is T & unknown[] {
	return Array.isArray(value);
}

export class FsScanCache<T extends unknown[]> {
	private cache: TtlLruCache<T>
	private ttlMs: number
	private emptyRecheckMs: number

	constructor(options: FsScanCacheOptions = {}) {
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
		this.emptyRecheckMs = options.emptyRecheckMs ?? DEFAULT_EMPTY_RECHECK_MS
		this.cache = new TtlLruCache<T>(options.maxEntries ?? DEFAULT_MAX_ENTRIES)
	}

	/**
	 * Build a cache key from scan options.
	 * Combines resolved root + gitignore rules hash + type filter.
	 */
		private buildKey(
		root: string,
		gitignoreRules?: string[],
		typeFilter?: string,
		maxFiles?: number,
	): string {
		const resolvedRoot = resolve(root)
		const gitignoreHash = (gitignoreRules ?? []).join("|")
		const filter = typeFilter ?? ""
		const mf = maxFiles !== undefined ? String(maxFiles) : ""
		return `${resolvedRoot}|${gitignoreHash}|${filter}|${mf}`
	}

	/**
	 * Get cached scan results, or run the scan if the cache is empty or expired.
	 * - Non-empty results expire at ttlMs.
	 * - Empty results expire at emptyRecheckMs (faster recheck for rapid changes).
	 *
	 * @param root - Root directory being scanned.
	 * @param scanFn - Async function that performs the actual file-system scan.
	 * @returns Result plus age of the cache entry in milliseconds.
	 */
	async getOrScan(
		root: string,
		scanFn: () => Promise<T>,
		gitignoreRules?: string[],
		typeFilter?: string,
		maxFiles?: number,
	): Promise<{ entries: T; cacheAgeMs: number }> {
		const key = this.buildKey(root, gitignoreRules, typeFilter, maxFiles)

		// Check cache: .get() bumps LRU access count, cacheGetWithAge retrieves metadata
		const cached = this.cache.get(key)
		const entryData = this.cacheGetWithAge(key)
		if (cached !== undefined && entryData !== undefined) {
			const now = Date.now()
			const age = now - entryData.createdAt
			const ttl = isArrayResult(entryData.data) && entryData.data.length === 0
				? this.emptyRecheckMs
				: this.ttlMs
			if (age < ttl) {
				return { entries: cached, cacheAgeMs: age }
			}
		}

		// Cache miss or expired — run the scan
		const result = await scanFn()

		// Re-check: if result is empty and a stale entry exists, skip caching to
		// allow rapid re-scanning for newly created files
		if (isArrayResult(result) && result.length === 0) {
			const existingEntry = this.cacheGetWithAge(key)
			if (existingEntry !== undefined) {
				const age = Date.now() - existingEntry.createdAt
				if (age < this.emptyRecheckMs) {
					return { entries: result, cacheAgeMs: age }
				}
			}
		}

		this.cache.set(key, result)
		return { entries: result, cacheAgeMs: 0 }
	}

	/** Internal: get entry with its createdAt timestamp. */
	private cacheGetWithAge(key: string): CacheEntry<T> | undefined {
		// Access via entries iterator since TtlLruCache doesn't expose metadata
		// We stored createdAt in the entry itself
		for (const [k, entry] of this.cache.entries()) {
			if (k === key) return entry
		}
		return undefined
	}

	/**
	 * Force a fresh scan, bypassing the cache.
	 *
	 * @param root - Root directory being scanned.
	 * @param scanFn - Async function that performs the actual file-system scan.
	 */
	async forceRescan(
		root: string,
		scanFn: () => Promise<T>,
		gitignoreRules?: string[],
		typeFilter?: string,
		maxFiles?: number,
	): Promise<{ entries: T; cacheAgeMs: number }> {
		const key = this.buildKey(root, gitignoreRules, typeFilter, maxFiles)
		this.cache.delete(key)
		const result = await scanFn()
		this.cache.set(key, result)
		return { entries: result, cacheAgeMs: 0 }
	}

	/**
	 * Invalidate cache entries whose cached root is equal to or an ancestor of the
	 * provided target path. Any cached scan whose root directory would contain
	 * the mutated path is invalidated.
	 *
	 * Call this on write/edit tool calls so subsequent scans pick up mutations.
	 *
	 * @param target - Path that was mutated. Can be a file or directory.
	 */
	invalidatePath(target: string): number {
		const resolvedTarget = resolve(target)
		return this.cache.deleteMatching((key) => {
			// Key format: "resolvedRoot|gitignoreHash|typeFilter"
			const sepIndex = key.indexOf("|")
			if (sepIndex === -1) return false
			const cacheRoot = key.slice(0, sepIndex)
			// Invalidate if target is at or under the cached root
			return (
				resolvedTarget === cacheRoot ||
				resolvedTarget.startsWith(cacheRoot + "/")
			)
		})
	}

	/** Invalidate all cache entries. */
	invalidateAll(): void {
		this.cache.clear()
	}

	/** Current number of cache entries. */
	get size(): number {
		return this.cache.size
	}
}

// ── Default instance for cross-tool sharing ─────────────────────────────────

const _defaultInstance = new FsScanCache<string[]>()

/**
 * Get the shared default FsScanCache instance.
 * Suitable for use by search, find, read_files tools.
 */
export function getFsScanCache(): FsScanCache<string[]> {
		return _defaultInstance
	}

/**
 * Invalidate the shared cache for a mutated path.
 * Call this from write/edit tool handlers in index.ts.
 */
export function invalidateFsScanCache(target: string): number {
	return _defaultInstance.invalidatePath(target) as number
}