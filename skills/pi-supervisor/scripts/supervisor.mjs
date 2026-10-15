#!/usr/bin/env node
// supervisor.mjs — run ONE long autonomous task in a child pi agent (RPC mode)
// and supervise it: detect repetitive tool-call loops and stalls, and escalate
// (steer → fork+retry → give up) instead of letting a watchdog kill the run.
//
// Why this exists:
//   billion-context-pi's `repetitionGuard` (issue #308; acp.json key
//   `repetitionGuard`, defaults warn=3 / abort=5, counter is PER SESSION)
//   refuses the 5th consecutive byte-identical tool call and ABORTS THE
//   TURN — that kills long autonomous jobs. A supervised child instead gets
//   an escalation ladder from the supervisor:
//     L1  steer() a corrective message (the programmatic "please continue")
//         — fires at --loop-threshold (default 4, i.e. BEFORE the guard's
//         abort-at-5)
//     L2  abort + fork(before the task message) + re-prompt with a note
//         ("start a branch from an earlier message" — loop history discarded;
//         a fork is a NEW session, so the guard's per-session counter starts
//         clean too)
//     L3  give up: RESULT status=stuck, exit 3
//   External aborts (agent_settled aborted=true not caused by the supervisor
//   — the guard firing at 5, or any other host-side abort) are recoverable:
//   straight to L2 while fork budget remains.
//
//   Consult mode (--consult): instead of L1/L2 firing with built-in messages,
//   the supervisor PAUSES at the intervention point: it persists the session,
//   writes pi-child-consult.json (trigger, loop stats, recent tool calls, last
//   assistant text, budgets, session id/file) and exits 4 with
//   RESULT status=consult. The parent session then decides and re-invokes:
//     node supervisor.mjs --consult-file pi-child-consult.json \
//       --action steer|fork|continue --message "your steering instruction"
//   steer    = send your message into the same session, in place
//   fork     = branch before the task message + re-prompt task+message
//              (new session file, fresh guard counter) — like L2, with your note
//   continue = resume with the built-in ladder for the rest of the run
//   Budgets, attempt count and the hard wall clock carry across resumes.
//
//   Sensors beyond loop/stall/external-abort — in consult mode any of them
//   PARKS the run (exit 4); in autonomous mode "error-loop" and "text-loop"
//   run the normal ladder (steer once, then fork), while "heartbeat" stays
//   consult-only (it is a parent-review mechanism, not a failure condition):
//     - "error-loop"  --max-errors <n>  (default 6, 0=off): N consecutive
//       FAILING tool calls (any tools/args) — the child is thrashing, even
//       though the calls are not byte-identical
//     - "heartbeat"   --heartbeat <n>   (default 0=off): after every N
//       completed tool calls — periodic parent review of progress. The payload
//       carries the recent tool trace (args + results + errors + last text)
//       so the parent can judge drift or any problem a fixed detector cannot
//       name. Each heartbeat = one parent turn + child restart (the child
//       re-reads its transcript), so keep N large.
//     - "text-loop"   --max-text <n>    (default 20000 chars, 0=off): an
//       assistant message growing past N characters WITHOUT a tool call — the
//       "thinking loop" where the model keeps appending words to the same
//       message. No other sensor catches this: the model is actively emitting
//       text deltas, so the stall detector sees a healthy, busy child.
//
// Usage:
//   node supervisor.mjs "task description" [options]
//
// Behavior:
//   - Single prompt = one autonomous job; the child works until it settles.
//   - Loop detection: >= --loop-threshold CONSECUTIVE identical tool calls
//     (same tool name + same args) → escalation.
//   - Stalls (no events at all): --idle-timeout while the model is thinking,
//     --tool-timeout while one tool call is running → straight to L2 (a steer
//     cannot reach a hung LLM call).
//   - --timeout is the hard wall clock; L3 when it expires.
//   - Degenerate settle: a turn that ends WITHOUT reporting (no text at all —
//     thinking-only or empty stop — or a <200-char stub with zero tool
//     activity on the initial attempt) is NOT "completed": one corrective
//     prompt (L1 budget) → fork (L2) → consult-park or exit 3 (exitReason
//     "degenerate-settle").
//   - --expect-file <path> (repeatable): on settle, missing artifacts are
//     handled exactly like a degenerate settle ("missing-expected-file").
//   - Progress log: pi-child-progress.log in the cwd is ALWAYS written (one
//     line per completed tool call + [start]/[settled]/[result]); a parent
//     session should poll it, not the session jsonl. Override: --progress-log.
//   - Tool exclusions: the child runs without ask_user_question and without
//     the acp_delegate* family (its sub-agents would be unsupervised). Opt
//     out: --keep-question-tool / --keep-delegate-tool.
//   - Strict CLI: unknown --flags are an error (exit 2) — they used to be
//     silently swallowed into the task text. A bare -- ends flag parsing.
//   - --preamble <t> prepends standing boilerplate to the task.
//   - Sessions persist by default (auto --session-id sup-<timestamp>) so runs
//     stay resumable. NOTE: each L2 fork creates a NEW session file — the
//     RESULT line reports the final session (id + file); resume THAT file.
//   - stdout: child's live text + final `=== RESULT === {json}` line (same
//     convention as rpc-child.mjs). RESULT fields: status, exitReason, task
//     (<=200 chars) + taskChars, attempts, interventions, sessionId,
//     sessionFile, finalText (<=4000 chars) + finalTextTruncated, settle
//     {textChars, toolCallsTotal, errorStreakAtEnd}, expectedFiles,
//     progressLog, elapsedMs, recentToolCalls. Diagnostics on stderr.
//   - Exit codes: 0 completed, 3 stuck, 4 consult (waiting on the parent
//     session to resume), 1 error, 2 usage.

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = `Usage:
  node supervisor.mjs "autonomous task description" [options]
Options:
  --task <t>            Task text (alternative to the positional argument)
  --session-id <id>     Persist under this exact ID (default: auto sup-<timestamp>)
  --no-session          Do not persist (throwaway run; fork retries happen in memory)
  --session <path|id>   Resume an existing session file or exact ID and run the
                        task on top of it (mutually exclusive with --session-id)
  --session-dir <dir>   Override where sessions are stored/looked up
  --name <name>         Session display name (default: the session ID)
  --provider <p>        Provider for the child (default: $PI_PROVIDER)
  --model <m>           Model for the child (default: $PI_MODEL)
  --loop-threshold <n>  Consecutive identical tool calls that count as a loop
                        (default: 4 — fires one before the host repetition
                        guard's default abort-at-5, so the steer lands first)
  --max-steers <n>      L1 budget: corrective steer messages (default: 3)
  --max-forks <n>       L2 budget: abort+fork+retry attempts (default: 2)
  --steer-msg <t>       Full replacement for the built-in L1 steer message
                        (variables: {tool}, {count})
  --fork-note <t>       Full replacement for the built-in L2 fork re-prompt
                        note (variable: {reason})
  --consult             Consult mode: on an intervention, persist the session,
                        write pi-child-consult.json and exit 4 so the parent
                        session can steer (requires a persisted session)
  --max-errors <n>      Consult sensor: N consecutive failing tool calls
                        triggers a consult (default 6; 0 disables)
  --heartbeat <n>       Consult sensor: consult after every N completed tool
                        calls for a parent progress review (default 0=off)
  --max-text <n>        Consult sensor: an assistant message longer than N
                        characters without a tool call triggers a consult
                        (default 20000; 0 disables)
  --idle-timeout <sec>  No-events timeout while the model is thinking (default 300)
  --tool-timeout <sec>  No-events timeout while one tool call is running
                        (long builds are normal; default 1800)
  --timeout <min>       Hard wall clock for the whole job (default: 240)
  --watch               Open a terminal window mirroring the child's live
                        activity (writes pi-child-live.log in the cwd)
  --progress-log <p>    Path of the compact progress log — ALWAYS written,
                        one line per completed tool call (default
                        pi-child-progress.log in the cwd). Poll this file,
                        not the session jsonl.
  --expect-file <path>  Completion artifact: on settle, if this file does not
                        exist the run is NOT "completed" — autonomous mode
                        settle-steers then forks per budget; consult mode
                        parks (trigger "missing-expected-file"). Repeatable.
  --preamble <t>        Boilerplate prepended to the task before the child
                        sees it (standing rules). Applies to every prompt,
                        including fork re-prompts.
  --keep-question-tool  Do not exclude ask_user_question (child can then block
                        on extension-UI dialogs; you must answer them)
  --keep-delegate-tool  Do not exclude the acp_delegate* tools (by default
                        the child cannot spawn unsupervised sub-agents)
Resume from a consult file (instead of a task):
  --consult-file <p>    Consult file to resume from (usually
                        pi-child-consult.json; path is in the RESULT line)
  --action <a>          steer | fork | continue (required with --consult-file)
  --message <t>         Parent-authored message for --action steer|fork
  -h, --help            Show this help`;

