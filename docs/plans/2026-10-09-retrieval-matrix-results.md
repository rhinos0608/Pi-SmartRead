# 2026-10-09 — Retrieval matrix results (frozen E18 arms, V2)

**Status: parent review pending.** Bounded analysis pass; no code, config, or holdout
state was touched. All numbers below were recomputed from the raw report JSON in this
session (not copied from worker summaries).

## 1. Scope and controls

- **Rows:** A0, A1–A8, A0r (10 rows × 4 legs = **40 report cells** used).
- **Legs:** L1 = D46 `--split selection` fresh cohort (112 queries, 96 answerable);
  L2 = internal-44 `judge/grep-e2e` (44 queries, 35 evaluable answerable);
  L3 = D46 dev (56 queries, 48 answerable); L4 = external dev64 owned mode
  (128 runs = 64 titles + 64 bodies).
- **Same-engine (V2):** every one of the 40 reports carries
  `sha256:e5fad8375eb02281e2b29ab9b12136d756b9f0a8f03f8ccfe94c95e9ea74ca4e:281-files`.
  This is the V2 freeze hash recorded in `2026-10-08-retrieval-frozen-A0-checkpoint.md`
  (§ "V2 source freeze"); it replaces the historical `daf2…` V1 value quoted at the top
  of the freeze manifest. **Same-engine requirement: satisfied, all cells V2.**
- **Judge:** off on every cell (L1/L3 `judge.config=off` + `judgeInvoked` 0/112 and 0/56
  on every arm; L2 `config=off`, `judgeUsage` resumed/newlyBilled all zero on every arm;
  L4 `judge="off"`).
- **Held-out untouched:** no holdout report exists in either report directory; no
  `holdout` input was read (confirmed by the per-arm worker reports' holdout-never
  checks; this pass only read the 40 listed reports).
- **Owned mode for L4:** all L4 reports are owned-state-root runs (each report
  carries its owned `state`/`inputs`/`manifestCanonical` sections; `runs=128`,
  `errors=0` on every arm).
- **Arm attribution:** by `rankingKnobs` / `retrievalConditions` in each report,
  cross-checked against all 19 per-arm worker reports' quoted paths
  (`subagent-artifacts/{7bd69592,1c78de80,91f6a8f5,7743f595,d262147a,f03f4101,
  fa0eb641,59597c94,491c00bd,a3b9219d,855bcf07,af9999de,bfa78116,d7e5a46f,
  84507dd1,a5eb2635,de3dfdcc}*_worker_output.md`, plus `f1ae5930`/`8f4a2510` for A0).
  **All 19 worker quotes match the knob-based attribution exactly** (no timestamp-only
  attribution was used). **A8 note (corrected run 2026-10-08 UTC):** A8's four cells were
  later replaced by a corrected run (dispatch-error provenance in §2); the corrected
  cells are attributed by their knob objects (`rankBm25b=0.5` + the three toggles)
  and the corrected run's leg logs, while the 19 worker quotes above describe the
  superseded first run.

## 2. Uniformity proof

Expected arm knob sets from `docs/plans/2026-10-08-retrieval-freeze-manifest.md`
lines 48–56 (A8 = "C2 + C4 + C6c", where C6c = "`b=0.5` + coverage" per the A5 line).

Checks per cell: (a) engine hash == V2; (b) knobs == the arm's intended set exactly,
identical across all four legs of the arm; (c) L4 `manifestSha256` ==
`9cfbf8e792e042991bdb8262364b1dcf9bb7daa2eaa806d4ee4742159e48b8d6`; (d) judge off;
(e) count denominators (96/35/48/128) and query/run totals (112/44/56/128).

| Row | engine V2 | knobs == intended (4 legs) | L4 manifestSha | judge off | counts | cell verdict |
|---|---|---|---|---|---|---|
| A0  | 4/4 ✓ | 4/4 ✓ (defaults) | ✓ | 4/4 ✓ | 4/4 ✓ | **OK** |
| A1  | 4/4 ✓ | 4/4 ✓ (filename) | ✓ | 4/4 ✓ | 4/4 ✓ | **OK** |
| A2  | 4/4 ✓ | 4/4 ✓ (stem) | ✓ | 4/4 ✓ | 4/4 ✓ | **OK** |
| A3  | 4/4 ✓ | 4/4 ✓ (b=0.5) | ✓ | 4/4 ✓ | 4/4 ✓ | **OK** |
| A4  | 4/4 ✓ | 4/4 ✓ (coverage) | ✓ | 4/4 ✓ | 4/4 ✓ | **OK** |
| A5  | 4/4 ✓ | 4/4 ✓ (b=0.5 + coverage) | ✓ | 4/4 ✓ | 4/4 ✓ | **OK** |
| A6  | 4/4 ✓ | 4/4 ✓ (demote 0.5) | ✓ | 4/4 ✓ | 4/4 ✓ | **OK** |
| A7  | 4/4 ✓ | 4/4 ✓ (stopwords) | ✓ | 4/4 ✓ | 4/4 ✓ | **OK** |
| A8  | 4/4 ✓ | 4/4 ✓ (filename + stem + b=0.5 + coverage — **corrected run 2026-10-08 UTC**) | ✓ | 4/4 ✓ | 4/4 ✓ | **OK (corrected run 2026-10-08 UTC; supersedes the invalid run dispatched with wrong C6c mapping)** |
| A0r | 4/4 ✓ | 4/4 ✓ (defaults) | ✓ | 4/4 ✓ | 4/4 ✓ | **OK** |

