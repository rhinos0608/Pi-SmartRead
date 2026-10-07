import { describe, it, expect } from "vitest";
import type { ScriptHostApi, HostFn } from "../../../src/script-mode/host-bindings.js";
import { runInSandbox } from "../../../src/script-mode/sandbox.js";

function stubHost(overrides: Partial<Record<string, HostFn>> = {}): ScriptHostApi {
    const unexpected: HostFn = async (...args) => {
        throw new Error(`unexpected host call: ${JSON.stringify(args).slice(0, 80)}`);
    };
    const lsp: Record<string, HostFn> = {};
    for (const name of [
        "definition", "references", "implementation", "hover", "documentSymbols",
        "workspaceSymbols", "prepareCallHierarchy", "incomingCalls", "outgoingCalls",
    ]) lsp[name] = overrides[`lsp.${name}`] ?? unexpected;
    const graph: Record<string, HostFn> = {};
    for (const name of [
        "impact", "deadCode", "callGraph", "hotspots", "routes",
        "diff", "clusters", "layers", "boundaries",
    ]) graph[name] = overrides[`graph.${name}`] ?? unexpected;
    return {
        grep: overrides.grep ?? unexpected,
        read: overrides.read ?? unexpected,
        inspectFile: overrides.inspectFile ?? unexpected,
        inspectDir: overrides.inspectDir ?? unexpected,
        lsp,
        graph,
    };
}

const okValue = (value: unknown): HostFn => async () => ({ value, evidence: null });

function freshSignal(): { signal: AbortSignal; abort: () => void } {
    const controller = new AbortController();
    return { signal: controller.signal, abort: () => controller.abort() };
}

