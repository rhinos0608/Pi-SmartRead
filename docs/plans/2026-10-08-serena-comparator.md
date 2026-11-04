# Serena comparator (E6 retrieval guard)

## Mechanism

Serena (`serena-agent`, MCP server over stdio, newline-delimited JSON-RPC)
is driven headless exactly like `mcp-language-server`: spawn
`serena start-mcp-server --project <corpus-root>`, `initialize` +
`notifications/initialized`, then `tools/call`. No Pi session, no dashboard
interaction (dashboard binds 127.0.0.1 only; ignored). Verified empirically
2026-10-08 on a two-file TS fixture: `find_symbol` and
`find_referencing_symbols` both return usable results headless.

Serena's backend is its own SolidLSP layer (MIT, `src/solidlsp`), which
starts and manages its own language server — it does **not** reuse our
pinned `typescript-language-server`. Project activation auto-generates
`<root>/.serena/project.yml` plus `<root>/.serena/cache/` inside the
corpus checkout; the runner removes `<root>/.serena` after each run so the
pinned corpora stay clean. Global state lives in `~/.serena/`
(auto-generated config, managed language-server installs) — outside the
repo, no action needed.

## Exact pin

- `serena-agent==1.7.0` (PyPI, latest release 2026-08-09), installed with
  pinned version into `~/.cache/pi-smartread-bench/tools/serena/.venv`
  (`serena --version` → `Serena 1.7.0`).
- Serena-managed language server (auto-installed on first activation,
  now cached): `typescript-language-server 5.1.3` + `typescript 5.9.3`
  under `~/.serena/language_servers/static/TypeScriptLanguageServer/`.
  This differs from the benchmark reference (TLS 6.0.0 + TS 5.9.2):
  Serena deltas therefore mix tool-layer and server-version effects.
  Recorded as a caveat on the adapter; no attempt to force Serena onto
  the pinned server (its install layout is version-managed internally).

## Install method

```sh
mkdir -p ~/.cache/pi-smartread-bench/tools/serena
cd ~/.cache/pi-smartread-bench/tools/serena
uv venv --python 3.11
VIRTUAL_ENV=$PWD/.venv uv pip install "serena-agent==1.7.0"
```

No global installs. First activation needs network (npm install of the
managed TS server); subsequent runs are offline apart from the pinned
corpora already on disk.

## Licence

Serena is licensed per component (README, authoritative): SolidLSP
(`src/solidlsp`) MIT, the Serena application (everything else)
GPL-3.0-or-later; combined distributions are GPL as a whole. Benchmark
use executes the tool without distributing it; no Serena code is vendored
into this repo (adapter talks MCP/JSON only).

## Hypothesis

