---
name: pi-supervisor
description: Spawn and interact with a second pi agent as a child process (RPC mode) for multi-turn agent-to-agent work. Use when a task needs a long-lived, isolated second pi — parallel work, a sub-conversation, or orchestrated follow-ups — that one-shot `pi --print` cannot cover. Also bundles supervisor.mjs for unattended long runs (loop/stall/degenerate-settle detection, steer/fork/stuck ladder, --expect-file completion artifacts, always-on progress log), a Docker 3-layer setup (scripts/docker/hypervisor.mjs) that runs supervisor and child in a container with the model on the host, a low-integrity sandbox variant (scripts/integrity/hypervisor.mjs) for admin-free native-Windows sandboxing via Mandatory Integrity Control (no Docker, no UAC prompt), and a dedicated-user variant (scripts/user/hypervisor.mjs) that runs the child as a confined local Windows account (real NTFS-ACL boundary, in-place project access) over loopback SSH.
---

# Interacting with a child pi process

A pi agent can spawn and converse with another pi agent. It is not limited to `acp_delegate` subagents. Pick the lightest interface that fits:

| Need | Interface | How |
|---|---|---|
| One-shot task, final text is enough | Print mode | `pi --print "task"` (plain bash) |
| One-shot, structured events | JSON mode | `pi --mode json "task"` |
| Multi-turn, bidirectional | **RPC mode** | `scripts/rpc-child.mjs` in this skill, or a custom `RpcClient` script |
| One long autonomous job, unattended | **Supervised RPC** | `scripts/supervisor.mjs` (loop/stall detection + steer→fork→stuck ladder) |
| One long autonomous job, sandboxed in a container | **Docker 3-layer** | `scripts/docker/hypervisor.mjs` (host) → supervisor + child in the container |
| One long autonomous job, sandboxed without Docker/admin | **Low-IL sandbox** | `scripts/integrity/hypervisor.mjs` (native Windows, no UAC prompt) |
| One long autonomous job, confined real account, in-place project | **Dedicated user** | `scripts/user/hypervisor.mjs` (loopback SSH to a confined local Windows account) |
| In-process Node/Bun, full API | SDK | `createAgentSession()` from `@earendil-works/pi-coding-agent` |

If the child's job is fire-and-forget with no ongoing dialogue, `acp_delegate` is usually better: clean context, async, result saved to a file.

## Quickstart (bundled harness)

Run `scripts/rpc-child.mjs` (relative to this skill directory) **from the directory the child should work in** — the child inherits that cwd.

```bash
# One-shot
node scripts/rpc-child.mjs "Explain this repository in one paragraph"

# Multi-turn: each --turn is sent only after the previous child reply settles
node scripts/rpc-child.mjs \
  --turn "Introduce yourself and ask me one short question" \
  --turn "Now answer your own question in one sentence; end with FINISHED"
```

Output: the child's live streamed text, then `[reply-N]` blocks, then a final machine-readable line —

```
=== RESULT === {"replies":["...", "..."]}
```

Parse that line for programmatic use. Exit code is non-zero on timeout or child failure. Options: `--provider`, `--model`, `--timeout <ms>`, `--keep-question-tool`, `--session-id <id>`, `--session <path|id>`, `--session-dir <dir>`, `--name <name>`, `--help`.

## Session persistence and resuming

By default the harness runs the child with `--no-session` — throwaway. Nothing is saved, so there is nothing to resume. To make a job resumable, persist the session under a stable ID, and reuse that ID (from the same working directory) in later runs:

```bash
# run 1 — creates the session
node scripts/rpc-child.mjs --session-id my-job --name "my-job" --turn "step 1..."

# run 2 — later, e.g. after a timeout or crash: continues the conversation
node scripts/rpc-child.mjs --session-id my-job --turn "continue; do step 2..."
```

Every run prints the resolved session to stderr (`[info] session id=... file=...`). Resumed turns are appended to the same transcript, so the child sees all earlier turns. `--session-id` creates the session if missing, so runs 1 and 2 use the same code path.
To resume a session created elsewhere (e.g. a TUI run), pass its file or exact ID instead:

```bash
node scripts/rpc-child.mjs --session <path-or-exact-id> --turn "..."
```

- Sessions are stored per-project: under `~/.pi/agent/sessions/`, grouped by working directory (override with `--session-dir <dir>`). The same `--session-id` from a *different cwd* silently creates a fresh session in that project.
- `--session` with a partial ID may open the interactive session picker, which blocks forever in RPC mode (there is no TUI). Pass the full path or full ID — from the `[info] session ...` line, or via `pi --resume` in a normal terminal.
- Don't point a child at a session that is open in another running pi (e.g. this session's own file) — two writers on one transcript. `pi --fork <id>` makes a branch you can hand to a child instead.
- Runtime alternative in a custom client: `client.switchSession(path)` / `client.newSession()` load a different session into an already-running child (`docs/rpc-commands.md`).

## Critical gotchas (learned the hard way — do not skip)

1. **The child does NOT inherit the parent session's model.** A bare child uses the *configured default* model. For local providers (llama.cpp) that means loading a different GGUF — very slow, or failing. Fix: pass `--provider`/`--model`; the harness auto-inherits the parent session's `PI_PROVIDER`/`PI_MODEL` env vars, which is why it "just works" inside a pi session.
2. **`RpcClient.promptAndWait` defaults to a 60-second timeout.** Slow local models exceed this. Always pass an explicit per-turn timeout (harness default: 5 min; `--timeout <ms>`). If a turn may exceed even that, see **Long-running work** below.
3. **Dialog tools hang the child.** `ask_user_question` (and similar extension-UI dialog tools) make the child emit an `extension_ui_request` on stdout and block until the client sends back a matching `extension_ui_response` on stdin. The harness excludes `ask_user_question` by default (`--keep-question-tool` retains it — then your client MUST answer dialogs per the RPC extension-UI protocol). The supervisor additionally excludes `acp_delegate` from the child's toolset by default (v0.4.0) — a child's sub-agents would run outside the supervision ladder (`--keep-delegate-tool` retains it).
4. **The child has zero context from the parent conversation.** Every prompt must be self-contained: include file paths, constraints, and everything the child needs — the same rule as writing `acp_delegate` tasks.
5. **`agent_end` ≠ done.** Retries, compaction, or queued work can follow `agent_end`; wait for `agent_settled` (the harness does this via `promptAndWait`).
6. **The child's stdout is the protocol.** Diagnostics belong on stderr; never write non-protocol data to the child's stdin/stdout.
7. **Windows/Node**: the child needs the pi CLI entry `dist/bundle/cli.js` of the installed package (the package `bin`), not `dist/cli.js` from a repo checkout. The harness resolves the global install automatically (`PI_PACKAGE_DIR` env overrides).
8. **Sessions are per-project.** The same `--session-id` resolves only in the same working directory (sessions live under `~/.pi/agent/sessions`, grouped by cwd). Resuming from a different cwd silently starts a fresh session. `--session`/`--session-id` must reference an exact ID or path — partial IDs may open the interactive picker, which blocks forever in RPC mode.