const argv = process.argv.slice(2);
const positional = [];
let task = "";
let sessionArg = "";
let sessionRef = "";
let noSession = false;
let sessionDir = "";
let sessionName = "";
let provider = process.env.PI_PROVIDER || "";
let model = process.env.PI_MODEL || "";
let loopThreshold = 4;
let maxSteers = 3;
let maxForks = 2;
let steerMsg = "";
let forkNote = "";
let consult = false;
let consultFileArg = "";
let resumeAction = "";
let resumeMessage = "";
let maxErrors = 6;
let heartbeatN = 0;
let maxTextLen = 20000;
let idleTimeoutMs = 300 * 1000;
let toolTimeoutMs = 1800 * 1000;
let hardTimeoutMs = 240 * 60 * 1000;
let keepQuestionTool = false;
let watch = false;
let keepDelegateTool = false;
let progressLogArg = "";
const expectFiles = [];
let preamble = "";

const VALID_FLAGS = [
  "--task", "--session-id", "--session", "--no-session", "--session-dir",
  "--name", "--provider", "--model", "--loop-threshold", "--max-steers",
  "--max-forks", "--steer-msg", "--fork-note", "--consult", "--consult-file",
  "--action", "--message", "--max-errors", "--heartbeat", "--max-text",
  "--idle-timeout", "--tool-timeout", "--timeout", "--watch", "--progress-log",
  "--expect-file", "--preamble", "--keep-question-tool", "--keep-delegate-tool",
  "-h", "--help",
];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--task") task = argv[++i];
  else if (a === "--session-id") sessionArg = argv[++i];
  else if (a === "--session") sessionRef = argv[++i];
  else if (a === "--no-session") noSession = true;
  else if (a === "--session-dir") sessionDir = argv[++i];
  else if (a === "--name") sessionName = argv[++i];
  else if (a === "--provider") provider = argv[++i];
  else if (a === "--model") model = argv[++i];
  else if (a === "--loop-threshold") loopThreshold = Number(argv[++i]);
  else if (a === "--max-steers") maxSteers = Number(argv[++i]);
  else if (a === "--max-forks") maxForks = Number(argv[++i]);
  else if (a === "--steer-msg") steerMsg = argv[++i];
  else if (a === "--fork-note") forkNote = argv[++i];
  else if (a === "--consult") consult = true;
  else if (a === "--consult-file") consultFileArg = argv[++i];
  else if (a === "--action") resumeAction = argv[++i];
  else if (a === "--message") resumeMessage = argv[++i];
  else if (a === "--max-errors") maxErrors = Number(argv[++i]);
  else if (a === "--heartbeat") heartbeatN = Number(argv[++i]);
  else if (a === "--max-text") maxTextLen = Number(argv[++i]);
  else if (a === "--idle-timeout") idleTimeoutMs = Number(argv[++i]) * 1000;
  else if (a === "--tool-timeout") toolTimeoutMs = Number(argv[++i]) * 1000;
  else if (a === "--timeout") hardTimeoutMs = Number(argv[++i]) * 60 * 1000;
  else if (a === "--watch") watch = true;
  else if (a === "--progress-log") progressLogArg = argv[++i];
  else if (a === "--expect-file") expectFiles.push(argv[++i]);
  else if (a === "--preamble") preamble = argv[++i];
  else if (a === "--keep-question-tool") keepQuestionTool = true;
  else if (a === "--keep-delegate-tool") keepDelegateTool = true;
  else if (a === "-h" || a === "--help") {
    console.log(USAGE);
    process.exit(0);
  } else if (a === "--") {
    positional.push(...argv.slice(i + 1));
    break;
  } else if (a.startsWith("--")) {
    console.error(`error: unknown flag "${a}" — unknown flags used to be silently treated as task text`);
    console.error(`valid flags: ${VALID_FLAGS.join(" ")}`);
    console.error(`if your task text starts with --, put a bare -- before it`);
    process.exit(2);
  } else positional.push(a);
}