Serena's symbol-level retrieval (`find_symbol`, `find_referencing_symbols`)
should match or beat raw LSP proxying on reference fidelity for named
symbols (it resolves through the same LSP `definition`/`references`
operations, plus a symbol index), at higher token/latency cost per query
(JSON symbol envelopes + snippets vs raw locations) and higher setup cost
(project activation + cross-file indexing). Expected weak spots: exact
position fidelity (its output is line-granular), overloaded/common names
(name-path addressing is ambiguous), and use-site-anchored references
(it needs the definition's file first — a two-step lookup).

## Position mapping (benchmark positions are file+line+character+name)

- `definition` ← `find_symbol({name_path_pattern: pos.name, include_body: false})`
  project-wide (no `relative_path` restriction — restricting would assume
  the answer). Returns `[{name_path, kind, relative_path, body_location:
  {start_line, end_line}}]` with **0-based lines, no columns**.
  Adapter emits point locations `(start_line, char 0)`.
- `references` ← two-step, Serena-native, no reference leakage:
  1. `find_symbol` as above → candidate definitions
     (`name_path` + `relative_path` per candidate).
  2. `find_referencing_symbols({name_path, relative_path})` for the first
     K=3 candidates, union the results.
  Output groups referencing symbols per file with `content_around_reference`
  snippets; the referenced line is marked `>` with a 0-based number
  (`  >   2:  return greet("world");`). Adapter parses `> N:` markers
  into point locations `(file, N, char 0)`. The K-cap and candidate count
  are recorded per position; over-cap truncation is a measured limitation,
  not silently dropped data.
- `hover`: **unsupported** — Serena has no hover/call-signature equivalent
  (`include_info` returns docstring/signature text for a *symbol*, not a
  position; not equivalent, so not scored).
- `workspaceSymbols`: **unsupported** in the runner (hardcoded for all
  comparators). Note `find_symbol` project-wide *is* a symbol search, but
  it is consumed here as the definition path; scoring it twice would
  double-count one call.

## Fair scoring (why standard exact metrics under-read Serena)

Serena output is line-granular by design (body_location lines, snippet
line markers) — character-exact `defExact` and char-sensitive ref F1 will
systematically under-score it. The adapter therefore reports, alongside
the standard metrics:

- `defLine`: any returned definition shares (file, start-line) with the
  reference definition (the fair definition comparison).
- `refLineF1`: F1 over (file, line) sets — reference refs mapped to
  (file, start-line) vs parsed `>` markers (the fair references
  comparison; mirrors the existing `startF1` secondary precedent for
  start-only outputs).
- Standard `defExact`/`refF1` are still recorded (expected ≈0/low) with
  this granularity note, so the comparison stays auditable.

## Unfair / unsupported cases (do not read as Serena failures)

1. Character-exact definition match — output has no columns by design.
2. Anonymous symbols, default-export callables, property accesses and
   operator overloads where `pos.name` is not the symbol's `name_path`
   tail — name addressing cannot name them; affected positions are
   reported, not silently scored zero without comment.
3. Common/short names (`run`, `name`, single letters): `find_symbol`
   returns every same-named symbol project-wide; only the first K=3
   definition candidates are expanded for references. Overloads surface
   as `name[i]` variants and are all kept within the cap.
4. Reference import lines: Serena reports importing files/symbols as
   referencing (with a "returning file symbol" fallback when no containing
   symbol is found) — file/line-level comparison absorbs most of this,
   residual mismatch is adapter-visible in raw output.
5. First-references latency includes one-time TS cross-file indexing
   (~5 s on the fixture); setup/indexing is reported separately from
   per-op latency per E6 (setup time separated).
6. Server-version skew (TLS 5.1.3/TS 5.9.3 vs reference 6.0.0/5.9.2):
   small definition/reference deltas may come from the server, not Serena.

## Results (self + mitt, --limit 150 --seed 20261005)

Runs: `node --import tsx scripts/eval/external/lsp/comparators/run-comparators.ts
--system serena --corpus <self|mitt> --limit 150 --seed 20261005`
(plus reference `../run.ts` and siblings for the vs columns).

| corpus | system | defExact | defLine | refF1 | refLineF1 (startF1) | mean tokens (def/ref) | p50 latency ms (def/ref/total) | setup ms |
|---|---|---|---|---|---|---|---|---|
| self | SmartRead (strict LSP) | 0.993 | — | 0.987 | — | — | 2 ref-side; ours 2/— | — |
| self | pi-lsp | 0.986 | — | 0.990 | (0.990) | 112 / 3605 | 2 / 2 / 7 | 244 |
| self | mcp-language-server | 0.000 | — | 0.033 | (0.498) | 28964 / 15126 | 26 / 74 / 105 | 1301 |
| self | **serena** | 0.000 | **0.741** | 0.034 | **0.461** | 1842 / 1202 | 355 / 646 / 1040 | 4644 |
| mitt | SmartRead (strict LSP) | 1.000 | — | 1.000 | — | — | ours ~1/— | — |
| mitt | pi-lsp | 1.000 | — | 1.000 | (1.000) | 63 / 501 | 1 / 1 / 2 | 242 |
| mitt | mcp-language-server | 0.000 | — | 0.207 | (0.547) | 1053 / 294 | 1 / 2 / 4 | 1248 |
| mitt | **serena** | 0.000 | **0.477** | 0.207 | **0.476** | 60 / 269 | 105 / 111 / 218 | 3563 |

Reference reports (same seed/limit, 2026-10-07): `lsp-self-…13-00-34`,
`lsp-mitt-…13-00-38`, `lsp-pi-lsp-{self,mitt}-…12-51`,
`lsp-mcp-language-server-{self,mitt}-…12-53`. Serena reports:
`lsp-serena-self-2026-10-07T13-26-57-491Z.json`,
`lsp-serena-mitt-2026-10-07T13-26-22-176Z.json`.
SmartRead latency columns are the strict-executor path (`ours` p50) and
setup is n/a (manager cache, same-process). hover: Serena `unsupported`
(300/300); status otherwise self ok 248 / empty 51 / error 1, mitt ok 157
/ empty 143 (name-address misses on the smaller corpus).

Reading: at its fair granularity Serena resolves the right definition
line ~74% (self) / ~48% (mitt) and reaches refLineF1 ~0.46–0.48 — below
mcp-language-server's start-anchored 0.50–0.55 on the same name-based
task, at ~10× the per-op latency of pi-lsp on self (1040 ms vs 7 ms
per-position total) and ~2–7× the output tokens of pi-lsp. defExact 0 is
the documented granularity artefact (no columns emitted), not a
capability zero. Hypothesis verdict: name-addressed symbol retrieval
confirms recall at line level but does not beat position-exact proxying
on fidelity-per-cost; no borrow.

## Borrow log

Nothing borrowed: Serena's symbol-abstraction critique (line-granular
symbol envelopes vs positions) confirms the current tool split — no
surface change proposed from this comparator alone.

