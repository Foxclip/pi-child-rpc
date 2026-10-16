#!/usr/bin/env node
// hypervisor.mjs (integrity variant) — run the pi-supervisor stack inside a
// LOW-INTegrity (S-1-16-4096) process tree, natively on Windows. No admin,
// no elevation, no UAC prompt, no Docker, no Hyper-V.
//
// Architecture (3 layers, all on this host):
//
//   Medium-IL hypervisor (this file, node)
//     |- creates <base>/{work,home,temp} + <home>/.pi and icacls's them to
//        (OI)(CI)Low   [MUST happen while still Medium: a Low process cannot
//        create directories in Medium-IL parents]
//     |- writes the child's agent config (<home>/.pi/models.json + auth.json,
//        openai-completions -> --model-base-url)
//     |- health-checks the model endpoint (GET .../v1/models)
//     |- [optional] copies --src project files into work/
//     |- no model forwarder is needed: the child is on this host, so
//        --model-base-url points straight at the model server
//     `- spawns powershell spawn-low.ps1 -Spec {exe: node, args: [supervisor.mjs, ...]}
//          |- self-downgrades its token to Low (OpenProcessToken with
//             TOKEN_QUERY|TOKEN_ADJUST_DEFAULT + SetTokenInformation)
//          `- node supervisor.mjs <supArgs>   (supervisor + child pi run at Low IL,
//             cwd = work, isolated HOME/USERPROFILE/TEMP under <base>\home)
//
// What Low IL protects (verified by --selftest):
//   - child writes to the user profile, HKCU registry, system dirs: DENIED
//   - child can still READ everything (integrity never blocks reads)
//   - child can execute host programs (reads of binaries are fine)
//   - network access is NOT restricted (closing that off needs admin; use the
//     docker variant if network isolation matters)
//   - results in work/ stay readable/writable by you (Medium) afterwards
//
// Usage:
//   node hypervisor.mjs --model <id> [hypervisor options] [supervisor options] "task"
//
//   Supervisor options (--timeout, --expect-file, --loop-threshold, --max-forks,
//   --max-errors, --consult, ...) are passed through unchanged; see
//   supervisor.mjs --help. The task is the first positional arg or --task.
//
// Exit codes: supervisor's own (0 completed, 1 infrastructure, 2 usage,
// 3 stuck, 4 consult), 90 = sandbox setup failed, 91 = downgrade failed
// (propagated from spawn-low.ps1).

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync,
  readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTEGRITY_DIR = join(SCRIPTS_DIR, "integrity");
const SUPervisor = join(SCRIPTS_DIR, "supervisor.mjs");

