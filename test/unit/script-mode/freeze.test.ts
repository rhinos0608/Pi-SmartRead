import { describe, it, expect } from "vitest";
import type { ScriptHostApi, HostFn } from "../../../src/script-mode/host-bindings.js";
import { runInSandbox } from "../../../src/script-mode/sandbox.js";

function markerHost(marker: string): ScriptHostApi {
    const fn: HostFn = async () => ({ value: marker, evidence: null });
    const lsp: Record<string, HostFn> = {};
    for (const name of [
        "definition", "references", "implementation", "hover", "documentSymbols",
        "workspaceSymbols", "prepareCallHierarchy", "incomingCalls", "outgoingCalls",
    ]) lsp[name] = fn;
    const graph: Record<string, HostFn> = {};
    for (const name of [
        "impact", "deadCode", "callGraph", "hotspots", "routes",
        "diff", "clusters", "layers", "boundaries",
    ]) graph[name] = fn;
    return { grep: fn, read: fn, inspectFile: fn, inspectDir: fn, lsp, graph };
}

describe("host binding freeze (§1)", () => {
    it("guest reassignment of a top-level binding has no effect", async () => {
        const host = markerHost("real");
        const { signal } = { signal: new AbortController().signal };
        const outcome = await runInSandbox({
            script: `grep = async () => "hacked"; return await grep("x");`,
            host,
            signal,
            timeoutMs: 5000,
        });
        expect(outcome.status).toBe("ok");
        expect(outcome.returnValue).toBe("real");
    });

    it("guest reassignment of a namespaced binding has no effect", async () => {
        const host = markerHost("real");
        const { signal } = { signal: new AbortController().signal };
        const outcome = await runInSandbox({
            script: `lsp.definition = async () => "hacked"; graph.impact = async () => "hacked"; return (await lsp.definition({})) + "+" + (await graph.impact({}));`,
            host,
            signal,
            timeoutMs: 5000,
        });
        expect(outcome.status).toBe("ok");
        expect(outcome.returnValue).toBe("real+real");
    });

    it("guest cannot swap lsp/graph namespaces via defineProperty", async () => {
        const host = markerHost("real");
        const { signal } = { signal: new AbortController().signal };
        const outcome = await runInSandbox({
            script: `try { Object.defineProperty(globalThis, "lsp", { value: {} }); return "redefined"; } catch (e) { return "blocked:" + e.name; }`,
            host,
            signal,
            timeoutMs: 5000,
        });
        expect(outcome.status).toBe("ok");
        expect(String(outcome.returnValue).startsWith("blocked:")).toBe(true);
        const outcome2 = await runInSandbox({
            script: `try { Object.defineProperty(globalThis, "graph", { value: {} }); return "redefined"; } catch (e) { return "blocked:" + e.name; }`,
            host,
            signal,
            timeoutMs: 5000,
        });
        expect(outcome2.status).toBe("ok");
        expect(String(outcome2.returnValue).startsWith("blocked:")).toBe(true);
    });

    it("eval restore is a harmless residual: bindings stay intact, guest realm only", async () => {
        // Probed: QuickJS ignores configurable:false for global `eval`, so a
        // defineProperty restore succeeds at the prop level. Harmless: host
        // bindings are separate props (still functional), and restored eval
        // reaches guest realm only (no host process/require).
        const host = markerHost("real");
        const { signal } = { signal: new AbortController().signal };
        const base = { host, signal, timeoutMs: 5000 };
        const after = await runInSandbox({
            ...base,
            script: `Object.defineProperty(globalThis, "eval", { value: (...a) => a }); return (await grep("x")) + ":" + (await lsp.definition({})) + ":" + typeof eval;`,
        });
        expect(after.status).toBe("ok");
        expect(after.returnValue).toBe("real:real:function");
        const realm = await runInSandbox({
            ...base,
            script: `const F = (async function(){}).constructor; Object.defineProperty(globalThis, "eval", { value: (s) => new F("return (" + s + ")")() }); return eval("typeof process + ',' + typeof require");`,
        });
        expect(realm.status).toBe("ok");
        expect(realm.returnValue).toBe("undefined,undefined");
    });

    it("guest cannot redefine bindings via defineProperty", async () => {
        const host = markerHost("real");
        const { signal } = { signal: new AbortController().signal };
        const outcome = await runInSandbox({
            script: `try { Object.defineProperty(globalThis, "grep", { value: 1 }); return "redefined"; } catch (e) { return "blocked:" + e.name; }`,
            host,
            signal,
            timeoutMs: 5000,
        });
        expect(outcome.status).toBe("ok");
        expect(String(outcome.returnValue).startsWith("blocked:")).toBe(true);
    });
});
