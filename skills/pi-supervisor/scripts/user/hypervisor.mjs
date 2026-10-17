#!/usr/bin/env node
// hypervisor.mjs (user variant) — run the pi-supervisor stack as a DEDICATED
// STANDARD local user (default "agent") over an SSH loopback connection.
// No admin, no elevation, no UAC prompt, no Docker, no Hyper-V, no integrity
// downgrade. Confinement comes from NTFS deny ACEs that were applied once at
// setup (see the "Dedicated-user sandbox" section of SKILL.md).
//
// Architecture (3 layers, all on this host):
//
//   Host user (this file, node)
//     |- stages guard.mjs + runner.mjs + selftest.ps1 into --stage
//        (default C:\ProgramData\pi-supervisor — host-writable, user-readable)
//     |- health-checks the model endpoint
//     `- ssh -i <key> -T <user>@127.0.0.1 "node <stage>\runner.mjs --spec <b64>"
//          |- bootstraps the user's agent config (<home>/.pi/models.json,
//             auth.json, settings.json, .gitconfig with safe.directory)
//          `- node guard.mjs <supArgs> [task]   (supervisor + child pi
//             run as the dedicated user, cwd = --project)
//
// What the dedicated user confines (verified by --selftest):
//   - writes to the project dir and the user's own profile: ALLOWED
//   - everything OUTSIDE the project subtree: reads mode --reads
//       deny  (default) = DENIED, reads AND writes (full (OI)(CI)F denies)
//       allow = default Windows ACLs — on this machine E: allows both reads
//               and writes (the account behaves like a normal logged-on
//               user; C:\Users\<host> stays blocked by its profile DACL)
//     Applied idempotently before every run via apply-denies.ps1 (skipped
//     when the sibling probe shows the tree is already in the requested
//     mode); the selftest verifies the ACTIVE mode and fails loudly on
//     mismatch. Note: "allow reads, deny writes" is NOT expressible with
//     icacls deny masks on this Windows build (probed: every write-mask
//     deny also blocks reads), hence the two modes above.
//   - the user's own .pi dir is where ALL child state lives (sessions, logs)
//   - network access is NOT restricted (same as the integrity variant)
//   - the user can still execute any host program (standard-user level)
//
// One-time prerequisites (see SKILL.md):
//   1. a standard local account (default "agent") with an SSH key you control
//      in its %USERPROFILE%\.ssh\authorized_keys (or a known password for the
//      first login)
//   2. reads-mode ACEs (the hypervisor applies them automatically before
//      every run via apply-denies.ps1; manual form:
//      `powershell -File apply-denies.ps1 -User agent -Project <dir>
//      -Reads deny|allow -Apply`)
//   3. pi installed for that account: `node hypervisor.mjs --setup`
//
// Usage:
//   node hypervisor.mjs --key <sshkey> --project <dir> "task"
//
//   Supervisor options (--timeout, --expect-file, --loop-threshold,
//   --max-forks, --max-errors, --consult, ...) are passed through unchanged;
//   see guard.mjs --help. The task is the first positional arg or --task.
//
// Exit codes: supervisor's own (0 completed, 1 infrastructure, 2 usage,
// 3 stuck, 4 consult), 90 = setup/health failure, 91 = ssh spawn failure.

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { detectReadsMode } from "./reads-probe.mjs";

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USER_DIR = join(SCRIPTS_DIR, "user");
const SUPERVISOR = join(SCRIPTS_DIR, "guard.mjs");

