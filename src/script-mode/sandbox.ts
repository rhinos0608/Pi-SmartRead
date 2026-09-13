/**
 * QuickJS execution core for script mode.
 *
 * Reuses the exact proven patterns from `scripts/spike-quickjs.mjs` —
 * do not rediscover them:
 * - host injection via `vm.newFunction` with `vm.defineProp`
 *   (non-writable + non-configurable per §1);
 * - async bridge via `vm.newPromise()` + `promise.settled.then(
 *   runtime.executePendingJobs)` + `vm.resolvePromise()` — NO asyncify;
 * - one `QuickJSContext` + `QuickJSRuntime` per run, always disposed in
 *   `finally` (spike create/eval/dispose-loop-clean pattern);
 * - `runtime.setInterruptHandler(shouldInterruptAfterDeadline(...))` as
 *   the interpreter-level backstop AND a separate host-side abort race
 *   as the actual bound (spike section c: the interpreter interrupt
 *   alone does not bound an already-dispatched host promise).
 *
 * §1 hardening applied here: frozen host impl object is adapted (never
 * re-exposed mutably), guest-visible `eval`/`Function` are cleared on
 * `vm.global`, and only the typed host functions cross the bridge.
 */
import {
    getQuickJS,
    shouldInterruptAfterDeadline,
    type QuickJSContext,
    type QuickJSHandle,
    type QuickJSRuntime,
} from "quickjs-emscripten";

type GuestPromiseResult = Awaited<ReturnType<QuickJSContext["resolvePromise"]>>;
import type { WorkspaceEvidenceEnvelope } from "@rhinos0608/pi-workspace-protocol";
import type { ScriptHostApi, HostFn } from "./host-bindings.js";
import type { ScriptErrorKind } from "./types.js";

export const DEFAULT_MEMORY_LIMIT_BYTES = 12 * 1024 * 1024;

export interface SandboxRunOptions {
    readonly script: string;
    /** Frozen host impl (from `buildHostBindings`). Adapted, never mutated. */
    readonly host: ScriptHostApi;
    /** Run-budget signal: the host-side deadline. Raced as the actual bound. */
    readonly signal: AbortSignal;
    /**
     * Failsafe wall-clock bound in ms. The budget signal normally fires
     * first; this timer guarantees the run returns even if it doesn't.
     */
    readonly timeoutMs: number;
    /** Interpreter interrupt deadline. Defaults to `timeoutMs`. */
    readonly interruptDeadlineMs?: number;
    readonly memoryLimitBytes?: number;
}

export interface SandboxOutcome {
    readonly status: "ok" | "degraded";
    readonly errorKind?: ScriptErrorKind;
    readonly errorMessage?: string;
    readonly returnValue?: unknown;
    /** Per-call envelopes in call-completion order (successes only). */
    readonly evidences: readonly WorkspaceEvidenceEnvelope[];
}

// Cached WASM module (one load per process; contexts stay per-run).
let quickJSModulePromise: ReturnType<typeof getQuickJS> | null = null;

function loadQuickJS(): ReturnType<typeof getQuickJS> {
    if (!quickJSModulePromise) quickJSModulePromise = getQuickJS();
    return quickJSModulePromise;
}

interface InjectCtx {
    readonly vm: QuickJSContext;
    readonly runtime: QuickJSRuntime;
    readonly evidences: WorkspaceEvidenceEnvelope[];
}

/** Plain-JSON → guest handle. Consumed by `deferred.resolve` (spike pattern). */
function toGuestHandle(vm: QuickJSContext, value: unknown): QuickJSHandle {
    if (value === undefined) return vm.undefined;
    if (value === null) return vm.null;
    if (value === true) return vm.true;
    if (value === false) return vm.false;
    if (typeof value === "number") return vm.newNumber(value);
    if (typeof value === "string") return vm.newString(value);
    if (typeof value === "bigint") return vm.newBigInt(value);
    if (Array.isArray(value)) return toGuestArray(vm, value);
    if (typeof value === "object") return toGuestObject(vm, value as Record<string, unknown>);
    return vm.newString(String(value));
}