**Counts: 40/40 engine hash ✓ · 40/40 judge off ✓ · 40/40 counts ✓ · 10/10 L4
manifestSha ✓ · 40/40 knobs ✓ (A8's four cells replaced by the corrected run
2026-10-08 UTC).**

### LOUD FINDING — A8 knob mismatch (first run INVALID; corrected run 2026-10-08 UTC supersedes)

- Pre-registered arm (freeze manifest line 56): "A8 interaction challenger
  **C2 + C4 + C6c**", where line 53 defines "A5 **C6c `b=0.5` + coverage**". Intended
  A8 set therefore: `rankFilename=true, rankStem=true, rankBm25b=0.5,
  rankCoverage=true`, rest default.
- As run, all four A8 reports carry `rankBm25b=0.75` (the source default) with the
  other three toggles set — verified by raw-string grep of each file, not just parsed
  fields:
  - L1 `d46-selection-…T20-22-13-934Z-a4631300.json`: `"rankBm25b": 0.75` ×2 (both
    `rankingKnobs` and `retrievalConditions`)
  - L2 `grep-e2e-…T20-22-29-904Z-p54825.json`: `"rankBm25b": 0.75`
  - L3 `d46-dev-…T20-24-21-475Z-6e57eeaa.json`: `"rankBm25b": 0.75` ×2
  - L4 `external-grep-dev-…T21-37-33-024Z-ceb77676.json`: `"rankBm25b": 0.75`
- Both A8 workers confirm the as-run set: legs-1–3 worker (`59597c94`) — "Env
  verification … exactly the three intended lines (`PI_SMARTREAD_GREP_RANK_COVERAGE=1`,
  `PI_SMARTREAD_GREP_RANK_STEM=1`, `PI_SMARTREAD_GREP_RANK_FILENAME=1`), no others" and
  "`rankBm25b:0.75`" as "default"; leg-4 worker (`a5eb2635`) — "arm toggles
  (filename/stem/coverage) true, all others source defaults". As-run A8 = C2 + C4 +
  C6b (coverage only), **not** the pre-registered C2 + C4 + C6c.
- **Per the uniformity rule, all four first-run A8 cells were marked INVALID and A8
  was not gate-evaluable.** Whether the pre-registration or the run instruction was
  wrong is an orchestrator decision, not an analysis decision; nothing was silently
  dropped. The first-run A8 metrics were tabulated below, flagged INVALID — they have
  since been replaced by the corrected run.

**Corrected run 2026-10-08 22:40–23:06 UTC (2026-10-09 AEDT; supersedes the invalid run dispatched with wrong C6c
mapping):** all four A8 legs re-run sequentially/solo (no other eval processes;
pgrep empty before L4), with the full pre-registered env exported and verified —
`env | grep PI_SMARTREAD_GREP_RANK` printed exactly these four lines:

```
PI_SMARTREAD_GREP_RANK_FILENAME=1
PI_SMARTREAD_GREP_RANK_STEM=1
PI_SMARTREAD_GREP_RANK_BM25=1.2,0.5
PI_SMARTREAD_GREP_RANK_COVERAGE=1
```

Every corrected report carries the identical knob object — all four deviations from
defaults present (L1/L3 from `rankingKnobs` + `retrievalConditions`, L2 from
`manifest.retrievalConditions`, L4 from `rankingKnobs`):

```json
{"rankBm25b": 0.5, "rankBm25k1": 1.2, "rankCoverage": true, "rankFilename": true,
 "rankStem": true, "rankStopwords": false, "rankTestDemote": 0.7}
```

**Dispatch-error provenance (process note, not hidden):** the parent dispatch for the
first run mapped A8 to C2 + C4 + coverage, omitting C6c's `b=0.5`; the pre-registration
is authoritative (freeze manifest line 56: "A8 interaction challenger C2 + C4 + C6c";
line 53: C6c = "`b=0.5` + coverage"). Corrected measurements replace the four INVALID
cells in §3 and §5; report paths + shas in §7. The four superseded INVALID reports
remain on disk: `owned/d46-selection-off-2026-10-08T20-22-13-934Z-a4631300.json`,
`grep-e2e/grep-e2e-off-2026-10-08T20-22-29-904Z-p54825.json`,
`owned/d46-dev-off-2026-10-08T20-24-21-475Z-6e57eeaa.json`,
`owned/external-grep-dev-2026-10-08T21-37-33-024Z-ceb77676.json`. Corrected-leg
commands followed the A0r worker's recorded forms (`de3dfdcc` artifact); run logs in
`/tmp/a8/leg{1..4}.log` (2026-10-08 22:40–23:06 UTC).