let resumePayload = null;
if (consultFileArg) {
  if (positional.length > 0 || task) {
    console.error("error: --consult-file resumes a run; do not pass a task argument");
    process.exit(2);
  }
  if (sessionArg || sessionRef || noSession) {
    console.error(
      "error: --consult-file sets the session itself; do not pass --session-id/--session/--no-session"
    );
    process.exit(2);
  }
  if (!["steer", "fork", "continue"].includes(resumeAction)) {
    console.error("error: --consult-file requires --action steer|fork|continue");
    process.exit(2);
  }
  if (resumeAction !== "continue" && !resumeMessage) {
    console.error("error: --action steer|fork requires --message <text>");
    process.exit(2);
  }
  try {
    resumePayload = JSON.parse(readFileSync(consultFileArg, "utf8"));
  } catch (e) {
    console.error(`error: cannot read consult file ${consultFileArg}: ${e.message}`);
    process.exit(2);
  }
  for (const k of [
    "task", "attempt", "steersUsed", "forksUsed", "loopsSeen",
    "maxSteers", "maxForks", "startTs", "hardTimeoutMs", "taskEntryId",
  ]) {
    if (resumePayload[k] === undefined) {
      console.error(`error: consult file missing field "${k}" — wrong or too-old file?`);
      process.exit(2);
    }
  }
  if (!resumePayload.sessionFile && !resumePayload.sessionId) {
    console.error("error: consult file has no session to resume (sessionFile/sessionId)");
    process.exit(2);
  }
  task = resumePayload.task;
}

const prompts = positional.length > 0 ? positional : [task];
if (!prompts.every((p) => p !== undefined && p !== "") || prompts.length === 0) {
  console.error("error: no task provided (check flag values) — a short/missing task usually means a misspelled flag or a dropped value");
  console.log(USAGE);
  process.exit(2);
}
task = prompts.join(" ");
if (!resumePayload && preamble) task = preamble + "\n\n" + task;
if (!resumePayload && task.length < 100) {
  process.stderr.write(
    `[warn] task suspiciously short (${task.length} chars) — check your invocation; ` +
      `unknown --flags are rejected, so a short task usually means a misspelled flag or a dropped value\n`
  );
}
if (consult && !resumePayload && noSession) {
  console.error("error: --consult requires a persisted session (not --no-session)");
  process.exit(2);
}
if (sessionRef && sessionArg) {
  console.error("error: --session-id and --session are mutually exclusive");
  console.log(USAGE);
  process.exit(2);
}
if (sessionRef && noSession) {
  console.error("error: --session and --no-session are mutually exclusive");
  console.log(USAGE);
  process.exit(2);
}
for (const [flag, value] of [
  ["--task", task],
  ["--session-id", sessionArg],
  ["--session-dir", sessionDir],
  ["--name", sessionName],
  ["--provider", provider],
  ["--model", model],
  ["--loop-threshold", loopThreshold],
  ["--max-steers", maxSteers],
  ["--max-forks", maxForks],
  ["--max-errors", maxErrors],
  ["--heartbeat", heartbeatN],
  ["--max-text", maxTextLen],
  ["--idle-timeout", idleTimeoutMs],
  ["--tool-timeout", toolTimeoutMs],
  ["--timeout", hardTimeoutMs],
]) {
  if (value === undefined || Number.isNaN(value)) {
    console.error(`error: ${flag} requires a (numeric) value`);
    console.log(USAGE);
    process.exit(2);
  }
}

// Locate the installed @earendil-works/pi-coding-agent package (same as the
// rpc-child.mjs harness: PI_PACKAGE_DIR > npm root -g > %APPDATA%\npm).
function resolvePackageDir() {
  const candidates = [];
  if (process.env.PI_PACKAGE_DIR) candidates.push(process.env.PI_PACKAGE_DIR);
  try {
    const root = execFileSync("npm", ["root", "-g", "--silent"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) candidates.push(join(root, "@earendil-works", "pi-coding-agent"));
  } catch {
    // npm not available — fall through
  }
  if (process.env.APPDATA) {
    candidates.push(
      join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent")
    );
  }
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, "dist", "index.js"))) return dir;
  }
  console.error(
    "error: could not locate @earendil-works/pi-coding-agent. " +
      "Set PI_PACKAGE_DIR to the directory containing dist/index.js."
  );
  process.exit(2);
}

const pkgDir = resolvePackageDir();
const cliPath = [join(pkgDir, "dist", "bundle", "cli.js"), join(pkgDir, "dist", "cli.js")].find(
  (p) => existsSync(p)
);
if (!cliPath) {
  console.error(`error: no cli entry found under ${pkgDir}/dist`);
  process.exit(2);
}

const { RpcClient } = await import(pathToFileURL(join(pkgDir, "dist", "index.js")).href);

