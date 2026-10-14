---
name: pi-child-rpc
description: Spawn and interact with a second pi agent as a child process (RPC mode) for multi-turn agent-to-agent work. Use when a task needs a long-lived, isolated second pi — parallel work, a sub-conversation, or orchestrated follow-ups — that one-shot `pi --print` cannot cover. Includes supervisor.mjs for unattended long runs: loop/stall/degenerate-settle detection, steer→fork→stuck ladder, --expect-file completion artifacts, always-on progress log.
---

# Interacting with a child pi process

A pi agent can spawn and converse with another pi agent. It is not limited to `acp_delegate` subagents. Pick the lightest interface that fits:

| Need | Interface | How |
|---|---|---|
| One-shot task, final text is enough | Print mode | `pi --print "task"` (plain bash) |
| One-shot, structured events | JSON mode | `pi --mode json "task"` |
| Multi-turn, bidirectional | **RPC mode** | `scripts/rpc-child.mjs` in this skill, or a custom `RpcClient` script |
| One long autonomous job, unattended | **Supervised RPC** | `scripts/supervisor.mjs` (loop/stall detection + steer→fork→stuck ladder) |
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
- **Extended sensors**. The built-in detectors cover *known* failure shapes; these widen the net. `error-loop` and `text-loop` run in **both** modes: in consult mode a hit parks the run for the parent, in autonomous mode they run the normal ladder (steer once, then fork per budget). `heartbeat` is consult-only (parking for a parent review is meaningless unattended):
  - `error-loop` — `--max-errors <n>` (default **6**, 0 disables): N consecutive *failing* tool calls of any kind. Catches thrashing the identical-loop detector misses (different calls, all failing).
  - `heartbeat` — `--heartbeat <n>` (default 0 = off): after every N completed tool calls, the supervisor parks and hands you the trace for a progress review. The payload carries the recent tool calls (args, truncated results, errors, durations) plus the child's last text, so you can judge drift, wasted work, or anything a fixed detector cannot name. Each heartbeat = one parent turn + child restart (it re-reads its transcript), so keep N large.
  - `text-loop` — `--max-text <n>` (default **20000** chars, 0 disables): an assistant message longer than N characters *without a tool call*. This is the "thinking loop" — the model keeps appending words to the same message. It is invisible to every other sensor: the child emits text deltas continuously, so the stall detector sees a healthy, busy child, and there are no tool calls for the loop/error/heartbeat detectors to key on. Without this sensor, only the hard wall clock stops the run — and that is terminal (`stuck`, exit 3). In consult mode the payload's `lastAssistantText` shows you the ramble (steer or fork); in autonomous mode the ladder steers the child back on task, then forks per budget.
- **Parent-authored ladder messages** (no consult needed): `--steer-msg "<text>"` and `--fork-note "<text>"` fully replace the built-in L1/L2 messages (variables `{tool}`, `{count}` / `{reason}`). Use for task-specific guidance — the parent wrote the task, so it knows which failure modes to warn about (e.g. "the registry is blocked; use the local cache").
- **Progress log, always on** (v0.4.0): `pi-child-progress.log` in the working directory is written in every mode — one line per completed tool call, plus `[start]`/`[settled]`/`[result]` summary lines. It is the cheap status surface for a parent that wants to peek without parsing a 20 MB session jsonl (see **Monitoring a long run**).
- **Strict CLI** (v0.4.0): an unknown `--flag` is an error (exit 2). Unknown flags used to be joined into the task text — a typo'd flag became the child's *entire* task. At startup the supervisor echoes the resolved task (`[supervisor] task: N chars — "..."`) and warns when it is suspiciously short (< 100 chars). `rpc-child.mjs` rejects unknown flags the same way.

```bash
node <skill_dir>/scripts/supervisor.mjs "Refactor module X to use Y; verify with the test suite"
```

