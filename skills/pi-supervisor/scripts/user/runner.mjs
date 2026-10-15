#!/usr/bin/env node
// runner.mjs (user variant, AGENT side) — runs as the dedicated standard
// account (default "agent") over the SSH loopback. It:
//   1. bootstraps the account's pi agent config under <home>\.pi
//      (models.json, auth.json, settings.json) + a .gitconfig with safe.directory
//   2. sets the env the supervisor + child need (PI_PROVIDER/PI_MODEL,
//      PI_PACKAGE_DIR, GIT_CONFIG_GLOBAL, ...)
//   3. execs supervisor.mjs with cwd = the project dir, inheriting stdio
//
// It receives everything as a single base64 --spec argument so the ssh
// command line carries no quotes/backslashes/spaces (PS/ssh quoting is the
// usual failure mode). The host-side hypervisor.mjs stages this file into a
// directory the account can read (default C:\ProgramData\pi-supervisor).

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

function die(msg, code) { console.error(msg); process.exit(code); }

let specB64 = "";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--spec") { specB64 = argv[i + 1]; i++; }
  else die(`error: unexpected argument: ${argv[i]}`, 2);
}
if (!specB64) die("error: --spec <base64> required", 2);
let spec;
try { spec = JSON.parse(Buffer.from(specB64, "base64").toString("utf8")); }
catch (e) { die(`error: could not decode spec: ${e.message}`, 2); }
for (const k of ["provider", "model", "baseUrl", "project"]) {
  if (!spec[k]) die(`error: spec missing "${k}"`, 2);
}
const contextWindow = spec.contextWindow || 262144;
const supArgs = Array.isArray(spec.supArgs) ? spec.supArgs : [];
const stageDir = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = join(stageDir, "supervisor.mjs");
if (!existsSync(SUPERVISOR)) die(`error: staged supervisor.mjs not found: ${SUPERVISOR}`, 90);

// ---------------------------------------------------------------------------
// Bootstrap the dedicated account's pi config (fresh per run, like integrity)
// ---------------------------------------------------------------------------
const home = process.env.USERPROFILE || process.env.HOME;
if (!home) die("error: USERPROFILE/HOME not set", 90);
const agentDir = join(home, ".pi");
mkdirSync(agentDir, { recursive: true });

const models = {
  providers: {
    [spec.provider]: {
      name: spec.provider,
      api: "openai-completions",
      baseUrl: spec.baseUrl,
      apiKey: spec.apiKey || "local",
      models: [{
        id: spec.model,
        name: spec.model,
        api: "openai-completions",
        reasoning: false,
        contextWindow,
        maxTokens: contextWindow,
      }],
    },
  },
};
writeFileSync(join(agentDir, "models.json"), JSON.stringify(models, null, 2));
writeFileSync(join(agentDir, "auth.json"),
  JSON.stringify({ [spec.provider]: { type: "api_key", key: spec.apiKey || "local" } }, null, 2));

// bash tool shell: prefer pwsh (bash-friendlier), fall back to Windows PowerShell
let shell = null;
try {
  shell = execFileSync("where", ["pwsh.exe"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).trim().split(/\r?\n/)[0];
} catch { /* no pwsh on PATH */ }
if (!shell || !existsSync(shell)) shell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: shell }, null, 2));

// git: the project is owned by the host user, so the child (different user)
// needs safe.directory to avoid "dubious ownership".
const gitconfigPath = join(home, ".gitconfig");
writeFileSync(gitconfigPath,
  `[safe]\n\tdirectory = ${spec.project}\n[user]\n\tname = pi-child\n\temail = pi-child@local\n`);

// ---------------------------------------------------------------------------
// Env for the supervisor + child
// ---------------------------------------------------------------------------
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_PROVIDER = spec.provider;
process.env.PI_MODEL = spec.model;
process.env.GIT_CONFIG_GLOBAL = gitconfigPath;
process.env.GIT_CONFIG_SYSTEM = join(home, ".gitconfig-system");
process.env.GIT_AUTHOR_NAME = "pi-child";
process.env.GIT_AUTHOR_EMAIL = "pi-child@local";
process.env.GIT_COMMITTER_NAME = "pi-child";
process.env.GIT_COMMITTER_EMAIL = "pi-child@local";

// Resolve the account's own global pi install (same candidate order as supervisor.mjs)
function resolvePackageDir() {
  const candidates = [];
  if (process.env.PI_PACKAGE_DIR) candidates.push(process.env.PI_PACKAGE_DIR);
  try {
    const root = execFileSync("npm", ["root", "-g", "--silent"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) candidates.push(join(root, "@earendil-works", "pi-coding-agent"));
  } catch { /* npm unavailable */ }
  if (process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent"));
  }
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, "dist", "index.js"))) return dir;
  }
  return null;
}
const pkg = resolvePackageDir();
if (!pkg) die("error: pi is not installed for this account. Run the host's `node user/hypervisor.mjs --setup` first (it does npm i -g for the account).", 90);
process.env.PI_PACKAGE_DIR = pkg;

// ---------------------------------------------------------------------------
// Exec the supervisor (cwd = project, stdio inherited so the host sees it live)
// ---------------------------------------------------------------------------
const child = spawn(process.execPath, [SUPERVISOR, ...supArgs], {
  cwd: spec.project,
  env: process.env,
  stdio: ["ignore", "inherit", "inherit"],
});
child.once("error", (e) => die(`error: supervisor failed to start: ${e.message}`, 1));
child.once("close", (code, signal) => process.exit(signal ? 128 + (signal === "SIGINT" ? 2 : 15) : (code ?? 1)));