// Sessions persist by default: an auto ID keeps runs resumable, and L2 forks
// need a persisted session file anyway (in-memory forks are lost on exit).
let sessionId = "";
if (!resumePayload && sessionArg) sessionId = sessionArg;
else if (!resumePayload && !sessionRef && !noSession) {
  sessionId = `sup-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
}

const args = [];
if (resumePayload) {
  // Resume: the consult file pins the exact session (file path preferred —
  // IDs only resolve per-cwd).
  args.push("--session", resumePayload.sessionFile || resumePayload.sessionId);
} else if (sessionId) args.push("--session-id", sessionId);
else if (sessionRef) args.push("--session", sessionRef);
else args.push("--no-session");
if (sessionDir) args.push("--session-dir", sessionDir);
if (sessionName && !resumePayload) args.push("--name", sessionName);
else if (sessionId) args.push("--name", sessionId); // auto-name = findable by ID
if (provider) args.push("--provider", provider);
if (model) args.push("--model", model);
{
  const excluded = [];
  if (!keepQuestionTool) excluded.push("ask_user_question");
  if (!keepDelegateTool) excluded.push("acp_delegate*"); // no unsupervised sub-agents
  if (excluded.length > 0) args.push("--exclude-tools", excluded.join(","));
}

const client = new RpcClient({ cliPath, args });

// ---------------------------------------------------------------------------
// Event plumbing: every child event lands in a queue the main loop drains with
// short ticks, so timers (idle/hard) can fire even when the child is silent.
// ---------------------------------------------------------------------------
const queue = [];
let wakeFn = null;
client.onEvent((ev) => {
  queue.push(ev);
  const w = wakeFn;
  wakeFn = null;
  if (w) w();
});
function nextEvent(timeoutMs) {
  if (queue.length > 0) return Promise.resolve(queue.shift());
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(queue.length > 0 ? queue.shift() : null);
    }, timeoutMs);
    wakeFn = () => {
      // onEvent pushed before calling this; a single waiter at a time.
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(queue.shift());
    };
  });
}

// --watch: mirror the child's activity to a live log file and open a terminal
// window tailing it (same mechanism as rpc-child.mjs).
if (watch) {
  const watchLog = join(process.cwd(), "pi-child-live.log");
  writeFileSync(watchLog, ""); // fresh file each run
  const wlog = (s) => {
    try { appendFileSync(watchLog, s); } catch { /* window/log best-effort */ }
  };
  client.onEvent((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      wlog(event.assistantMessageEvent.delta);
    } else if (event.type === "message_start") wlog(`\n[message: ${event.message?.role ?? "?"}]\n`);
    else if (event.type === "message_end") wlog("\n");
    else if (event.type === "turn_start") wlog("\n=== turn start ===\n");
    else if (event.type === "turn_end") wlog("\n=== turn end ===\n");
    else if (event.type === "tool_execution_start")
      wlog(`\n[tool] ${event.toolName} ${JSON.stringify(event.args ?? {}).slice(0, 300)}\n`);
    else if (event.type === "tool_execution_end") {
      const raw = typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? "");
      const dur = event.durationMs !== undefined ? ` (${event.durationMs}ms)` : "";
      wlog(`[tool${event.isError ? " ERROR" : " done"}] ${event.toolName}${dur} :: ${raw.slice(0, 500).replace(/\n/g, " ⏎ ")}\n`);
    } else if (event.type === "agent_settled") wlog("[settled]\n");
  });
  const tailCmd = `Get-Content '${watchLog}' -Wait -Encoding utf8`;
  let opened = null;
  try {
    const wtPath = execFileSync("where.exe", ["wt"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().split(/\r?\n/)[0];
    if (wtPath) {
      spawn(wtPath, ["new-tab", "powershell", "-NoExit", "-Command", tailCmd], {
        windowsHide: true,
        detached: true,
        stdio: "ignore",
      }).unref();
      opened = "Windows Terminal (wt new-tab)";
    }
  } catch { /* no wt — fall through */ }
  if (!opened) {
    try {
      const ps1 = join(tmpdir(), `pi-child-watch-${process.pid}.ps1`);
      writeFileSync(ps1, `Start-Process powershell -ArgumentList @('-NoExit','-Command','${tailCmd.replace(/'/g, "''")}')\r\n`);
      spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1], {
        windowsHide: true,
        detached: true,
        stdio: "ignore",
      }).unref();
      opened = "PowerShell Start-Process (new console window)";
    } catch { /* fall through */ }
  }
  process.stderr.write(
    opened
      ? `[watch] activity window opened via ${opened}; log: ${watchLog}\n`
      : `[watch] WARNING: could not open an activity window; log file: ${watchLog} (open it manually)\n`
  );
}

// ---------------------------------------------------------------------------
// Supervision state
// ---------------------------------------------------------------------------
let stateSessionId = "";
let stateSessionFile = "";
let checkpointId = null; // entry id of the CURRENT attempt's task message
let lastSig = null;
let loopCount = 0;
let pendingLoop = null; // {toolName, count} — threshold hit, escalation queued
let toolDepth = 0;
let lastToolName = "";
let lastEventAt = Date.now();
let startTs = 0;
let attempt = 1;
let steersUsed = 0;
let forksUsed = 0;
let loopsSeen = 0;
let abortedByMe = false;
let finalTextAcc = "";
let consultMode = consult;
let consultOutFile = "";
let consultOut = null; // last consult payload (surfaced in RESULT)
const recentCalls = []; // completed tool calls (ring, last 15)
const openCalls = [];   // in-flight tool calls
let errorStreak = 0;           // consecutive failing tool calls
let toolsSinceCheckpoint = 0;  // completed tool calls since start/resume
let textSinceTool = 0;         // chars of assistant text since the last tool call
let attemptTextChars = 0;      // chars of streamed assistant text since the last prompt
let attemptToolCalls = 0;      // tool calls started since the last prompt
let steersThisAttempt = 0;     // steers delivered in the current attempt
let sensorHold = null;         // autonomous sensor already fired; re-arms on next tool result
function resetAttemptCounters() {
  attemptTextChars = 0;
  attemptToolCalls = 0;
}