- **Persists the session by default** (auto `--session-id sup-<timestamp>`, `--name` = the ID) so runs stay resumable. Every L2 fork creates a NEW session file — the RESULT line reports the **final** session (`sessionId`/`sessionFile`); resume THAT file with `rpc-child.mjs --session <file>` to continue or debug. `--no-session` for throwaway.
- RESULT JSON: `{status: "completed"|"stuck"|"consult", exitReason: completed|hard-timeout|stuck-loop|stuck-idle|aborted-external|degenerate-settle|missing-expected-file|consult-loop|consult-stall|consult-external-abort|consult-error-loop|consult-heartbeat|consult-text-loop, task (≤200 chars) + taskChars, attempts, interventions: {steers, forks, loopsSeen}, sessionId, sessionFile, finalText (≤4000 chars) + finalTextTruncated, settle: {attemptTextChars, attemptToolCalls, lastMessageTextChars, errorStreakAtEnd}, expectedFiles (when given), progressLog, elapsedMs, recentToolCalls (last 15: {tool, args, isError, result≤300, durationMs}), consultFile/trigger/allowedActions (status=consult only)}`. The same summary is also written as a `[result]` line in the progress log. Exit codes: 0 completed, 3 stuck, **4 consult** (waiting on the parent's resume), 1 error, 2 usage (including an unknown `--flag`).
- Tuning: `--loop-threshold` (default **4** — one below the guard's default abort=5 so the steer lands first), `--max-steers`, `--max-forks`, `--idle-timeout`, `--tool-timeout`, `--timeout <min>` (hard wall clock, default 240), `--expect-file <path>` (repeatable), `--watch`, `--keep-delegate-tool`, consult sensors (`--max-errors`, `--heartbeat`, `--max-text`), steering (`--consult`, `--consult-file`, `--action`, `--message`, `--steer-msg`, `--fork-note`), plus all harness session/model flags (`--provider`, `--model`, `--session-id`, `--session`, `--session-dir`, `--name`).
- If you run with a custom `repetitionGuard` config, set `--loop-threshold` one below its `abort` value so L1 always wins the race.

### Task authoring (what a good long task contains)

A long autonomous task is a *contract*, not a suggestion. Every failure in this skill's history traced back to a missing piece of the contract:

1. **Goal + explicit completion criteria.** Name the files the task must produce, and pass them as `--expect-file` so a "settled" turn is not accepted while they are missing.
2. **Anti-loop rules.** "Max 3 attempts per approach; no cosmetic re-runs of a failing command (re-running it with `| head -N` or a reworded variant counts as the same attempt); if an approach is exhausted, log it and move to the next." This keeps the model just inside the repetitionGuard's threshold — a 6h48m run with zero interventions used exactly this preamble.
3. **Durability rule — the transcript is NOT storage.** ACP compression can physically delete old transcript messages (rebase), so anything that must survive (credentials, artifacts, intermediate findings) has to be written to disk *immediately*: "write the credentials to `data/creds.txt` FIRST, before continuing". A VK password that existed only in the transcript was unrecoverable after a rebase, and a 3.8-hour run was lost re-hunting it. Keep a `STATUS.md` (or notes file) updated at milestones — it is what makes a resumed or forked run start with context instead of amnesia.
4. **Boundaries.** "Do not use `acp_delegate`" (excluded by default anyway), "no new dependencies", and the paths of everything the child needs — it has zero context from your conversation.
5. **No silent stops.** "End with a written status update (what is done, what is blocked and why, what remains) — never stop with only internal thinking." Degenerate settles are now caught by the supervisor, but the contract makes the child avoid them in the first place.
6. **Budget awareness.** State the hard deadline in the task ("stop by 15:40") so the child can park mid-item and write a clean handoff instead of being cut off mid-tool-call.

### Monitoring a long run (parent side)

- **Verify on launch, before walking away.** The first `[supervisor] task: N chars — "..."` line in the log is the task the child *actually received*. Read it. A typo'd `--flag` (now exit 2) or a truncated task used to become the child's entire task, and the run would "complete" doing nothing in 6 minutes.
- **One blocking wait, not polling.** For a run with a known budget, run the supervisor in the **foreground of a single bash call** with the call's timeout matched to the budget; the call returns exactly at run end and the last line of the log is the RESULT JSON. Mid-run status comes from the progress log, not from re-running anything.
- **The progress log is the status surface.** `pi-child-progress.log` (path in the `[start]` line and in RESULT's `progressLog`): one line per completed tool call plus `[settled]`/`[result]` summary lines. A peek is a `tail` on a small file — no 20 MB session-jsonl parsing, no custom scripts.
- **Polls must be non-identical.** The ACP host's own `repetitionGuard` (warn=3/abort=5, per session, byte-identical calls) counts *your* monitoring calls too — an unchanging `tail -n 20 file` poll will trip it. Vary the call each time (a changing offset, a `--since <last-line>` argument, or append the poll timestamp to the command).
- **The session file rotates after an L2 fork.** Anything keyed to one session-file path goes blind after a fork. Follow `sessionId`/`sessionFile` in the RESULT (or the consult file), or just watch the progress log — it is cwd-relative and stable.
- **Windows gotchas** (this skill was developed under them): the console codepage is cp1251 — any script that prints Cyrillic must set `PYTHONIOENCODING=utf-8` and reconfigure stdout with `errors="replace"`, or it crashes on the first non-Latin character. MSYS bash expands `$_`/`$()` inside double-quoted `powershell -Command "..."` — write a `.ps1`/`.py` file and run it with `-File`/`python <file>` instead. Host safety rules may block inline one-liners for the same reason.
- **After a hard-timeout or stuck exit**, capture "what remains" from the child's STATUS.md *before* relaunching: the resume (same session file, fresh supervisor run) then starts with a precise remainder list instead of re-deriving state.

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

## Watching the child (live window)

The RPC child has **no TUI** — in RPC mode its stdout is the JSON protocol, by design. To watch it work, run the harness with `--watch`:

```bash
node <skill_dir>/scripts/rpc-child.mjs --watch --turn "..."
```

It opens a visible window tailing `pi-child-live.log` in the cwd, mirroring the child's events as they happen: message boundaries with roles, streamed text, `tool_execution_start` (name + args) and `tool_execution_end` (result, truncated; errors flagged), turn and settle markers. Window mechanism, in order: (1) **Windows Terminal** — `wt new-tab powershell -NoExit -Command "Get-Content <log> -Wait"` (wt is a GUI app, so this works from any context, including console-less agent sessions); (2) fallback **PowerShell `Start-Process`** (via a temp .ps1 for deterministic quoting) opening a new console window. The tailer uses `-NoExit`, so the transcript stays readable after the run; the log file is kept too. The RPC control flow is unaffected — the parent still drives every turn; `--watch` only adds a mirror.

**Do not use `cmd /c start` for this**: in a console-less context (`not a tty`, e.g. agent tool sessions) it silently fails to create a visible window, and its first unquoted token is treated as the *program*, not the title (`start "title" prog` needs the title quoted). (Plain alternative: launch a TUI-mode `pi` in a new window to watch/steer manually, but then the parent cannot drive it.)

## Notes

- The harness runs the child with `--no-session` (throwaway) by default. Use `--session-id`/`--session` to persist and resume — see **Session persistence and resuming**.
- The child is a full agent: it has `read`, `bash`, `edit`, `write` by default and can do real work. Its tool activity arrives as `tool_execution_start` events (harness prints them to stderr).
- Credentials/config are inherited from the same config dir and environment, so a child in a pi session can use the same providers as the parent.
- Protocol references (pi docs, in the package): `docs/rpc.md` (protocol), `docs/rpc-commands.md` (all stdin commands), `docs/json.md` (events), `docs/rpc-extension-ui.md` (dialogs), `docs/cli-integration.md` (mode overview).
