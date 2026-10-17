# pi-supervisor

Pi package containing the **pi-supervisor** skill: spawn a second pi agent as
a child process (RPC mode), hold a multi-turn, bidirectional conversation with
it from inside a pi session, and run long unattended jobs under a supervision
ladder — optionally in a Docker container or a native low-integrity Windows
sandbox.

## What's inside

- `scripts/rpc-child.mjs` — a harness that starts a child pi, sends your
  prompts one by one (each sent only after the previous reply settles),
  streams the child's live output, and ends with a machine-readable
  `=== RESULT === {"replies":[...]}` line.
- `scripts/guard.mjs` — runs **one long autonomous task** under
  supervision: detects repetitive tool-call loops, stalls and degenerate
  settles, and escalates (steer → fork-from-checkpoint → give up) instead of
  letting the host repetition guard abort the run. Persists the session by
  default (auto `sup-<timestamp>` ID, so forks and consults stay resumable).
  Also: consult mode (`--consult` — exit 4, the parent session resumes with
  `--consult-file` + `--action steer|fork|continue`), completion artifacts
  (`--expect-file`), parent-review sensors (`--max-errors`, `--heartbeat`,
  `--max-text`), and an **always-on compact progress log**
  (`pi-child-progress.log`, one line per completed tool call — poll that, not
  the multi-MB session jsonl).
- `scripts/docker/hypervisor.mjs` + `scripts/docker/Dockerfile` — Docker
  **3-layer** run: a host hypervisor (agent config, model forwarder, health
  checks, image build, container lifecycle, no-progress backstop, RESULT
  collection) launches guard + child pi inside a container while the
  model server stays on the host. The guard's options pass through
  unchanged.
- `scripts/integrity/` — **low-integrity sandbox** variant
  (`hypervisor.mjs` + `spawn-low.ps1` + `selftest.ps1`): native Windows, no
  admin, no Docker, no UAC prompt. Self-downgrade to Low integrity via
  Mandatory Integrity Control; the child's *writes* to the user profile, HKCU
  and system dirs are confined to the sandbox tree (reads and network stay
  open — use the Docker variant if network isolation matters). `--selftest`
  verifies the isolation.
- `scripts/test-guard.mjs` — static test suite for the supervision
  ladder (fake pi scripted via JSON spec, no model needed):
  `node scripts/test-guard.mjs`.

## Install

```bash
# pin a tag
pi install git:github.com/Foxclip/pi-supervisor@v0.8.1

# try it for one invocation without installing
pi -e git:github.com/Foxclip/pi-supervisor
```

## What you get

The `pi-supervisor` skill, which pi loads when a task needs a long-lived second
pi agent. Quick usage (run from the directory the child should work in):

```bash
# one-shot
node <skill>/scripts/rpc-child.mjs "Explain this repository in one paragraph"

# multi-turn
node <skill>/scripts/rpc-child.mjs \
  --turn "Introduce yourself and ask me one short question" \
  --turn "Now answer your own question; end with FINISHED"

# one long autonomous job, supervised (loop/stall detection + recovery)
node <skill>/scripts/guard.mjs "Refactor module X to use Y; verify with the test suite"

# the same idea, sandboxed in a Docker container (model stays on the host)
node <skill>/scripts/docker/hypervisor.mjs "Refactor module X to use Y"

# the same idea, sandboxed without Docker/admin (native Windows)
node <skill>/scripts/integrity/hypervisor.mjs --model <id> "Build and test the project"
```

The skill's instructions cover the full interface table
(`pi --print` / JSON / RPC / guard / Docker / low-IL / SDK), session
persistence and resuming, and the hard-won gotchas: model/provider
inheritance from `PI_PROVIDER`/`PI_MODEL`, the 60s default
`promptAndWait` timeout, dialog tools that block on unanswered
extension-UI requests, and monitoring long runs by polling the compact
progress log. Child sessions are throwaway by default in `rpc-child.mjs`;
`guard.mjs` persists by default so forks and consults can resume.

## Requirements

- pi installed via npm (the scripts locate the installed
  `@earendil-works/pi-coding-agent` package automatically; set
  `PI_PACKAGE_DIR` to override).
- Node.js >= 22.19.
- Docker variant: a Docker runtime (written and tested with Docker Desktop on
  Windows; the forwarder/health/lifecycle flow assumes a host model server).
- Integrity variant: Windows only (relies on Mandatory Integrity Control).

## License

MIT
