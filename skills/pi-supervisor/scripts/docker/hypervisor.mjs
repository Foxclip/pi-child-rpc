#!/usr/bin/env node
// hypervisor.mjs — the HOST layer of the 3-layer pi-supervisor docker setup.
//
//   host:      hypervisor.mjs (this file)
//                |- generates the container's agent config (models.json + auth.json)
//                |- owns the host->container model forwarder (default 0.0.0.0:8081 -> 127.0.0.1:8080)
//                |- health-checks the model server (host path) before launch and during the run
//                |- builds the image if missing, launches the container
//                |- watches the progress log for total no-progress
//                |- restarts the container once on infrastructure failure (default)
//                `- collects the supervisor's RESULT and reports it
//   container: supervisor.mjs (unchanged, mounted from this skill)
//                `- child `pi --mode rpc` -> model (host llama.cpp router via forwarder)
//
// Why 3 layers: the in-container supervisor owns the tight agent-behavior loop
// (loop detection, steer, fork — cheap because it is co-located with the child
// and forks are local process spawns). The container boundary creates a failure
// domain it cannot see: the host model server / forwarder can die, the container
// itself can wedge. Only a host-side layer can see and heal those. Each layer
// recovers what it can see cheaply and escalates the rest.
//
// Usage:
//   node scripts/docker/hypervisor.mjs "long autonomous task" [options]
//
// Supervisor options are passed through UNCHANGED to the in-container
// supervisor.mjs (same names and semantics as running it directly):
//   --task --session-id --session --no-session --session-dir --name
//   --provider --model --loop-threshold --max-steers --max-forks
//   --steer-msg --fork-note --consult --consult-file --action --message
//   --max-errors --heartbeat --max-text --idle-timeout --tool-timeout
//   --timeout --progress-log --expect-file --preamble
//   --keep-question-tool --keep-delegate-tool
//
// Hypervisor options:
//   --image <name>         Container image (default pi-supervisor:docker; built
//                          from the bundled Dockerfile if missing)
//   --docker <cmd>         Container runtime command (default: docker)
//   --workdir <dir>        Host working directory mounted at /work (default: cwd).
//                          The child works in /work; the progress log, session
//                          files, consult file and --expect-file artifacts all
//                          appear here on the host.
//   --model-base-url <u>   Model server URL as seen FROM THE CONTAINER (default
//                          http://host.docker.internal:8081/v1)
//   --provider <p>         Non-reserved provider id for the container models.json
//                          (default: $PI_PROVIDER, or "localllama" when unset or
//                          reserved). See the reserved-id note below.
//   --model <m>            Model id (default: $PI_MODEL)
//   --api-key <key>        Key written for the endpoint (default: the provider id;
//                          local endpoints ignore it)
//   --context-window <n>   Declared context window AND max output tokens (default 262144)
//   --forward-from <port>  Host port for the model forwarder (default 8081)
//   --forward-to <h:p>     Host target the forwarder pipes to (default 127.0.0.1:8080)
//   --no-forward           Skip the forwarder (model already reachable from container)
//   --skip-health          Skip model health checks (e.g. model lives IN the container)
//   --skip-latency         Skip the preflight latency probe (tok/s measurement)
//   --restarts <n>         Container restarts on infrastructure failure (default 1)
//   --no-progress <sec>    Kill + restart after this much total silence in the
//                          progress log (default 2700; 0 disables). Must exceed the
//                          supervisor's --tool-timeout (a single long tool call is
//                          legitimate silence).
//   --keep-container       Do not --rm the container on exit (inspect it)
//   --log <path>           Hypervisor log (default pi-child-hypervisor.log in workdir)
//   -h, --help             Show this help
//
// Exit codes: the in-container supervisor's own (0 completed, 3 stuck, 4
// consult), or 1 for hypervisor/infrastructure failure, 2 for usage.
//
// THE RESERVED-ID GOTCHA: in pi v1.2.0 the provider id "llama.cpp" is RESERVED
// (built-in router integration; its models come from the router's loaded set, so
// a models.json entry under that id collides and yields "No models available"
// even though auth reports ready). Register the endpoint under a non-reserved
// id (default "localllama"); this script refuses --provider llama.cpp.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(__dirname, ".."); // .../scripts (supervisor.mjs lives here)

