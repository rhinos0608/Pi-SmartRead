/**
 * Tests for fs-scan-cache.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { FsScanCache, invalidateFsScanCache, getFsScanCache } from "../../fs-scan-cache.js"

describe("FsScanCache", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fs-scan-cache-test-"))
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	describe("basic cache operations", () => {
		it("caches and returns scan results", async () => {
			const cache = new FsScanCache<string[]>({ ttlMs: 5000, maxEntries: 10 })

			writeFileSync(join(tmpDir, "a.ts"), "export const a = 1;\n")
			writeFileSync(join(tmpDir, "b.ts"), "export const b = 2;\n")

			let callCount = 0
			const scanFn = async () => {
				callCount++
				return ["a.ts", "b.ts"]
			}

			// First call — executes scan
			const result1 = await cache.getOrScan(tmpDir, scanFn)
			expect(result1.entries).toEqual(["a.ts", "b.ts"])
			expect(callCount).toBe(1)

			// Second call — returns from cache
			const result2 = await cache.getOrScan(tmpDir, scanFn)
			expect(result2.entries).toEqual(["a.ts", "b.ts"])
			expect(callCount).toBe(1) // still 1, no new scan
			expect(result2.cacheAgeMs).toBeGreaterThanOrEqual(0)
		})

		it("forceRescan bypasses cache", async () => {
			const cache = new FsScanCache<string[]>({ ttlMs: 5000, maxEntries: 10 })

			let callCount = 0
			const scanFn = async () => {
				callCount++
				return [`file${callCount}.ts`]
			}

			const result1 = await cache.getOrScan(tmpDir, scanFn)
			expect(result1.entries).toEqual(["file1.ts"])

			const result2 = await cache.forceRescan(tmpDir, scanFn)
			expect(result2.entries).toEqual(["file2.ts"])
			expect(callCount).toBe(2)

			// Subsequent getOrScan still uses cache (from forceRescan)
			const result3 = await cache.getOrScan(tmpDir, scanFn)
			expect(result3.entries).toEqual(["file2.ts"])
			expect(callCount).toBe(2)
		})
	})

	describe("LRU eviction", () => {
		it("evicts oldest entries when maxEntries is exceeded", async () => {
			const cache = new FsScanCache<string[]>({ maxEntries: 3 })

			// Create 3 cache entries
			await cache.getOrScan(join(tmpDir, "dir1"), async () => ["dir1"])
			await cache.getOrScan(join(tmpDir, "dir2"), async () => ["dir2"])
			await cache.getOrScan(join(tmpDir, "dir3"), async () => ["dir3"])
			expect(cache.size).toBe(3)

			// Access dir1 to make it recently used
			await cache.getOrScan(join(tmpDir, "dir1"), async () => ["dir1"])

			// Add a 4th entry — should evict dir2 (LRU)
			await cache.getOrScan(join(tmpDir, "dir4"), async () => ["dir4"])
			expect(cache.size).toBe(3)

			// dir2 should be evicted, dir1 and dir3 and dir4 should remain
			const dir1Result = await cache.getOrScan(join(tmpDir, "dir1"), async () => "MISSING" as unknown as string[])
			const dir2Result = await cache.getOrScan(join(tmpDir, "dir2"), async () => "MISSING" as unknown as string[])
			const dir4Result = await cache.getOrScan(join(tmpDir, "dir4"), async () => "MISSING" as unknown as string[])

			expect(dir1Result.entries).toEqual(["dir1"]) // still cached
			expect(dir2Result.entries).toEqual("MISSING") // was evicted, so scan ran
			expect(dir4Result.entries).toEqual(["dir4"]) // still cached
		})
	})

	describe("invalidatePath", () => {
		it("invalidates cache entries whose root is at or under target", async () => {
			const cache = new FsScanCache<string[]>({ maxEntries: 10 })

			mkdirSync(join(tmpDir, "src"), { recursive: true })
			mkdirSync(join(tmpDir, "lib"), { recursive: true })

			// Create cache entries for tmpDir and subdirs
			await cache.getOrScan(tmpDir, async () => ["root"])
			await cache.getOrScan(join(tmpDir, "src"), async () => ["src"])
			await cache.getOrScan(join(tmpDir, "lib"), async () => ["lib"])

			expect(cache.size).toBe(3)

			// Invalidate a file in src — should invalidate src entry
			const removed = cache.invalidatePath(join(tmpDir, "src", "util.ts"))
			expect(removed).toBeGreaterThanOrEqual(1)

			// src entry should be gone, others may remain
			const srcResult = await cache.getOrScan(join(tmpDir, "src"), async () => "MISSING" as unknown as string[])
			expect(srcResult.entries).toEqual("MISSING") // evicted, scan ran

			// lib entry should still be cached
			const libResult = await cache.getOrScan(join(tmpDir, "lib"), async () => "MISSING" as unknown as string[])
			expect(libResult.entries).toEqual(["lib"]) // still cached
		})

		it("invalidateAll clears all entries", async () => {
			const cache = new FsScanCache<string[]>({ maxEntries: 10 })

			await cache.getOrScan(join(tmpDir, "a"), async () => ["a"])
			await cache.getOrScan(join(tmpDir, "b"), async () => ["b"])

			cache.invalidateAll()
			expect(cache.size).toBe(0)

			const result = await cache.getOrScan(join(tmpDir, "a"), async () => "MISSING" as unknown as string[])
			expect(result.entries).toEqual("MISSING") // was cleared, scan ran
		})
	})

	describe("cache key uniqueness", () => {
		it("treats different roots as separate cache entries", async () => {
			const cache = new FsScanCache<string[]>({ maxEntries: 10 })

			mkdirSync(join(tmpDir, "dir1"), { recursive: true })
			mkdirSync(join(tmpDir, "dir2"), { recursive: true })

			const result1 = await cache.getOrScan(join(tmpDir, "dir1"), async () => ["from-dir1"])
			const result2 = await cache.getOrScan(join(tmpDir, "dir2"), async () => ["from-dir2"])

			expect(result1.entries).toEqual(["from-dir1"])
			expect(result2.entries).toEqual(["from-dir2"])
			expect(cache.size).toBe(2)
		})

		it("uses resolved paths for cache keys", async () => {
			const cache = new FsScanCache<string[]>({ maxEntries: 10 })

			mkdirSync(join(tmpDir, "mydir"), { recursive: true })

			const dir1 = join(tmpDir, "mydir")
			const dir2 = join(tmpDir, "mydir", "..", "mydir")

			// Same directory via different paths (one via ..)
			const result1 = await cache.getOrScan(dir1, async () => ["result1"])
		const result2 = await cache.getOrScan(dir2, async () => "MISSING" as unknown as string[])

		// Should be the same cache entry (resolved paths are equal)
		expect(result1.entries).toEqual(["result1"])
		expect(result2.entries).toEqual(["result1"])
		})
	})

	describe("cacheAgeMs", () => {
		it("returns 0 for newly cached entries", async () => {
			const cache = new FsScanCache<string[]>({ ttlMs: 5000 })

			const result = await cache.getOrScan(tmpDir, async () => ["cached"])
			expect(result.cacheAgeMs).toBe(0)
		})
	})

	describe("TTL and expiry behavior", () => {
		it("re-runs scan after emptyRecheckMs for empty results", async () => {
			const cache = new FsScanCache<string[]>({ emptyRecheckMs: 100, ttlMs: 5000 })
			let scanCount = 0
			const scanFn = async () => {
				scanCount++
				return []
			}

			// First call — runs scan, caches empty result
			const result1 = await cache.getOrScan(tmpDir, scanFn)
			expect(result1.entries).toEqual([])
			expect(scanCount).toBe(1)

			// Second call — still within emptyRecheckMs (100ms), should return cached empty
			const result2 = await cache.getOrScan(tmpDir, scanFn)
			expect(result2.entries).toEqual([])
			expect(scanCount).toBe(1)

			// Wait past emptyRecheckMs
			await new Promise((r) => setTimeout(r, 150))

			// Third call — past emptyRecheckMs, scan should run again
			const result3 = await cache.getOrScan(tmpDir, scanFn)
			expect(result3.entries).toEqual([])
			expect(scanCount).toBe(2)
		})

		it("runs a fresh scan after TTL expires", async () => {
			const cache = new FsScanCache<string[]>({ ttlMs: 100, maxEntries: 10 })
			let scanCount = 0
			const scanFn = async () => {
				scanCount++
				return [`file${scanCount}.ts`]
			}

			// First call — caches result
			const result1 = await cache.getOrScan(tmpDir, scanFn)
			expect(result1.entries).toEqual(["file1.ts"])
			expect(scanCount).toBe(1)

			// Second call — within TTL, returns cached
			const result2 = await cache.getOrScan(tmpDir, scanFn)
			expect(result2.entries).toEqual(["file1.ts"])
			expect(scanCount).toBe(1)

			// Wait past TTL
			await new Promise((r) => setTimeout(r, 150))

			// Third call — TTL expired, fresh scan runs
			const result3 = await cache.getOrScan(tmpDir, scanFn)
			expect(result3.entries).toEqual(["file2.ts"])
			expect(scanCount).toBe(2)
		})

		it("returns cached result for concurrent reads after initial scan", async () => {
			const cache = new FsScanCache<string[]>({ ttlMs: 5000, maxEntries: 10 })
			let scanCount = 0
			const scanFn = async () => {
				scanCount++
				await new Promise((r) => setTimeout(r, 50))
				return ["result.ts"]
			}

			// Prime the cache first
			const prime = await cache.getOrScan(tmpDir, scanFn)
			expect(prime.entries).toEqual(["result.ts"])
			expect(scanCount).toBe(1)

			// Concurrent reads should all hit the cache
			const results = await Promise.all([
				cache.getOrScan(tmpDir, scanFn),
				cache.getOrScan(tmpDir, scanFn),
				cache.getOrScan(tmpDir, scanFn),
			])

			expect(scanCount).toBe(1) // scan still only ran once
			for (const r of results) {
				expect(r.entries).toEqual(["result.ts"])
			}
		})
	})
})

describe("global default instance", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fs-scan-default-test-"))
		// Clear global cache before each test
		invalidateFsScanCache(tmpDir)
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
		// Clear global cache after test
		invalidateFsScanCache(tmpDir)
	})

	it("getFsScanCache returns the same shared instance", () => {
		const cache1 = getFsScanCache()
		const cache2 = getFsScanCache()
		expect(cache1).toBe(cache2)
	})

	it("invalidateFsScanCache invalidates entries for a path", async () => {
		const cache = getFsScanCache()

		mkdirSync(join(tmpDir, "project"), { recursive: true })

		await cache.getOrScan(join(tmpDir, "project"), async () => ["cached"])

		const removed = invalidateFsScanCache(join(tmpDir, "project", "src.ts"))
		expect(removed).toBeGreaterThanOrEqual(1)
	})
})