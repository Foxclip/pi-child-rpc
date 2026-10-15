# Changelog

## v0.7.0 — 2026-10-15

**Low-integrity sandbox variant (`scripts/integrity/`) — native Windows,
no admin, no Docker, no UAC prompt.** A third way to run long supervised
jobs, for machines (like this one) where the user is a standard account and
wants real confinement without installing or elevating anything.

- `scripts/integrity/hypervisor.mjs` — Medium-IL orchestrator. Creates
  `<base>/{work,home,temp}` under `%USERPROFILE%\pi-supervisor-sandbox` and
  icacls's them `(OI)(CI)Low`; writes the child's own agent config
  (`models.json` + `auth.json`, openai-completions → `--model-base-url`,
  and `settings.json` with `shellPath` → PowerShell, because Git-bash/MSYS2
  cannot start at Low integrity — the child's bash tool runs PowerShell, so
  task text must use PowerShell syntax); health-checks the model; copies
  `--src` project files; then spawns the
  Low-IL tree. No model forwarder (child is on this host). Supervisor
  options pass through unchanged; same `=== RESULT ===` line, progress log
  and exit codes as the other variants; 90 = sandbox setup/selftest failure.
  `--selftest` runs the isolation checks and exits 0/90.
- `scripts/integrity/spawn-low.ps1` — the downgrade itself:
  `OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_ADJUST_DEFAULT)`
  (0x88 — the only mask the current OS grants for this) +
  `SetTokenInformation(TokenIntegrityLevel)` with the OS-reported label size
  (28 bytes; the textbook 24 fails), target SID `S-1-16-4096` (Low).
  Takes the command as a single base64-encoded JSON `-Spec` argument
  (base64 because PS 5.1 command-line quoting mangles raw JSON's escaped
  quotes; and the decoded object is kept in `$specObj`, never `$spec` —
  PS member access is case-insensitive, so `$spec.Exe` would read the
  string param and stringify it). Pure ASCII (PS 5.1 cp1252 pitfall).
  Exits 91 on downgrade failure.
- E2E-verified on the authoring machine (VS2022 Community + CMake 4.0.3):
  child built a C++ project in the Low-IL sandbox (`cl.exe`), ran the
  binary, wrote `out.txt`/`done.txt`; passed on both gemma-4-26B and
  Qwen3.8-27B (~30 s–2 min per run).
- `scripts/integrity/selftest.ps1` — 5 checks, all verified PASS on the
  authoring machine: userprofile write blocked, HKCU write blocked,
  Low-IL dir write allowed, child process inherits Low, Medium-IL reads
  still work.
- SKILL.md: interface-table row + full section (architecture, protection
  matrix, flags, MSVC/CMake + PowerShell-shell notes, gotchas).

Protection boundary: integrity confinement is write-only — the child can
READ everything and the network is unrestricted (both would need admin or a
container to close). Use the Docker variant when network isolation matters;
use this one for admin-free file/registry confinement of long native runs.

## v0.6.0 — 2026-10-15

**Rename: `pi-child-rpc` → `pi-supervisor`.** The repo was renamed on
GitHub (`Foxclip/pi-child-rpc` → `Foxclip/pi-supervisor`) and the skill takes
the same name. Nothing else changed.

- Skill: frontmatter `name: pi-supervisor`, folder `skills/pi-supervisor/`
  (the skill's invocation is now `pi-supervisor`, e.g. `/skill:pi-supervisor`).
- Install pin: `git:github.com/Foxclip/pi-supervisor@v0.6.0` (the old pin
  `git:github.com/Foxclip/pi-child-rpc@...` is dead — GitHub redirects the old
  repo URL, but the pi package path no longer matches).
- Package metadata: `package.json` name `pi-supervisor`, version 0.6.0
  (also syncing the version field, which had lagged at 0.4.0 since v0.4.0),
  repository URL updated; `package-lock.json` synced.
- Docker artifacts renamed: image `pi-supervisor:docker` (an existing local
  `pi-child-rpc:docker` image is NOT reused — the first run after the rename
  builds a fresh one), bind mount `/opt/pi-child-rpc` → `/opt/pi-supervisor`,
  container name prefix `pi-child-rpc-` → `pi-supervisor-`.
- NOT renamed: the `pi-child-*` runtime artifact file names
  (`pi-child-progress.log`, `pi-child-consult.json`, `pi-child-hypervisor.log`,
  `pi-child-live.log`) — they name the child pi process, stay stable across
  the rename, and keep in-progress/monitoring runs working.
- Historical CHANGELOG entries keep their original names.

## v0.5.0 — 2026-10-15

New variant: the 3-layer Docker run. The skill now has two variants — host
(supervisor + child both on the host, `supervisor.mjs` directly, unchanged) and
Docker (host hypervisor → container supervisor → container child, model on the
host). The supervisor is unchanged in both; all of its options pass through
the new hypervisor unchanged.

### scripts/docker/hypervisor.mjs (new)
- Host-side hypervisor for running `supervisor.mjs` + child inside a container
  while the model is served from the host. Owns what only the host can see:
  - generates the container's agent config (models.json + auth.json) under
    `<workdir>/.pi-docker/agent/` — sessions land there too, untouched on
    regeneration;
  - embedded model forwarder `0.0.0.0:8081 → 127.0.0.1:8080` by default
    (reused if the port already serves a model endpoint; `--no-forward` to skip);
  - model health checks before launch and every 30 s during the run (the
    in-container supervisor cannot see the host model server);
  - builds the image if missing, launches the container, watches the progress
    log for total no-progress (`--no-progress`, default 2700 s), kills +
    restarts a fresh container on infrastructure failure only when the model
    is reachable (task-level exits 0/3/4 never restart);
  - collects the supervisor's RESULT and prints `=== HYPERVISOR RESULT ===`
    with host-side path mapping (`sessionFileHost`).
- **Reserved provider-id guard**: pi v1.2.0 reserves the provider id
  `llama.cpp` (built-in router integration) — a models.json entry under that id
  collides and the model list stays empty even though auth reports ready. The
  hypervisor registers under a non-reserved id (default `localllama`, or
  `$PI_PROVIDER` when non-reserved), swaps a reserved `$PI_PROVIDER` with a
  note, and refuses `--provider llama.cpp` (exit 2).
- Strict CLI like the rest of the skill; exit codes: the supervisor's (0/3/4)
  or 1 infrastructure / 2 usage. `--watch` opens the host-side progress window
  (the in-container supervisor cannot). Flag surface: `--image --docker
  --workdir --model-base-url --provider --model --api-key --context-window
  --forward-from --forward-to --no-forward --skip-health --restarts
  --no-progress --keep-container --watch --log` + all supervisor options
  passthrough.

### scripts/docker/Dockerfile (new)
`node:24-bookworm-slim` + global `@earendil-works/pi-coding-agent` install.
Skill scripts are bind-mounted read-only at `/opt/pi-child-rpc` at run time,
so skill updates never require an image rebuild. Image name:
`pi-child-rpc:docker`.

### SKILL.md
- New **Docker 3-layer run** section: architecture (why the supervisor stays
  in the container and the hypervisor is on the host), usage, the
  reserved-id gotcha, full flag table, host-side monitoring, exit codes and
  restart policy, Windows notes. Interface table gained a Docker row.

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