function die(msg, code) {
  console.error(msg);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// CLI (strict; unknown --flags are passed to guard.mjs verbatim)
// ---------------------------------------------------------------------------
const RESERVABLE = new Set([
  "user", "key", "project", "model", "model-input", "provider", "model-base-url", "api-key",
  "context-window", "task", "selftest", "setup", "stage", "skip-health",
  "skip-latency", "log", "host", "reads", "help", "h",
]);
const opt = {
  user: "agent",
  key: "",
  host: "127.0.0.1",
  project: "",
  model: process.env.PI_MODEL || "",
  modelInput: "", // comma list: text,image,audio,video (declared in the child's models.json)
  provider: "localllama", // fresh id: the child gets its own agent dir, so nothing collides
  modelBaseUrl: "http://127.0.0.1:8080/v1",
  apiKey: "local",
  contextWindow: 262144,
  task: "",
  selftest: false,
  setup: false,
  stage: "C:\\ProgramData\\pi-supervisor",
  skipHealth: false,
  skipLatency: false,
  log: "pi-child-hypervisor.log",
  reads: "deny",
};
const supArgs = [];
let task = "";

function usage() {
  console.log(`user/hypervisor.mjs — run guard.mjs as a dedicated standard user over SSH (no admin, no docker)

options:
  --user <name>          dedicated account (default "agent")
  --key <path>           SSH private key for that account (required for run; the
                         public half must be in the account's .ssh\\authorized_keys)
  --host <addr>          ssh target (default 127.0.0.1 — loopback only)
  --project <dir>        working directory the child runs in (required for run)
  --model <id>           model id (default $PI_MODEL)
  --model-input <csv>    input modalities declared in the child's models.json
                         (comma list from text,image,audio,video). Without it
                         pi's default declaration applies — on a text-only
                         default the child CANNOT be fed images even when the
                         server supports them (the classic silent failure).
  --provider <id>        provider id registered in the child's models.json (default "localllama")
  --model-base-url <u>   model endpoint (default http://127.0.0.1:8080/v1)
  --api-key <k>          (default "local")
  --context-window <n>   (default 262144)
  --task <text>          task text (or first positional)
  --stage <dir>          staging dir the account can read (default C:\\ProgramData\\pi-supervisor)
  --setup                one-time: install pi for the account (npm i -g), then exit
  --selftest             verify confinement + toolchain as the account, then exit
  --skip-health          skip the model endpoint health check
  --skip-latency         skip the preflight latency probe (one small timed
                         completion; logs tok/s so you can size --timeout)
  --log <file>           log file name (default pi-child-hypervisor.log in project)
  --reads deny|allow     outside reads mode, applied idempotently via
                         apply-denies.ps1 before every run (skipped if the
                         tree is already in this mode). Default "deny":
                         deny  = the account can neither read nor write
                                 anything outside the project (sealed)
                         allow = the account gets the default Windows ACLs
                                 outside (on this machine E: allows both
                                 reads and writes)
  <task>                 positional task text
  everything else        passed through to guard.mjs (see its --help)

examples:
  node hypervisor.mjs --key C:\\keys\\agent_key --project E:\\Projects\\Foo "add the feature; run the tests"
  node hypervisor.mjs --key C:\\keys\\agent_key --selftest --project E:\\Projects\\Foo
  node hypervisor.mjs --key C:\\keys\\agent_key --setup
`);
}

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--help" || a === "-h") { usage(); process.exit(0); }
  if (!a.startsWith("--")) {
    if (!task && !opt.task) task = a;
    else die(`error: unexpected positional argument (task already given): ${a}`, 2);
    continue;
  }
  const name = a.slice(2);
  if (!RESERVABLE.has(name)) {
    supArgs.push(a);
    if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { supArgs.push(argv[i + 1]); i++; }
    continue;
  }
  const v = argv[i + 1];
  if (v === undefined || (v.startsWith("--") && RESERVABLE.has(v.slice(2)))) {
    if (name === "selftest") { opt.selftest = true; continue; }
    if (name === "setup") { opt.setup = true; continue; }
    if (name === "skip-health") { opt.skipHealth = true; continue; }
    if (name === "skip-latency") { opt.skipLatency = true; continue; }
    die(`error: --${name} needs a value`, 2);
  }
  switch (name) {
    case "user": opt.user = v; break;
    case "key": opt.key = v; break;
    case "host": opt.host = v; break;
    case "project": opt.project = resolve(v); break;
    case "model": opt.model = v; break;
    case "model-input": opt.modelInput = v; break;
    case "provider": opt.provider = v; break;
    case "model-base-url": opt.modelBaseUrl = v; break;
    case "api-key": opt.apiKey = v; break;
    case "context-window": opt.contextWindow = Number(v) || 0; break;
    case "task": opt.task = v; break;
    case "selftest": opt.selftest = true; break;
    case "setup": opt.setup = true; break;
    case "stage": opt.stage = resolve(v); break;
    case "skip-health": opt.skipHealth = true; break;
    case "skip-latency": opt.skipLatency = true; break;
    case "log": opt.log = v; break;
    case "reads":
      if (v !== "deny" && v !== "allow") die(`error: --reads must be "deny" or "allow" (got "${v}")`, 2);
      opt.reads = v; break;
    default: break;
  }
  i++;
}
if (opt.task) task = opt.task;
if (!task && !opt.selftest && !opt.setup) { usage(); die("error: no task (positional or --task)", 2); }
if (opt.contextWindow <= 0) die("error: --context-window must be > 0", 2);
const MODEL_INPUTS = ["text", "image", "audio", "video"];
let modelInputs = [];
if (opt.modelInput) {
  modelInputs = opt.modelInput.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = modelInputs.filter((m) => !MODEL_INPUTS.includes(m));
  if (bad.length > 0) die(
    `error: --model-input has unknown modalities: ${bad.join(", ")} (allowed: ${MODEL_INPUTS.join(", ")})`, 2
  );
}
if (!opt.model && !opt.selftest && !opt.setup) die("error: no model — pass --model or set $PI_MODEL", 2);
if (!opt.key && !opt.setup) die("error: --key <path> required (SSH private key for the dedicated account)", 2);
if (opt.key && !existsSync(opt.key)) die(`error: --key not found: ${opt.key}`, 2);
if (!opt.project && !opt.selftest && !opt.setup) die("error: --project <dir> required", 2);
if (opt.project && !existsSync(opt.project)) die(`error: --project not found: ${opt.project}`, 2);