// Compact progress log — ALWAYS written (no flag). One line per completed
// tool call, plus [start]/[settled]/[result] markers. The parent session
// should poll THIS small file instead of parsing the (multi-MB) session
// jsonl. --watch's full mirror (pi-child-live.log) is separate and only
// written under --watch.
const progressLogPath = progressLogArg || join(process.cwd(), "pi-child-progress.log");
writeFileSync(progressLogPath, "");
const plog = (s) => { try { appendFileSync(progressLogPath, s); } catch { /* best effort */ } };
plog(
  `[start] ${new Date().toISOString()} task=${task.length}chars ` +
    `hard=${Math.round(hardTimeoutMs / 60000)}min session=${sessionId || "?"} ` +
    `consult=${consult ? "on" : "off"}\n`
);

function logSup(msg) {
  process.stderr.write(msg + "\n");
}

function fillTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

function consultAllowed(trigger) {
  const acts = [];
  // steer is available whenever the child is healthy (loop/error-loop/heartbeat/text-loop);
  // not for stall/external-abort, where a steer cannot reach a hung turn.
  if (
    (trigger === "loop" || trigger === "error-loop" || trigger === "heartbeat" ||
      trigger === "text-loop" || trigger === "degenerate-settle" ||
      trigger === "missing-expected-file") && steersUsed < maxSteers
  ) acts.push("steer");
  if (forksUsed < maxForks) acts.push("fork");
  acts.push("continue");
  return acts;
}

// Consult mode: hand the intervention to the parent session. The child is
// shut down orderly (finally → client.stop()); the session file persists, so
// the parent resumes via --consult-file. Sets outcome; caller breaks the loop.
async function doConsult(trigger, extra) {
  let lastText = "";
  try {
    lastText = (await client.getLastAssistantText())?.text ?? "";
  } catch { /* best effort */ }
  if (!lastText) lastText = finalTextAcc;
  const payload = {
    v: 1,
    at: new Date().toISOString(),
    trigger,
    ...extra,
    allowedActions: consultAllowed(trigger),
    task,
    attempt,
    steersUsed,
    forksUsed,
    loopsSeen,
    maxSteers,
    maxForks,
    startTs,
    hardTimeoutMs,
    sessionId: stateSessionId || null,
    sessionFile: stateSessionFile || null,
    taskEntryId: checkpointId,
    errorStreak,
    toolsSinceCheckpoint,
    charsSinceTool: textSinceTool,
    openToolCalls: openCalls,
    recentToolCalls: recentCalls.slice(-15),
    lastAssistantText: lastText.slice(0, 4000),
  };
  const p = join(process.cwd(), "pi-child-consult.json");
  writeFileSync(p, JSON.stringify(payload, null, 2));
  consultOutFile = p;
  consultOut = payload;
  outcome = `consult-${trigger}`;
  logSup(
    `[supervisor] CONSULT (${trigger}): payload → ${p}; allowed actions: ` +
      `${payload.allowedActions.join("|")}. The child is being shut down orderly; ` +
      `the session persists — resume with --consult-file to steer.`
  );
}

function handleEvent(ev) {
  if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
    process.stdout.write(ev.assistantMessageEvent.delta);
    finalTextAcc += ev.assistantMessageEvent.delta;
    textSinceTool += ev.assistantMessageEvent.delta.length;
    attemptTextChars += ev.assistantMessageEvent.delta.length;
  } else if (ev.type === "tool_execution_start") {
    toolDepth++;
    attemptToolCalls++;
    textSinceTool = 0;
    lastToolName = ev.toolName;
    logSup(`[child tool: ${ev.toolName}] ${JSON.stringify(ev.args ?? {}).slice(0, 200)}`);
    openCalls.push({ tool: ev.toolName, args: JSON.stringify(ev.args ?? {}).slice(0, 300) });
    const sig = ev.toolName + "\x1f" + JSON.stringify(ev.args ?? {});
    if (sig === lastSig) loopCount++;
    else {
      lastSig = sig;
      loopCount = 1;
    }
    if (loopCount >= loopThreshold && !pendingLoop) {
      pendingLoop = { toolName: ev.toolName, count: loopCount };
    }
  } else if (ev.type === "tool_execution_end") {
    if (toolDepth > 0) toolDepth--;
    const c = openCalls.pop();
    if (c) {
      c.isError = !!ev.isError;
      if (ev.durationMs !== undefined) c.durationMs = ev.durationMs;
      const rawRes = typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result ?? "");
      c.result = rawRes.slice(0, 300);
      errorStreak = c.isError ? errorStreak + 1 : 0;
      toolsSinceCheckpoint++;
      recentCalls.push(c);
      if (recentCalls.length > 15) recentCalls.shift();
      sensorHold = null; // re-arm autonomous sensors after new tool activity
      plog(
        `[tool] ${new Date().toISOString()} tools=${toolsSinceCheckpoint} ` +
          `${c.tool}${c.isError ? " ERR" : ""}${c.durationMs !== undefined ? " " + c.durationMs + "ms" : ""}\n`
      );
    }
  } else if (ev.type === "extension_ui_request") {
    if (["select", "confirm", "input", "editor"].includes(ev.method)) {
      logSup(
        `[WARN] child blocked on extension-UI dialog (method=${ev.method}, id=${ev.id}); ` +
          `it will hang until answered — use --keep-question-tool deliberately`
      );
    }
  }
}

// Entry id of the last user message = checkpoint for "branch from before the
// current attempt". Must be a user message (pi's fork requires it).
async function findCheckpoint() {
  try {
    const { entries } = await client.getEntries();
    for (let i = (entries?.length ?? 0) - 1; i >= 0; i--) {
      const e = entries[i];
      if (e && e.type === "message" && e.message && e.message.role === "user") return e.id;
    }
  } catch (e) {
    logSup(`[supervisor] getEntries failed: ${e.message}`);
  }
  return null;
}

async function doSteer(pl) {
  steersUsed++;
  steersThisAttempt++;
  loopsSeen++;
  pendingLoop = null;
  lastSig = null;
  loopCount = 0;
  const msg = steerMsg
    ? fillTemplate(steerMsg, { tool: pl.toolName, count: pl.count })
    : `You are repeating yourself: the tool call \`${pl.toolName}\` with the same arguments has ` +
      `now occurred ${pl.count} times in a row without progress. Stop. Reassess the situation, ` +
      `pick a DIFFERENT concrete next step, and continue with the original task. Do not repeat ` +
      `that failing call; if the task cannot proceed, say exactly where it is blocked.`;
  logSup(`[supervisor] L1 steer #${steersUsed}/${maxSteers}: loop on ${pl.toolName} x${pl.count}`);
  const disp = await client.steer(msg);
  logSup(`[supervisor] steer disposition=${disp}`);
}

