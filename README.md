# pi-child-rpc

Pi package containing the **pi-child-rpc** skill: spawn a second pi agent as a
child process (RPC mode) and hold a multi-turn, bidirectional conversation
with it from inside a pi session.

The skill bundles `scripts/rpc-child.mjs` — a ready-to-run harness that starts
a child pi, sends your prompts one by one (each sent only after the previous
reply settles), streams the child's live output, and ends with a
machine-readable `=== RESULT === {"replies":[...]}` line.

## Install

```bash
# pin a tag
pi install git:github.com/Foxclip/pi-child-rpc@v0.1.0

# try it for one invocation without installing
pi -e git:github.com/Foxclip/pi-child-rpc
```

## What you get

The `pi-child-rpc` skill, which pi loads when a task needs a long-lived second
pi agent. Quick usage (run from the directory the child should work in):

```bash
# one-shot
node <skill>/scripts/rpc-child.mjs "Explain this repository in one paragraph"

# multi-turn
node <skill>/scripts/rpc-child.mjs \
  --turn "Introduce yourself and ask me one short question" \
  --turn "Now answer your own question; end with FINISHED"
```

The skill's instructions cover the interfaces to choose between
(`pi --print` / JSON / RPC / SDK) and the hard-won gotchas: model/provider
inheritance from `PI_PROVIDER`/`PI_MODEL`, the 60s default
`promptAndWait` timeout, and dialog tools that block on unanswered
extension-UI requests.

## Requirements

- pi installed via npm (the harness locates the installed
  `@earendil-works/pi-coding-agent` package automatically; set `PI_PACKAGE_DIR`
  to override).
- Node.js >= 22.19.

## License

MIT
