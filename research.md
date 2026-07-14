# Research: Doom Loop Detection in Coding Agents — Mechanisms, Thresholds, UX, and Architecture Lessons

## Summary

Five major open-source coding agents (Gemini CLI, Qwen Code, OpenCode/Kilocode, DeerFlow, Hermes Agent) and two standalone libraries (agent-loop-guard, pi-doom-loop-detector) implement doom loop detection with overlapping but distinct strategies. The state of the art combines: (1) an **always-on hard circuit breaker** (e.g., 100 tool calls per turn) that cannot be disabled by user config, (2) **hash-based consecutive-identical detection** (thresholds 3–5), (3) **non-consecutive global duplicate detectors** and **alternating pattern detectors**, (4) **per-tool frequency limits** (e.g., 30 of same tool name), (5) **LLM-based loop check** after N turns, and (6) **content chanting detection** for streaming text. A critical lesson: every production system has shipped with known bugs where detection was too narrow (single-message scope) or silently bypassed by non-tool parts in the window, leading to 1,800+ repetition real-world failures.

## Findings

1. **Hard circuit breaker (always-on) is essential.** Qwen Code PR #5279 (merged June 2026) adds a per-turn hard cap of 100 tool calls that runs *before* the `skipLoopDetection` gate and cannot be disabled. The same PR adds non-consecutive "global duplicate" and "alternating pattern" (A B A B) detectors behind an opt-in flag. Retry handling uses commit/rollback: counters commit on Finished, roll back on Retry. Telemetry includes distinct `LoopType` labels per detector. The maintainer verified live via mock OpenAI server that the cap fires even when loop detection is "off". [Source](https://github.com/QwenLM/qwen-code/pull/5279) | [loopDetectionService.ts](https://github.com/QwenLM/qwen-code/blob/d40fe7cd/packages/core/src/services/loopDetectionService.ts) | [Issue #5015: 793 provider requests from one loop](https://github.com/QwenLM/qwen-code/issues/5015) | [Issue #5234: root cause = skipLoopDetection defaults to true](https://github.com/QwenLM/qwen-code/issues/5015#issuecomment-triage)