Excluded from the matrix (not cells, not counted as mismatches): two aborted 0-run L4
attempts in the owned dir (`external-grep-dev-…T15-54-56-029Z-f839e16a.json` and
`…T16-20-12-854Z-f839e16a.json`, `runs=0`), and all pre-2026-10-08 files in the
grep-e2e bench directory (Oct-5/6/7 exploratory runs).

## 3. Master metrics

L1 = fresh-cohort success@5 /96 · L2 = internal-44 fileHit@5 /35 ·
L3 = D46-dev success@5 /48 · L4 = dev64 success@5 /128 + meanRecall@5 + meanMRR.

| Arm | L1 success@5 | L2 fileHit@5 | L3 success@5 | L4 success@5 | L4 meanRecall@5 | L4 meanMRR |
|---|---|---|---|---|---|---|
| A0  | 50/96 | 20/35 | 25/48 | 35/128 | 0.2164 | 0.1613 |
| A1  | 52/96 | 20/35 | 25/48 | 32/128 | 0.2031 | 0.1637 |
| A2  | 46/96 | 18/35 | 23/48 | 34/128 | 0.2122 | 0.1668 |
| A3  | 55/96 | 19/35 | 27/48 | 39/128 | 0.2437 | 0.2078 |
| A4  | 59/96 | 21/35 | 29/48 | 40/128 | 0.2604 | 0.2116 |
| A5  | 67/96 | 22/35 | 34/48 | 47/128 | 0.2901 | 0.2405 |
| A6  | 50/96 | 21/35 | 26/48 | 35/128 | 0.2190 | 0.1702 |
| A7  | 56/96 | 24/35 | 27/48 | 34/128 | 0.2109 | 0.1601 |
| A8  | 57/96 | 20/35 | 35/48 | 45/128 | 0.2784 | 0.2309 |
| A0r | 50/96 | 20/35 | 25/48 | 35/128 | 0.2164 | 0.1613 |

(L1/L3 also carry meanRecall/meanMRR in the reports; the table keeps the six
predeclared columns. L4 values shown to 4 dp; full-precision A0/A0r values are in §4;
all raw values live in the appendix reports.)

## 4. Drift: A0r vs today's A0

Comparator is **today's A0** (V2, owned mode):
`external-grep-dev-2026-10-08T19-19-30-779Z-80820a88.json` (the file named in the
task) — verified directly: `successAt5 "35/128"`,
`meanRecallAt5 0.21640624999999997` (→ 0.2164), `meanMRR 0.1613396855203406`
(→ 0.1613). That matches the values stated in the task.

| Leg | A0 | A0r | Verdict |
|---|---|---|---|
| L1 selection | 50/96, rr 0.42534722222222227, mrr 0.33303571428571427, readReady 24/96 | identical | **EXACT MATCH** (0 per-query success diffs, 0 readReady diffs) |
| L2 internal-44 | 20/35, readReady 5/35 | 20/35, 5/35 | **EXACT MATCH** (0 per-query fileHit diffs) |
| L3 D46 dev | 25/48, rr 0.44097222222222227, mrr 0.3735119047619047, readReady 8/48 | identical | **EXACT MATCH** (0 per-query diffs) |
| L4 dev64 | 35/128, 0.21640624999999997, 0.1613396855203406; title 17/64, body 18/64 | identical, title 17/64, body 18/64 | **EXACT MATCH** (0/128 outcome diffs; full outcome objects identical excluding `elapsedMs`; `meanRenderedTokens` equal) |

**Correction of the A0r worker's "DELTA":** the A0r worker (`de3dfdcc`) reported "L4
DELTA on 4 of 6 headline numbers (36/128 → 35/128 …)" because its L4 target was the
**V1-era doc value** (`daf2…` tree, legacy mode: 36/128, 0.219, 0.163 — the number the
worker quotes from the historical doc). Against **today's A0** — the correct baseline
for a V2 drift check — A0r matches exactly on all four legs, including every
per-query/per-outcome record. The "delta" was a baseline mismatch (V1 doc vs V2 run),
not run-to-run drift; the worker's own anomaly note already suspected this ("stable
mode/engine-version offset"). **Drift verdict: no drift, A0 ≡ A0r.**

## 5. E18 gate evaluation

Gate text, quoted verbatim from `docs/plans/2026-10-07-tool-ergonomics-decision-log.md`
(E18, "written before any arm runs"):

> **Gate** (exactly as E15, not relaxed): net success gain ≥ +2 on the fresh cohort AND
> net file-hit gain ≥ +2 on internal-44; ≤ 1 previously successful query lost per
> set/formulation (fresh cohort, internal-44, D46 dev, dev64 titles, dev64 bodies); no
> net read-ready regression on any set; no increase in absence false-content or exact_ish
> losses; no unexpected judge invocation. **Champion tie-break:** largest fresh-cohort
> net gain → fewest total lost queries → fewest knobs → lowest mean rendered tokens.
> If no arm passes, no champion: the holdout is not opened and defaults stay.