describe("sandbox (spike ports)", () => {
    it("async bridge round trip without asyncify", async () => {
        const host = stubHost({ grep: async (pattern) => ({ value: `pong:${pattern}`, evidence: null }) });
        const { signal } = freshSignal();
        const outcome = await runInSandbox({
            script: `return await grep("ping") + "!";`,
            host,
            signal,
            timeoutMs: 5000,
        });
        expect(outcome.status).toBe("ok");
        expect(outcome.returnValue).toBe("pong:ping!");
    });

    it("passes objects both directions", async () => {
        const host = stubHost({ read: okValue({ lineCount: 7, truncated: false, nested: { a: [1, 2] } }) });
        const { signal } = freshSignal();
        const outcome = await runInSandbox({
            script: `const r = await read("x", { offset: 2, limit: 3 }); return r.lineCount + ":" + r.truncated + ":" + r.nested.a[1];`,
            host,
            signal,
            timeoutMs: 5000,
        });
        expect(outcome.status).toBe("ok");
        expect(outcome.returnValue).toBe("7:false:2");
    });

    it("host-side deadline wins while the interpreter interrupt is parked far out (spike c)", async () => {
        const ctl = new AbortController();
        const host = stubHost({
            grep: async () =>
                new Promise<never>((_resolve, reject) => {
                    ctl.signal.addEventListener(
                        "abort",
                        () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
                        { once: true },
                    );
                }),
        });
        setTimeout(() => ctl.abort(), 200);
        const t0 = Date.now();
        const outcome = await runInSandbox({
            script: `return await grep("slow");`,
            host,
            signal: ctl.signal,
            timeoutMs: 20_000,
            interruptDeadlineMs: 30_000,
        });
        const elapsed = Date.now() - t0;
        expect(outcome.status).toBe("degraded");
        expect(elapsed).toBeLessThan(5000);
        expect(elapsed).toBeGreaterThanOrEqual(150);
        expect(outcome.evidences).toEqual([]);
    });

    it("failsafe timeout bounds even an uncooperative host that ignores abort", async () => {
        const host = stubHost({ grep: () => new Promise(() => {}) as Promise<never> });
        const { signal } = freshSignal();
        const t0 = Date.now();
        const outcome = await runInSandbox({
            script: `return await grep("never");`,
            host,
            signal,
            timeoutMs: 400,
        });
        expect(outcome.status).toBe("degraded");
        expect(outcome.errorKind).toBe("timeout");
        expect(Date.now() - t0).toBeLessThan(5000);
    });

    it("memory limit is catchable and the process survives", async () => {
        // Spike's exact tripping variant: string-doubling hits QuickJS's
        // max-string RangeError first, so grow via array push instead.
        const host = stubHost();
        const { signal } = freshSignal();
        const outcome = await runInSandbox({
            script: `let a = []; try { while (true) { a.push("x".repeat(100000)); } } catch (e) { throw e; }`,
            host,
            signal,
            timeoutMs: 25_000,
            memoryLimitBytes: 8 * 1024 * 1024,
        });
        expect(outcome.status).toBe("degraded");
        expect(outcome.errorKind).toBe("memory-limit");
    }, 30_000);

    it("infinite loop trips the interpreter interrupt", async () => {
        const host = stubHost();
        const { signal } = freshSignal();
        const t0 = Date.now();
        const outcome = await runInSandbox({
            script: `while (true) {}`,
            host,
            signal,
            timeoutMs: 400,
        });
        const elapsed = Date.now() - t0;
        expect(outcome.status).toBe("degraded");
        expect(outcome.errorKind).toBe("interrupted");
        expect(elapsed).toBeLessThan(5000);
    });

    it("context disposal loop stays clean", async () => {
        const host = stubHost({ grep: okValue(0) });
        const { signal } = freshSignal();
        for (let i = 0; i < 5; i++) {
            const outcome = await runInSandbox({
                script: `return (${i} * 2);`,
                host,
                signal,
                timeoutMs: 5000,
            });
            expect(outcome.status).toBe("ok");
            expect(outcome.returnValue).toBe(i * 2);
        }
    });

    it("no-ops guest eval/Function without breaking normal execution", async () => {
        const host = stubHost();
        const { signal } = freshSignal();
        const base = { host, signal, timeoutMs: 5000 };
        expect((await runInSandbox({ ...base, script: `return 1 + 2;` })).returnValue).toBe(3);
        expect((await runInSandbox({ ...base, script: `return typeof eval;` })).returnValue).toBe("undefined");
        expect((await runInSandbox({ ...base, script: `return typeof Function;` })).returnValue).toBe("undefined");
        const evalCall = await runInSandbox({ ...base, script: `eval("1+1"); return "reached";` });
        expect(evalCall.status).toBe("degraded");
        expect(evalCall.errorKind).toBe("js-exception");
        const fnCall = await runInSandbox({ ...base, script: `new Function("return 1"); return "reached";` });
        expect(fnCall.status).toBe("degraded");
        expect(fnCall.errorKind).toBe("js-exception");
    });

    it("constructor-chain reconstruction stays in the guest realm (no host reach)", async () => {
        const host = stubHost();
        const { signal } = freshSignal();
        const base = { host, signal, timeoutMs: 5000 };
        // Spike proved a reconstructed Function stays in the guest realm with
        // no host `process`. Encode exactly that — not a stronger claim.
        const outcome = await runInSandbox({
            ...base,
            script: `const F = (async function(){}).constructor; try { const f = new F("return typeof process"); return f(); } catch (e) { return "threw"; }`,
        });
        expect(outcome.status).toBe("ok");
        expect(["undefined", "threw"]).toContain(outcome.returnValue);
    });

    it("reports host rejections as js-exception and lets scripts catch them", async () => {
        const failing: HostFn = async () => {
            throw new Error("nope");
        };
        const host = stubHost({ read: failing });
        const { signal } = freshSignal();
        const uncaught = await runInSandbox({ script: `return await read("x");`, host, signal, timeoutMs: 5000 });
        expect(uncaught.status).toBe("degraded");
        expect(uncaught.errorKind).toBe("js-exception");
        expect(uncaught.errorMessage).toContain("nope");
        const caught = await runInSandbox({
            script: `try { await read("x"); return "no-throw"; } catch (e) { return "caught:" + e; }`,
            host,
            signal,
            timeoutMs: 5000,
        });
        expect(caught.status).toBe("ok");
        expect(caught.returnValue).toBe("caught:nope");
    });

    it("collects per-call evidences in completion order", async () => {
        const { mkdtempSync, writeFileSync, rmSync, realpathSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const path = (await import("node:path")).default;
        const { computePathEvidence } = await import("../../../src/evidence/path-evidence.js");
        const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "sandbox-ev-")));
        try {
            writeFileSync(path.join(dir, "f.ts"), "a\n");
            const session = "/tmp/fake-sandbox-session.jsonl";
            const env = computePathEvidence({ path: "f.ts", cwd: dir, sessionFilePath: session }).workspaceEvidence;
            const host = stubHost({
                grep: async () => ({ value: "g", evidence: env }),
                read: async () => ({ value: "r", evidence: env }),
            });
            const { signal } = freshSignal();
            const outcome = await runInSandbox({
                script: `const a = await grep("x"); const b = await read("f"); return a + b;`,
                host,
                signal,
                timeoutMs: 5000,
            });
            expect(outcome.status).toBe("ok");
            expect(outcome.returnValue).toBe("gr");
            expect(outcome.evidences).toHaveLength(2);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
