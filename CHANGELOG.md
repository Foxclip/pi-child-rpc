# Changelog

## v0.4.0 — 2026-10-15

Hardening after a week of long unattended runs on a local 27B model (two of which
were falsely reported `completed`).

### supervisor.mjs
- **Degenerate-settle detection** (P0): a turn that settles with no text, no tool
  calls (thinking-only), or empty right after an external abort is no longer
  reported as `completed`. It is handled like an external abort: corrective
  prompt (L1 budget) → L2 fork → consult-park or exit 3 with
  `exitReason: "degenerate-settle"`. A post-abort settle is degenerate only if the
  model produced nothing at all in between.
- **Strict CLI** (P0): unknown `--flag` is now an error (exit 2) instead of being
  joined into the task text. At startup the supervisor echoes the resolved task
  (`[supervisor] task: N chars — "…"`) and warns when it is suspiciously short
  (< 100 chars).
- **`--expect-file <path>`** (repeatable) (P1): completion artifacts. On any
  settle, a missing expected file is handled like a degenerate settle
  (`exitReason: "missing-expected-file"`) — the supervisor no longer declares
  success while a required artifact is absent.
- **Progress log, always on** (P1): `pi-child-progress.log` in the working
  directory is written in every mode (previously only under `--watch`): one line
  per completed tool call plus `[start]`/`[settled]`/`[result]` summary lines.
  The parent's cheap status surface — no session-jsonl parsing needed.
- **`acp_delegate` excluded from the child's toolset by default** (P1) — a child's
  sub-agents would run outside the supervision ladder. `--keep-delegate-tool`
  retains it (mirrors `--keep-question-tool`).
- **RESULT JSON enrichment** (P1): `task` truncated to 200 chars + `taskChars`,
  `finalTextTruncated` (the 4000-char slice was previously unmarked),
  `settle: {attemptTextChars, attemptToolCalls, lastMessageTextChars,
  errorStreakAtEnd}`, `expectedFiles`, `progressLog`. The summary is also written
  as a `[result]` line in the progress log.

### rpc-child.mjs
- **Strict CLI**: unknown `--flag` is an error (exit 2) with the list of valid
  flags (same fix as the supervisor).

### Tests
- New static regression suite `scripts/test-supervisor.mjs` (no model needed):
  a fake `@earendil-works/pi-coding-agent` package scripted by a JSON spec covers
  9 scenarios — external abort → L2 fork → completed; stall → L2 fork; error
  loop → L1 steer; tool loop → L1 steer; degenerate empty stop → stuck
  (exit 3); normal completion; stray-tail non-degeneracy; `--expect-file`
  missing → steer → artifact → completed; unknown flag → usage error.
  `node scripts/test-supervisor.mjs` → 9/9.

### SKILL.md
- New **Task authoring** section: the contract every long task should carry —
  completion criteria + `--expect-file`, anti-loop rules, the durability rule
  (the transcript is not storage; ACP rebase physically deletes old messages —
  write credentials/artifacts to disk immediately, keep a STATUS.md),
  boundaries, no silent stops, budget awareness.
- New **Monitoring a long run** section (parent side): verify-on-launch (read
  the task echo line), one blocking wait instead of polling, progress log as the
  status surface, non-identical polls (the host's own repetitionGuard counts
  your monitoring calls), session-file rotation after L2 forks, Windows
  cp1251/MSYS-quoting gotchas.