The freeze manifest (lines 59–63) restates the same gate with the sets unenumerated and
adds "fresh cohort (sealed, 112 …) and internal-44" as the selection sets. E15's gate
line additionally names "body" among the regression guards and requires "all flips
disclosed"; both are honored below. Set→leg mapping: fresh cohort = L1,
internal-44 = L2, D46 dev = L3, dev64 titles/bodies = L4 formulations.

### Gate arithmetic (every arm vs A0)

- **G1** = fresh-cohort success gain ≥ +2 (L1 successes, arm − A0 where A0 = 50/96)
- **G2** = internal-44 file-hit gain ≥ +2 (L2 fileHit, A0 = 20/35)
- **G3** = ≤1 previously successful query lost per set/formulation
- **G4** = no net read-ready regression (A0: L1 24/96, L2 5/35, L3 8/48)
- **G5** = absence false-content not increased (A0: L1 16/16, L3 8/8) and no exact_ish
  losses (A0-vs-self = 0)
- **G6** = no unexpected judge invocation

| Arm | G1 | G2 | G3 losses L1/L2/L3/title/body | G4 read-ready | G5 | G6 | Overall |
|---|---|---|---|---|---|---|---|
| A1 | **PASS** 52−50=+2 | **FAIL** 20−20=0 | **FAIL** 1 / 0 / 0 / 1 / **3** | PASS 25≥24, 5≥5, 8≥8 | PASS | PASS | **FAIL** |
| A2 | **FAIL** 46−50=−4 | **FAIL** 18−20=−2 | **FAIL 6 / 6 / 3 / 3** / 0 | **FAIL** 13<24, 5=5, 7<8 | PASS | PASS | **FAIL** |
| A3 | **PASS** 55−50=+5 | **FAIL** 19−20=−1 | **FAIL 2** / 1 / 0 / 0 / **2** | PASS 24≥24, 5≥5, 8≥8 | PASS | PASS | **FAIL** |
| A4 | **PASS** 59−50=+9 | **FAIL** 21−20=+1 (<+2) | 1 / 0 / **2** / **3** / **2** → **FAIL** | PASS 25≥24, 6≥5, 8≥8 | PASS | PASS | **FAIL** |
| A5 | **PASS** 67−50=+17 | **PASS** 22−20=+2 | **FAIL 2** / 0 / **3** / 1 / **3** | PASS 28≥24, 6≥5, 8≥8 | PASS | PASS | **FAIL** |
| A6 | **FAIL** 50−50=0 | **FAIL** 21−20=+1 | PASS 0 / 0 / 0 / 0 / 0 | PASS 24≥24, 5≥5, 8≥8 | PASS | PASS | **FAIL** |
| A7 | **PASS** 56−50=+6 | **PASS** 24−20=+4 | 1 / 0 / 1 / 1 / **4** → **FAIL** | PASS 27≥24, 5≥5, 8≥8 | PASS | PASS | **FAIL** |
| A8 | **PASS** 57−50=+7 | **FAIL** 20−20=0 (<+2) | **FAIL 8 / 2 / 6 / 2 / 3** (each >1) | **FAIL** 15<24, 6≥5, 7<8 | PASS | PASS | **FAIL** |
| A0r | n/a (baseline rerun: all deltas 0, all losses 0) | | | | | | **matches A0** |

**A8 corrected-run arithmetic (vs A0; the only arm re-evaluated):**

- **G1:** L1 success@5 57/96 − 50/96 = **+7 ≥ +2 → PASS**
- **G2:** L2 fileHit@5 20/35 − 20/35 = **0 < +2 → FAIL**
- **G3** (≤1 previously successful query lost per set/formulation): L1 **8** lost
  (`pmndrs__zustand-architecture-01/-02/-03`, `pmndrs__zustand-behaviour-01/-02`,
  `pmndrs__zustand-multi_file-02`, `rollup__rollup-behaviour-03`,
  `solidjs__solid-configuration-01`); L2 **2** (`B4-stageapply`, `q10`); L3 **6**
  (`honojs-hono-dev-003/-012/-014/-015/-019`, `tj-commander-dev-architecture-03`);
  L4-title **2** (`preactjs__preact-3062`, `vuejs__core-9572`); L4-body **3**
  (`mrdoob__three.js-25687`, `preactjs__preact-3454`, `vuejs__core-11515`) →
  **every set above the ≤1 cap → FAIL**
- **G4** (read-ready): L1 15/96 vs A0 24/96 → regression; L2 6/35 ≥ 5/35 ok;
  L3 7/48 vs A0 8/48 → regression; L4 read-ready not evaluable (no field) → **FAIL**
- **G5:** absence falseContent L1 16 = 16, L3 8 = 8 (not increased); exact_ish
  losses vs A0: L1 0, L3 0 → **PASS**
- **G6:** L1/L3 `judge.config=off` + `unexpectedJudge` 0, L2 `judgeUsage` all 0,
  L4 `judge="off"` → **PASS**