## Audit

Conducted 2026-10-08. Verified against upstream (`github.com/oraios/serena` at `v1.7.0` and `main`), the installed package under `~/.cache/pi-smartread-bench/tools/serena/.venv`, the cached language server installation under `~/.serena/`, the comparator adapter (`scripts/eval/external/lsp/comparators/serena.ts`), and the raw report files under `~/.cache/pi-smartread-bench/reports/`.

### 1. Pin & Environment Claims

- **`serena-agent==1.7.0` pin & release date:** **VERIFIED**
  - Upstream GitHub release `v1.7.0` was published `2026-08-09T18:38:06Z` (latest release as of benchmark run).
  - Virtual environment at `~/.cache/pi-smartread-bench/tools/serena/.venv` contains `serena_agent-1.7.0.dist-info/METADATA` confirming version `1.7.0`.
- **Serena-managed language server (`typescript-language-server 5.1.3` + `typescript 5.9.3`):** **VERIFIED**
  - Confirmed via `~/.serena/language_servers/static/TypeScriptLanguageServer/ts-lsp/node_modules/typescript-language-server/package.json` (`5.1.3`) and `typescript/package.json` (`5.9.3`), matching defaults declared in `solidlsp/language_servers/typescript_language_server.py`.
  - Minor path precision note: the files reside in subfolder `ts-lsp/` under `~/.serena/language_servers/static/TypeScriptLanguageServer/`.
- **Benchmark reference skew (TLS 6.0.0 + TS 5.9.2):** **VERIFIED**
  - Reference binaries and report metadata (`pinned.typescriptLanguageServer: "6.0.0"`, `pinned.typescript: "5.9.2"`) match doc description.

### 2. Licence Claims