const USAGE = `Usage:
  node hypervisor.mjs "long autonomous task" [options]

3-layer docker run: host hypervisor -> container (supervisor.mjs + child pi).
Supervisor options are passed through unchanged; see supervisor.mjs --help.

Hypervisor options:
  --image <name>         Container image (default pi-supervisor:docker)
  --docker <cmd>         Container runtime (default: docker)
  --workdir <dir>        Host dir mounted at /work (default: cwd)
  --model-base-url <u>   Model URL from the CONTAINER (default http://host.docker.internal:8081/v1)
  --provider <p>         Non-reserved provider id (default $PI_PROVIDER or localllama)
  --model <m>            Model id (default $PI_MODEL)
  --api-key <key>        Endpoint key (default: provider id)
  --context-window <n>   Declared context window / max output (default 262144)
  --model-input <csv>    Input modalities to declare for the model in the
                        container's models.json (comma list, e.g. "text,image").
                        Without it the model gets pi's default declaration —
                        on a text-only declaration the child cannot be fed
                        images/video even if the endpoint supports them.
  --forward-from <port>  Forwarder host port (default 8081)
  --forward-to <h:p>     Forwarder host target (default 127.0.0.1:8080)
  --no-forward           Skip the forwarder
  --skip-health          Skip model health checks
  --skip-latency         Skip the preflight latency probe (tok/s measurement)
  --restarts <n>         Container restarts on infra failure (default 1)
  --no-progress <sec>    Silence window before kill+restart (default 2700, 0=off)
  --keep-container       Keep the container after exit
  --log <path>           Hypervisor log (default pi-child-hypervisor.log in workdir)
  -h, --help             Show this help`;

// ---------------------------------------------------------------------------
// Argument parsing (strict: unknown --flag is an error, like the rest of the skill)
// ---------------------------------------------------------------------------
const SUP_VALUE = new Set([
  "--task", "--task-file", "--session-id", "--session", "--session-dir", "--name",
  "--loop-threshold", "--max-steers", "--max-forks", "--steer-msg", "--fork-note",
  "--consult-file", "--action", "--message", "--max-errors", "--heartbeat",
  "--max-text", "--idle-timeout", "--tool-timeout", "--timeout", "--finalize",
  "--stagnation", "--progress-log", "--expect-file", "--preamble",
]);
const SUP_BOOL = new Set(["--no-session", "--consult", "--keep-question-tool", "--keep-delegate-tool"]);
const HY_VALUE = new Set([
  "--image", "--docker", "--workdir", "--model-base-url", "--api-key",
  "--context-window", "--model-input", "--forward-from", "--forward-to", "--restarts",
  "--no-progress", "--log",
]);
const HY_BOOL = new Set([
  "--no-forward", "--skip-health", "--skip-latency", "--keep-container", "-h", "--help",
]);
// Shared: hypervisor uses them for config/env AND passes them to the supervisor.
const SHARED_VALUE = new Set(["--provider", "--model"]);

const argv = process.argv.slice(2);
const supArgs = [];
let task = "";
let sawTaskFile = false;
const opt = {
  image: "pi-supervisor:docker",
  docker: "docker",
  workdir: process.cwd(),
  modelBaseUrl: "http://host.docker.internal:8081/v1",
  provider: "",
  model: "",
  apiKey: "",
  contextWindow: 262144,
  modelInput: "",
  forwardFrom: 8081,
  forwardTo: "127.0.0.1:8080",
  noForward: false,
  skipHealth: false,
  skipLatency: false,
  restarts: 1,
  noProgressSec: 2700,
  keepContainer: false,
  log: "",
};
let sawHelp = false;