**A8 overall: FAIL** (G2, G3, G4 fail). Full-precision L4: `meanRecallAt5`
0.27838541666666666, `meanMRR` 0.230942816207002 (A0: 0.21640624999999997 /
0.1613396855203406); L4 title 24/64, body 21/64; readReady L1 15/96, L2 6/35,
L3 7/48.

**Flips disclosed (E15 "all flips disclosed"):** lost-query IDs per arm/set:

- **A1** — L1: `pmndrs__zustand-architecture-03`; L4-title: `vuejs__core-8535`;
  L4-body: `facebook__docusaurus-10130`, `mrdoob__three.js-25687`,
  `preactjs__preact-4245`. (L2, L3: none.)
- **A2** — L1: `nestjs__nest-multi_file-03`, `pmndrs__zustand-architecture-03`,
  `rollup__rollup-behaviour-03`, `rollup__rollup-configuration-01`,
  `rollup__rollup-multi_file-02`, `rollup__rollup-multi_file-03`; L2: `B13-doomloop`,
  `B18-strict`, `B4-stageapply`, `B9-registry`, `q03`, `q10`; L3: `honojs-hono-dev-003`,
  `honojs-hono-dev-005`, `honojs-hono-dev-019`; L4-title: `facebook__docusaurus-9183`,
  `vuejs__core-8535`, `vuejs__core-9572`. (L4-body: none.)
- **A3** — L1: `pmndrs__zustand-behaviour-02`, `solidjs__solid-configuration-01`;
  L2: `B16-lifecycle`; L4-body: `mrdoob__three.js-25687`, `vuejs__core-11515`.
  (L3, L4-title: none.)
- **A4** — L1: `pmndrs__zustand-behaviour-02`; L3: `honojs-hono-dev-003`,
  `honojs-hono-dev-009`; L4-title: `preactjs__preact-3062`, `vuejs__core-8535`,
  `vuejs__core-9507`; L4-body: `mrdoob__three.js-25687`, `vuejs__core-11515`.
  (L2: none.)
- **A5** — L1: `pmndrs__zustand-architecture-02`, `pmndrs__zustand-behaviour-02`;
  L3: `honojs-hono-dev-003`, `honojs-hono-dev-009`, `honojs-hono-dev-012`;
  L4-title: `preactjs__preact-3062`; L4-body: `mrdoob__three.js-25687`,
  `preactjs__preact-3454`, `vuejs__core-11515`. (L2: none.)
- **A6** — no losses on any set (the only arm with zero losses everywhere: G3
  passes 0/0/0/0/0). Gains: +1 on L2, +1 on L3, zero on L1/title/body.
- **A7** — L1: `nestjs__nest-multi_file-01`; L3: `tj-commander-dev-behaviour-02`;
  L4-title: `axios__axios-5338`; L4-body: `facebook__docusaurus-10130`,
  `mrdoob__three.js-25687`, `preactjs__preact-2927`, `preactjs__preact-4152`.
  (L2: none.)
- **A8 (corrected run 2026-10-08 UTC)** — L1: `pmndrs__zustand-architecture-01`,
  `pmndrs__zustand-architecture-02`, `pmndrs__zustand-architecture-03`,
  `pmndrs__zustand-behaviour-01`, `pmndrs__zustand-behaviour-02`,
  `pmndrs__zustand-multi_file-02`, `rollup__rollup-behaviour-03`,
  `solidjs__solid-configuration-01`; L2: `B4-stageapply`, `q10`; L3:
  `honojs-hono-dev-003`, `honojs-hono-dev-012`, `honojs-hono-dev-014`,
  `honojs-hono-dev-015`, `honojs-hono-dev-019`, `tj-commander-dev-architecture-03`;
  L4-title: `preactjs__preact-3062`, `vuejs__core-9572`; L4-body:
  `mrdoob__three.js-25687`, `preactjs__preact-3454`, `vuejs__core-11515`.
- **A0r** — no flips (identical to A0).

Gross gains (arm gained where A0 failed), per set L1/L2/L3/title/body:
A1 3/0/0/0/1 · A2 2/4/1/2/0 · A3 7/0/2/2/4 · A4 10/1/6/7/3 · A5 19/2/12/9/7 ·
A6 0/1/1/0/0 · A7 7/4/3/2/2 · A8 15/2/16/9/6 (corrected run) · A0r 0/0/0/0/0.

### Gate verdicts

**No arm passes the E18 gate.** A5 and A7 clear both positive gates (G1, G2) but fail
the loss veto (A5: 2 fresh-cohort + 3 D46-dev + 3 dev64-body losses; A7: 4 dev64-body
losses — each > 1 per set/formulation). A6 satisfies every veto but fails both positive
gates. A1–A4 fail G2 (and A2/A3/A4 additionally fail G3/G4). The corrected A8
clears G1 (+7) but fails G2 (0 < +2), G3 (8/2/6/2/3 losses — every set above the ≤1
cap) and G4 (L1 read-ready 15<24, L3 7<8) → FAIL.
Per the quoted gate: **"If no arm passes, no champion: the holdout is not opened and
defaults stay."** The champion tie-break is not reached (it applies only among arms
that pass).

