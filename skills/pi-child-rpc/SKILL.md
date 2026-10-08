---
name: pi-child-rpc
description: Spawn and interact with a second pi agent as a child process (RPC mode) for multi-turn agent-to-agent work. Use when a task needs a long-lived, isolated second pi — parallel work, a sub-conversation, or orchestrated follow-ups — that one-shot `pi --print` cannot cover.
---

# Interacting with a child pi process

A pi agent can spawn and converse with another pi agent. It is not limited to `acp_delegate` subagents. Pick the lightest interface that fits:

| Need | Interface | How |
|---|---|---|
| One-shot task, final text is enough | Print mode | `pi --print "task"` (plain bash) |
| One-shot, structured events | JSON mode | `pi --mode json "task"` |
| Multi-turn, bidirectional | **RPC mode** | `scripts/rpc-child.mjs` in this skill, or a custom `RpcClient` script |
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

Parse that line for programmatic use. Exit code is non-zero on timeout or child failure. Options: `--provider`, `--model`, `--timeout <ms>`, `--keep-question-tool`, `--help`.

## Critical gotchas (learned the hard way — do not skip)

1. **The child does NOT inherit the parent session's model.** A bare child uses the *configured default* model. For local providers (llama.cpp) that means loading a different GGUF — very slow, or failing. Fix: pass `--provider`/`--model`; the harness auto-inherits the parent session's `PI_PROVIDER`/`PI_MODEL` env vars, which is why it "just works" inside a pi session.
2. **`RpcClient.promptAndWait` defaults to a 60-second timeout.** Slow local models exceed this. Always pass an explicit per-turn timeout (harness default: 5 min; `--timeout <ms>`). If a turn may exceed even that, see **Long-running work** below.
3. **Dialog tools hang the child.** `ask_user_question` (and similar extension-UI dialog tools) make the child emit an `extension_ui_request` on stdout and block until the client sends back a matching `extension_ui_response` on stdin. The harness excludes `ask_user_question` by default (`--keep-question-tool` retains it — then your client MUST answer dialogs per the RPC extension-UI protocol).
4. **The child has zero context from the parent conversation.** Every prompt must be self-contained: include file paths, constraints, and everything the child needs — the same rule as writing `acp_delegate` tasks.
5. **`agent_end` ≠ done.** Retries, compaction, or queued work can follow `agent_end`; wait for `agent_settled` (the harness does this via `promptAndWait`).
6. **The child's stdout is the protocol.** Diagnostics belong on stderr; never write non-protocol data to the child's stdin/stdout.
7. **Windows/Node**: the child needs the pi CLI entry `dist/bundle/cli.js` of the installed package (the package `bin`), not `dist/cli.js` from a repo checkout. The harness resolves the global install automatically (`PI_PACKAGE_DIR` env overrides).

## Long-running work (when a turn exceeds the timeout)

The timeout is **client-side, wall-clock, per turn**. When it fires, `promptAndWait` rejects with `Timeout collecting events`, the harness exits non-zero, and `client.stop()` closes the child's stdin — an **orderly shutdown**: the child aborts the in-flight turn and exits (no orphan process). **No rollback**: tool side effects already completed stay on disk; the partial turn is lost, and with `--no-session` there is no transcript to resume it. Completed earlier turns remain in the output (`[reply-N]` blocks; the exit code marks the failure).

Mitigations:

1. **Raise it**: `--timeout 3600000` (1 h). It is a hard wall-clock deadline, so size it to the job.
2. **Decompose into more, smaller turns** — the interactive advantage: the parent reads each `[reply-N]`/`RESULT` line and sends the next step, so every turn gets its own budget and you can react mid-job instead of blind-waiting on one long prompt.
3. **Custom client with an idle-based timeout** — the built-in deadline is wall-clock from prompt send, so a legitimate long tool run plus a long generation can trip it even though nothing is wrong. In a custom `RpcClient` script, reset the deadline on every incoming event (text deltas, `tool_execution_start`/`update`, `bash_execution_update`): an actively working child keeps emitting events; only a genuinely hung child (e.g. stalled provider, unanswered dialog) goes silent.
4. **Persist the child's session** for long jobs — drop `--no-session` (add `--name`/`--session-dir`) so a timed-out or aborted job can be *resumed* in a fresh child instead of restarted from scratch.

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

It opens a detached terminal window (default terminal: Windows Terminal or conhost) tailing `pi-child-live.log` in the cwd, mirroring the child's events as they happen: message boundaries with roles, streamed text, `tool_execution_start` (name + args) and `tool_execution_end` (result, truncated; errors flagged), turn and settle markers. The window uses `-NoExit`, so the transcript stays readable after the run; the log file is kept too. The RPC control flow is unaffected — the parent still drives every turn; `--watch` only adds a mirror. (Plain alternative: launch a TUI-mode `pi` in a new window to watch/steer manually, but then the parent cannot drive it.)

## Notes

- The harness runs the child with `--no-session` (throwaway). Drop that flag and use `--session-dir`/`--name` if the child's session must be inspected later.
- The child is a full agent: it has `read`, `bash`, `edit`, `write` by default and can do real work. Its tool activity arrives as `tool_execution_start` events (harness prints them to stderr).
- Credentials/config are inherited from the same config dir and environment, so a child in a pi session can use the same providers as the parent.
- Protocol references (pi docs, in the package): `docs/rpc.md` (protocol), `docs/rpc-commands.md` (all stdin commands), `docs/json.md` (events), `docs/rpc-extension-ui.md` (dialogs), `docs/cli-integration.md` (mode overview).