function toGuestArray(vm: QuickJSContext, value: unknown[]): QuickJSHandle {
    const arr = vm.newArray();
    value.forEach((item, i) => {
        const child = toGuestHandle(vm, item);
        vm.setProp(arr, String(i), child);
        child.dispose();
    });
    return arr;
}

function toGuestObject(vm: QuickJSContext, value: Record<string, unknown>): QuickJSHandle {
    const obj = vm.newObject();
    for (const [key, entry] of Object.entries(value)) {
        const child = toGuestHandle(vm, entry);
        vm.setProp(obj, key, child);
        child.dispose();
    }
    return obj;
}

/** Best-effort guest-arg decode. Undecodable args become `undefined`. */
function dumpGuestArgs(vm: QuickJSContext, handles: QuickJSHandle[]): unknown[] {
    return handles.map((h) => {
        try {
            return vm.dump(h);
        } catch {
            return undefined;
        }
    });
}

/**
 * Spike's error reader: `name: message` off the guest error handle.
 * Host rejections cross the bridge as plain strings (no name/message
 * props), so string handles read directly — verified against QuickJS:
 * `getProp(strHandle, "name")` yields undefined, which `getString`
 * coerces to the literal `"undefined"`.
 */
function readErrorText(vm: QuickJSContext, errHandle: QuickJSHandle): string {
    try {
        if (vm.typeof(errHandle) === "string") return `Error: ${vm.getString(errHandle)}`;
    } catch {
        /* fall through to the object path */
    }
    let nameH: QuickJSHandle | undefined;
    let msgH: QuickJSHandle | undefined;
    try {
        nameH = vm.getProp(errHandle, "name");
        msgH = vm.getProp(errHandle, "message");
        return `${readPropString(vm, nameH, "Error")}: ${readPropString(vm, msgH, "(unreadable)")}`;
    } catch {
        return "(unreadable error)";
    } finally {
        try {
            nameH?.dispose();
        } catch {
            /* best-effort cleanup */
        }
        try {
            msgH?.dispose();
        } catch {
            /* best-effort cleanup */
        }
    }
}

function readPropString(vm: QuickJSContext, handle: QuickJSHandle, fallback: string): string {
    try {
        if (vm.typeof(handle) === "undefined") return fallback;
        return vm.getString(handle);
    } catch {
        return fallback;
    }
}

function classifySyncError(text: string): ScriptErrorKind {
    if (/out of memory/i.test(text)) return "memory-limit";
    if (/interrupted/i.test(text)) return "interrupted";
    return "js-exception";
}

function pumpJobs(ctx: InjectCtx): void {
    try {
        ctx.runtime.executePendingJobs();
    } catch {
        /* pump errors must not fail the run */
    }
}

function makeHostFn(ctx: InjectCtx, name: string, fn: HostFn): QuickJSHandle {
    const { vm } = ctx;
    return vm.newFunction(name, (...argHandles) => {
        const deferred = vm.newPromise();
        const jsArgs = dumpGuestArgs(vm, argHandles);
        fn(...jsArgs).then(
            ({ value, evidence }) => {
                try {
                    if (evidence) ctx.evidences.push(evidence);
                    deferred.resolve(toGuestHandle(vm, value));
                } catch {
                    try {
                        deferred.resolve(vm.newString("(unserializable result)"));
                    } catch {
                        /* interpreter gone; finally still disposes */
                    }
                }
                deferred.settled.then(() => pumpJobs(ctx)).catch(() => {});
            },
            (err) => {
                try {
                    deferred.reject(vm.newString(String((err as Error | null)?.message ?? err)));
                } catch {
                    /* interpreter gone; finally still disposes */
                }
                deferred.settled.then(() => pumpJobs(ctx)).catch(() => {});
            },
        );
        return deferred.handle;
    });
}