function die(msg, code) {
  console.error(msg);
  process.exit(code);
}

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-h" || a === "--help") { sawHelp = true; continue; }
  if (a === "--") { // everything after a bare -- is task text
    task = argv.slice(i + 1).join(" ");
    i = argv.length;
    continue;
  }
  if (a === "--task") {
    if (task) die("error: --task given twice", 2);
    task = argv[++i] ?? die("--task requires a value", 2);
    continue;
  }
  if (SHARED_VALUE.has(a)) {
    const v = argv[++i];
    if (v === undefined) die(`error: ${a} requires a value`, 2);
    if (a === "--provider") opt.provider = v;
    if (a === "--model") opt.model = v;
    supArgs.push(a, v);
    continue;
  }
  if (SUP_VALUE.has(a)) {
    if (a === "--task-file") sawTaskFile = true;
    supArgs.push(a, argv[++i] ?? die(`error: ${a} requires a value`, 2));
    continue;
  }
  if (SUP_BOOL.has(a)) { supArgs.push(a); continue; }
  if (HY_VALUE.has(a)) {
    const v = argv[++i];
    if (v === undefined) die(`error: ${a} requires a value`, 2);
    switch (a) {
      case "--image": opt.image = v; break;
      case "--docker": opt.docker = v; break;
      case "--workdir": opt.workdir = resolve(v); break;
      case "--model-base-url": opt.modelBaseUrl = v; break;
      case "--api-key": opt.apiKey = v; break;
      case "--context-window": opt.contextWindow = Number(v) || 0; break;
      case "--model-input": opt.modelInput = v; break;
      case "--forward-from": opt.forwardFrom = Number(v) || 0; break;
      case "--forward-to": opt.forwardTo = v; break;
      case "--restarts": opt.restarts = Number(v); break;
      case "--no-progress": opt.noProgressSec = Number(v); break;
      case "--log": opt.log = v; break;
    }
    continue;
  }
  if (HY_BOOL.has(a)) {
    switch (a) {
      case "--no-forward": opt.noForward = true; break;
      case "--skip-health": opt.skipHealth = true; break;
      case "--skip-latency": opt.skipLatency = true; break;
      case "--keep-container": opt.keepContainer = true; break;
    }
    continue;
  }
  if (a.startsWith("--")) {
    die(`error: unknown flag "${a}" — unknown flags are an error (strict CLI).\n` +
      `supervisor options pass through: ${[...SUP_VALUE, ...SUP_BOOL].join(" ")}\n` +
      `hypervisor options: ${[...HY_VALUE, ...HY_BOOL, ...SHARED_VALUE].join(" ")}\n` +
      `if your task starts with --, put a bare -- before it.`, 2);
  }
  if (task) die(`error: multiple positional tasks ("${task}" and "${a}") — pass one task`, 2);
  task = a;
}
if (sawHelp) { console.log(USAGE); process.exit(0); }

if (task && supArgs.includes("--task")) die("error: pass the task positionally OR via --task, not both", 2);
const isResume = supArgs.includes("--consult-file");
if (!task && !sawTaskFile && !isResume) die(USAGE + "\n\nerror: a task is required (positionally, via --task, or via --task-file)", 2);
if (isResume && !supArgs.includes("--action")) die("error: --consult-file requires --action steer|fork|continue", 2);

// Provider/model defaults + reserved-id guard.
const RESERVED_PROVIDER = "llama.cpp";
if (!opt.model) opt.model = process.env.PI_MODEL || "";
if (!opt.provider) {
  const envP = process.env.PI_PROVIDER || "";
  opt.provider = envP === RESERVED_PROVIDER ? "" : envP; // empty -> fallback below
}
if (opt.provider === RESERVED_PROVIDER) {
  die(`error: provider id "${RESERVED_PROVIDER}" is reserved in pi v1.2.0 (built-in router integration). ` +
    `A models.json entry under that id collides with it and the model list stays empty even though auth reports ready. ` +
    `Pass a non-reserved id, e.g. --provider localllama.`, 2);
}
if (!opt.provider) opt.provider = "localllama";
// True when we silently swapped the reserved env provider for a safe id.
const usedFallbackProvider =
  process.env.PI_PROVIDER === RESERVED_PROVIDER && opt.provider === "localllama" && !supArgs.includes("--provider");