- **Claim:** "Serena is licensed per component (README, authoritative): SolidLSP (`src/solidlsp`) MIT, the Serena application (everything else) GPL-3.0-or-later; combined distributions are GPL as a whole."
- **Status:** **MISMATCH**
  - **Upstream at stated version (`v1.7.0`):** `LICENSE` is pure MIT (`Copyright (c) 2025 Oraios AI`). `pyproject.toml` declares `[project.license] text = "MIT"` and classifier `"License :: OSI Approved :: MIT License"`. There is no GPL text or dual-licensing split at tag `v1.7.0`.
  - **Installed package (`serena-agent==1.7.0`):** `serena_agent-1.7.0.dist-info/METADATA` lists `License: MIT` and `Classifier: License :: OSI Approved :: MIT License`. Wheel license file `licenses/LICENSE` is pure MIT.
  - **Discrepancy cause:** The GPL-3.0-or-later / SolidLSP MIT split was introduced subsequently on `main` (unreleased, targeting Serena v2.0; see `CHANGELOG.md` under `# Unreleased (main)` and GitHub Discussion #1986). Upstream `CHANGELOG.md` explicitly notes: *"The change is not retroactive: all earlier releases and commits remain available under MIT."*
  - **Finding:** Pinned version `1.7.0` as installed and benchmarked is licensed entirely under MIT, not GPL-3.0-or-later. The document's licence claim reflects unreleased upstream `main`, not the stated pin.

### 3. Quantitative Results Audit

All raw reports cited were inspected directly from `~/.cache/pi-smartread-bench/reports/`:
- `lsp-self-2026-10-07T13-00-34-985Z.json`
- `lsp-mitt-2026-10-07T13-00-38-774Z.json`
- `lsp-pi-lsp-self-2026-10-07T12-51-11-248Z.json`
- `lsp-pi-lsp-mitt-2026-10-07T12-51-14-141Z.json`
- `lsp-mcp-language-server-self-2026-10-07T12-53-30-150Z.json`
- `lsp-mcp-language-server-mitt-2026-10-07T12-53-39-687Z.json`
- `lsp-serena-self-2026-10-07T13-26-57-491Z.json`
- `lsp-serena-mitt-2026-10-07T13-26-22-176Z.json`

#### Table Values (All 32 Cells Across Both Corpora): **VERIFIED**
- **Self corpus:**
  - SmartRead (strict LSP): defExact `0.993` (0.9930), refF1 `0.987` (0.9872), ours p50 latency `2 ms`: **VERIFIED**
  - pi-lsp: defExact `0.986` (0.9860), refF1 `0.990` (0.9901), startF1 `(0.990)`, mean tokens `112 / 3605` (112.1 / 3604.7), latency `2 / 2 / 7 ms`, setup `244 ms`: **VERIFIED**
  - mcp-language-server: defExact `0.000`, refF1 `0.033` (0.0333), startF1 `(0.498)` (0.4975), mean tokens `28964 / 15126` (28963.9 / 15125.8), latency `26 / 74 / 105 ms`, setup `1301 ms`: **VERIFIED**
  - serena: defExact `0.000`, defLine `0.741` (0.7413), refF1 `0.034` (0.0336), refLineF1 `0.461` (0.4614), mean tokens `1842 / 1202` (1842.2 / 1201.7), latency `355 / 646 / 1040 ms`, setup `4644 ms`: **VERIFIED**
- **Mitt corpus:**
  - SmartRead (strict LSP): defExact `1.000` (1.0), refF1 `1.000` (1.0), ours p50 latency `1 ms`: **VERIFIED**
  - pi-lsp: defExact `1.000` (1.0), refF1 `1.000` (1.0), startF1 `(1.000)`, mean tokens `63 / 501` (62.8 / 500.8), latency `1 / 1 / 2 ms`, setup `242 ms`: **VERIFIED**
  - mcp-language-server: defExact `0.000`, refF1 `0.207` (0.2067), startF1 `(0.547)` (0.5469), mean tokens `1053 / 294` (1053.3 / 294.1), latency `1 / 2 / 4 ms`, setup `1248 ms`: **VERIFIED**
  - serena: defExact `0.000`, defLine `0.477` (0.4775), refF1 `0.207` (0.2067), refLineF1 `0.476` (0.4760), mean tokens `60 / 269` (60.0 / 268.7), latency `105 / 111 / 218 ms`, setup `3563 ms`: **VERIFIED**

#### Prose Statistics:
- **Hover & Status counts:** **VERIFIED**
  - Serena hover unsupported: `300/300` across runner (150 hover + 150 workspaceSymbols recorded as unsupported in statusCounts).
  - Self status: ok 248 / empty 51 / error 1: **VERIFIED**.
  - Mitt status: ok 157 / empty 143: **VERIFIED**.
- **Accuracy summaries (~74% self / ~48% mitt defLine; ~0.46–0.48 refLineF1; vs mcp 0.50–0.55):** **VERIFIED**.
- **Latency multiplier claim ("at ~10× the per-op latency of pi-lsp on self (1040 ms vs 7 ms per-position total)"):** **MISMATCH**
  - 1040 ms vs 7 ms is **~148×** (or ~150×), not ~10×. The ~10× multiplier corresponds to Serena vs mcp-language-server (1040 ms vs 105 ms = 9.9×), but the text explicitly names pi-lsp.
- **Token multiplier claim ("~2–7× the output tokens of pi-lsp"):** **MISMATCH / UNVERIFIABLE**
  - Total tokens per position on self are 3044 (Serena) vs 3717 (pi-lsp) — Serena emits fewer total tokens. On mitt, Serena emits 329 vs 564 — again fewer.
  - Per-operation: on self definition, Serena emits 1842 vs 112 (~16.4×); on self references, Serena emits 1202 vs 3605 (~0.33×). On mitt definition, Serena is 60 vs 63 (~0.95×); on mitt references, 269 vs 501 (~0.54×). No dimension reflects a 2–7× increase over pi-lsp.

### 4. Fairness Findings

- **Position → Name-Path Mapping:** **FAIR**
  - Serena's MCP API does not expose position-anchored navigation (`file:line:character`); its semantic operations (`find_symbol`, `find_referencing_symbols`) index exclusively by symbol name/path.
  - Project-wide lookup `find_symbol({ name_path_pattern: pos.name, include_body: false })` without `relative_path` filtering is the fairest formulation: restricting by file would assume the definition file in advance.
  - The plan fairly recognizes that character-exact metrics (`defExact`, char-sensitive `refF1`) penalize Serena's line-only output format, and explicitly introduces `defLine` and `refLineF1` secondaries while classifying `defExact: 0` as a known granularity artefact rather than a capability defect.
- **K=3 Reference Candidate Cap:** **FAIR & PROPERLY DISCLOSED**
  - Serena's `find_referencing_symbols` requires both `name_path` and `relative_path` of the defining site, necessitating a two-step lookup from sampled positions.
  - For common identifier names, unconstrained expansion of all definitions returned by `find_symbol` would trigger tens of tool calls and multi-minute timeouts per position. Capping candidate definitions at K=3 is an operational necessity.
  - Truncation occurred on 33/150 positions in `self` and 7/150 positions in `mitt`. The adapter explicitly records `[candidates truncated: K/N expanded]` in raw output, and the caveat is documented in both §Position mapping and §Unfair/unsupported cases (point 3), as well as in the comparator descriptor caveats.
  - Fairness consequence: When a symbol's true definition ranks beyond K=3, references are missed (lowering recall); conversely, unioning references across up to 3 candidate definitions can introduce references belonging to unrelated homonyms (lowering precision). Both effects are inherent characteristics of name-based retrieval versus location-exact resolution and are documented as such.