/**
 * Inject one host binding as a getter-only, non-configurable accessor.
 *
 * Empirically (probed 2026-09-13): plain value props with
 * writable:false + configurable:false still let QuickJS's
 * `Object.defineProperty(globalThis, name, { value })` swap the value —
 * a spec deviation in this QuickJS build. An accessor with no setter
 * closes it: assignment silently fails (sloppy) / throws (strict),
 * and every `defineProperty` shape-change on a non-configurable
 * accessor throws. Each access mints a fresh host-function handle
 * (interpreter-owned), so there is no shared handle to corrupt.
 */
function injectAsyncFn(ctx: InjectCtx, container: QuickJSHandle, name: string, fn: HostFn): void {
    const { vm } = ctx;
    vm.defineProp(container, name, {
        get: () => makeHostFn(ctx, name, fn),
        configurable: false,
        enumerable: true,
    });
}

function makeNamespace(ctx: InjectCtx, fns: Readonly<Record<string, HostFn>>): QuickJSHandle {
    const obj = ctx.vm.newObject();
    for (const [name, fn] of Object.entries(fns)) injectAsyncFn(ctx, obj, name, fn);
    return obj;
}

function injectHostApi(ctx: InjectCtx, host: ScriptHostApi): void {
    const { vm } = ctx;
    // §1: no legitimate use for dynamic code generation from the script.
    // Neutralized as getter-only accessors (same pattern as `injectAsyncFn`;
    // plain value props would be trivially assignable). Probed 2026-09-13:
    // QuickJS reports the `eval` accessor back as `configurable:true`
    // despite `configurable:false` here, so a guest
    // `Object.defineProperty(globalThis, "eval", { value })` restore
    // SUCCEEDS at the prop level (unlike `grep`/`lsp`/`graph`, which throw
    // `TypeError`). Accepted residual, not a seal: (1) the restore touches
    // only the `eval` prop — host bindings are separate accessor props and
    // stay intact/functional afterwards (probed: `await grep()` still
    // returns the host value post-restore); (2) any restored/eval'd or
    // constructor-chain-reconstructed `Function` still resolves to the
    // guest realm only — `typeof process`/`typeof require` stay
    // `"undefined"` (probed). Blast radius is therefore nil by
    // construction: read-only frozen host API + zero host globals exposed
    // means a restored `eval` gains nothing privileged to reach.
    for (const name of ["eval", "Function"]) {
        vm.defineProp(vm.global, name, {
            get: () => vm.undefined,
            configurable: false,
            enumerable: false,
        });
    }
    injectAsyncFn(ctx, vm.global, "grep", host.grep);
    injectAsyncFn(ctx, vm.global, "read", host.read);
    injectAsyncFn(ctx, vm.global, "inspectFile", host.inspectFile);
    injectAsyncFn(ctx, vm.global, "inspectDir", host.inspectDir);
    // Namespaces ride the same getter-only accessor (fresh object per
    // access — `ns.op()` chains and stashed `const l = lsp` both work;
    // only `lsp === lsp` identity is not preserved, which scripts never need).
    vm.defineProp(vm.global, "lsp", {
        get: () => makeNamespace(ctx, host.lsp),
        configurable: false,
        enumerable: true,
    });
    vm.defineProp(vm.global, "graph", {
        get: () => makeNamespace(ctx, host.graph),
        configurable: false,
        enumerable: true,
    });
}

type PreparedGuest =
    | { readonly ok: false; readonly errorText: string }
    | { readonly ok: true; readonly native: Promise<GuestPromiseResult> };

/** Inject + evaluate. Spike pattern: async IIFE, resolve via `vm.resolvePromise`. */
function prepareGuest(ctx: InjectCtx, host: ScriptHostApi, script: string): PreparedGuest {
    injectHostApi(ctx, host);
    const r = ctx.vm.evalCode(`(async () => {\n${script}\n})()`, "script.js");
    if (r.error) {
        const errorText = readErrorText(ctx.vm, r.error);
        r.error.dispose();
        return { ok: false, errorText };
    }
    const native = ctx.vm.resolvePromise(r.value);
    r.value.dispose();
    ctx.runtime.executePendingJobs();
    return { ok: true, native };
}

