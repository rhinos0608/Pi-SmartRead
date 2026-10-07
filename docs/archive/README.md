# Archived Documentation

This directory holds historical SmartRead audits and planning documents that
describe prior tooling and design phases which no longer reflect the current
codebase.

**Archived as of:** 2026-08-14.

**What is archived here:**
- `audits/` — one-off audit/fix review documents from earlier development cycles.
- `plans/` — superseded implementation/redesign plans.
- Top-level `.md` design/research/implementation notes from `docs/` (retrieval,
  deep search, tool consolidation, meta-prompting, phase notes).

**Why archived:** the tools, modes, and architecture described in these files
have been consolidated or removed (e.g. `read_files`/`search`/`repo_map`/
`symbol`/`deep_search` were folded into `inspect`; query/symbol/action modes
were removed in favor of the `grep` tool). Keeping them next to current docs
created confusion about which behavior is live.

**Current normative reference:** `docs/parity/**` is the normative contract/spec
documentation. `docs/superpowers/**` is retained process history/reference and
is not a current contract. For runtime behavior, consult `AGENTS.md` and the
`docs/mcp-quickstart.md`.