const logPath = opt.project ? (isAbsolute(opt.log) ? opt.log : join(opt.project, opt.log)) : "";
const startedAt = Date.now();

function log(msg) {
  const line = `[hypervisor] ${msg}`;
  process.stderr.write(line + "\n");
  if (logPath) { try { appendFileSync(logPath, line + "\n"); } catch { /* best-effort */ } }
}

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------
function sshArgs() {
  const a = ["-T", "-i", opt.key, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"];
  return a;
}
function sshTarget() {
  return `${opt.user}@${opt.host}`;
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------
function stage() {
  mkdirSync(opt.stage, { recursive: true });
  for (const f of ["guard.mjs", "runner.mjs", "selftest.ps1"]) {
    const src = f === "guard.mjs" ? SUPERVISOR : join(USER_DIR, f);
    if (!existsSync(src)) die(`error: missing skill file: ${src}`, 90);
    copyFileSync(src, join(opt.stage, f));
  }
  log(`staged guard.mjs + runner.mjs + selftest.ps1 -> ${opt.stage}`);
}

// ---------------------------------------------------------------------------
// Reads mode — apply-denies.ps1 (runs locally as the host user, idempotent)
// ---------------------------------------------------------------------------
// NOTE: detectReadsMode() lives in reads-probe.mjs (shared with the CLI and
// the unit tests). It classifies only EXPLICIT agent ACEs — INHERITED ones
// (agent:(I)...) come from out-of-scope ancestors and are not mode state.
function applyReadsMode() {
  const cur = detectReadsMode({ user: opt.user, project: opt.project });
  if (cur === opt.reads) {
    log(`reads mode already "${opt.reads}" (sibling probe) — skipping apply-denies.ps1`);
    return;
  }
  const ps = join(USER_DIR, "apply-denies.ps1");
  if (!existsSync(ps)) die(`error: missing skill file: ${ps}`, 90);
  log(`applying reads mode "${opt.reads}" (detected: ${cur}) via apply-denies.ps1 ...`);
  const t = Date.now();
  const r = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps,
    "-User", opt.user,
    "-Project", opt.project,
    "-Reads", opt.reads,
    "-Apply",
  ], { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) {
    die(`error: apply-denies.ps1 exited ${r.status} — ACLs may be inconsistent; not launching the child`, 90);
  }
  log(`reads mode "${opt.reads}" applied in ${Math.round((Date.now() - t) / 1000)}s`);
}

// ---------------------------------------------------------------------------
// Model health
// ---------------------------------------------------------------------------
async function httpGet(url, timeoutMs = 5000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: "", err: e.message };
  }
}
function modelsUrl(baseUrl) {
  const b = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return /\/v\d+$/.test(b) ? `${b}/models` : `${b}/v1/models`;
}
async function modelHealth() {
  const url = modelsUrl(opt.modelBaseUrl);
  const r = await httpGet(url);
  if (!r.ok) return { ok: false, reason: r.err ? `unreachable (${r.err})` : `HTTP ${r.status}`, url };
  let ids = [];
  try { ids = ((JSON.parse(r.text).data) || []).map((m) => m.id); } catch { /* non-JSON */ }
  return { ok: true, url, ids };
}

