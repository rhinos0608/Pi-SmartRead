# Agent-in-the-loop evaluation notes

Practical harness notes captured while reviewing the sibling `Pi-SmartEdit/benchmark/` runners. These are a starting checklist for future SmartRead/SmartEdit agent evaluations, not a claim that one run establishes a result.

## Know which benchmark you are running

- `benchmark/compare.ts` is the end-to-end runner: it launches Pi for each fixture, applies a restricted `read,edit` tool allowlist, checks the workspace on disk against expected files, and writes JSONL transcripts plus a report.
- `benchmark/parallel.ts` starts independent `compare.ts` processes (three by default). Its processes inherit the same environment, so isolate their outputs by PID and avoid shared mutable fixtures.
- `benchmark/hashline-bench.ts` is a deterministic library-level anchor/churn microbenchmark. It does not measure agent behavior, prompt compliance, provider usage, or end-to-end latency.

## Isolate Pi before measuring

- A worktree extension can be shadowed by Pi's configured/discovered extensions. Run with `pi -ne -e <worktree>/src/index.ts` to disable ambient extensions and load only the target extension. Pi 0.99.2 documents that explicit `-e` paths still load with `-ne`; add any provider or support extension the run needs explicitly.
- Disable ambient behavior consistently in both arms: skills, context files, prompt templates, and any other injected instructions. Use the same tool allowlist, model, thinking setting, and environment except for the treatment under test.
- Verify which version of each extension actually loaded before interpreting a result. An unrelated startup parse failure or duplicate extension load is infrastructure failure, not a model/tool failure.

## Preserve paired-task validity

- `compare.ts` grades file contents byte-for-byte; whitespace changes count. Keep the prompt and expected output aligned, include fixture runtime dependencies, and review the oracle before running.
- Freeze prompts and answer keys before the final run set. If an oracle must change, invalidate and rerun the affected pairs rather than mixing old and new expectations.
- Alternate treatment order by task and run to reduce order effects. Use at least three independent processes/runs for comparative claims; a single run is diagnostic only.
- Set a finite timeout. Preserve each task transcript and stderr, record unfinished tool calls separately from completed calls, and exclude paired tasks with infrastructure failure while retaining their failure artifacts.
- Stream transcripts to files during long runs rather than relying only on buffered process output. Use PID-suffixed run directories; keep raw runs in git-ignored output and put only reviewed summaries in durable tracking docs.

## Attribute metrics correctly

- Pi model usage is reported on `message_end` events (`message.usage`). Tool calls and tool completion/errors are separate events; do not infer successful completion from a request block alone.
- SmartRead judge cost is separate from model-token usage: collect `details.judge.costUsd` from tool results and report it independently.
- Report task-level outcomes alongside aggregate rates, latency, model usage, judge cost, and infrastructure failures. Never treat an incomplete run as a paired success/failure observation.

## SmartRead judge benchmark runner

`npx tsx scripts/eval/judge/run.ts --backend cloud|local|both --set a|b|both` evaluates the audited JSONL sets from `~/.cache/pi-smartread-judge-spike/eval/` against source ranges pinned to commit `18f6463caa78e6657b1af6c7eb86b711bc2364f8`. It performs one warm-up request per backend, includes warm-up token/cost usage in totals, and reports per-query judge-call latency separately from source-range materialization. Reports are written with mode `0600` under `~/.cache/pi-smartread-judge-spike/bench/`; raw reports stay outside the repository.

- Cloud evaluation requires `PI_SMARTREAD_JUDGE_API_KEY` in the process environment. The runner pins the endpoint to `CLOUD_JUDGE_DEFAULT_BASE_URL` (OpenRouter); it does not read repo configuration or accept an endpoint override.
- Local evaluation uses `http://127.0.0.1:8000` by default. `PI_SMARTREAD_JUDGE_BASE_URL` may select a different `http://127.0.0.1` port only. This runner does not install or launch von, so it cannot bypass the `/judge install` confirmation.
- Latest attempt (2026-10-05): local warm-up returned `network`; PID 65735 existed but no process was listening on port 8000. The shell had no `PI_SMARTREAD_JUDGE_API_KEY`, so no cloud run was attempted. No quality metrics are available from this attempt. Superseded by the completed benchmark runs below.

## Benchmark results (2026-10-05)