function die(msg, code) {
  console.error(msg);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// CLI (strict; unknown --flags are passed to supervisor.mjs verbatim)
// ---------------------------------------------------------------------------
const RESERVABLE = new Set([
  "base", "workdir", "src", "reuse", "model", "provider", "model-base-url",
  "api-key", "context-window", "task", "selftest", "log", "skip-latency",
  "help", "h",
]);
const opt = {
  base: process.env.USERPROFILE ? join(process.env.USERPROFILE, "pi-supervisor-sandbox") : join(process.cwd(), "pi-supervisor-sandbox"),
  workdir: "",
  src: "",
  reuse: false,
  model: process.env.PI_MODEL || "",
  provider: "localllama", // fresh id: the child gets its own agent dir, so nothing collides
  modelBaseUrl: "http://127.0.0.1:8080/v1",
  apiKey: "local",
  contextWindow: 262144,
  task: "",
  selftest: false,
  log: "pi-child-hypervisor.log",
  skipLatency: false,
};
const supArgs = [];
let task = "";

function usage() {
  console.log(`integrity/hypervisor.mjs — run supervisor.mjs in a low-integrity sandbox (no admin, no docker)

options:
  --base <dir>           sandbox root (default %USERPROFILE%\\pi-supervisor-sandbox)
  --workdir <dir>        child's work area (default <base>\\work); must be empty unless --reuse
  --src <dir>            copy this directory into the workdir before launching
  --reuse                allow a pre-existing non-empty workdir (its files may be Medium IL!)
  --model <id>           model id (default $PI_MODEL)
  --provider <id>        provider id (default "localllama")
  --model-base-url <u>   model endpoint (default http://127.0.0.1:8080/v1)
  --api-key <k>          (default "local")
  --context-window <n>   (default 262144)
  --task <text>          task text (or first positional)
  --selftest             verify downgrade + isolation, then exit
  --skip-latency         Skip the preflight latency probe (tok/s measurement)
  --log <file>           log file name (default pi-child-hypervisor.log in workdir)
  <task>                 positional task text
  everything else        passed through to supervisor.mjs (see its --help)

examples:
  node hypervisor.mjs --model gemma-4-26B-A4B --expect-file out.txt "solve the task; write the answer to out.txt"
  node hypervisor.mjs --model m --selftest
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
  if (!RESERVABLE.has(name)) { supArgs.push(a); if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { supArgs.push(argv[i + 1]); i++; } continue; }
  const v = argv[i + 1];
  if (v === undefined || (v.startsWith("--") && RESERVABLE.has(v.slice(2)))) {
    // boolean-ish reserved flags
    if (name === "selftest") { opt.selftest = true; continue; }
    if (name === "reuse") { opt.reuse = true; continue; }
    if (name === "skip-latency") { opt.skipLatency = true; continue; }
    die(`error: --${name} needs a value`, 2);
  }
  switch (name) {
    case "base": opt.base = resolve(v); break;
    case "workdir": opt.workdir = resolve(v); break;
    case "src": opt.src = resolve(v); break;
    case "model": opt.model = v; break;
    case "provider": opt.provider = v; break;
    case "model-base-url": opt.modelBaseUrl = v; break;
    case "api-key": opt.apiKey = v; break;
    case "context-window": opt.contextWindow = Number(v) || 0; break;
    case "task": opt.task = v; break;
    case "selftest": opt.selftest = true; break;
    case "log": opt.log = v; break;
    default: break;
  }
  i++;
}
if (opt.task) task = opt.task;
if (!task && !opt.selftest) { usage(); die("error: no task (positional or --task)", 2); }
if (opt.contextWindow <= 0) die("error: --context-window must be > 0", 2);
if (!opt.workdir) opt.workdir = join(opt.base, "work");
if (!opt.model && !opt.selftest) die("error: no model — pass --model or set $PI_MODEL", 2);

const base = opt.base;
const workdir = opt.workdir;
const home = join(base, "home");
const lowTemp = join(base, "temp");
const agentDir = join(home, ".pi");
const logPath = isAbsolute(opt.log) ? opt.log : join(workdir, opt.log);
const startedAt = Date.now();

function log(msg) {
  const line = `[hypervisor] ${msg}`;
  process.stderr.write(line + "\n");
  try { appendFileSync(logPath, line + "\n"); } catch { /* log dir may not exist yet */ }
}

// ---------------------------------------------------------------------------
// Sandbox layout (all while still Medium IL)
// ---------------------------------------------------------------------------
function icaclsLow(dir) {
  const r = spawnSync("icacls", [dir, "/setintegritylevel", "(OI)(CI)Low"], { stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) {
    die(`error: icacls failed on ${dir} (exit ${r.status}): ${r.stderr.toString().trim()}`, 90);
  }
}

function setupSandbox() {
  mkdirSync(base, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  mkdirSync(lowTemp, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(home, ".npm-cache"), { recursive: true });
  mkdirSync(join(home, "AppData", "Roaming"), { recursive: true });
  mkdirSync(join(home, "AppData", "Local"), { recursive: true });
  for (const d of [base, workdir, lowTemp, home]) icaclsLow(d);
  log(`sandbox ready: base=${base} (work, home, temp all (OI)(CI)Low)`);

  // workdir content policy (the log file itself is excluded — it is created
  // by log() before this check runs)
  const logName = isAbsolute(opt.log) ? "" : opt.log;
  if (readdirSync(workdir).filter((f) => f !== logName).length > 0) {
    if (!opt.reuse) die(`error: workdir not empty: ${workdir} — pass --reuse to keep existing files (note: pre-existing files are Medium IL and the Low child cannot modify them), or pick a fresh --workdir`, 90);
    log("workdir already has content (--reuse) — pre-existing Medium-IL files stay read-only for the child");
  }
  if (opt.src) {
    if (!existsSync(opt.src)) die(`error: --src not found: ${opt.src}`, 90);
    cpSync(opt.src, workdir, { recursive: true });
    log(`copied ${opt.src} -> ${workdir} (new files inherit Low IL)`);
  }
}

// ---------------------------------------------------------------------------
// Child agent config (same shape the docker hypervisor generates)
// ---------------------------------------------------------------------------
function writeAgentConfig() {
  const models = {
    providers: {
      [opt.provider]: {
        name: opt.provider,
        api: "openai-completions",
        baseUrl: opt.modelBaseUrl,
        apiKey: opt.apiKey,
        models: [{
          id: opt.model,
          name: opt.model,
          api: "openai-completions",
          reasoning: false,
          contextWindow: opt.contextWindow,
          maxTokens: opt.contextWindow,
        }],
      },
    },
  };
  const auth = { [opt.provider]: { type: "api_key", key: opt.apiKey } };
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(models, null, 2));
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(auth, null, 2));
  // The bash tool must use a NATIVE shell: Git-bash (MSYS2) cannot start at
  // Low integrity — it has to create \BaseNamedObjects\msys-2.0S5-<hash>, and
  // the mandatory-integrity policy denies Low-IL object creation there (this
  // is a known MSYS2 limitation, same wall other Windows sandboxes hit).
  // PowerShell accepts the "-c" argument the bash tool passes (it is the
  // standard abbreviation of -Command). Prefer PS7 (bash-friendlier syntax:
  // &&, ternary, ...), fall back to Windows PowerShell 5.1.
  let shell = null;
  try {
    shell = execFileSync("where", ["pwsh.exe"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().split(/\r?\n/)[0];
  } catch { /* no pwsh on PATH */ }
  if (!shell || !existsSync(shell)) {
    shell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  }
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: shell }, null, 2));
  log(`agent config: ${agentDir}/models.json (provider=${opt.provider}, model=${opt.model}, baseUrl=${opt.modelBaseUrl})`);
  log(`bash tool shell (shellPath): ${shell}`);
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

// Preflight latency probe: one small timed completion (16 tokens) to measure
// tok/s — the number the task budget (--timeout, per-item timeboxes) must be
// sized from. Best-effort: any failure just logs and the run continues.
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
// Selftest
// ---------------------------------------------------------------------------
async function runSelftest() {
  const scratch = join(base, `selftest-${Date.now().toString(36)}`);
  try {
    mkdirSync(scratch, { recursive: true });
    icaclsLow(scratch);
    // Medium-IL probe file for the selftest's read check (a Low process cannot
    // create files in Medium-IL TEMP, so the caller creates it here)
    writeFileSync(join(scratch, "read-probe.txt"), "medium");
    log(`selftest scratch: ${scratch}`);
    const r = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", join(INTEGRITY_DIR, "selftest.ps1"), "-Scratch", scratch,
    ], { stdio: ["ignore", "inherit", "inherit"], encoding: "utf8" });
    log(`selftest exit=${r.status}`);
    return r.status;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Low-IL tree
// ---------------------------------------------------------------------------
// The sandboxed tree gets an isolated APPDATA/HOME, so the child supervisor
// cannot find the global pi install itself. Resolve it HERE (real env) and
// pin it via PI_PACKAGE_DIR. Same candidate order as supervisor.mjs:
// PI_PACKAGE_DIR > npm root -g > %APPDATA%\npm.
function resolveRealPackageDir() {
  const candidates = [];
  if (process.env.PI_PACKAGE_DIR) candidates.push(process.env.PI_PACKAGE_DIR);
  try {
    const root = execFileSync("npm", ["root", "-g", "--silent"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) candidates.push(join(root, "@earendil-works", "pi-coding-agent"));
  } catch { /* npm unavailable — fall through */ }
  if (process.env.APPDATA) {
    candidates.push(
      join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent")
    );
  }
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, "dist", "index.js"))) return dir;
  }
  die("error: could not locate @earendil-works/pi-coding-agent (real env). Set PI_PACKAGE_DIR.", 2);
}

function lowEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === "PI_PROVIDER" || k === "PI_MODEL" || k === "PI_CODING_AGENT_DIR") delete env[k];
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.TEMP = lowTemp;
  env.TMP = lowTemp;
  env.APPDATA = join(home, "AppData", "Roaming");
  env.LOCALAPPDATA = join(home, "AppData", "Local");
  env.npm_config_cache = join(home, ".npm-cache");
  env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
  env.GIT_CONFIG_SYSTEM = join(home, ".gitconfig-system");
  env.GIT_AUTHOR_NAME = env.GIT_AUTHOR_NAME || "pi-child";
  env.GIT_AUTHOR_EMAIL = env.GIT_AUTHOR_EMAIL || "pi-child@local";
  env.GIT_COMMITTER_NAME = env.GIT_COMMITTER_NAME || "pi-child";
  env.GIT_COMMITTER_EMAIL = env.GIT_COMMITTER_EMAIL || "pi-child@local";
  env.PI_CODING_AGENT_DIR = agentDir;
  env.PI_PROVIDER = opt.provider;
  env.PI_MODEL = opt.model;
  env.PI_PACKAGE_DIR = resolveRealPackageDir();
  return env;
}

function supervisorArgs() {
  const a = [...supArgs];
  if (task) a.push(task); // positional (supervisor accepts positional or --task)
  return a;
}

let lowProc = null;
function killTree() {
  if (!lowProc) return;
  try {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(lowProc.pid)], { stdio: "ignore" });
  } catch { /* already dead */ }
}

async function runLowTree() {
  writeAgentConfig();
  // base64 keeps the -Spec argument free of quotes/backslashes/spaces (PS 5.1
  // command-line quoting mangles escaped quotes in raw JSON)
  const spec = Buffer.from(JSON.stringify({ exe: process.execPath, args: [SUPervisor, ...supervisorArgs()] }), "utf8").toString("base64");
  lowProc = spawn("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", join(INTEGRITY_DIR, "spawn-low.ps1"), "-Spec", spec,
  ], {
    cwd: workdir,
    env: lowEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  log(`low-IL tree started: pid=${lowProc.pid} cwd=${workdir}`);

  let outBuf = "";
  let errBuf = "";
  lowProc.stdout.on("data", (d) => {
    const s = d.toString();
    outBuf = (outBuf + s).slice(-1000000);
    process.stdout.write(s);
    try { appendFileSync(logPath, s); } catch { /* best-effort */ }
  });
  lowProc.stderr.on("data", (d) => {
    const s = d.toString();
    errBuf = (errBuf + s).slice(-1000000);
    process.stderr.write(s);
    try { appendFileSync(logPath, s); } catch { /* best-effort */ }
  });
  const code = await new Promise((res) => {
    lowProc.once("error", (e) => { die(`error: low-IL tree failed to start: ${e.message}`, 1); });
    lowProc.once("close", (c) => res(c));
  });

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
  log(`received ${sig} — killing low-IL tree`);
  killTree();
  setTimeout(() => process.exit(130), 3000);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const t0 = Date.now();
if (opt.selftest) {
  setupSandbox();
  const rc = await runSelftest();
  console.log(rc === 0 ? "SELFTEST=PASS" : `SELFTEST=FAIL (exit ${rc})`);
  process.exit(rc === 0 ? 0 : 90);
}

setupSandbox();
const health = await modelHealth();
if (!health.ok) {
  die(`error: model endpoint not reachable at ${health.url} (${health.reason}) — start the model server (or pass --model-base-url)`, 90);
}
log(`model healthy: ${health.url} ids=[${health.ids.join(", ")}]`);
if (opt.model && !health.ids.includes(opt.model)) {
  log(`note: requested model id "${opt.model}" not in server model list [${health.ids.join(", ")}] — the child will get a model-not-found error if the id is wrong`);
}

if (!opt.skipLatency) {
  const lt = await latencyProbe(opt.modelBaseUrl, opt.model);
  if (lt.ok) {
    log(`latency probe: ${lt.tokens} tokens in ${(lt.ms / 1000).toFixed(1)}s (~${lt.tps.toFixed(1)} tok/s) — size --timeout and per-item timeboxes from this`);
    if (lt.tps < 2) log("  SLOW — budget per-item timeboxes accordingly (long turns may hit endpoint timeouts)");
  } else {
    log(`latency probe: failed (${lt.reason}) — continuing without tok/s`);
  }
}

const code = await runLowTree();
log(`done: exit=${code} in ${Math.round((Date.now() - t0) / 1000)}s — workdir: ${workdir}`);
process.exit(code);