## Long-running work (when a turn exceeds the timeout)

The timeout is **client-side, wall-clock, per turn**. When it fires, `promptAndWait` rejects with `Timeout collecting events`, the harness exits non-zero, and `client.stop()` closes the child's stdin — an **orderly shutdown**: the child aborts the in-flight turn and exits (no orphan process). **No rollback**: tool side effects already completed stay on disk; the partial turn is lost, and with `--no-session` there is no transcript to resume it. Completed earlier turns remain in the output (`[reply-N]` blocks; the exit code marks the failure).

Mitigations:

1. **Raise it**: `--timeout 3600000` (1 h). It is a hard wall-clock deadline, so size it to the job.
2. **Decompose into more, smaller turns** — the interactive advantage: the parent reads each `[reply-N]`/`RESULT` line and sends the next step, so every turn gets its own budget and you can react mid-job instead of blind-waiting on one long prompt.
3. **Custom client with an idle-based timeout** — the built-in deadline is wall-clock from prompt send, so a legitimate long tool run plus a long generation can trip it even though nothing is wrong. In a custom `RpcClient` script, reset the deadline on every incoming event (text deltas, `tool_execution_start`/`update`, `bash_execution_update`): an actively working child keeps emitting events; only a genuinely hung child (e.g. stalled provider, unanswered dialog) goes silent.
4. **Persist the child's session** for long jobs — pass `--session-id <id>` (plus `--name`) so a timed-out or aborted job can be *resumed* in a fresh child instead of restarted from scratch: same ID, same cwd, next turn continues the conversation (see **Session persistence and resuming**).

## Supervised autonomous runs (supervisor.mjs)

For **one long autonomous job** (one task, many turns, runs unattended), use `scripts/supervisor.mjs` instead of one giant `--turn`. It runs the child and supervises it against the failure modes that kill long jobs:

