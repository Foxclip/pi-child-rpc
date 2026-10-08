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
2. **`RpcClient.promptAndWait` defaults to a 60-second timeout.** Slow local models exceed this. Always pass an explicit per-turn timeout (harness default: 5 min; `--timeout <ms>`).
3. **Dialog tools hang the child.** `ask_user_question` (and similar extension-UI dialog tools) make the child emit an `extension_ui_request` on stdout and block until the client sends back a matching `extension_ui_response` on stdin. The harness excludes `ask_user_question` by default (`--keep-question-tool` retains it — then your client MUST answer dialogs per the RPC extension-UI protocol).
4. **The child has zero context from the parent conversation.** Every prompt must be self-contained: include file paths, constraints, and everything the child needs — the same rule as writing `acp_delegate` tasks.
5. **`agent_end` ≠ done.** Retries, compaction, or queued work can follow `agent_end`; wait for `agent_settled` (the harness does this via `promptAndWait`).
6. **The child's stdout is the protocol.** Diagnostics belong on stderr; never write non-protocol data to the child's stdin/stdout.
7. **Windows/Node**: the child needs the pi CLI entry `dist/bundle/cli.js` of the installed package (the package `bin`), not `dist/cli.js` from a repo checkout. The harness resolves the global install automatically (`PI_PACKAGE_DIR` env overrides).

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

- The harness runs the child with `--no-session` (throwaway). Drop that flag and use `--session-dir`/`--name` if the child's session must be inspected later.
- The child is a full agent: it has `read`, `bash`, `edit`, `write` by default and can do real work. Its tool activity arrives as `tool_execution_start` events (harness prints them to stderr).
- Credentials/config are inherited from the same config dir and environment, so a child in a pi session can use the same providers as the parent.
- Protocol references (pi docs, in the package): `docs/rpc.md` (protocol), `docs/rpc-commands.md` (all stdin commands), `docs/json.md` (events), `docs/rpc-extension-ui.md` (dialogs), `docs/cli-integration.md` (mode overview).