// Preflight latency probe: one small completion, timed. The endpoint can be
// "healthy" (list models) while generating at 0.5 tok/s — that fact is only
// visible after an hour of child work, and it re-scopes the task (fewer
// candidates, bigger --timeout). Non-fatal: a probe failure just logs a note.
async function latencyProbe(baseUrl, model, timeoutMs = 180000) {
  const b = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const url = /\/v\d+$/.test(b) ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        max_tokens: 16,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text().catch(() => "");
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, ms };
    let tokens = 0;
    try { tokens = JSON.parse(text).usage?.completion_tokens ?? 0; } catch { /* non-JSON */ }
    if (!tokens) tokens = 16;
    return { ok: true, ms, tokens, tps: tokens / (ms / 1000) };
  } catch (e) {
    return {
      ok: false,
      reason: /abort|timeout/i.test(e.message ?? "") ? `no completion in ${Math.round(timeoutMs / 1000)}s` : e.message,
    };
  }
}

// ---------------------------------------------------------------------------
// Remote bootstrap + run
// ---------------------------------------------------------------------------
let remoteProc = null;
function killTree() {
  if (!remoteProc) return;
  try {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(remoteProc.pid)], { stdio: "ignore" });
  } catch { /* already dead */ }
}

function supervisorArgs() {
  const a = [...supArgs];
  if (task) a.push(task); // positional (supervisor accepts positional or --task)
  return a;
}