Supplementary E15 "body regression" check (dev64 body net vs A0 = 18/64): A1 −2 ✗,
A7 −2 ✗, A2 0, A3 +2, A4 +1, A5 +4, A6 0, A8 +3 (corrected run). This does not change
any overall verdict (A1/A7 already fail on loss counts).

### Not-evaluable / ambiguity (stated, not invented)

1. **Read-ready on dev64 titles/bodies — NOT EVALUABLE.** Gate line: *"no net
   read-ready regression on any set"*. The external-grep L4 reports contain no
   read-ready field on `summary` or `outcomes` (outcome keys: instanceId, formulation,
   rankedFiles, goldRanks, successAt5, recallAt5, mrr, hunkOverlapAt5, overTokenCap,
   renderedTokens, elapsedMs, status, topEngine, shownCards, routing). Read-ready is
   evaluated on the three sets that measure it (fresh cohort, internal-44, D46 dev);
   for dev64 the gate component is recorded as not-evaluable rather than assumed pass.
2. **CI / replicates — NOT APPLICABLE to this gate as written, NOT EVALUABLE if
   intended.** The E18 gate text contains no CI or replicate requirement; each cell is
   a single run (`replicate: 1`). The "positive paired 95% CI on titles" belongs to
   E15's *holdout confirmation* stage ("confirmation also needs a positive paired 95%
   CI on titles"), which is not reached because there is no champion. If a
   CI-across-replicates reading was intended for the selection gate, it is not in the
   quoted text and cannot be computed with n=1 — flagged, not invented.
