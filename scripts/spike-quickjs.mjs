// Spike: prove quickjs-emscripten@0.32.0 works as sandbox engine for planned inspect({script}).
// Plain Node ESM. Run: node scripts/spike-quickjs.mjs
// Each section prints PASS/FAIL. Section (f) is informational only (OBSERVED).
import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";

const results = {};
function report(name, pass, detail = "") {
  results[name] = pass ? "PASS" : "FAIL";
  console.log(`${pass ? "PASS" : "FAIL"} [${name}]${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function dumpError(vm, errHandle) {
  try {
    const ctor = vm.getProp(errHandle, "constructor");
    const nameH = vm.getProp(errHandle, "name");
    const msgH = vm.getProp(errHandle, "message");
    let out = "";
    try { out += vm.getString(nameH); } catch { out += "?"; }
    out += ": ";
    try { out += vm.getString(msgH); } catch { out += "?"; }
    try { ctor.dispose(); } catch {}
    try { nameH.dispose(); } catch {}
    try { msgH.dispose(); } catch {}
    return out;
  } catch {
    return "(unreadable error)";
  }
}

const QuickJS = await getQuickJS();
console.log(`quickjs-emscripten loaded (variant: ${QuickJS.variant ?? "default"})`);

// ---- (a) host function injection + basic round trip ----
{
  const t0 = Date.now();
  const runtime = QuickJS.newRuntime();
  const vm = runtime.newContext();
  try {
    const addFn = vm.newFunction("add", (a, b) => {
      const sum = vm.getNumber(a) + vm.getNumber(b);
      return vm.newNumber(sum);
    });
    vm.setProp(vm.global, "add", addFn);
    addFn.dispose();
    const r = vm.evalCode("add(2, 3)");
    if (r.error) {
      report("a-host-roundtrip", false, dumpError(vm, r.error));
      r.error.dispose();
    } else {
      const v = vm.getNumber(r.value);
      r.value.dispose();
      report("a-host-roundtrip", v === 5, `add(2,3)=${v} in ${Date.now() - t0}ms`);
    }
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

// ---- (b) async host bridge, sync build, no asyncify ----
{
  const runtime = QuickJS.newRuntime();
  const vm = runtime.newContext();
  try {
    const hostAsync = vm.newFunction("hostAsync", (arg) => {
      const deferred = vm.newPromise();
      const input = vm.getString(arg);
      const t = setTimeout(() => {
        deferred.resolve(vm.newString(`pong:${input}`));
        deferred.settled
          .then(() => { try { runtime.executePendingJobs(); } catch {} })
          .catch(() => {});
      }, 100);
      t.unref?.();
      return deferred.handle;
    });
    vm.setProp(vm.global, "hostAsync", hostAsync);
    hostAsync.dispose();
    const t0 = Date.now();
    const r = vm.evalCode(`(async () => { const v = await hostAsync("ping"); return v + "!"; })()`);
    if (r.error) {
      report("b-async-bridge", false, dumpError(vm, r.error));
      r.error.dispose();
    } else {
      const native = vm.resolvePromise(r.value);
      r.value.dispose();
      runtime.executePendingJobs();
      const timeout = sleep(5000).then(() => ({ timedOut: true }));
      const settled = await Promise.race([native.then((res) => ({ res })), timeout]);
      if (settled.timedOut) {
        report("b-async-bridge", false, "timed out waiting for guest promise");
      } else if (settled.res?.error) {
        report("b-async-bridge", false, dumpError(vm, settled.res.error));
        settled.res.error.dispose();
      } else {
        const s = vm.getString(settled.res.value);
        settled.res.value.dispose();
        const ok = s === "pong:ping!";
        report("b-async-bridge", ok, `guest awaited host promise -> ${JSON.stringify(s)} in ${Date.now() - t0}ms (no asyncify)`);
      }
    }
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

// ---- (c) host-side deadline wins over interpreter interrupt ----
{
  const runtime = QuickJS.newRuntime();
  // Interpreter-level interrupt set FAR out (30s): proves it is not what bounds the run.
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 30_000));
  const vm = runtime.newContext();
  const RUN_DEADLINE_MS = 2000;
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), RUN_DEADLINE_MS);
  try {
    const slowFn = vm.newFunction("slowOp", () => {
      const deferred = vm.newPromise();
      const t = setTimeout(() => {
        try { deferred.resolve(vm.newString("too-late")); } catch {}
        deferred.settled.then(() => { try { runtime.executePendingJobs(); } catch {} }).catch(() => {});
      }, 10_000);
      t.unref?.();
      controller.signal.addEventListener("abort", () => {
        clearTimeout(t);
        try { deferred.reject(vm.newString("aborted: run deadline exceeded")); } catch {}
        deferred.settled.then(() => { try { runtime.executePendingJobs(); } catch {} }).catch(() => {});
      }, { once: true });
      return deferred.handle;
    });
    vm.setProp(vm.global, "slowOp", slowFn);
    slowFn.dispose();
    const t0 = Date.now();
    const r = vm.evalCode(`(async () => { return await slowOp(); })()`);
    let elapsed, outcome;
    if (r.error) {
      elapsed = Date.now() - t0;
      outcome = `sync error: ${dumpError(vm, r.error)}`;
      r.error.dispose();
      // A sync error here would be unexpected (promise path), still bounded.
      report("c-host-deadline", elapsed < 4000, `${outcome}, elapsed=${elapsed}ms`);
    } else {
      const native = vm.resolvePromise(r.value);
      r.value.dispose();
      runtime.executePendingJobs();
      const abortPromise = new Promise((resolve) =>
        controller.signal.addEventListener("abort", () => resolve({ aborted: true }), { once: true })
      );
      const settled = await Promise.race([
        native.then(
          (res) => ({ kind: "resolved", res }),
          (err) => ({ kind: "rejected", err })
        ),
        abortPromise.then(() => ({ kind: "aborted" })),
      ]);
      elapsed = Date.now() - t0;
      if (settled.kind === "aborted") {
        // Host-side abort fired at ~2s while interpreter interrupt was 30s out:
        // the abort (not QuickJS) bounded the run.
        runtime.executePendingJobs();
        report("c-host-deadline", elapsed >= 1900 && elapsed < 5000,
          `AbortController fired at ~${elapsed}ms (deadline ${RUN_DEADLINE_MS}ms; interpreter interrupt was 30s out) — host-side deadline bounded run`);
      } else if (settled.kind === "resolved" || settled.kind === "rejected") {
        // The slowOp's own abort listener rejected the deferred; pump jobs so the
        // guest promise settles, then re-read via a fresh resolve attempt is complex —
        // simplest honest signal: run ended bounded, inspect what happened.
        let detail = "";
        if (settled.res?.error) { detail = dumpError(vm, settled.res.error); settled.res.error.dispose(); }
        else if (settled.res?.value) { detail = `value=${JSON.stringify(vm.getString(settled.res.value))}`; settled.res.value.dispose(); }
        else detail = JSON.stringify(settled).slice(0, 120);
        report("c-host-deadline", elapsed < 5000, `run ended in ${elapsed}ms via host path: ${detail}`);
      } else {
        report("c-host-deadline", false, `unexpected outcome elapsed=${elapsed}ms`);
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
    vm.dispose();
    runtime.dispose();
  }
}

// ---- (d) memory limit: catchable error, process survives ----
{
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(8 * 1024 * 1024); // 8MB
  const vm = runtime.newContext();
  try {
    const t0 = Date.now();
    const r = vm.evalCode(`let a = []; try { while (true) { a.push("x".repeat(100000)); } } catch (e) { throw e; }`);
    // Allocation past limit may surface as eval error OR throw inside; either is fine.
    // Also try a pure-growth variant if first didn't error.
    let errText = null;
    if (r.error) { errText = dumpError(vm, r.error); r.error.dispose(); }
    else {
      r.value.dispose();
      const r2 = vm.evalCode(`let s = "x"; while (true) { s = s + s; }`);
      if (r2.error) { errText = dumpError(vm, r2.error); r2.error.dispose(); }
      else { r2.value.dispose(); }
    }
    const elapsed = Date.now() - t0;
    if (errText) report("d-memory-limit", true, `caught as error (${errText}) in ${elapsed}ms, process alive`);
    else report("d-memory-limit", false, "guest grew past 8MB with no error");
  } finally {
    vm.dispose();
    runtime.dispose();
  }
  console.log("INFO [d-memory-limit] process survived past memory-limit test");
}

// ---- (e) instruction/step interrupt on infinite loop ----
{
  const runtime = QuickJS.newRuntime();
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 500));
  const vm = runtime.newContext();
  try {
    const t0 = Date.now();
    const r = vm.evalCode(`while (true) {}`);
    const elapsed = Date.now() - t0;
    if (r.error) {
      const msg = dumpError(vm, r.error);
      r.error.dispose();
      report("e-infinite-loop-interrupt", elapsed < 3000 && /interrupted/i.test(msg),
        `threw ${JSON.stringify(msg)} after ~${elapsed}ms (deadline 500ms)`);
    } else {
      r.value.dispose();
      report("e-infinite-loop-interrupt", false, `eval returned normally after ${elapsed}ms (interrupt did NOT fire)`);
    }
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

// ---- (f) escape probe: informational only ----
{
  const runtime = QuickJS.newRuntime();
  const vm = runtime.newContext();
  try {
    const probes = [
      `typeof process`,
      `typeof require`,
      `typeof module`,
      `typeof globalThis.process`,
      `typeof globalThis.require`,
      `typeof eval`,
      `typeof Function`,
      `typeof globalThis.Function`,
      `Object.getOwnPropertyNames(globalThis).join(",")`,
    ];
    for (const code of probes) {
      const r = vm.evalCode(code);
      if (r.error) console.log(`OBSERVED [f-escape] ${code} => threw ${dumpError(vm, r.error)}`);
      else {
        let v;
        try { v = vm.getString(r.value); } catch { v = "(non-string)"; }
        if (v.length > 400) v = v.slice(0, 400) + "…";
        console.log(`OBSERVED [f-escape] ${code} => ${JSON.stringify(v)}`);
        r.value.dispose();
      }
      if (r.error) r.error.dispose();
    }
    const trick = `(function(){}).constructor("return this")() === globalThis ? "same-as-guest-globalThis" : "different"`;
    const rt = vm.evalCode(trick);
    if (rt.error) console.log(`OBSERVED [f-escape] Function-constructor trick => threw ${dumpError(vm, rt.error)}`);
    else { console.log(`OBSERVED [f-escape] Function-constructor trick => ${JSON.stringify(vm.getString(rt.value))}`); rt.value.dispose(); }
    const hostReach = vm.evalCode(`(function(){}).constructor("return this")().process ?? (typeof process !== "undefined" ? "has-process" : "no-host-process")`);
    if (hostReach.error) console.log(`OBSERVED [f-escape] trick.process => threw ${dumpError(vm, hostReach.error)}`);
    else { console.log(`OBSERVED [f-escape] trick.process => ${JSON.stringify(vm.getString(hostReach.value))}`); hostReach.value.dispose(); }
  } finally {
    vm.dispose();
    runtime.dispose();
  }
  console.log("OBSERVED [f-escape] done (informational, not a gate)");
}

// ---- (g) context disposal loop x20 ----
{
  let ok = true;
  let detail = "";
  try {
    for (let i = 0; i < 20; i++) {
      const runtime = QuickJS.newRuntime();
      const vm = runtime.newContext();
      const r = vm.evalCode(`(${i} * 2)`);
      if (r.error) { ok = false; detail = `iter ${i}: ${dumpError(vm, r.error)}`; r.error.dispose(); vm.dispose(); runtime.dispose(); break; }
      const v = vm.getNumber(r.value);
      r.value.dispose();
      if (v !== i * 2) { ok = false; detail = `iter ${i}: wrong value ${v}`; vm.dispose(); runtime.dispose(); break; }
      vm.dispose();
      runtime.dispose();
    }
    if (ok) detail = "20 create/eval/dispose cycles, no errors";
  } catch (e) {
    ok = false;
    detail = `threw: ${e?.message ?? e}`;
  }
  report("g-disposal-loop", ok, detail);
}

console.log("\n--- summary ---");
for (const [k, v] of Object.entries(results)) console.log(`${v} ${k}`);
const hardFail = Object.entries(results).filter(([k, v]) => k !== "f-escape" && v !== "PASS");
if (hardFail.length) { console.log(`\n${hardFail.length} HARD FAIL(S) — see above`); process.exit(1); }
console.log("\nAll load-bearing checks passed ((f) informational).");