type SettledGuest =
    | { readonly kind: "settled"; readonly res: GuestPromiseResult }
    | { readonly kind: "rejected"; readonly err: unknown }
    | { readonly kind: "aborted" }
    | { readonly kind: "timeout" };

async function settleGuest(
    native: Promise<GuestPromiseResult>,
    signal: AbortSignal,
    timeoutMs: number,
): Promise<{ settled: SettledGuest; clearFailsafe: () => void }> {
    const abortPromise = new Promise<{ kind: "aborted" }>((resolve) => {
        if (signal.aborted) resolve({ kind: "aborted" });
        else signal.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const failsafePromise = new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
        timer.unref?.();
    });
    const settled = await Promise.race([
        native.then(
            (res) => ({ kind: "settled" as const, res }),
            (err: unknown) => ({ kind: "rejected" as const, err }),
        ),
        abortPromise,
        failsafePromise,
    ]);
    return { settled, clearFailsafe: () => clearTimeout(timer) };
}

function outcomeFromSettled(
    ctx: InjectCtx,
    signal: AbortSignal,
    settled: SettledGuest,
): SandboxOutcome {
    const evidences = [...ctx.evidences];
    if (settled.kind === "aborted" || settled.kind === "timeout") {
        pumpJobs(ctx);
        return {
            status: "degraded",
            errorKind: settled.kind === "aborted" && signal.aborted ? "aborted" : "timeout",
            errorMessage:
                settled.kind === "aborted"
                    ? "host-side deadline: run aborted before guest promise settled"
                    : "host-side deadline: guest promise did not settle in time",
            evidences,
        };
    }
    if (settled.kind === "rejected") {
        const err = settled.err as { message?: unknown } | null;
        return {
            status: "degraded",
            errorKind: "js-exception",
            errorMessage: String(err?.message ?? settled.err ?? "promise rejected"),
            evidences,
        };
    }
    const res = settled.res;
    if (res.error) {
        const text = readErrorText(ctx.vm, res.error);
        res.error.dispose();
        return { status: "degraded", errorKind: classifySyncError(text), errorMessage: text, evidences };
    }
    let returnValue: unknown;
    try {
        returnValue = ctx.vm.dump(res.value);
    } catch {
        returnValue = "(unreadable return value)";
    }
    res.value.dispose();
    return { status: "ok", returnValue, evidences };
}

export async function runInSandbox(opts: SandboxRunOptions): Promise<SandboxOutcome> {
    if (typeof opts.script !== "string" || opts.script.length === 0) {
        return { status: "degraded", errorKind: "js-exception", errorMessage: "empty script", evidences: [] };
    }
    if (opts.signal.aborted) {
        return { status: "degraded", errorKind: "aborted", errorMessage: "run aborted before start", evidences: [] };
    }

    const QuickJS = await loadQuickJS();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(opts.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES);
    runtime.setInterruptHandler(
        shouldInterruptAfterDeadline(Date.now() + (opts.interruptDeadlineMs ?? opts.timeoutMs)),
    );
    const vm = runtime.newContext();
    const ctx: InjectCtx = { vm, runtime, evidences: [] };
    let clearFailsafe: (() => void) | undefined;
    try {
        const prepared = prepareGuest(ctx, opts.host, opts.script);
        if (!prepared.ok) {
            return {
                status: "degraded",
                errorKind: classifySyncError(prepared.errorText),
                errorMessage: prepared.errorText,
                evidences: [...ctx.evidences],
            };
        }
        const { settled, clearFailsafe: clear } = await settleGuest(prepared.native, opts.signal, opts.timeoutMs);
        clearFailsafe = clear;
        return outcomeFromSettled(ctx, opts.signal, settled);
    } finally {
        clearFailsafe?.();
        try {
            runtime.executePendingJobs();
        } catch {
            /* best-effort flush before dispose */
        }
        try {
            vm.dispose();
        } catch {
            /* best-effort dispose */
        }
        try {
            runtime.dispose();
        } catch {
            /* best-effort dispose */
        }
    }
}