// L2: abort + fork(before the task message) + re-prompt. The fork creates a NEW
// session file whose context ends right before the current attempt — the loop
// history is discarded, everything earlier is kept ("branch from an earlier
// message"). If we have no checkpoint (or --no-session), degrade to abort +
// re-prompt in the same session.
async function doFork(reason) {
  forksUsed++;
  if (pendingLoop) loopsSeen++;
  pendingLoop = null;
  logSup(`[supervisor] L2 fork #${forksUsed}/${maxForks}: ${reason}`);
  abortedByMe = true;
  toolDepth = 0;
  resetAttemptCounters();
  steersThisAttempt = 0;
  sensorHold = null;
  try {
    await client.abort();
  } catch (e) {
    logSup(`[supervisor] abort warn: ${e.message}`);
  }
  try {
    await client.clearQueue();
  } catch { /* best effort */ }
  if (checkpointId) {
    try {
      const r = await client.fork(checkpointId);
      if (r && r.cancelled) logSup("[supervisor] fork cancelled by an extension; retrying in place");
    } catch (e) {
      logSup(`[supervisor] fork failed (${e.message}); retrying in the same session`);
    }
  } else {
    logSup("[supervisor] no checkpoint available; retrying in the same session");
  }
  try {
    const st = await client.getState();
    if (st) {
      stateSessionId = st.sessionId ?? stateSessionId;
      stateSessionFile = st.sessionFile ?? stateSessionFile;
    }
  } catch { /* best effort */ }
  logSup(`[supervisor] session now id=${stateSessionId || "?"} file=${stateSessionFile || "?"}`);
  attempt++;
  finalTextAcc = "";
  const note = forkNote
    ? fillTemplate(forkNote, { reason })
    : `A previous attempt at this task ${reason}. That approach is exhausted — do NOT repeat it. ` +
      `Break the work into smaller steps, verify assumptions as you go, and if you cannot proceed, ` +
      `finish with a clear explanation of exactly where it is blocked.`;
  await client.prompt(task + "\n\n" + note);
  checkpointId = await findCheckpoint();
  lastSig = null;
  loopCount = 0;
  toolDepth = 0;
  lastEventAt = Date.now();
}

// Settle quality. A healthy completion ends with a written report; a model
// that cut out mid-thought ends on a thinking-only (or empty) message with no
// report. Both were observed in the wild and must not count as "completed".
// inspectSettle() inspects only the LAST assistant message (its text and
// thinking content); the degenerate decision in the main loop combines it with
// the attempt-scoped counters (text streamed + tool calls since the last
// prompt), so a stray thinking-only tail after a real answer is NOT flagged.
async function inspectSettle() {
  const info = { textChars: 0, thinkingChars: 0 };
  try {
    info.textChars = ((await client.getLastAssistantText())?.text ?? "").trim().length;
  } catch { /* best effort */ }
  try {
    const { entries } = await client.getEntries();
    const list = entries ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e?.type === "message" && e.message?.role === "assistant") {
        for (const b of e.message?.content ?? []) {
          if (b?.type === "thinking") info.thinkingChars += (b.thinking ?? "").length;
        }
        break;
      }
    }
  } catch (e) {
    logSup(`[supervisor] settle inspection warn: ${e.message}`);
  }
  return info;
}

// A settle-time corrective prompt (cheaper than a fork): the child is idle
// between turns, so a plain prompt starts a new turn in the same session.
async function doDegenerateSteer(dReason, missing) {
  steersUsed++;
  steersThisAttempt++;
  resetAttemptCounters();
  const msg =
    missing.length > 0
      ? `[supervisor] You ended your turn without creating the required file(s): ${missing.join(", ")}. ` +
        `Create them, then finish with a clear written status update.`
      : `[supervisor] You ended your turn ${dReason}. That is not a valid completion — continue ` +
        `the task from where you left off and finish with a clear written status update.`;
  logSup(
    `[supervisor] L1 settle-steer #${steersUsed}/${maxSteers}: ` +
      `${missing.length > 0 ? "missing expected file(s)" : "degenerate settle"}`
  );
  const disp = await client.prompt(msg);
  logSup(`[supervisor] settle-steer disposition=${disp}`);
}