Completed runs with the judge benchmark runner against the audited JSONL sets, ranges pinned to commit `18f6463caa78e6657b1af6c7eb86b711bc2364f8`.

- Fixture sets: set-a 159 rows / 22 queries, set-b 155 rows / 22 queries; 314 judgments total (78 gold / 236 negative).
- Local (von v1.3 via pinned `von-sdk==1.3.7`, Apple MPS, loopback): AUROC 0.5077, ECE 0.3539; P/R at threshold 0.2 = 0.2484/1.000, at 0.45 = 0.2484/1.000; latency p50 1799 ms / p95 3298 ms, warmup 2835 ms, cost n/a. Per-set AUROC: set-a 0.4783, set-b 0.5593 (gold vs hard+easy). All 314 scores compressed into [0.5106, 0.678]; zero scores below 0.45, so both thresholds classify everything positive. Near-chance discrimination and severely miscalibrated — von stays experimental; the 0.45 pointer threshold is meaningless for the local backend as measured.
- Cloud (OpenRouter, model `~typesafe/jev-latest`): AUROC 0.9592, ECE 0.1368; P/R at 0.2 = 0.4968/1.000, at 0.45 = 0.6210/0.9872; latency p50 294 ms / p95 470 ms, warmup 778 ms; cost $0.00717 (170,832 input tokens + 1,078 warmup tokens, approx $0.000045 per judgment). Per-set AUROC: set-a 0.9704, set-b 0.9495 (gold vs hard+easy); gold-vs-hard-only 0.9541 / 0.9169. Score spread p in [0.01, 0.99].
- Report files (outside the repo, mode `0600`): `~/.cache/pi-smartread-judge-spike/bench/results-2026-10-05T14-07-38-157Z-p86427.json` (local), `results-2026-10-05T14-09-25-547Z-p95695.json` (cloud). An earlier run `results-2026-10-05T14-02-39-703Z-p76617.json` failed with a network error (pre-fix crash, see below) and carries no quality metrics.
- Bug found and fixed during benchmarking: von's MPS (Metal) backend aborts the entire server process with "failed assertion: A command encoder is already encoding to this command buffer" when two `/v1/systemone` requests overlap. Fixed by serializing `LocalJudge` HTTP requests process-wide per endpoint baseUrl (`src/judge/local-judge.ts`, `runSerialized`/`endpointTails`). Regression tests in `test/unit/judge/local-judge.test.ts`: "serializes requests to one endpoint across calls and instances" and "keeps serving queued requests after one request fails". After the fix the full local benchmark completed without a crash/restart.
- Conclusion: cloud is the recommended judge backend; local von remains experimental (near-chance on code relevance). Quality claim caveat: single-run benchmarks; treat as directional, not calibrated acceptance.

### Multi-run stability and grep keep-gate choice (2026-10-06)

The cloud benchmark was repeated three more times against the same 314 audited unit judgments (four cloud runs total). AUROC stayed in 0.9589–0.9598 and ECE in 0.1368–0.1380. Treating the four production-like stochastic runs as repeated observations gives:

- τ 0.20: pooled precision/recall 0.4952/1.0000 (312 TP, 318 FP, 0 FN).
- τ 0.40: pooled precision/recall 0.6055/0.9936 (310 TP, 202 FP, 2 FN).
- τ 0.45: pooled precision/recall 0.6240/0.9840 (307 TP, 185 FP, 5 FN).
- At τ 0.40, every run retained at least one gold unit for every one of the 35 answerable queries; the two pooled false negatives are repeated observations of the same secondary q11 helper (`fetchEmbeddings`), while the primary sharding/retry/merge implementation remained at p≈0.99.
- Moving τ 0.40 → 0.45 removes 17 additional false positives but adds 3 false negatives, a break-even FN:FP cost ratio of 17/3 ≈ 5.7. Because grep is an evidence-retrieval stage where dropping relevant code is materially worse than carrying one extra candidate, τ 0.40 is the selected recall-biased default.

This unit benchmark directly validates only the full-text grep unit gate. It does **not** calibrate the 0.45 signature-only pointer gate, the 0.40 `find` file-card gate, or the 0.35 `exists` abstention gate; those use different state/question shapes and need task-specific evaluation. The planned grep end-to-end comparison (Recall@5, tokens returned, and abstention correctness) is still required before treating the thresholds as final product calibration.