if (!opt.model) die("error: no model — pass --model or set $PI_MODEL", 2);
if (!opt.apiKey) opt.apiKey = opt.provider;
if (opt.contextWindow <= 0) die("error: --context-window must be > 0", 2);
if (opt.restarts < 0) die("error: --restarts must be >= 0", 2);

// --model-input: input modalities to declare in the container's models.json.
// Without an explicit declaration pi uses its default for the entry; a
// text-only default means the child cannot be fed images/video even when the
// endpoint supports them. Declaring vision on a text-only endpoint is the
// user's call (the request simply fails at runtime, visibly).
const MODEL_INPUTS = new Set(["text", "image", "audio", "video"]);
let modelInputs = [];
if (opt.modelInput) {
  modelInputs = opt.modelInput.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = modelInputs.find((m) => !MODEL_INPUTS.has(m));
  if (bad) die(`error: --model-input "${bad}" is not a known input modality (valid: ${[...MODEL_INPUTS].join(", ")})`, 2);
}

// ---------------------------------------------------------------------------
// Paths + logging
// ---------------------------------------------------------------------------
const workdir = opt.workdir;
const dockerDir = __dirname; // Dockerfile lives here
const agentDirHost = join(workdir, ".pi-docker", "agent");
const agentDirC = "/work/.pi-docker/agent"; // container view (workdir is /work)
let progressLogHost = join(workdir, "pi-child-progress.log");
{ // Honor a custom --progress-log (container cwd is /work = host workdir).
  const i = supArgs.indexOf("--progress-log");
  if (i >= 0 && supArgs[i + 1]) {
    const p = supArgs[i + 1];
    progressLogHost = isAbsolute(p) ? p : join(workdir, p);
  }
}
const logPath = isAbsolute(opt.log) ? opt.log : join(workdir, opt.log || "pi-child-hypervisor.log");
const containerName = `pi-supervisor-${Date.now().toString(36)}`;

