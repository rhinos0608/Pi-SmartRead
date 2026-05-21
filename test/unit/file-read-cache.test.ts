import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
	recordContiguous,
	recordSparse,
	getSnapshot,
	invalidate,
	clearSession,
	resolveSessionKey,
	__test__clearAll,
	type SearchMatchEntry,
} from "../../file-read-cache.js";

beforeEach(() => {
	__test__clearAll();
});

afterEach(() => {
	__test__clearAll();
});

describe("resolveSessionKey", () => {
	it("strips trailing numeric suffix", () => {
		expect(resolveSessionKey("abc:0")).toBe("abc");
		expect(resolveSessionKey("read:42")).toBe("read");
		expect(resolveSessionKey("search:999")).toBe("search");
	});

	it("returns full key when no colon", () => {
		expect(resolveSessionKey("abc")).toBe("abc");
	});

	it("returns full key when colon is at position 0", () => {
		expect(resolveSessionKey(":abc")).toBe(":abc");
	});
});

describe("recordContiguous", () => {
	it("stores a new snapshot", () => {
		recordContiguous("sess", "/a.ts", 1, ["line 1", "line 2", "line 3"]);
		const snap = getSnapshot("sess", "/a.ts");
		expect(snap).not.toBeNull();
		expect(snap!.get(1)).toBe("line 1");
		expect(snap!.get(2)).toBe("line 2");
		expect(snap!.get(3)).toBe("line 3");
	});

	it("extends an existing snapshot with new line numbers", () => {
		recordContiguous("sess", "/a.ts", 1, ["line 1", "line 2"]);
		recordContiguous("sess", "/a.ts", 3, ["line 3", "line 4"]);
		const snap = getSnapshot("sess", "/a.ts");
		expect(snap).not.toBeNull();
		expect(snap!.size).toBe(4);
		expect(snap!.get(1)).toBe("line 1");
		expect(snap!.get(3)).toBe("line 3");
	});

	it("replaces entire snapshot on conflict", () => {
		recordContiguous("sess", "/a.ts", 1, ["line 1", "line 2"]);
		// Conflicting write at line 2
		recordContiguous("sess", "/a.ts", 2, ["line 2 CHANGED", "line 3"]);
		const snap = getSnapshot("sess", "/a.ts");
		expect(snap).not.toBeNull();
		// Line 1 was not re-recorded — gone because snapshot was replaced.
		// Lines 2 and 3 are present.
		expect(snap!.get(1)).toBeUndefined();
		expect(snap!.get(2)).toBe("line 2 CHANGED");
		expect(snap!.get(3)).toBe("line 3");
	});

	it("ignores same-content records at the same line numbers", () => {
		recordContiguous("sess", "/a.ts", 1, ["line 1", "line 2"]);
		recordContiguous("sess", "/a.ts", 1, ["line 1", "line 2"]);
		const snap = getSnapshot("sess", "/a.ts");
		expect(snap).not.toBeNull();
		expect(snap!.size).toBe(2);
	});

	it("starts at offset line number", () => {
		recordContiguous("sess", "/a.ts", 10, ["line 10", "line 11"]);
		const snap = getSnapshot("sess", "/a.ts");
		expect(snap).not.toBeNull();
		expect(snap!.get(10)).toBe("line 10");
		expect(snap!.get(11)).toBe("line 11");
	});

	it("isolates sessions", () => {
		recordContiguous("sess1", "/a.ts", 1, ["sess1 line"]);
		recordContiguous("sess2", "/a.ts", 1, ["sess2 line"]);
		expect(getSnapshot("sess1", "/a.ts")!.get(1)).toBe("sess1 line");
		expect(getSnapshot("sess2", "/a.ts")!.get(1)).toBe("sess2 line");
	});
});

describe("recordSparse", () => {
	it("stores sparse match entries", () => {
		const entries: SearchMatchEntry[] = [
			{ line: 5, text: "fn hello()" },
			{ line: 12, text: "fn world()" },
		];
		recordSparse("sess", "/b.ts", entries);
		const snap = getSnapshot("sess", "/b.ts");
		expect(snap).not.toBeNull();
		expect(snap!.get(5)).toBe("fn hello()");
		expect(snap!.get(12)).toBe("fn world()");
	});

	it("merges with existing sparse entries", () => {
		recordSparse("sess", "/b.ts", [{ line: 5, text: "fn hello()" }]);
		recordSparse("sess", "/b.ts", [{ line: 12, text: "fn world()" }]);
		const snap = getSnapshot("sess", "/b.ts");
		expect(snap).not.toBeNull();
		expect(snap!.size).toBe(2);
	});

	it("replaces snapshot on conflict", () => {
		recordSparse("sess", "/b.ts", [{ line: 5, text: "fn hello()" }]);
		recordSparse("sess", "/b.ts", [{ line: 5, text: "fn hello MODIFIED()" }]);
		const snap = getSnapshot("sess", "/b.ts");
		expect(snap).not.toBeNull();
		expect(snap!.get(5)).toBe("fn hello MODIFIED()");
		expect(snap!.size).toBe(1);
	});

	it("ignores empty entries", () => {
		recordSparse("sess", "/b.ts", []);
		expect(getSnapshot("sess", "/b.ts")).toBeNull();
	});

	it("isolates sessions", () => {
		recordSparse("sess1", "/b.ts", [{ line: 5, text: "sess1" }]);
		recordSparse("sess2", "/b.ts", [{ line: 5, text: "sess2" }]);
		expect(getSnapshot("sess1", "/b.ts")!.get(5)).toBe("sess1");
		expect(getSnapshot("sess2", "/b.ts")!.get(5)).toBe("sess2");
	});
});

describe("getSnapshot", () => {
	it("returns null for unknown session", () => {
		expect(getSnapshot("unknown-session", "/a.ts")).toBeNull();
	});

	it("returns null for uncached path", () => {
		recordContiguous("sess", "/a.ts", 1, ["line"]);
		expect(getSnapshot("sess", "/unknown.ts")).toBeNull();
	});

	it("returns null for invalidated path", () => {
		recordContiguous("sess", "/a.ts", 1, ["line"]);
		invalidate("sess", "/a.ts");
		expect(getSnapshot("sess", "/a.ts")).toBeNull();
	});
});

describe("invalidate", () => {
	it("removes a single path from cache without affecting other paths", () => {
		recordContiguous("sess", "/a.ts", 1, ["a"]);
		recordContiguous("sess", "/b.ts", 1, ["b"]);
		invalidate("sess", "/a.ts");
		expect(getSnapshot("sess", "/a.ts")).toBeNull();
		expect(getSnapshot("sess", "/b.ts")!.get(1)).toBe("b");
	});

	it("is a no-op for unknown session", () => {
		expect(() => invalidate("unknown-session", "/a.ts")).not.toThrow();
	});
});

describe("clearSession", () => {
	it("removes all cached paths for a session", () => {
		recordContiguous("sess1", "/a.ts", 1, ["a"]);
		recordContiguous("sess1", "/b.ts", 1, ["b"]);
		recordContiguous("sess2", "/c.ts", 1, ["c"]);
		clearSession("sess1");
		expect(getSnapshot("sess1", "/a.ts")).toBeNull();
		expect(getSnapshot("sess1", "/b.ts")).toBeNull();
		expect(getSnapshot("sess2", "/c.ts")!.get(1)).toBe("c");
	});

	it("is safe to call on already-clear session", () => {
		expect(() => clearSession("unknown-session")).not.toThrow();
	});
});