3. **"No increase in absence false-content or exact_ish losses" — baseline not spelled
   out.** Evaluated against A0 (baseline losses vs itself = 0; A0 absence
   false-content = 16/16 on L1, 8/8 on L3). Under both plausible readings (strict
   zero-tolerance, or ≤1 under G3's cap) every valid arm passes: absence
   false-content is byte-identical across all arms (L1 16, L3 8), and exact_ish
   losses vs A0 = 0 on L1 **and** L3 for every arm.
4. **A8 arm-definition conflict — RESOLVED by the corrected run 2026-10-08 UTC.**
   Pre-registration (manifest) says C6c (b=0.5 + coverage); the first dispatch used
   coverage only at default b (dispatch-error provenance recorded in §2, not hidden).
   The four cells were re-run with the full pre-registered set and now carry
   `rankBm25b=0.5` + the three toggles; the row is gate-evaluable and evaluated
   **FAIL** in §5.

## 6. Caveats

- **Mode/engine differences vs the Oct-7 mixed-engine exploratory set:** the Oct-5/6/7
  numbers in the decision log (e.g. E16: D46 dev 24→25/48, external dev64 35→36/128)
  were produced on the V1 `daf2…` tree in legacy mode; today's matrix is uniformly V2
  (`e5fad837`) with owned-mode L4. The A0 checkpoint explicitly says "Old `daf2…` A0
  cannot baseline future arms". Do not diff matrix cells against the Oct-7 docs —
  e.g. today's A0 L4 is 35/128 vs the doc's 36/128, a mode+engine confound, not
  retrieval drift (same point that misled the A0r worker, §4).
- **L1/L2/L3 legacy-report-path quirk:** there is no per-arm report directory. L1/L3
  write to the shared owned reports dir with timestamp-only disambiguation; L2 writes
  into the legacy judge-spike bench tree (`~/.cache/pi-smartread-judge-spike/bench/
  grep-e2e/`) even though the judge is off (the leg-2 harness has no `--reports-dir`
  by design; workers resolved its path via their own `report:` log lines). Path or
  timestamp alone is therefore unsafe for attribution; knob fields + worker quotes
  were used instead (§1).
- **Concurrency batches:** legs for A1–A4 ran interleaved in 19:35–19:42 (e.g. A1's
  L3 at 19:37:54 overlapped A2's L1 at 19:37:38), A5–A8 interleaved in 20:18–20:24,
  and two L4 files share the second `21:00:08`. Batches were concurrent, so
  `elapsedMs`/`meanElapsedMs` are contention-affected and must not be compared across
  arms. Metric determinism is evidenced by A0 ≡ A0r (byte-identical outcomes, §4) —
  but that evidence is n=2 and only for default knobs; no arm has a replicate. The
  corrected A8 run (2026-10-08 22:40–23:06 UTC) is the exception: its four legs ran
  sequentially with no other eval processes present (pgrep empty before L4), so its
  timings are uncontended — still not comparable to the batched arms, still n=1.
- **Single replicate everywhere** (see not-evaluable #2): gate as written does not
  require more, but no arm's numbers carry an uncertainty estimate.

## 7. Appendix — per-leg report paths and SHA-256

Owned reports dir = `/Users/rhinesharar/.cache/pi-smartread-retrieval-owned-20261008/reports/`;
grep-e2e dir = `/Users/rhinesharar/.cache/pi-smartread-judge-spike/bench/grep-e2e/`.
Shas are of the report files themselves, computed in this pass.

| Arm | Leg | File | sha256 |
|---|---|---|---|
| A0 | L1 | owned/d46-selection-off-2026-10-08T16-25-30-510Z-55015e79.json | 4f0108942447a3613d4f22fc78c51e2e333baadd188df58c2d6e888b23140d3c |
| A0 | L2 | grep-e2e/grep-e2e-off-2026-10-08T16-26-53-195Z-p13196.json | eaa055c4ac1db805e038d19cc15eb553cd067c82dfd7c98f748dc5a3c3a10566 |
| A0 | L3 | owned/d46-dev-off-2026-10-08T16-28-12-440Z-d221deca.json | d482fa7cf0e51393df970ceae804af529ff89456efa1f5c3a1057f06e11b1ea8 |
| A0 | L4 | owned/external-grep-dev-2026-10-08T19-19-30-779Z-80820a88.json | 7462a1441ac2d5a9fc5ec974ea8ca98bcaa3e09d7b9c0acdd2200e2ff6eddb6a |
| A1 | L1 | owned/d46-selection-off-2026-10-08T19-38-56-760Z-da14c242.json | 91d6db948de4f20ae656a0f8cea5b08b976492131295caa0af0fd8f3014e3a69 |
| A1 | L2 | grep-e2e/grep-e2e-off-2026-10-08T19-40-23-628Z-p7304.json | 8d7342e985587c8573be26e22d2d4d4b10c009270f87d64bf9a6f222eeb82e89 |
| A1 | L3 | owned/d46-dev-off-2026-10-08T19-42-51-359Z-1682ee84.json | 3e54a6c8f4496de609392ea0fd97cba16ea6759aa7f47843c67d17da3b49b3c5 |
| A1 | L4 | owned/external-grep-dev-2026-10-08T21-00-08-206Z-2307ad5e.json | c6dc262935b9617da0fa175c1002b53c9c397a5466f3af23e7c8c03fc3557574 |
| A2 | L1 | owned/d46-selection-off-2026-10-08T19-35-17-706Z-ca24361c.json | 56bf85aa6ec657feaa06d1ead707ec8bdeeed6a54da524ae58c99c1df0a7e2fa |
| A2 | L2 | grep-e2e/grep-e2e-off-2026-10-08T19-35-56-223Z-p2166.json | 22d78b8af0c98fb6b256d55b4f6cc474fd828d1d073ee7589938b4a364fe7f78 |
| A2 | L3 | owned/d46-dev-off-2026-10-08T19-37-54-445Z-a67cbe21.json | 95ebea2bd13f7c84b8ab3b66fac4371443b6b7f09f6ba51ff384ab63bde1a43b |
| A2 | L4 | owned/external-grep-dev-2026-10-08T20-58-28-587Z-3e6cd2f7.json | 92ae68af887d257d74b18d20595f8fed9b618a4d552139d5b8740103b8334855 |
| A3 | L1 | owned/d46-selection-off-2026-10-08T19-38-21-112Z-9c03f073.json | a907a77e6a17c2d2e47ec46a8171d8a76c579996352513597ac77adc6a5c1de4 |
| A3 | L2 | grep-e2e/grep-e2e-off-2026-10-08T19-38-48-032Z-p5390.json | f36424379251c1c796ee16fd5c217b6a0be5d5917e5789ff43c05faebff007bf |
| A3 | L3 | owned/d46-dev-off-2026-10-08T19-41-07-528Z-5c700d80.json | e3f1f659c79a575c9a6637d6acf52e1703673eea61a3e2b82e3969156c8734dd |
| A3 | L4 | owned/external-grep-dev-2026-10-08T21-00-08-275Z-98f66788.json | 95b0ba6801ee90ec120f1f241a64a5acc93a296f58e2f7f3c06bb98d0dbb21d6 |
| A4 | L1 | owned/d46-selection-off-2026-10-08T19-37-38-051Z-defb81c0.json | 047210a8fd9b37a2c69a0b8b562f450eb85f7c00de511dc22ec5184de40cb516 |
| A4 | L2 | grep-e2e/grep-e2e-off-2026-10-08T19-38-05-140Z-p4690.json | 0c8c74e0122d1b8d521037356e4b43e37b12b18abe099d9b92c928b1e3ab5867 |
| A4 | L3 | owned/d46-dev-off-2026-10-08T19-39-54-768Z-f1adb040.json | 5f734beb689d4c4e0f80b073b2a9b0e09493d81d10ef7fdd44918b265fb7cabe |
| A4 | L4 | owned/external-grep-dev-2026-10-08T21-01-48-145Z-791c292e.json | 5a5a561a976ca70715dc95f034eccb5b4726aca6179edd23bdc9ae5cf7219fd0 |
| A5 | L1 | owned/d46-selection-off-2026-10-08T20-21-23-362Z-5baf8b55.json | b57581d916c09d67b3d478789e6250a3a7920df3ea082e9a79098359d90beae4 |
| A5 | L2 | grep-e2e/grep-e2e-off-2026-10-08T20-21-42-169Z-p53594.json | ca9a663bf3de08af13ab959c236133c34612fca714f967b4e1f305796980e6e0 |
| A5 | L3 | owned/d46-dev-off-2026-10-08T20-23-19-317Z-abb18a4d.json | b24cff7c07121920a524598bb5153192ef1d0e6c81f5c215b8eb4b483ffed78e |
| A5 | L4 | owned/external-grep-dev-2026-10-08T21-38-32-544Z-1b8d3e70.json | d62becce7ab5409ff0fca5d6641c6fecb9412cd10f923367c1848cfc3ce00bb5 |
| A6 | L1 | owned/d46-selection-off-2026-10-08T20-20-19-868Z-1e1a9839.json | ea666794418edb163c981401f60285788e9bbd6e14d3557c05a2d26bfc95c23d |
| A6 | L2 | grep-e2e/grep-e2e-off-2026-10-08T20-20-40-800Z-p52165.json | c7156bf8c1348db1d2c369cfa558f10729e17afad6d91a55b3d24a7688b7657c |
| A6 | L3 | owned/d46-dev-off-2026-10-08T20-22-37-032Z-d953b281.json | 4981e6fab192ed0039c929ea3a00ed64e29597b3a48179560abd12def9ea330a |
| A6 | L4 | owned/external-grep-dev-2026-10-08T21-38-58-316Z-bdf400dd.json | f7a6c4952a6d466435f31e5b09e31fca096a5f1ed9f694544ec5ab265afb21c0 |
| A7 | L1 | owned/d46-selection-off-2026-10-08T20-18-47-483Z-bc9be39d.json | 2df23538236ee521fb4c25f17258d52c467a5915f0a761983cb3ec955bfd003c |
| A7 | L2 | grep-e2e/grep-e2e-off-2026-10-08T20-19-17-180Z-p50856.json | c05d91f672bc5b2884d7f48b42a1d1c099cd489537354de8c364d9616ad2e44f |
| A7 | L3 | owned/d46-dev-off-2026-10-08T20-21-16-570Z-897400ef.json | 76a070dd3b1f09046418bcfa531b0d66f97a0d0f18dcbba1bce6df4d0669229c |
| A7 | L4 | owned/external-grep-dev-2026-10-08T21-40-40-062Z-2584e285.json | 3c59fb5758f1bfe2d98e4defb1da0b496a38f28fff522fe1fda689f82ba91765 |
| A8 | L1 (corrected 2026-10-08 UTC) | owned/d46-selection-off-2026-10-08T22-40-43-179Z-c8c84ab0.json | 1584af2e3da807560777467406162572fbd56db4a8859a148406b098d03bb06a |
| A8 | L2 (corrected 2026-10-08 UTC) | grep-e2e/grep-e2e-off-2026-10-08T22-40-55-021Z-p90712.json | bff93fa10d6db905cda8490c698bcf6f63c3700e1a1e6a9e98d744453d8e9cf9 |
| A8 | L3 (corrected 2026-10-08 UTC) | owned/d46-dev-off-2026-10-08T22-42-50-073Z-9b1c7e83.json | a5d33f8955b3ab7153828c9b605f09bb866aae2b6089aa60f450baf8644ed867 |
| A8 | L4 (corrected 2026-10-08 UTC) | owned/external-grep-dev-2026-10-08T23-06-25-027Z-d70935c6.json | ab1db33e90986d3d11437f7c14fbb2cb50480bbe6777e9c913977c78442c12f4 |
| A0r | L1 | owned/d46-selection-off-2026-10-08T21-47-14-549Z-623e5805.json | 5ac8fa67ee6e1b000e5a3bdfd3f743a8468cda79d5885504234f444d98f4e8b7 |
| A0r | L2 | grep-e2e/grep-e2e-off-2026-10-08T21-47-33-749Z-p44390.json | e6688d977423a5a7b3b2f3975d60b65d95e530834e9003a840002496b025da0f |
| A0r | L3 | owned/d46-dev-off-2026-10-08T21-49-07-314Z-0267e05b.json | bfdf178c166413372e785db5b7565c044c10000364e14ae5f2e0af0a711d3c29 |
| A0r | L4 | owned/external-grep-dev-2026-10-08T22-10-35-337Z-a253217c.json | 9ab677ff8d9a7e9fed11f4569b5be84454fca3b007cf9cfd58633b856859122c |

Excluded (not cells): `owned/external-grep-dev-2026-10-08T15-54-56-029Z-f839e16a.json`
(sha 448ed6e173f8…) and `owned/external-grep-dev-2026-10-08T16-20-12-854Z-f839e16a.json`
(sha 99ea02ea219d…) — aborted A0 L4 attempts, `runs=0`, V2 hash, default knobs;
plus all `grep-e2e-off-2026-10-0{5,6,7}*` files (pre-matrix exploratory runs).

---

**Parent review pending** — the A8 INVALID adjudication is resolved by the corrected
run 2026-10-08 UTC (§2, including the dispatch-error provenance); the two not-evaluable
gate components (§5) remain open before treating this as final.