async function runRemote(remoteCmd, label) {
  const args = ["-T", "-i", opt.key, "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    sshTarget(), remoteCmd];
  remoteProc = spawn("ssh.exe", args, {
    cwd: opt.project || process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  log(`${label} started: pid=${remoteProc.pid}`);
  let outBuf = "";
  let errBuf = "";
  remoteProc.stdout.on("data", (d) => {
    const s = d.toString();
    outBuf = (outBuf + s).slice(-1000000);
    process.stdout.write(s);
    if (logPath) { try { appendFileSync(logPath, s); } catch { /* best-effort */ } }
  });
  remoteProc.stderr.on("data", (d) => {
    const s = d.toString();
    errBuf = (errBuf + s).slice(-100000);
    process.stderr.write(s);
    if (logPath) { try { appendFileSync(logPath, s); } catch { /* best-effort */ } }
  });
  const code = await new Promise((res) => {
    remoteProc.once("error", (e) => { die(`error: ${label} failed to start: ${e.message}`, 91); });
    remoteProc.once("close", (c) => res(c));
  });
  return { code, outBuf };
}

async function runSelftest() {
  // pick a sibling of the project as the deny probe (should be fully denied)
  let denyDir = "";
  try {
    const parent = dirname(opt.project);
    for (const n of readdirSync(parent)) {
      if (n === basename(opt.project)) continue;
      const p = join(parent, n);
      try { if (statSync(p).isDirectory()) { denyDir = p; break; } } catch { /* gone */ }
    }
  } catch { /* no sibling — the selftest skips the deny probe */ }
  const hostUser = process.env.USERNAME || "";
  const ps = join(opt.stage, "selftest.ps1").replace(/\\/g, "\\\\");
  const proj = opt.project.replace(/\\/g, "/").replace(/"/g, "");
  const deny = denyDir.replace(/\\/g, "/").replace(/"/g, "");
  const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${ps}" -Project "${proj}" -DenyDir "${deny}" -HostUser "${hostUser}" -ReadsMode ${opt.reads}`;
  const { code, outBuf } = await runRemote(cmd, "selftest");
  console.log(code === 0 ? "SELFTEST=PASS" : `SELFTEST=FAIL (exit ${code})`);
  void outBuf;
  return code;
}

async function runSetup() {
  const cmd = 'npm install -g @earendil-works/pi-coding-agent';
  const { code } = await runRemote(cmd, "setup (npm i -g pi for the account)");
  if (code === 0) console.log("SETUP=PASS (pi installed for the dedicated account)");
  return code;
}

async function runSupervisor() {
  // base64 keeps the --spec argument free of quotes/backslashes/spaces
  const spec = Buffer.from(JSON.stringify({
    provider: opt.provider,
    model: opt.model,
    input: modelInputs,
    baseUrl: opt.modelBaseUrl,
    apiKey: opt.apiKey,
    contextWindow: opt.contextWindow,
    project: opt.project,
    supArgs: supervisorArgs(),
  }), "utf8").toString("base64");
  log(
    `model input modalities: ${modelInputs.length > 0 ? "[" + modelInputs.join(", ") + "]" : `not declared (pi default for ${opt.model || "the model"})`} ` +
      `— the child's effective config lands in .pi-child-env.json (project dir)`
  );
  const runner = join(opt.stage, "runner.mjs").replace(/\\/g, "/");
  const cmd = `node ${runner} --spec ${spec}`;
  const { code, outBuf } = await runRemote(cmd, "supervisor");

  // RESULT (supervisor prints `=== RESULT === {json}` on stdout)
  const m = outBuf.split("\n").filter((l) => l.trim().startsWith("=== RESULT ===")).pop();
  if (m) {
    try {
      const result = JSON.parse(m.trim().slice("=== RESULT ===".length).trim());
      log(`RESULT: status=${result.status} exitReason=${result.exitReason} attempts=${result.attempts}`);
    } catch (e) {
      log(`RESULT line present but unparseable: ${e.message}`);
    }
  } else {
    log(`no RESULT line (exit ${code})`);
  }
  return code;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${sig} — killing remote tree`);
  killTree();
  setTimeout(() => process.exit(130), 3000);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const t0 = Date.now();
if (opt.setup) {
  const code = await runSetup();
  process.exit(code);
}
stage();
applyReadsMode();
if (opt.selftest) {
  const rc = await runSelftest();
  process.exit(rc === 0 ? 0 : 90);
}
if (!opt.skipHealth) {
  const health = await modelHealth();
  if (!health.ok) {
    die(`error: model endpoint not reachable at ${health.url} (${health.reason}) — start the model server (or pass --model-base-url / --skip-health)`, 90);
  }
  log(`model healthy: ${health.url} ids=[${health.ids.join(", ")}]`);
  if (opt.model && !health.ids.includes(opt.model)) {
    log(`note: requested model id "${opt.model}" not in server model list [${health.ids.join(", ")}] — the child will get a model-not-found error if the id is wrong`);
  }
  if (!opt.skipLatency) {
    const lat = await latencyProbe(opt.modelBaseUrl, opt.model);
    if (lat.ok) {
      log(
        `model latency: ${lat.tokens} tokens in ${(lat.ms / 1000).toFixed(1)}s (${lat.tps.toFixed(2)} tok/s)` +
        (lat.tps < 2 ? " — SLOW model: size per-item timeboxes and --timeout accordingly" : "")
      );
    } else {
      log(`note: latency probe failed (${lat.reason}) — non-fatal`);
    }
  }
}

const code = await runSupervisor();
log(`done: exit=${code} in ${Math.round((Date.now() - t0) / 1000)}s — project: ${opt.project}`);
process.exit(code);