const startedAt = Date.now();
function log(msg) {
  const line = `[hypervisor] ${msg}`;
  process.stderr.write(line + "\n");
  try { appendFileSync(logPath, line + "\n"); } catch { /* log file best-effort */ }
}
function winPath(p) { // normalize for docker -v on Windows (slashes)
  return p.replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// Helpers
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

// Host-side view of the model endpoint: the forwarder (if active) re-exposes
// the container URL's host:port on the host loopback.
function hostModelBaseUrl() {
  if (opt.noForward) return opt.modelBaseUrl;
  try {
    const u = new URL(opt.modelBaseUrl);
    u.hostname = "127.0.0.1";
    u.port = String(opt.forwardFrom);
    return u.toString().replace(/\/$/, "");
  } catch {
    return opt.modelBaseUrl;
  }
}

async function modelHealth() {
  const url = modelsUrl(hostModelBaseUrl());
  const r = await httpGet(url);
  if (!r.ok) return { ok: false, reason: r.err ? `unreachable (${r.err})` : `HTTP ${r.status}`, url };
  let ids = [];
  try { ids = ((JSON.parse(r.text).data) || []).map((m) => m.id); } catch { /* non-JSON */ }
  return { ok: true, url, ids };
}

// Preflight latency probe: one small timed completion (16 tokens) against the
// HOST-side endpoint (the forwarder, i.e. what the container's requests also
// traverse) to measure tok/s — the number the task budget (--timeout,
// per-item timeboxes) must be sized from. Best-effort: any failure just logs
// and the run continues.
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
// Forwarder (embedded; reused if the port already serves a model endpoint)
// ---------------------------------------------------------------------------
let forwarder = null;
async function startForwarder() {
  if (opt.noForward) { log("forwarder disabled (--no-forward)"); return; }
  const [host, port] = opt.forwardTo.split(":");
  const srv = net.createServer((sock) => {
    const up = net.connect(Number(port || 8080), host || "127.0.0.1");
    sock.pipe(up); up.pipe(sock);
    const kill = () => { try { sock.destroy(); } catch {} try { up.destroy(); } catch {} };
    sock.on("error", kill); up.on("error", kill);
  });
  try {
    await new Promise((res, rej) => {
      srv.once("error", rej);
      srv.listen(Number(opt.forwardFrom), "0.0.0.0", () => { srv.removeAllListeners("error"); res(); });
    });
    forwarder = srv;
    log(`forwarder up: 0.0.0.0:${opt.forwardFrom} -> ${host}:${port}`);
  } catch (e) {
    if (e.code === "EADDRINUSE") {
      const probe = await httpGet(`http://127.0.0.1:${opt.forwardFrom}/v1/models`);
      if (probe.ok) {
        log(`forwarder port :${opt.forwardFrom} already serves a model endpoint — reusing the existing listener`);
        return;
      }
      die(`error: port ${opt.forwardFrom} is in use by something that does not answer /v1/models — stop it, or pick another --forward-from`, 1);
    }
    die(`error: forwarder: ${e.message}`, 1);
  }
}

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------
function imageExists(name) {
  const r = spawnSync(opt.docker, ["image", "inspect", name], { stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0;
}
function ensureImage() {
  if (imageExists(opt.image)) { log(`image ${opt.image} present`); return; }
  log(`image ${opt.image} missing — building from ${winPath(dockerDir)}`);
  const r = spawnSync(opt.docker, ["build", "-t", opt.image, winPath(dockerDir)], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) die(`error: docker build failed (exit ${r.status})`, 1);
}

// ---------------------------------------------------------------------------
// Container agent config (generated fresh each launch; sessions are untouched)
// ---------------------------------------------------------------------------
function writeAgentConfig() {
  mkdirSync(agentDirHost, { recursive: true });
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
          ...(modelInputs.length > 0 ? { input: modelInputs } : {}),
        }],
      },
    },
  };
  const auth = { [opt.provider]: { type: "api_key", key: opt.apiKey } };
  writeFileSync(join(agentDirHost, "models.json"), JSON.stringify(models, null, 2));
  writeFileSync(join(agentDirHost, "auth.json"), JSON.stringify(auth, null, 2));
  log(`agent config written: ${winPath(agentDirHost)}/models.json (provider=${opt.provider}, model=${opt.model}, baseUrl=${opt.modelBaseUrl}, input=${modelInputs.length > 0 ? modelInputs.join(",") : "pi default"})`);
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------
function containerSupArgs() {
  const a = [...supArgs];
  if (task) a.push(task); // positional task (supervisor accepts positional or --task)
  return a;
}

function dockerRunArgs() {
  const a = ["run"];
  if (!opt.keepContainer) a.push("--rm");
  a.push("--name", containerName, "-i");
  a.push("-v", `${winPath(workdir)}:/work`);
  a.push("-v", `${winPath(SCRIPTS_DIR)}:/opt/pi-supervisor:ro`);
  a.push("--add-host=host.docker.internal:host-gateway");
  a.push("-e", `PI_CODING_AGENT_DIR=${agentDirC}`);
  a.push("-e", `PI_PROVIDER=${opt.provider}`);
  a.push("-e", `PI_MODEL=${opt.model}`);
  if (process.env.PI_REASONING_LEVEL) a.push("-e", `PI_REASONING_LEVEL=${process.env.PI_REASONING_LEVEL}`);
  a.push(opt.image, "node", "/opt/pi-supervisor/supervisor.mjs");
  a.push(...containerSupArgs());
  return a;
}

function dockerKill(name) {
  const r = spawnSync(opt.docker, ["kill", name], { stdio: ["ignore", "pipe", "pipe"] });
  return r.status === 0;
}

