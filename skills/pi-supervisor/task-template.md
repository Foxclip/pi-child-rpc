# Task contract template (pi-supervisor child tasks)

Fill in the `[...]` slots, save as `<name>.md`, launch with `--task-file <name>.md`
(and `--expect-file <report path>`). Encodes the SKILL.md "Task authoring" rules
plus the field lessons from the 2026-10-16/17 video-extension runs.

---

You are a supervised child pi agent. You have NO conversation context —
everything you need is in this file. The host cannot see your screen; the
report file is the ONLY channel that matters.

## Goal

[one paragraph: what "done" means, what the host will do with the result]

## Environment (verify first, then work from facts)

- Read `.pi-child-env.json` in the working directory FIRST (host-written at
  launch): pi path/version, ffmpeg, TEMP, node, installed packages, model
  input modalities.
- Working directory: [absolute path]. Use absolute paths everywhere
  (Set-Location into it may fail in your shell).
- Model endpoint: [base URL], model [id]. [If the task needs images: the
  host declared `input` — verify it in .pi-child-env.json before assuming the
  model is text-only.]
- If a required tool is missing, install it [exact command], then verify with
  [exact command].

## Work items

For each item, record ONE line to `[results file, e.g. results.md]` as soon
as it is done (do not batch at the end):

1. [item] — exact commands:
   `[command 1]`
   `[command 2]`
   Timebox: [N min]. If a probe returns no usable content 3 times in a row,
   record the finding and move on (environment failure is a valid finding).
2. [...]

## Rules

- Do not repeat a tool call with the same arguments more than [2] times —
  the supervisor will steer you, and a fork costs the whole context so far.
- Log EVERY config change you make (models.json, settings, env) to the
  report — the host is sealed from your profile and cannot inspect it.
- If you are killed or interrupted: on the next turn, write the (partial)
  report BEFORE doing anything else.
- If the task is to test an extension/plugin: verify it is LOADED IN THE
  RUNNING PROCESS, not merely installed (`pi list` / package presence is not
  proof — hooks load at process start). Report "live vs installed-only" as a
  distinct status; results from running the package's modules directly are
  module results, not extension results.
- Write large temp files to the working directory, not `/tmp` or `%TEMP%` —
  the workdir is persistent, host-visible, and where artifacts belong; /tmp
  may be small and dies with the container.
- Keep single tool calls to ~5 min or less: chunk long operations (per-segment
  ASR, per-range downloads) so progress stays observable in the status file
  and the work stays resumable if a call is lost.
- Do not ask the user questions. Do not spawn sub-agents.

## Report protocol

- Write the final report to `[report path]` — the LAST thing before you stop.
- Content: [per-item verdicts with the exact evidence (verbatim tool output
  for anything surprising)], environment facts the host cannot see, config
  changes made, cleanup performed, open issues.
- Last line of the report, exactly: `REPORT_DONE`