- **Tool-call loops.** The ACP context layer (the `billion-context-pi` package) runs a `repetitionGuard` (issue #308; `acp.json` key `repetitionGuard`; defaults warn=3, abort=5, counter **per session**) that refuses the 5th consecutive byte-identical tool call and **aborts the turn**. The supervisor detects the loop itself — consecutive identical tool+args in `tool_execution_start` events — and escalates:
  1. **L1 steer** (default budget `--max-steers 3`): inject a corrective message via `steer()` — the programmatic "please continue, different approach".
  2. **L2 fork+retry** (default budget `--max-forks 2`): abort + `fork(before the task message)` + re-prompt with a "that approach is exhausted" note. A fork is a **new session file** — loop history discarded, and the guard's per-session counter starts clean.
  3. **L3 give up**: `RESULT status=stuck`, exit 3.
- **Stalls** (no events at all): `--idle-timeout` (default 300 s while the model thinks) or `--tool-timeout` (default 1800 s while one tool call is running — long builds are normal) → straight to L2; a steer cannot reach a hung LLM call.
- **External aborts** (the guard firing at 5, or any host-side abort of the turn) are treated as recoverable: straight to L2 while fork budget remains.
- **Degenerate settles** (v0.4.0) — the model can end a turn *without acting*: thinking-only (no text, no tool call), empty text, or a settle right after an external abort with nothing produced in between. Before v0.4.0 these were reported as `completed` — a 3.8-hour run that spent its whole budget hunting a now-unrecoverable transcript secret, and a run whose task was a 27-char CLI artifact, both "completed" this way. Now the supervisor inspects every settle: a degenerate settle is handled like an external abort (corrective prompt on L1 budget → L2 fork → consult-park or `exitReason=degenerate-settle`, exit 3). A settle right after an external abort is degenerate only if the model produced nothing at all in between (a short, deliberate stop that follows an abort is a normal stop).
- **Missing completion artifacts** (`--expect-file <path>`, repeatable, v0.4.0): the supervisor has no notion of "done" beyond "the model stopped talking". On any settle, a missing expected file is handled exactly like a degenerate settle (`exitReason=missing-expected-file`) — the supervisor does not declare success while a required artifact is absent.
- **Consult mode** (`--consult`) — intelligent steering by the parent session: instead of firing L1/L2 with built-in messages, the supervisor **pauses at the intervention point**. It persists the session, writes `pi-child-consult.json` (trigger, loop stats, open + last 15 completed tool calls, last assistant text, budgets, session id/file) and exits **4** with `RESULT status=consult, consultFile=...`. The child is shut down orderly (in-flight turn aborted; completed side effects stay on disk). The parent then reads the payload and re-invokes:
  ```bash
  node scripts/supervisor.mjs --consult-file pi-child-consult.json --action steer|fork|continue --message "your steering instruction"
  ```
  `steer` = send your message into the same session, in place. `fork` = branch before the task message and re-prompt task + your message (new session file, fresh guard counter — like L2, but with your note). `continue` = resume with the built-in ladder for the rest of the run. Budgets, attempt count and the hard wall clock carry across resumes (they come from the consult file, not flags). The consult file is **overwritten at each intervention** — always resume the latest one. While the child is parked, it is not running: no CPU/model cost, but also no progress.
- **Extended sensors**. The built-in detectors cover *known* failure shapes; these widen the net. `error-loop`, `text-loop` and `stagnation` run in **both** modes: in consult mode a hit parks the run for the parent, in autonomous mode they run the normal ladder (steer once, then fork per budget). `heartbeat` is consult-only (parking for a parent review is meaningless unattended):
  - `error-loop` — `--max-errors <n>` (default **6**, 0 disables): N consecutive *failing* tool calls of any kind. Catches thrashing the identical-loop detector misses (different calls, all failing).
  - `heartbeat` — `--heartbeat <n>` (default 0 = off): after every N completed tool calls, the supervisor parks and hands you the trace for a progress review. The payload carries the recent tool calls (args, truncated results, errors, durations) plus the child's last text, so you can judge drift, wasted work, or anything a fixed detector cannot name. Each heartbeat = one parent turn + child restart (it re-reads its transcript), so keep N large.
  - `text-loop` — `--max-text <n>` (default **20000** chars, 0 disables): an assistant message longer than N characters *without a tool call*. This is the "thinking loop" — the model keeps appending words to the same message. It is invisible to every other sensor: the child emits text deltas continuously, so the stall detector sees a healthy, busy child, and there are no tool calls for the loop/error/heartbeat detectors to key on. Without this sensor, only the hard wall clock stops the run — and that is terminal (`stuck`, exit 3). In consult mode the payload's `lastAssistantText` shows you the ramble (steer or fork); in autonomous mode the ladder steers the child back on task, then forks per budget.
  - `stagnation` — `--stagnation <n>` (default **0 = off**): N consecutive tool calls that returned **no usable content** — empty output, `killed`, `timed out`, HTTP 4xx/5xx, permission denied. These calls *succeed* (exit 0), so `error-loop` never sees them; this is the shape probe-heavy tasks die in (a 2026-10-16 run made 124 calls, most returning "killed at 270 s" or HTTP 400, and no failure sensor ever fired). Marked calls carry `noContent: true` in `recentToolCalls`.
- **Deadline awareness and finalization** (v0.10.0): the child is told the hard deadline in the initial prompt (`[supervisor] HARD DEADLINE: ...`), a `BUDGET WARNING` is sent at 90% of the budget ("do not start new work items; write your final report now"), and the wall-clock expiry does NOT kill the run while `--finalize <min>` is enabled (default **10**, `0` = the old immediate kill): the supervisor enters a **finalization window** — one prompt ("STOP all new work, write the final report NOW"), up to N minutes waiting for a settle with the ladder suppressed. A settle with a report → `exitReason=completed-finalized` (status `completed`, exit 0); nothing usable → `hard-timeout` (exit 3). This turns a hard timeout from "no artifact" into "partial report" — a 4-hour run killed mid-probe was recovered in ~5 minutes instead of ~1 hour of forensics.
- **Parent-authored ladder messages** (no consult needed): `--steer-msg "<text>"` and `--fork-note "<text>"` fully replace the built-in L1/L2 messages (variables `{tool}`, `{count}` / `{reason}`). Use for task-specific guidance — the parent wrote the task, so it knows which failure modes to warn about (e.g. "the registry is blocked; use the local cache").
- **Progress log, always on** (v0.4.0): `pi-child-progress.log` in the working directory is written in every mode — one line per completed tool call, plus `[start]`/`[settled]`/`[result]` summary lines. It is the cheap status surface for a parent that wants to peek without parsing a 20 MB session jsonl (see **Monitoring a long run**).
- **Live status file, always on** (v0.11.0): `pi-child-status.json` in the working directory, rewritten on every completed tool call and every state transition (start/steer/fork/consult/result/error): `{status, exitReason, attempt, toolCalls, lastTool, lastToolStartedAt, elapsedMs, sessionId, sessionFile, expectedFiles}`. The machine-readable half of the progress log — a monitoring loop is one read + JSON.parse, and the `expectedFiles` map answers "is the artifact there yet?" without an `ls`.
- **Task from a file** (`--task-file <path>`, v0.11.0): long tasks belong in a file — no shell quoting, no truncation. The whole file (BOM/whitespace-trimmed) becomes the task; mutually exclusive with a positional/`--task` task. A task that happens to be an existing file path (the classic "I passed the path, not the text" bug — it cost a 2026-10-17 run a wasted discovery step) now gets an explicit `did you mean --task-file?` warning.
- **Strict CLI** (v0.4.0): an unknown `--flag` is an error (exit 2). Unknown flags used to be joined into the task text — a typo'd flag became the child's *entire* task. At startup the supervisor echoes the resolved task (`[supervisor] task: N chars — "..."`) and warns when it is suspiciously short (< 100 chars). `rpc-child.mjs` rejects unknown flags the same way.

```bash
node <skill_dir>/scripts/supervisor.mjs "Refactor module X to use Y; verify with the test suite"
```

- **Persists the session by default** (auto `--session-id sup-<timestamp>`, `--name` = the ID) so runs stay resumable. Every L2 fork creates a NEW session file — the RESULT line reports the **final** session (`sessionId`/`sessionFile`); resume THAT file with `rpc-child.mjs --session <file>` to continue or debug. `--no-session` for throwaway.
- RESULT JSON: `{status: "completed"|"stuck"|"consult", exitReason: completed|completed-finalized|hard-timeout|stuck-loop|stuck-idle|aborted-external|degenerate-settle|missing-expected-file|stuck-stagnation|consult-loop|consult-stall|consult-external-abort|consult-error-loop|consult-heartbeat|consult-text-loop|consult-stagnation, task (≤200 chars) + taskChars, attempts, interventions: {steers, forks, loopsSeen}, sessionId, sessionFile, finalText (≤4000 chars) + finalTextTruncated, settle: {attemptTextChars, attemptToolCalls, lastMessageTextChars, errorStreakAtEnd}, expectedFiles (when given), progressLog, elapsedMs, recentToolCalls (last 15: {tool, args, isError, result≤300, durationMs, noContent?}), deadline (ISO), finalized (when the timeout was absorbed by the finalization window), manifest (path), consultFile/trigger/allowedActions (status=consult only)}`. The same summary is also written as a `[result]` line in the progress log, and the same payload + `cwd/provider/model/startedAt/finishedAt` is **always written to `pi-child-result.json` in the working directory** (the `manifest` field) — a stable small file the parent reads instead of digging the RESULT line out of a multi-hundred-KB log. Exit codes: 0 completed (incl. `completed-finalized`), 3 stuck, **4 consult** (waiting on the parent's resume), 1 error, 2 usage (including an unknown `--flag`).
- Tuning: `--loop-threshold` (default **4** — one below the guard's default abort=5 so the steer lands first), `--max-steers`, `--max-forks`, `--idle-timeout`, `--tool-timeout`, `--timeout <min>` (hard wall clock, default 240; `0` = no wall clock / unlimited), `--finalize <min>` (finalization window at the wall clock, default 10, 0=off), `--expect-file <path>` (repeatable), `--keep-delegate-tool`, sensors (`--max-errors`, `--heartbeat`, `--max-text`, `--stagnation`), steering (`--consult`, `--consult-file`, `--action`, `--message`, `--steer-msg`, `--fork-note`), plus all harness session/model flags (`--provider`, `--model`, `--session-id`, `--session`, `--session-dir`, `--name`).
- If you run with a custom `repetitionGuard` config, set `--loop-threshold` one below its `abort` value so L1 always wins the race.

### Task authoring (what a good long task contains)

Start from `task-template.md` in this skill directory — a fill-in-the-blanks contract that encodes the rules below.

A long autonomous task is a *contract*, not a suggestion. Every failure in this skill's history traced back to a missing piece of the contract:

1. **Goal + explicit completion criteria.** Name the files the task must produce, and pass them as `--expect-file` so a "settled" turn is not accepted while they are missing.
2. **Anti-loop rules.** "Max 3 attempts per approach; no cosmetic re-runs of a failing command (re-running it with `| head -N` or a reworded variant counts as the same attempt); if an approach is exhausted, log it and move to the next." This keeps the model just inside the repetitionGuard's threshold — a 6h48m run with zero interventions used exactly this preamble.
3. **Durability rule — the transcript is NOT storage.** ACP compression can physically delete old transcript messages (rebase), so anything that must survive (credentials, artifacts, intermediate findings) has to be written to disk *immediately*: "write the credentials to `data/creds.txt` FIRST, before continuing". A VK password that existed only in the transcript was unrecoverable after a rebase, and a 3.8-hour run was lost re-hunting it. Keep a `STATUS.md` (or notes file) updated at milestones — it is what makes a resumed or forked run start with context instead of amnesia.
4. **Boundaries.** "Do not use `acp_delegate`" (excluded by default anyway), "no new dependencies", and the paths of everything the child needs — it has zero context from your conversation.
5. **No silent stops.** "End with a written status update (what is done, what is blocked and why, what remains) — never stop with only internal thinking." Degenerate settles are now caught by the supervisor, but the contract makes the child avoid them in the first place.
6. **Budget awareness.** The supervisor injects the hard deadline into the initial prompt and sends a BUDGET WARNING at 90% of the budget (v0.10.0), but state *per-item* timeboxes in the task ("each candidate: max ~15 min including retries") — the deadline is global; per-item pacing is yours to give.
7. **Incremental artifacts.** Make the child append a one-line result to a results file *immediately after each sub-item* (in addition to the final report, passed as `--expect-file`). A partial results file survives a timeout or crash; a report-only-at-end does not.

### Monitoring a long run (parent side)

- **Verify on launch, before walking away.** The first `[supervisor] task: N chars — "..."` line in the log is the task the child *actually received*. Read it. A typo'd `--flag` (now exit 2) or a truncated task used to become the child's entire task, and the run would "complete" doing nothing in 6 minutes.
- **One blocking wait, not polling.** For a run with a known budget, run the supervisor in the **foreground of a single bash call** with the call's timeout matched to the budget; the call returns exactly at run end and the last line of the log is the RESULT JSON. Mid-run status comes from the progress log, not from re-running anything.
- **The progress log is the status surface.** `pi-child-progress.log` (path in the `[start]` line and in RESULT's `progressLog`): one line per completed tool call plus `[settled]`/`[result]` summary lines. A peek is a `tail` on a small file — no 20 MB session-jsonl parsing, no custom scripts.
- **The result manifest is the exit surface.** `pi-child-result.json` in the working directory (always written, every outcome including consult/stuck): the full RESULT payload + run metadata. At the end of a run, read this one small file, not the log.
- **Multi-hour runs: `--consult --heartbeat <N>` for structured monitoring.** Instead of ad-hoc log tailing, the supervisor parks every N completed tool calls and hands you the recent trace (the payload includes the last tool calls with args/results + the child's last text). Each heartbeat = one parent turn + child restart (it re-reads its transcript), so keep N large (≥30; much larger on slow local models).
- **Polls must be non-identical.** The ACP host's own `repetitionGuard` (warn=3/abort=5, per session, byte-identical calls) counts *your* monitoring calls too — an unchanging `tail -n 20 file` poll will trip it. Vary the call each time (a changing offset, a `--since <last-line>` argument, or append the poll timestamp to the command).
- **The session file rotates after an L2 fork.** Anything keyed to one session-file path goes blind after a fork. Follow `sessionId`/`sessionFile` in the RESULT (or the consult file), or just watch the progress log — it is cwd-relative and stable.
- **Windows gotchas** (this skill was developed under them): the console codepage is cp1251 — any script that prints Cyrillic must set `PYTHONIOENCODING=utf-8` and reconfigure stdout with `errors="replace"`, or it crashes on the first non-Latin character. MSYS bash expands `$_`/`$()` inside double-quoted `powershell -Command "..."` — write a `.ps1`/`.py` file and run it with `-File`/`python <file>` instead. Host safety rules may block inline one-liners for the same reason.
- **After a hard-timeout or stuck exit**, capture "what remains" from the child's STATUS.md *before* relaunching: the resume (same session file, fresh supervisor run) then starts with a precise remainder list instead of re-deriving state. With `--finalize` (v0.10.0) the child usually wrote its own partial report first — check `pi-child-result.json` → `finalText` / the expect-file before doing anything else.

## Multi-hour run playbook (host side)

Field lessons from real long runs — including a 240-minute run on a ~0.5 tok/s local model that was killed mid-probe with no report and had to be reconstructed from logs afterwards.

**Preflight (host side, before launch — cheap checks the child cannot do for you):**
- Verify every external package/model/credential the task references *by name* (`npm view <pkg> version`, endpoint model list). A 2026-10-16 run lost 30+ minutes to discovering that 4 of 6 candidate package names were 404s on npm.
- Declare vision if the task needs it (all variants; v0.11.0 user, v0.11.1 docker + integrity): `--model-input text,image` writes the modalities into the child's models.json. Without it pi's default declaration applies — a text-only default means the child CANNOT be fed images even when the server supports them, and nothing warns about it. Verify what landed: user variant → `.pi-child-env.json` (project dir, see After the run); docker/integrity → the `input=…` field of the `agent config` line in `pi-child-hypervisor.log`.
- Measure the model: the hypervisors all run a preflight latency probe and log tok/s (`--skip-latency` to skip). Then budget: Σ(per-item timebox) ≤ `--timeout`. A run where N items × T min > the hard timeout is mathematically doomed before launch — reduce N, raise `--timeout`, or split the run.
- Verify the child's toolchain deps (ffmpeg, venvs, writable temp dirs — see child-environment gotchas below).

**Task contract (beyond the authoring rules above):**
- Incremental artifacts: one line per sub-item to a results file immediately (`--expect-file` for the final report).
- Give the child an *environment-failure policy*: "if a tool returns no usable content three times in a row, record the finding and move on" (the `--stagnation` sensor steers it there if it doesn't).

**Monitoring:** end of run → `pi-child-result.json` (manifest) + the expected artifacts; mid-run → `pi-child-status.json` (one small JSON, updated per tool call) and the progress log (non-identical polls); long runs → `--consult --heartbeat` (above).

**Compression hygiene (ACP hosts):** when compressing conversation around a run, record the *exact* artifact paths (project dir, log files, report file) in the summary, verbatim. A paraphrased path cost an hour of artifact hunting in the 2026-10-16 post-mortem.

**Child-environment gotchas (field-found; user variant / PS 5.1 child):**
- `Set-Location` into the project can fail for the child — write the task with absolute paths.
- Extensions that stage files in `%TEMP%` (e.g. video transcodes) fail with Permission denied: the agent cannot write its own TEMP under the user-variant DACLs. Redirect first: `$env:TMP = "<project>\tmp"`.
- A `parallel=1` llama.cpp server *queues* a new request while a killed probe client's request is still generating — the next probe "hangs" for the rest of the queued generation. Drain/wait before the next probe.

**After the run:**
- Read `.pi-child-env.json` (project dir; written by the user-variant runner at launch, v0.11.0) — the host's window into the child-side environment the profile DACLs hide: pi path/version, ffmpeg, TEMP, node, installed packages (including orphans `pi list` does not show), and the model input modalities that were requested.
- Check `pi-child-profile-delta.txt` (user variant) for packages the child installed into its persistent profile; clean leftovers before the next run (a 2026-10-16 run silently left two video extensions on the account profile).
- `pi-child-final.txt` (user variant) holds the child's FULL final message (`RESULT.finalText` is truncated to 4000 chars).

## Docker 3-layer run (hypervisor.mjs)

To run a long autonomous job **inside a container** — sandboxed filesystem, throwaway state, model served from the host — use the 3-layer setup:

```
host:      hypervisor.mjs   config generation, model forwarder, health checks,
                            image build, container lifecycle, no-progress
                            backstop, RESULT collection
container: supervisor.mjs (unchanged) → child pi --mode rpc → model
```

This is the Docker **variant** of the skill. The host variant (supervisor +
child both on the host, no Docker) is `supervisor.mjs` directly — the two are
alternatives, and all supervisor options work identically in both.

Why 3 layers: the in-container supervisor owns the tight agent-behavior loop
(loop/steer/fork — forks stay cheap because they are local process spawns with
local session files). The container boundary creates a failure domain it cannot
see: the host model server / forwarder can die, and the container itself can
wedge. Only a host-side layer can see and heal those. Each layer recovers what
it can see cheaply and escalates the rest.

### Usage

```bash
node <skill_dir>/scripts/docker/hypervisor.mjs "long autonomous task" [options]
```

Run it from the directory the child should work in (that is `--workdir`,
mounted at `/work`). The hypervisor then: generates the container's agent
config under `<workdir>/.pi-docker/agent/` (models.json + auth.json; session
files created later land there too), builds the image `pi-supervisor:docker`
if missing (bundled `scripts/docker/Dockerfile`: node + global pi install;
skill scripts are bind-mounted at `/opt/pi-supervisor` so skill updates never
require an image rebuild), starts the host model forwarder, health-checks the
model endpoint, launches the container, and watches it.

**The reserved-id gotcha (cost of hours to find, so it is enforced):** in pi
v1.2.0 the provider id `llama.cpp` is RESERVED — a built-in router integration
whose model list comes from the router's *currently loaded* models. A
models.json entry under that id collides with it: `pi --list-models` shows
"No models available" **even though auth reports ready** (the key is read
fine). The hypervisor therefore registers the endpoint under a **non-reserved
id** (default `localllama`, or `$PI_PROVIDER` when it is non-reserved), and
**refuses `--provider llama.cpp`** (exit 2). A reserved `$PI_PROVIDER`
(`llama.cpp`) is silently swapped to `localllama` with a stderr note.

### Flags

All supervisor options pass through unchanged: `--task --session-id --session
--no-session --session-dir --name --provider --model --loop-threshold
--max-steers --max-forks --steer-msg --fork-note --consult --consult-file
--action --message --max-errors --heartbeat --max-text --stagnation
--idle-timeout --tool-timeout --timeout --finalize --progress-log
--expect-file --preamble --keep-question-tool --keep-delegate-tool`. (A task may be positional or via
`--task`; a task beginning with `--` goes after a bare `--`.)

Hypervisor-only:

| Flag | Default | Meaning |
|---|---|---|
| `--image <name>` | `pi-supervisor:docker` | container image; built from the bundled Dockerfile if missing |
| `--docker <cmd>` | `docker` | container runtime command |
| `--workdir <dir>` | cwd | host dir mounted at `/work`; child works there |
| `--model-base-url <u>` | `http://host.docker.internal:8081/v1` | model URL **from the container** |
| `--provider <p>` | `$PI_PROVIDER` or `localllama` | non-reserved provider id (see gotcha above) |
| `--model <m>` | `$PI_MODEL` | model id |
| `--api-key <key>` | provider id | key written for the endpoint (local servers ignore it) |
| `--context-window <n>` | `262144` | declared context window and max output |
| `--model-input <csv>` | pi's default declaration | input modalities written into the model entry (text,image,audio,video) — declare vision or the child is silently text-only |
| `--forward-from <port>` | `8081` | host port of the model forwarder |
| `--forward-to <h:p>` | `127.0.0.1:8080` | host target the forwarder pipes to |
| `--no-forward` | off | skip the forwarder (model already reachable from the container) |
| `--skip-health` | off | skip model health checks (e.g. model lives in the container) |
| `--skip-latency` | off | skip the preflight latency probe (timed 16-token completion; logs tok/s — probes the host-side URL, i.e. the forwarder path the container also traverses) |
| `--restarts <n>` | `1` | container restarts on infrastructure failure |
| `--no-progress <sec>` | `2700` | kill+restart after this much total silence in the progress log; `0` disables. Must exceed the supervisor's `--tool-timeout` — a single long tool call is legitimate silence |
| `--keep-container` | off | do not `--rm` the container on exit |
| `--log <path>` | `pi-child-hypervisor.log` in workdir | hypervisor log |

### Monitoring (host side)

Two logs, both on the host in the workdir:

- `pi-child-hypervisor.log` — lifecycle: config written, image/forwarder state,
  health, the exact `docker run` command, model-down warnings, restarts,
  final status.
- `pi-child-progress.log` — child activity (written by the in-container
  supervisor: `[start]`, one line per tool call, `[settled]`, `[result]`).

Poll the progress log for liveness (same non-identical-polls rule as host
runs). The hypervisor re-checks the model server every 30 s; a model outage is
logged as `WARNING model server unreachable ... — the child will stall`, and
once the `--no-progress` window elapses with no progress the container is
killed and — if the model is reachable again and restart budget remains — a
fresh container is launched (fresh auto session id).

### Exit codes and restarts

The hypervisor propagates the supervisor's exit codes (0 completed, 3 stuck,
4 consult) and exits 1 on infrastructure failure / 2 on usage. **Task-level
outcomes (0/3/4) never restart**; error (1) and no-progress kills restart a
fresh container only when the model server is reachable at that moment (up to
`--restarts`). The final line is `=== HYPERVISOR RESULT === {json}` with
`status`, `exitCode`, `attempts`, `elapsedMs`, `workdir`, `progressLog`,
`sessionFile` (container path) + `sessionFileHost` (host path), and the full
supervisor `result` nested.

Consult resume works unchanged: the consult file lands at
`<workdir>/pi-child-consult.json`, and re-running the hypervisor with
`--consult-file pi-child-consult.json --action steer|fork|continue --message
"..."` resumes in a new container (budgets carry over as usual; session files
live under `<workdir>/.pi-docker/agent/sessions/`).

### Windows notes

The hypervisor is a plain node script (no shell involved), so MSYS
path-mangling does not apply. Bind mounts are used for the workdir and the
skill scripts dir (read-only at `/opt/pi-supervisor`).

## Low-integrity sandbox (integrity variant — no admin, no Docker)

Runs supervisor + child pi **natively on Windows** inside a **Low integrity**
process tree (Mandatory Integrity Control, `S-1-16-4096`). The child pi can
write wherever it likes *except* the sandbox directories the hypervisor
created: user profile, HKCU registry, Program Files and all system locations
are write-protected. No admin, no elevation, no UAC prompt, no Docker,
no Hyper-V — the downgrade is a plain `SetTokenInformation` on the process's
own token, which Windows allows without any privilege.

**Architecture (3 layers, all on this host):**

```
Medium-IL hypervisor  scripts/integrity/hypervisor.mjs (node)
  |- creates <base>/{work,home,temp} and icacls's them (OI)(CI)Low
  |    [must happen while still Medium: a Low process cannot create
  |     directories in Medium-IL parents]
  |- generates the child's agent config (<home>/.pi/models.json,
  |    openai-completions -> --model-base-url; settings.json pins the
  |    bash tool's shellPath to PowerShell — see Windows-development note)
  |- health-checks the model endpoint (GET .../v1/models)
  |- [optional] copies --src project files into work/
  `- spawn-low.ps1  (self-downgrades the token to Low)
       `- node supervisor.mjs   (supervisor + child pi at Low IL, cwd = work,
          isolated HOME/USERPROFILE/TEMP under <base>\home)
```

No model forwarder is needed: the child is on this host, so
`--model-base-url` points straight at the model server (default
`http://127.0.0.1:8080/v1`) — no port remapping like the Docker variant.

**Protection matrix (verified by `--selftest`):**
- child writes to user profile, HKCU registry, system dirs → **DENIED**
- child writes into the sandbox work/home/temp dirs → allowed
- child READs of any file → allowed (integrity never blocks reads)
- child execution of host programs → allowed
- network access → **NOT restricted** (closing it off needs admin; use the
  Docker variant if network isolation matters)
- afterwards you (Medium) can still read/write everything in work/

**Setup:** none — nothing to install or pre-run. Verify with
`node scripts/integrity/hypervisor.mjs --selftest` (prints 5 PASS checks,
exit 0). If a Windows update ever changes the token rules, this fails
loudly instead of silently letting the child run unsandboxed.

**Usage:** start the model server, then

```
node scripts/integrity/hypervisor.mjs --model <id> [supervisor options] "task"
```

Supervisor options (`--timeout`, `--expect-file`, `--loop-threshold`,
`--max-forks`, `--max-errors`, `--consult`, ...) pass through unchanged —
see `supervisor.mjs --help`. Progress log, `=== RESULT ===` line and exit
codes (0 completed / 1 infrastructure / 2 usage / 3 stuck / 4 consult) are
identical to the other variants; the hypervisor additionally exits 90 on
sandbox-setup or selftest failure and propagates 91 from spawn-low.ps1 if
the downgrade itself fails.

**Hypervisor flags:**

| Flag | Meaning | Default |
|---|---|---|
| `--base <dir>` | sandbox root (work/home/temp live here) | `%USERPROFILE%\pi-supervisor-sandbox` |
| `--workdir <dir>` | child work area; must be empty unless `--reuse` | `<base>\work` |
| `--src <dir>` | copy this directory into the workdir before launch | — |
| `--reuse` | allow a pre-existing non-empty workdir (its old files are Medium IL — the child cannot modify them) | off |
| `--model <id>` / `--provider <id>` | model id / provider id (the child gets its own fresh agent dir, so `localllama` never collides) | `$PI_MODEL` / `localllama` |
| `--model-base-url <u>` | model endpoint | `http://127.0.0.1:8080/v1` |
| `--context-window <n>` | context window written into the child's models.json | 262144 |
| `--model-input <csv>` | input modalities written into the model entry (text,image,audio,video) | pi's default declaration |
| `--task <t>` / positional | task text | required |
| `--selftest` | run the isolation selftest and exit | off |
| `--skip-latency` | skip the preflight latency probe (timed 16-token completion; logs tok/s) | off |
| `--log <file>` | log file name (in the workdir) | `pi-child-hypervisor.log` |

**Windows-development note:** the child keeps the host's full native
toolchain — e.g. on a machine with Visual Studio 2022 Community, MSVC C++
(`cl.exe`) and CMake are available; build with
`cmake -S . -B build -G "Visual Studio 17 2022"` and every artifact lands
in `work/` (readable by you afterwards). Every process the child spawns
inherits Low IL, so the confinement holds for the whole build/test tree.

**Shell note (task authors!):** the child's `bash` tool runs **Windows
PowerShell, not bash** — Git-bash (MSYS2) cannot start at Low integrity
(it must create `\BaseNamedObjects\msys-2.0S5-<hash>`, which MIC denies
Low-IL creation). The hypervisor writes `shellPath` (pwsh if on PATH, else
PowerShell 5.1) into the child's agent `settings.json`. So task text and
build/run commands must use PowerShell syntax: `cmake ... ; cmake --build
build --config Release` then `.\build\Release\demo.exe` — backslash paths,
`Set-Content`/`Out-File`, no `&&` on 5.1. Say this in the task if the
model might default to bash idioms.

**Gotchas:**
- The self-downgrade uses the exact access mask the current OS grants the
  Medium token (`TOKEN_QUERY | TOKEN_ADJUST_DEFAULT`, 0x88) and the label
  buffer size `GetTokenInformation` reports (28 bytes on current Windows, not
  the textbook 24). Other masks (e.g. `TOKEN_ADJUST_GROUPS`) are denied.
- The child's pi agent dir is `<base>\home\.pi` — sessions are NOT in your
  main `~/.pi`; to inspect a run, look there.
- Pre-existing files copied into the workdir *before* the icacls step (or
  left over with `--reuse`) keep Medium IL and are read-only for the child.

## Dedicated-user variant (user variant — a real confined account, in-place project)

Runs supervisor + child pi as a **dedicated standard local user** (default
`agent`) so the child develops the project **in place** — the real repo, the
real git state — while NTFS ACLs confine it to the project directory. Unlike
the low-integrity variant (MIC blocks only *writes*, and only what the label
policy covers), this is a real account boundary: in the default `deny` reads
mode, reads of everything outside the grant are denied too (`--reads allow`
relaxes outside *reads* while the write seal stays — see **Reads mode**
below). The host user (you) keeps full control; the child gets a grant on
the project and deny-on-everything-else.

**Architecture (all on this host):**

```
host user
  `- node scripts/user/hypervisor.mjs
       |- health-checks the model endpoint
       |- stages supervisor.mjs + runner.mjs + selftest.ps1
       |    into C:\ProgramData\pi-supervisor  (world-readable;
       |    the only path both users can touch without a grant)
       |- [mode selftest]  or [mode run]
       `- ssh -i <key> agent@127.0.0.1 (loopback SSH, key-only after setup)
            `- runner.mjs as the dedicated user
                 |- bootstraps the per-run profile env (USERPROFILE/HOME/
                 |  TEMP/PI_CODING_AGENT_DIR/PI_PACKAGE_DIR/GIT_CONFIG_*)
                 |- writes the child's .pi config (models.json + auth.json)
                 |  and .gitconfig (safe.directory = project)
                 |- selftest: 11-check confinement matrix (exit 0/1)
                 `- node supervisor.mjs (child pi, cwd = the project)
```

**Confinement (the ACL matrix, applied once — "tier 1" needs no admin):**
- grant the user `(OI)(CI)M` on the project directory
- deny `(OI)(CI)F` on every sibling of the project (its whole subtree) and
  on the foreign top-level entries of the project's drive root; a partial
  deny on the project's parent dir keeps the grant from leaking outward
- the host user's home is already unreadable/unwritable to other users
  under the standard Windows profile DACL — no action needed
- "tier 2" (needs admin, optional): the drive root itself and foreign-owned
  directories that resist icacls as a standard user (`$RECYCLE.BIN`,
  `System Volume Information`, `Backup`, `Trash`, `MySQL`, ...). Ship as
  `admin-tier2-<user>.bat`; run it elevated once. Tier-1 already blocks the
  interesting targets; tier 2 closes the cosmetic gaps.

**Reads mode (`--reads deny|allow`, default `deny`):** the write confinement
is identical in both modes (project grant; zone-root create/delete denied;
host home sealed by the profile DACL). The flag only controls the sibling
deny matrix:
- `deny` — full denies on every sibling subtree of the project's parent
  (plus the foreign drive-root entries): the child cannot even *list* what
  is outside its grant. The strictest option.
- `allow` — no sibling denies: the child can read (and, per the default
  ACLs, write) elsewhere on the machine — e.g. to consult a reference repo
  or docs — while its own project stays the only in-place write zone it
  cares about.

The matrix is applied by `scripts/user/apply-denies.ps1` (idempotent:
cleans every `agent` ACE on the project's drive zone, then re-applies per
mode). The hypervisor probes one sibling with a single `icacls` call before
every run and skips the full re-apply (measured ~6 min on a ~200-sibling
tree) when the tree is already in the requested mode. `--selftest`
verifies the matching matrix per mode: in `allow` the sibling read/write
probes must *succeed*, in `deny` both must be blocked. Both matrices are
live-verified (11/11 in each mode).

The probe classifies only EXPLICIT `agent` ACEs: ancestor-*inherited* ACEs
(e.g. a legacy NO_ACCESS deny on `C:\Users\<host>`, which every subtree
shows as `agent:(I)...`) are not mode state — a clean can never remove them
from a child's own DACL, so counting them made the probe force a re-apply
that then failed on the very same ACEs (die 90 on every launch, 2026-10-16).
The probe logic lives in `scripts/user/reads-probe.mjs` (CLI:
`node reads-probe.mjs <user> <dir>`; unit-tested in `test-supervisor.mjs`).

Apply ACLs with `icacls` or .NET (`[IO.Directory]::SetAccessControl` — works
when the `Microsoft.PowerShell.Security` module is broken, which also breaks
`Get-Acl`/`ConvertTo-SecureString` on some installs; build SecureStrings via
`[SecureString]::AppendChar` instead).

**One-time setup (host user, no admin):**
1. Create the account: `net user agent <pw> /add` (machine-wide node/git on
   PATH are used by the child — true on this machine).
2. Apply the tier-1 ACL matrix (above) — `scripts/user/apply-denies.ps1 -User
   agent -Project <dir> -Mode deny|allow`; the hypervisor also applies it
   itself before setup/selftest/run (skipping when already in the requested
   mode).
3. SSH: `ssh-keygen -t ed25519` into a host-user-only dir, `icacls /inheritance:r
   /grant <you>:F` on the dir + private key (ssh refuses group/world-readable
   keys), then a ONE-TIME password login (env `SSH_ASKPASS_REQUIRE=force` +
   an askpass.bat that echoes `%PI_AGENT_SSH_PASS%`, `DISPLAY` set) to append
   the pubkey to the user's `%USERPROFILE%\.ssh\authorized_keys`. All later
   launches are key-only (`-i <key>`). The key path is the `--key` flag.
4. `node scripts/user/hypervisor.mjs --key <key> --setup "<project>"` —
   bootstraps the user's profile dirs and installs the pi package into the
   user's own `%APPDATA%\npm` (idempotent).
5. `node scripts/user/hypervisor.mjs --key <key> --selftest "<project>"` —
   the 11-check matrix (profile/project writable, git works, sibling + host
   home blocked or open per reads mode, node/git/model reachable). Pass the
   same `--reads` mode you will run with — the matrix is mode-aware. Exit 0
   before you trust a real run.

**Usage:** start the model server, then

```
node scripts/user/hypervisor.mjs --key <key> --project <dir> --reads deny|allow [supervisor options] "task"
```

Supervisor options (`--timeout`, `--expect-file`, `--loop-threshold`,
`--max-forks`, `--max-errors`, `--consult`, ...) pass through unchanged. The
child works **in place** on `<dir>` (git `safe.directory` is set for it via
`GIT_CONFIG_GLOBAL`); commits, if the task asks for any, carry the child's
`pi-child` git identity. Progress log, `=== RESULT ===` line and exit codes
(0/1/2/3/4) match the other variants; the hypervisor additionally exits 90 on
setup/selftest/model-health failure and 91 on spawn/ssh failure.

Before every launch the hypervisor also runs one small **timed completion**
against the endpoint (16 tokens) and logs tok/s — on a slow local model that
number is what you size `--timeout` and per-item timeboxes by
(`--skip-latency` to skip; the probe is non-fatal).

**Run artifacts (v0.10.0):** the supervisor always writes
`pi-child-result.json` (the manifest) into the project. On *any* exit the
runner then exports the child's full final message (`pi-child-final.txt`,
untruncated — `RESULT.finalText` is capped at 4000 chars) and the **profile
delta** (`pi-child-profile-delta.txt` — packages the child installed or
removed in its persistent profile, so leftovers are visible without touching
the locked agent profile), plus a best-effort copy of all three into
`<stage>\runs\`. Everything is in the project dir, which the host reads
freely — the host never needs to enter the agent profile (locked by design).

**Hypervisor flags:**

| Flag | Meaning | Default |
|---|---|---|
| `--user <name>` | dedicated Windows account | `agent` |
| `--key <path>` | host-side ed25519 private key for loopback SSH | required |
| `--project <dir>` | the in-place project the child is granted | required (setup/selftest take it positionally) |
| `--reads <mode>` | outside reads: `deny` (sealed) or `allow` (open; outside writes sealed either way) | `deny` |
| `--model <id>` / `--provider <id>` | model id / provider id | `$PI_MODEL` / `localllama` |
| `--model-input <csv>` | input modalities declared in the child's models.json (comma list from text,image,audio,video) | pi's default declaration |
| `--model-base-url <u>` | model endpoint | `http://127.0.0.1:8080/v1` |
| `--api-key <k>` | provider API key | `local` |
| `--context-window <n>` | context window written into models.json | 262144 |
| `--stage-dir <dir>` | script staging dir (must be readable by the user) | `C:\ProgramData\pi-supervisor` |
| `--skip-latency` | skip the preflight latency probe (timed 16-token completion; logs tok/s) | off |
| `--log <file>` | log file name (in the project) | `pi-child-hypervisor.log` |
| `--setup` / `--selftest` | one-time profile+pi bootstrap / confinement matrix | off |

**Gotchas (all E2E-proven):**
- The user's profile dir DACL is locked against the host user on purpose —
  NEVER write into `C:\Users\<user>` as the host (mkdir/icacls fail by
  design); everything in there happens in-process as the user (profile
  bootstrap is part of every run).
- PS 5.1 drops empty-string args to natives (`ssh-keygen -N ''` → "Too many
  arguments") — generate keys via `cmd /c`.
- `-NoNewWindow` + `-WindowStyle` are mutually exclusive in Start-Process.
- The child's `bash` tool resolved to **PowerShell 5.1** on this machine
  (bash-idiom probes `ls && ...` failed instantly; `Get-ChildItem`/`if`
  commands worked — the child self-corrected after ~2 failed probes). Task
  text should say "PowerShell, no `&&`" up front, like the low-IL variant.
- `Start-Process -Credential` / CreateProcessAsUser do NOT work for launching
  as the user without admin (non-elevated token lacks SeImpersonatePrivilege
  → `ERROR_NO_TOKEN` / ACCESS_DENIED); schtasks `/RU <user>` also needs
  admin. Loopback SSH is the no-admin path.
- Staged scripts (supervisor/runner/selftest) live in `C:\ProgramData\pi-
supervisor`, NOT in the project — so a task that rewrites its own build
  area cannot break the supervisor mid-run.

## Custom client (when the harness isn't enough)

For reacting dynamically between turns, answering extension-UI dialogs, switching models mid-conversation, or inspecting session state, write a short script using the exported `RpcClient`. `scripts/rpc-child.mjs` is the same pattern with argument parsing — read it as a reference. Core shape:

```js
import { pathToFileURL } from "node:url";
const pkgDir = "<resolved global dir of @earendil-works/pi-coding-agent>";
const { RpcClient } = await import(pathToFileURL(`${pkgDir}/dist/index.js`).href);

const client = new RpcClient({
  cliPath: `${pkgDir}/dist/bundle/cli.js`,
  args: [
    "--no-session",
    "--provider", process.env.PI_PROVIDER, // child would otherwise use configured defaults
    "--model", process.env.PI_MODEL,
    "--exclude-tools", "ask_user_question", // dialog tools block on unanswered UI requests
  ],
});
await client.start();
client.onEvent((e) => { /* stream e.assistantMessageEvent deltas, watch tool_execution_start / extension_ui_request */ });
await client.promptAndWait("turn 1", undefined, 5 * 60 * 1000);
// read the reply (accumulate text deltas, or client.getLastAssistantText()), then:
await client.promptAndWait("turn 2 that reacts to the reply", undefined, 5 * 60 * 1000);
await client.stop();
```

## No Node available?

Raw JSONL over stdio works in any language: spawn `pi --mode rpc --no-session`, write one JSON command object per line to stdin, read LF-delimited JSON records from stdout, and wait for `agent_settled`:

```python
import json, subprocess
p = subprocess.Popen(["pi", "--mode", "rpc", "--no-session"],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE)
p.stdin.write(json.dumps({"type": "prompt", "message": "Hello"}).encode() + b"\n")
p.stdin.flush()
for line in p.stdout:
    r = json.loads(line)
    if r.get("type") == "message_update" and r["assistantMessageEvent"]["type"] == "text_delta":
        print(r["assistantMessageEvent"]["delta"], end="", flush=True)
    elif r.get("type") == "agent_settled":
        break
p.stdin.close(); p.wait()
```

Note: do not use a generic line reader that splits on Unicode line separators (U+2028/U+2029) — split on LF only.

## Notes

- The harness runs the child with `--no-session` (throwaway) by default. Use `--session-id`/`--session` to persist and resume — see **Session persistence and resuming**.
- The child is a full agent: it has `read`, `bash`, `edit`, `write` by default and can do real work. Its tool activity arrives as `tool_execution_start` events (harness prints them to stderr).
- Credentials/config are inherited from the same config dir and environment, so a child in a pi session can use the same providers as the parent.
- Protocol references (pi docs, in the package): `docs/rpc.md` (protocol), `docs/rpc-commands.md` (all stdin commands), `docs/json.md` (events), `docs/rpc-extension-ui.md` (dialogs), `docs/cli-integration.md` (mode overview).