function logSignature(p) {
  try {
    const s = statSync(p);
    return `${s.size}:${s.mtimeMs}`;
  } catch { return "none"; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runContainer() {
  const args = dockerRunArgs();
  const shown = [...args];
  const last = shown[shown.length - 1];
  if (typeof last === "string" && last.length > 120) shown[shown.length - 1] = last.slice(0, 120) + `… (${last.length} chars)`;
  log(`${opt.docker} ${shown.join(" ")}`);
  const proc = spawn(opt.docker, args, {
    cwd: workdir,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const captured = [];
  proc.stdout.on("data", (d) => { process.stdout.write(d); captured.push(d); });
  proc.stderr.on("data", (d) => process.stderr.write(d));

  let exitCode = null;
  let infraFail = null;
  let sig = logSignature(progressLogHost);
  let idleMs = 0;
  let lastHealthCheck = 0;
  let modelDownLogged = false;

  const poll = (async () => {
    while (exitCode === null) {
      await sleep(3000);
      const now = Date.now();
      const s = logSignature(progressLogHost);
      if (s !== sig) { sig = s; idleMs = 0; } else idleMs += 3000;
      // Periodic model health (every 30 s) — the host-only visibility.
      if (!opt.skipHealth && now - lastHealthCheck > 30000) {
        lastHealthCheck = now;
        const h = await modelHealth();
        if (!h.ok && !modelDownLogged) {
          log(`WARNING model server unreachable at ${h.url} (${h.reason}) — the child will stall; waiting for recovery`);
          modelDownLogged = true;
        } else if (h.ok && modelDownLogged) {
          log("model server reachable again");
          modelDownLogged = false;
        }
      }
      if (opt.noProgressSec > 0 && idleMs >= opt.noProgressSec * 1000) {
        const h = await modelHealth();
        log(`no progress for ${Math.round(idleMs / 1000)} s (progress log ${winPath(progressLogHost)}); model server: ${h.ok ? "reachable" : h.reason} — killing container`);
        proc.kill("SIGKILL");
        infraFail = "no-progress";
        // Give docker a moment to reap, then make sure the container is gone.
        await sleep(2000);
        if (!dockerKill(containerName)) { /* already gone */ }
        break;
      }
    }
  })();

  exitCode = await new Promise((res) => {
    proc.on("close", (code) => res(code ?? 1));
    proc.on("error", (e) => { infraFail = `docker spawn: ${e.message}`; res(1); });
  });
  await poll;
  if (exitCode === null) exitCode = 1;
  if (exitCode === 0) {
    // Container exited cleanly; the --rm removal is automatic, but a name-based
    // kill is a no-op safeguard if --keep-container left it behind.
  } else if (!infraFail) {
    // Supervisor exited non-zero. Distinguish task-level (3 stuck, 4 consult —
    // never restart) from error (1 — possibly infra; caller decides restart).
  }
  return { exitCode, infraFail, output: Buffer.concat(captured).toString("utf8") };
}

// ---------------------------------------------------------------------------
// Result collection
// ---------------------------------------------------------------------------
function extractResult(output) {
  const lines = output.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^=== RESULT === (.*)$/);
    if (m) { try { return JSON.parse(m[1]); } catch { /* keep searching */ } }
  }
  // Fallback: the supervisor also writes a [result] line to the progress log.
  try {
    const log = readFileSync(progressLogHost, "utf8").split(/\r?\n/).reverse();
    for (const line of log) {
      const m = line.match(/^\[result\] (.*)$/);
      if (m) { try { return JSON.parse(m[1]); } catch { /* keep searching */ } }
    }
  } catch { /* no log */ }
  return null;
}

function hostSessionFile(c) {
  if (!c || !c.startsWith("/work/")) return c || null;
  return winPath(join(workdir, c.slice("/work/".length)));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!existsSync(workdir)) mkdirSync(workdir, { recursive: true });
  if (usedFallbackProvider) {
    console.error(`[hypervisor] note: $PI_PROVIDER is "${RESERVED_PROVIDER}" (reserved in pi v1.2.0) — using "${opt.provider}" in-container`);
  }
  log(`workdir=${winPath(workdir)} image=${opt.image} provider=${opt.provider} model=${opt.model}`);
  log(`container model url=${opt.modelBaseUrl} host-side url=${hostModelBaseUrl()}`);
  writeAgentConfig();
  ensureImage();
  await startForwarder();

  if (!opt.skipHealth) {
    const h = await modelHealth();
    if (!h.ok) {
      log(`FATAL model server unreachable at ${h.url} (${h.reason})`);
      log(`  forwarder: ${opt.noForward ? "disabled" : `0.0.0.0:${opt.forwardFrom} -> ${opt.forwardTo}`}`);
      log(`  check the model server is up, the forwarder target is right (--forward-to), and the router is listening`);
      die(`error: model server unreachable (exit 1)`, 1);
    }
    if (!h.ids.includes(opt.model)) {
      log(`WARNING model "${opt.model}" not in /v1/models yet — the router may load it on demand; continuing`);
    } else {
      log(`health ok: model "${opt.model}" present (${h.ids.length} models listed)`);
    }
  }

  if (!opt.skipLatency) {
    const lt = await latencyProbe(hostModelBaseUrl(), opt.model);
    if (lt.ok) {
      log(`latency probe: ${lt.tokens} tokens in ${(lt.ms / 1000).toFixed(1)}s (~${lt.tps.toFixed(1)} tok/s) — size --timeout and per-item timeboxes from this`);
      if (lt.tps < 2) log("  SLOW — budget per-item timeboxes accordingly (long turns may hit endpoint timeouts)");
    } else {
      log(`latency probe: failed (${lt.reason}) — continuing without tok/s`);
    }
  }

  const maxAttempts = 1 + opt.restarts;
  let attempt = 0;
  let result = { exitCode: 1, infraFail: null, output: "" };
  while (attempt < maxAttempts) {
    attempt++;
    if (attempt > 1) log(`restart ${attempt - 1}/${opt.restarts}: fresh container (new auto session id)`);
    result = await runContainer();
    // Task-level outcomes: never restart, report as-is.
    if ([0, 3, 4].includes(result.exitCode)) break;
    if (attempt >= maxAttempts) break;
    // Infra-level (exit 1, spawn error, no-progress): restart only if the model
    // server is actually reachable now — restarting into a dead model wastes the budget.
    if (!opt.skipHealth) {
      const h = await modelHealth();
      if (!h.ok) { log(`not restarting: model server still unreachable (${h.reason})`); break; }
    }
  }

  const supResult = extractResult(result.output);
  const elapsedMs = Date.now() - startedAt;
  const status = { 0: "completed", 3: "stuck", 4: "consult" }[result.exitCode] || (result.infraFail || "error");
  const hypResult = {
    status,
    exitCode: result.exitCode,
    infraFail: result.infraFail || undefined,
    attempts: attempt,
    elapsedMs,
    workdir: winPath(workdir),
    progressLog: winPath(progressLogHost),
    sessionFile: supResult?.sessionFile || null,
    sessionFileHost: hostSessionFile(supResult?.sessionFile),
    consultFile: supResult?.consultFile || null,
    result: supResult,
  };
  console.log(`\n=== HYPERVISOR RESULT === ${JSON.stringify(hypResult)}\n`);
  log(`done: status=${status} exitCode=${result.exitCode} attempts=${attempt} elapsed=${Math.round(elapsedMs / 1000)}s`);
  process.exit(result.exitCode === 0 || [3, 4].includes(result.exitCode) ? result.exitCode : 1);
}

// Graceful teardown on ctrl-c / task-manager kill.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown signal — killing container");
  dockerKill(containerName);
  if (forwarder) forwarder.close();
  process.exit(130);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((e) => {
  console.error(`[hypervisor] fatal: ${e.stack || e.message}`);
  process.exit(1);
});