let exitCode = 1;
let outcome = "error";
try {
  if (provider && model) {
    logSup(`[info] child provider=${provider} model=${model}`);
  } else {
    logSup("[warn] no PI_PROVIDER/PI_MODEL in env; child will use configured defaults");
  }
  logSup(`[info] starting supervised child: ${cliPath} --mode rpc ${args.join(" ")}`);
  logSup(
    `[supervisor] loop-threshold=${loopThreshold} max-steers=${maxSteers} max-forks=${maxForks} ` +
      `idle=${Math.round(idleTimeoutMs / 1000)}s tool=${Math.round(toolTimeoutMs / 1000)}s ` +
      `hard=${Math.round(hardTimeoutMs / 60000)}min`
  );
  logSup(
    `[supervisor] task: ${task.length} chars — "${task.slice(0, 160).replace(/\s+/g, " ")}${task.length > 160 ? "…" : ""}"`
  );
  if (expectFiles.length > 0) logSup(`[supervisor] expected files: ${expectFiles.join(", ")}`);
  logSup(`[supervisor] progress log: ${progressLogPath}`);
  if (loopThreshold >= 5) {
    logSup(
      "[supervisor] NOTE: threshold >= 5 means the host repetition guard " +
        "(default abort=5, see acp.json `repetitionGuard`) usually aborts the " +
        "turn before your steer fires; external aborts are still recovered via fork"
    );
  }
  await client.start();

  try {
    const st = await client.getState();
    if (st) {
      stateSessionId = st.sessionId ?? "";
      stateSessionFile = st.sessionFile ?? "";
    }
  } catch { /* diagnostic only */ }
  logSup(`[info] session id=${stateSessionId || "?"} file=${stateSessionFile || "?"}`);

  startTs = Date.now();
  lastEventAt = startTs;
  if (resumePayload) {
    // Resume from a consult file: budgets, attempt count and the hard wall
    // clock come from the file, not from flags, so they carry across resumes.
    attempt = resumePayload.attempt ?? 1;
    steersUsed = resumePayload.steersUsed ?? 0;
    forksUsed = resumePayload.forksUsed ?? 0;
    loopsSeen = resumePayload.loopsSeen ?? 0;
    maxSteers = resumePayload.maxSteers ?? maxSteers;
    maxForks = resumePayload.maxForks ?? maxForks;
    startTs = resumePayload.startTs ?? startTs;
    hardTimeoutMs = resumePayload.hardTimeoutMs ?? hardTimeoutMs;
    checkpointId = resumePayload.taskEntryId ?? null;
    lastEventAt = Date.now();
    resetAttemptCounters();
    logSup(
      `[supervisor] RESUME (action=${resumeAction}) attempt=${attempt} ` +
        `steers=${steersUsed}/${maxSteers} forks=${forksUsed}/${maxForks} session=${stateSessionId || "?"}`
    );
    if (resumeAction === "fork") {
      if (!checkpointId) {
        console.error("error: consult file has no taskEntryId; cannot fork");
        process.exit(1);
      }
      forksUsed++;
      attempt++;
      try {
        const r = await client.fork(checkpointId);
        if (r && r.cancelled) logSup("[supervisor] fork cancelled by an extension; continuing in the same session");
      } catch (e) {
        logSup(`[supervisor] fork failed (${e.message}); continuing in the same session`);
      }
      try {
        const st = await client.getState();
        if (st) {
          stateSessionId = st.sessionId ?? stateSessionId;
          stateSessionFile = st.sessionFile ?? stateSessionFile;
        }
      } catch { /* best effort */ }
      logSup(`[supervisor] session now id=${stateSessionId || "?"} file=${stateSessionFile || "?"}`);
      const d = await client.prompt(task + "\n\n" + resumeMessage);
      logSup(`[supervisor] fork re-prompt disposition=${d}`);
      checkpointId = await findCheckpoint();
    } else if (resumeAction === "steer") {
      steersUsed++;
      const d = await client.prompt(resumeMessage);
      logSup(`[supervisor] steer disposition=${d}`);
    } else {
      // continue: hand the remaining budget to the built-in ladder
      const d = await client.prompt(
        "[supervisor] Supervision was paused and has now resumed. Continue the original task from where you left off."
      );
      logSup(`[supervisor] continue disposition=${d}`);
      consultMode = false;
    }
  } else {
    resetAttemptCounters();
    const disp0 = await client.prompt(task);
    logSup(`[supervisor] prompt disposition=${disp0}`);
    checkpointId = await findCheckpoint();
    if (!checkpointId) {
      logSup("[supervisor] WARN: no checkpoint entry found; L2 forks will retry in place");
    }
  }

  let settled = false;
  while (!settled) {
    const ev = await nextEvent(250);
    const now = Date.now();
    if (ev) {
      lastEventAt = now;
      if (ev.type === "agent_settled") {
        plog(`[settled] ${new Date().toISOString()} aborted=${ev.aborted ? "yes" : "no"}\n`);
        if (ev.aborted) {
          if (!abortedByMe) {
            // External abort — most commonly the host repetition guard
            // refusing the Nth identical call and aborting the turn.
            // Recoverable: fork + retry (new session = fresh guard counter).
            if (consultMode && forksUsed < maxForks) {
              await doConsult("external-abort", {
                detail: "the host aborted the turn (repetition guard or external abort)",
              });
              break;
            }
            if (forksUsed < maxForks) {
              await doFork(
                "aborted mid-run by the host (repetition guard or external abort)"
              );
              continue;
            }
            outcome = "aborted-external";
            break;
          }
          // Expected settle from our own abort (L2) — the new attempt is
          // (or will be) re-prompted; keep waiting for its settle.
        } else {
          // Normal settle. Accepting "completed" requires: (a) the attempt
          // is not degenerate, and (b) every --expect-file artifact exists.
          // Degenerate shapes (both observed in the wild):
          //   emptyStop  — the attempt produced NOTHING (no streamed text,
          //                no tool calls): the model stopped immediately.
          //   strayTail  — the last message is thinking-only (no text) AND
          //                the attempt barely reported (<200 chars of text).
          // A thinking-only tail AFTER a real answer is a local-model quirk,
          // not a failure — it is deliberately not flagged (calibrated in the
          // 2026-10-15 live test: real answers end on stray thinking tails).
          const si = await inspectSettle();
          const emptyStop = attemptTextChars === 0 && attemptToolCalls === 0;
          const strayTail = si.textChars === 0 && si.thinkingChars > 0 && attemptTextChars < 200;
          const degenerate = emptyStop || strayTail;
          const missing = expectFiles.filter((f) => !existsSync(f));
          if (degenerate || missing.length > 0) {
            const dReason = emptyStop
              ? `with no text and no tool activity`
              : `with a thinking-only final message (${si.thinkingChars} chars of thinking) after only ${attemptTextChars} chars of attempt text`;
            if (degenerate) logSup(`[supervisor] degenerate settle: ended ${dReason}`);
            if (missing.length > 0) logSup(`[supervisor] missing expected file(s): ${missing.join(", ")}`);
            const trigger = missing.length > 0 ? "missing-expected-file" : "degenerate-settle";
            if (consultMode && (steersUsed < maxSteers || forksUsed < maxForks)) {
              await doConsult(trigger, {
                detail: missing.length > 0
                  ? `settle with missing expected file(s): ${missing.join(", ")}`
                  : `settle ${dReason}`,
                settle: si,
                missing,
              });
              break;
            }
            if (steersUsed < maxSteers) {
              await doDegenerateSteer(dReason, missing);
              continue;
            }
            if (forksUsed < maxForks) {
              await doFork(
                missing.length > 0
                  ? `ended without creating the required file(s): ${missing.join(", ")}`
                  : `ended its turn ${dReason} — not a completion`
              );
              continue;
            }
            outcome = trigger;
            break;
          }
          settled = true;
          outcome = "completed";
          abortedByMe = false;
          break;
        }
        continue;
      }
      handleEvent(ev);
    }
    if (now - startTs > hardTimeoutMs) {
      outcome = "hard-timeout";
      break;
    }
    if (pendingLoop) {
      if (consultMode && (steersUsed < maxSteers || forksUsed < maxForks)) {
        await doConsult("loop", { loop: { tool: pendingLoop.toolName, count: pendingLoop.count } });
        break;
      }
      if (steersUsed < maxSteers) {
        await doSteer(pendingLoop);
        continue;
      }
      if (forksUsed < maxForks) {
        await doFork(`looped repeatedly on \`${pendingLoop.toolName}\` (${pendingLoop.count}+ identical calls in a row)`);
        continue;
      }
      outcome = "stuck-loop";
      break;
    }
    // Sensors beyond loop/stall/external-abort: consecutive error streaks
    // (--max-errors), long narration without a tool call (--max-text), and —
    // consult mode only — periodic heartbeat (--heartbeat, a parent-review
    // mechanism, not a failure condition).
    //   consult mode:    any hit PARKS the run for the parent (doConsult).
    //   autonomous mode: error-loop and text-loop run the normal ladder —
    //                    steer once, then fork per budget.
    if (!pendingLoop && !sensorHold) {
      let sensor = null;
      if (maxErrors > 0 && errorStreak >= maxErrors) {
        sensor = { kind: "error-loop", detail: `${errorStreak} consecutive tool calls failed` };
      } else if (consultMode && heartbeatN > 0 && toolsSinceCheckpoint >= heartbeatN) {
        sensor = { kind: "heartbeat", detail: `${toolsSinceCheckpoint} tool calls since the last checkpoint` };
      } else if (maxTextLen > 0 && textSinceTool >= maxTextLen) {
        sensor = { kind: "text-loop", detail: `${textSinceTool} chars of assistant text since the last tool call — the model may be stuck in a thinking loop` };
      }
      if (sensor) {
        if (consultMode) {
          if (sensor.kind === "heartbeat" || steersUsed < maxSteers || forksUsed < maxForks) {
            await doConsult(sensor.kind, { detail: sensor.detail });
            break;
          }
        } else if (steersUsed < maxSteers) {
          sensorHold = sensor.kind;
          steersUsed++;
          loopsSeen++;
          const msg = sensor.kind === "error-loop"
            ? `[supervisor] ${sensor.detail}. Stop repeating the failing approach: change your method or verify an assumption, then continue. If it cannot work, say exactly where it is blocked.`
            : `[supervisor] You have written ${textSinceTool} chars of text without taking a tool action. Stop narrating and take the next concrete action with a tool call.`;
          logSup(`[supervisor] L1 ${sensor.kind} steer #${steersUsed}/${maxSteers}: ${sensor.detail}`);
          const disp = await client.steer(msg);
          logSup(`[supervisor] ${sensor.kind} steer disposition=${disp}`);
          continue;
        } else if (forksUsed < maxForks) {
          await doFork(`${sensor.kind}: ${sensor.detail}`);
          continue;
        } else {
          outcome = `stuck-${sensor.kind}`;
          break;
        }
      }
    }
    const inTool = toolDepth > 0;
    const idleLimit = inTool ? toolTimeoutMs : idleTimeoutMs;
    if (now - lastEventAt > idleLimit) {
      const what = inTool
        ? `no events for ${Math.round(idleLimit / 1000)}s during tool call \`${lastToolName}\``
        : `no events for ${Math.round(idleLimit / 1000)}s (model stalled or hung)`;
      if (consultMode && forksUsed < maxForks) {
        await doConsult("stall", { detail: what, inTool, lastTool: lastToolName, idleMs: now - lastEventAt });
        break;
      }
      if (forksUsed < maxForks) {
        await doFork(`stalled (${what})`);
        continue;
      }
      outcome = "stuck-idle";
      break;
    }
  }

  let finalText = "";
  try {
    finalText = (await client.getLastAssistantText())?.text ?? "";
  } catch { /* best effort */ }
  if (!finalText) finalText = finalTextAcc.trim();

  const isConsult = outcome.startsWith("consult-");
  const result = {
    status: outcome === "completed" ? "completed" : isConsult ? "consult" : "stuck",
    exitReason: outcome,
    task: task.length > 200 ? task.slice(0, 200) + `…(+${task.length - 200} chars)` : task,
    taskChars: task.length,
    attempts: attempt,
    interventions: { steers: steersUsed, forks: forksUsed, loopsSeen },
    sessionId: stateSessionId || null,
    sessionFile: stateSessionFile || null,
    finalText: finalText.slice(0, 4000),
    finalTextTruncated: finalText.length > 4000,
    settle: {
      attemptTextChars,
      attemptToolCalls,
      lastMessageTextChars: finalText.length,
      errorStreakAtEnd: errorStreak,
    },
    expectedFiles: expectFiles.length > 0 ? expectFiles : undefined,
    progressLog: progressLogPath,
    elapsedMs: Date.now() - startTs,
    recentToolCalls: recentCalls.slice(-15),
  };
  if (isConsult && consultOut) {
    result.consultFile = consultOutFile;
    result.trigger = consultOut.trigger;
    result.allowedActions = consultOut.allowedActions;
  }
  plog(`[result] ${new Date().toISOString()} status=${result.status} exitReason=${outcome} attempts=${attempt}\n`);
  process.stdout.write(`\n=== RESULT === ${JSON.stringify(result)}\n`);
  exitCode = outcome === "completed" ? 0 : isConsult ? 4 : 3;
} catch (err) {
  logSup(`\n[error] ${err.message}`);
  exitCode = 1;
} finally {
  await client.stop().catch(() => {});
}
process.exit(exitCode);