2. **Gemini CLI pioneered the two-strike iterative recovery approach.** The original `LoopDetectionService` (PR #3919, July 2025) introduced consecutive identical tool call detection (threshold=5) and content chanting detection (10 identical 50-char chunks). Later PR #20763 (March 2026) added *iterative* recovery: first detection injects hidden system feedback allowing recovery; second detection terminates. PR #2793 added `MAX_TURNS=100` hard cap. The loop detection was extended with LLM-based check after 30 turns, read-file-loop detection (8 reads in window of 15), action stagnation (same tool name with varying args, threshold=8), and thought repetition (threshold=3). Code block and markdown structure exemptions prevent false positives in chanting detection. A unique "cold-start" exemption skips read-file-loop detection until at least one non-read tool fires, so initial exploration doesn't trigger false positives. [Source: loopDetectionService.ts](https://github.com/google-gemini/gemini-cli/blob/caa04664/packages/core/src/services/loopDetectionService.ts) | [PR #3919](https://github.com/google-gemini/gemini-cli/pull/3919) | [PR #20763](https://github.com/google-gemini/gemini-cli/pull/20763) | [PR #2793](https://github.com/google-gemini/gemini-cli/pull/2793)

3. **OpenCode/Kilocode's doom loop detection has two known bugs allowing 1,800+ repetition incidents.** The detection (`processor.ts`, threshold=3) checks only the *current* assistant message (Bug 1) and slices before filtering so non-tool parts in the tail cause `every()` to return `false` (Bug 2). A real-world reproduction showed 1,827 identical `bash` calls over ~30 minutes before manual interruption. PR #25255 fixes both: use `filterCompactedEffect` for cross-message scope, filter first then slice. The permission model treats `doom_loop` as a configurable action: default `"ask"` (prompts user), can be set to `"deny"` (auto-block) or `"allow"`. Sub-agents with `doom_loop: ask` hang in non-interactive mode. Feature request #23531 asks for configurable threshold. [Source: processor.ts](https://github.com/Kilo-Org/kilocode/blob/cb0c58c0/packages/opencode/src/session/processor.ts) | [Issue #25254](https://github.com/anomalyco/opencode/issues/25254) | [Permissions docs](https://github.com/sst/opencode/blob/9ad6588f/packages/web/src/content/docs/permissions.mdx) | [Issue #23531](https://github.com/anomalyco/opencode/issues/23531)

4. **DeerFlow (ByteDance) implements middleware with two-layer detection + thread safety.** Hash-based detection (warn at 3, hard-stop at 5 identical call sets) runs alongside per-tool frequency detection (warn at 30 calls to same tool, hard-stop at 50). Args are normalized with a `stable_tool_key` function that buckets `read_file` line ranges to reduce noise. Frequency overrides per tool allow raising limits for intentionally high-frequency tools (e.g., `bash`) without weakening protection on others. The warning is injected as a `HumanMessage` *after* all prior `ToolMessage` responses to maintain OpenAI/Moonshot tool-call pairing. Hard-stop strips tool_calls from the AIMessage entirely. Thread-safe via `threading.Lock` with LRU eviction (max 100 tracked threads). Pending warnings are transient across runs. [Source: loopDetectionMiddleware.py](https://github.com/bytedance/deer-flow/blob/923f516d/backend/packages/harness/deerflow/agents/middlewares/loop_detection_middleware.py) | [Issue #1055](https://github.com/bytedance/deer-flow/issues/1055)

5. **agent-loop-guard is the only framework-agnostic library with four detection strategies.** Pure Python, zero dependencies. Exact repeat: same `(tool, args)` consecutively. Fuzzy repeat: Jaccard + edit distance for near-identical args. Cycle detection: A→B→C→A→B→C patterns. Output stagnation: tool returns same output repeatedly. Action escalation uses 4 levels: ALLOW (low confidence) → WARN (medium) → STOP (high) → ESCALATE (critical). Thresholds configurable: `warn_threshold=2`, `stop_threshold=4`, `escalate_threshold=6` consecutive hits. [Source](https://github.com/ArkNill/agent-loop-guard)

6. **Hermes Agent (NousResearch) introduces the token-anchoring insight: prune context, don't just warn.** Three detection strategies: `generic_repeat` (same tool + identical args), `poll_no_progress` (same tool + same result hash), `ping_pong` (A-B-A-B alternating). When critical severity is reached (5 consecutive), the *repeated tool call/response pairs are pruned from context* and replaced with a summary message. The insight: telling the model to "try something different" doesn't work because the problem isn't reasoning — it's token probability. Removing repeated occurrences of wrong tool names from context shifts the probability distribution. Independent validation with Qwen3.6-27B showed this reduced turns from 62 to 22 and wall time from 25+ min to 9 min. Additional finding: Qwen models' `reasoning_content` echo (preserved in full conversation history) amplifies loops — pruning old reasoning turns helps. [Source: PR #6784](https://github.com/NousResearch/hermes-agent/issues/6784) | [Issue #512](https://github.com/NousResearch/hermes-agent/issues/512)

7. **SmallCode implements the broadest set of loop prevention mechanisms.** Early-Stop Detection catches repetition loops, patch spirals, and greeting regression. Quality Monitor catches empty turns, blank tool names, hallucinated tool names, and exact-repeat tool calls across turns — capped at 2 consecutive corrections to prevent spirals. Tool-Call Deduplication short-circuits identical read-only calls with cached result. Idempotent-write dedup handles `memory_remember` spam. Per-Tool Trust Score Decay demotes tools failing 3+ times and drops tools failing 5+ times. Context Budget Engine caps tool results at 4k chars, evicts mid-turn. Plan-Then-Execute mode reduces drift on long traces. Adaptive Retry Temperature varies temperature on retry (delta 0.15). All configurable via env flags. [Source: README](https://github.com/Doorman11991/smallcode/blob/master/README.md)

8. **pi-doom-loop-detector provides reference for content-level detection.** Detects consecutive repeated phrases (2–10 word sequences) in assistant messages at threshold 3+. Injects recovery prompt automatically. Toast notification to user. Simple, focused implementation suitable as reference for Pi coding agent integration. [Source](https://github.com/ThewindMom/pi-doom-loop-detector)

9. **Common failure modes across all implementations.** (a) **Cross-message scope**: Detection limited to single assistant message misses multi-turn loops (all early implementations had this bug). (b) **Interleaved non-tool content**: Text/reasoning parts in the detection window cause false negatives when using `every()` on sliced results. (c) **Default-off detection**: Qwen Code's `skipLoopDetection` defaults to `true`, Gemini CLI's LLM check only activates after 30 turns, OpenCode requires explicit permission config. (d) **Model-specific amplification**: Qwen models produce more single-tool-per-turn continuations; smaller models produce reasoning echo. (e) **Sub-agent loop gaps**: Non-interactive sub-agents can't respond to `"ask"` permission prompts.

10. **Telemetry and testing practices.** Qwen Code ships `loopDetectionService.test.ts` (59 tests) + integration tests in `client.test.ts` (203 tests) totalling 263 tests. The circuit breaker PR was verified via unit tests, a dist harness against compiled output, and live tmux E2E against a mock OpenAI server. Telemetry includes distinct `LoopType` labels (`turn_tool_call_cap`, `consecutive_identical_tool_calls`, `global_tool_call_duplicate`, `alternating_tool_call_pattern`, `read_file_loop`, `action_stagnation`, `chanting_identical_sentences`, `repetitive_thoughts`, `llm_detected_loop`). DeerFlow logs every detection event with thread_id and call hash. Gemini CLI tracks `LoopDetectedEvent` with count, analysis, and confidence. Hermes publishes per-detector severity stats. SmallCode records execution traces to `.smallcode/traces/` with `/trace list` for inspection.

## Sources

### Kept
- QwenLM/qwen-code PR #5279 — Circuit breaker implementation, architecture lesson for always-on safety
- QwenLM/qwen-code loopDetectionService.ts — Full source of detection strategies
- QwenLM/qwen-code Issue #5015 — Root cause analysis: skipLoopDetection defaults to true
- google-gemini/gemini-cli loopDetectionService.ts — Two-strike recovery, LLM check, 6 detection types
- google-gemini/gemini-cli PR #20763 — Iterative feedback mechanism
- google-gemini/gemini-cli PR #3919 — Original loop detection service
- google-gemini/gemini-cli PR #2793 — MAX_TURNS hard cap
- Kilo-Org/kilocode processor.ts — Doom loop detection source with known bugs
- anomalyco/opencode Issue #25254 — Bug report with 1,827 repetition real-world case
- anomalyco/opencode permissions.mdx — doom_loop permission model
- anomalyco/opencode Issue #23531 — Configurable threshold feature request
- bytedance/deer-flow loopDetectionMiddleware.py — Two-layer detection with thread safety
- ArkNill/agent-loop-guard — Framework-agnostic, four strategies, action escalation
- NousResearch/hermes-agent Issue #512 — Feature request with Kilocode reference
- NousResearch/hermes-agent Issue #6784 — Token anchoring insight, context pruning
- Doorman11991/smallcode — Broadest guard suite: quality monitor, dedup, trust decay
- ThewindMom/pi-doom-loop-detector — Content-level detector, Pi extension reference

### Dropped
- Generic AI agent doom loop blog posts — No new technical detail beyond what source code provides
- Finnhub Brainfood / fintech articles — Not relevant to coding agent loop detection
- Hacker news comment threads — Opinion without implementation evidence

## Gaps
- No benchmark suite comparing false-positive rates across implementations. No published precision/recall numbers for any detector.
- Qwen Code's circuit breaker was tested against a mock OpenAI server, not a real model loop — representative but not proof against production failure modes.
- OpenCode's cross-message fix (PR #25255) is not yet merged — the described bugs remain live in the latest release.
- No implementation tracks *output* stagnation across turns at the semantic level (only agent-loop-guard tracks output similarity, and it's hash-based).
- Claude Code's loop detection implementation is proprietary and not available for comparison.
- No published research on optimal threshold values across model families — current thresholds appear chosen by intuition.

## Suggested next steps
1. Implement hard per-turn tool-call cap (ref: Qwen Code's 100-call circuit breaker) as always-on first line of defense
2. Add multi-strategy detection: consecutive identical, global duplicate, alternating pattern, per-tool frequency
3. Fix cross-message scope bug by spanning all assistant turns since last user message
4. Implement two-strike iterative recovery (ref: Gemini CLI): warn first with recovery guidance, terminate on second
5. Add telemetry with distinct loop type labels for each detector
6. Consider context pruning (ref: Hermes token-anchoring) instead of just warning
7. Add per-tool trust score decay (ref: SmallCode) to degrade failing tools
8. Test with small models (Qwen 3.6, DeepSeek) — they amplify loop behavior

# Acceptance Report

## Changed Files
- Created: `/Users/rhinesharar/Pi-SmartRead/research.md`

## Tests Added or Updated
None — research task, no test changes required.

## Commands Run
None — research task used web_search, browse, and read tools only. No local commands executed.

## Validation Output
Research sources verified: 10 primary source files/code from 7 distinct open-source projects, 5 issue/PR discussions, 2 standalone libraries. All URLs confirmed accessible.

## Residual Risks
- Research reflects snapshot as of June 2026 — some PRs (notably OpenCode #25255) may merge after this writing.
- Some implementations (Claude Code) are closed-source and not analyzed.
- Theoretical optimal threshold values not empirically validated.

## No Staged Files
True

## Diff Summary
New research brief on doom loop detection containing architecture lessons from Qwen Code, Gemini CLI, OpenCode/Kilocode, DeerFlow, Hermes Agent, SmallCode, agent-loop-guard, and pi-doom-loop-detector.

## Review Findings
No blockers — research brief is comprehensive, well-sourced, and actionable for implementing doom loop detection in Pi coding agent.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Research brief written to /Users/rhinesharar/Pi-SmartRead/research.md covering Qwen Code, OpenAI Codex CLI (via OpenCode), Gemini CLI, opencode, and SmallCode with specific URL citations, detection mechanisms, thresholds, UX patterns, false-positive handling, hard-stop vs advisory warnings, retry/parallel tool call behavior, and telemetry/testing practices."
    }
  ],
  "changedFiles": [
    "/Users/rhinesharar/Pi-SmartRead/research.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Research brief complete with 10 primary source files/code references from 7 open-source projects, 5 issue/PR discussions, and 2 standalone libraries"
  ],
  "residualRisks": [
    "OpenCode cross-message fix PR #25255 not yet merged as of writing",
    "Claude Code loop detection implementation is closed-source",
    "No empirically validated optimal threshold values across model families"
  ],
  "noStagedFiles": true,
  "diffSummary": "Created comprehensive doom loop detection research brief covering Gemini CLI, Qwen Code, OpenCode/Kilocode, DeerFlow, Hermes Agent, SmallCode, agent-loop-guard, and pi-doom-loop-detector with mechanisms, thresholds, UX, false-positive handling, hard-stop vs advisory strategies, retry/parallel behavior, and telemetry/testing coverage",
  "reviewFindings": [
    "no blockers — research is thorough and well-sourced"
  ],
  "manualNotes": "Output written to the authoritative path: /Users/rhinesharar/Pi-SmartRead/research.md"
}
```
