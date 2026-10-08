#!/usr/bin/env node
// rpc-child.mjs — spawn a child pi agent (RPC mode) and hold a multi-turn
// conversation with it. Bundled with the pi-child-rpc skill.
//
// Usage:
//   node rpc-child.mjs "one-shot prompt"
//   node rpc-child.mjs --turn "..." --turn "..."
//   node rpc-child.mjs --provider llama.cpp --model <model> --timeout 600000 --turn "..."
//
// Behavior:
//   - Inherits the parent pi session's provider/model from the PI_PROVIDER /
//     PI_MODEL env vars (a bare child would otherwise use the configured
//     default model). Override with --provider / --model.
//   - Excludes the ask_user_question tool by default: dialog tools make the
//     child block on an extension_ui_request until the client answers it.
//     --keep-question-tool disables the exclusion (then the client MUST answer
//     dialogs via extension_ui_response, see docs/rpc-extension-ui.md).
//   - Streams the child's live text to stdout; tool activity + diagnostics go
//     to stderr.
//   - Prints [reply-N] blocks and a final machine-readable line:
//       === RESULT === {"replies":["...", "..."]}
//   - Exits non-zero on timeout or child failure.
//
// Run from the directory the child should work in (it inherits this cwd).

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = `Usage:
  node rpc-child.mjs "one-shot prompt"
  node rpc-child.mjs --turn "prompt 1" --turn "prompt 2" ...
Options:
  --provider <p>      Provider for the child (default: $PI_PROVIDER)
  --model <m>         Model for the child (default: $PI_MODEL)
  --timeout <ms>      Per-turn timeout (default: 300000 = 5 min; RpcClient's
                      own default is only 60000, too short for slow local models)
  --keep-question-tool  Do not exclude ask_user_question (child can then block
                      on extension-UI dialogs; you must answer them)
  -h, --help          Show this help`;

const argv = process.argv.slice(2);
const turns = [];
const positional = [];
let provider = process.env.PI_PROVIDER || "";
let model = process.env.PI_MODEL || "";
let timeoutMs = 5 * 60 * 1000;
let keepQuestionTool = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--turn") turns.push(argv[++i]);
  else if (a === "--provider") provider = argv[++i];
  else if (a === "--model") model = argv[++i];
  else if (a === "--timeout") timeoutMs = Number(argv[++i]);
  else if (a === "--keep-question-tool") keepQuestionTool = true;
  else if (a === "-h" || a === "--help") {
    console.log(USAGE);
    process.exit(0);
  } else positional.push(a);
}
const prompts = turns.length > 0 ? turns : positional;
if (prompts.some((p) => p === undefined) || prompts.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

// Locate the installed @earendil-works/pi-coding-agent package.
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
    // npm not available or not installed globally — fall through
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

// Import RpcClient by absolute path (works without a local node_modules).
const { RpcClient } = await import(pathToFileURL(join(pkgDir, "dist", "index.js")).href);

const args = ["--no-session"];
if (provider) args.push("--provider", provider);
if (model) args.push("--model", model);
if (!keepQuestionTool) args.push("--exclude-tools", "ask_user_question");

const client = new RpcClient({ cliPath, args });

const replies = [];
let turnText = "";
const off = client.onEvent((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
    turnText += event.assistantMessageEvent.delta;
  } else if (event.type === "tool_execution_start") {
    process.stderr.write(`\n[child tool: ${event.toolName}]\n`);
  } else if (event.type === "extension_ui_request") {
    // Only dialog methods block; fire-and-forget ones (notify, setStatus,
    // setWidget, setTitle, set_editor_text) expect no response.
    if (["select", "confirm", "input", "editor"].includes(event.method)) {
      process.stderr.write(
        `\n[WARN] child blocked on extension-UI dialog (method=${event.method}, id=${event.id}); ` +
          `it will hang until the client answers via extension_ui_response\n`
      );
    }
  }
});

let exitCode = 1;
try {
  if (provider && model) {
    process.stderr.write(`[info] child provider=${provider} model=${model}\n`);
  } else {
    process.stderr.write("[warn] no PI_PROVIDER/PI_MODEL in env; child will use configured defaults\n");
  }
  process.stderr.write(`[info] starting child: ${cliPath} --mode rpc ${args.join(" ")}\n`);
  await client.start();

  for (let i = 0; i < prompts.length; i++) {
    process.stdout.write(`\n--- turn ${i + 1} (parent → child) ---\n${prompts[i]}\n\n[child → parent]\n`);
    turnText = "";
    // 3rd arg = per-turn timeout in ms. Waits for agent_settled (agent_end alone
    // is not enough: retries/compaction/queued work can follow).
    await client.promptAndWait(prompts[i], undefined, timeoutMs);
    const reply = turnText.trim();
    replies.push(reply);
    process.stdout.write(`\n[reply-${i + 1}]\n${reply}\n`);
  }

  process.stdout.write(`\n=== RESULT === ${JSON.stringify({ replies })}\n`);
  exitCode = 0;
} catch (err) {
  process.stderr.write(`\n[error] ${err.message}\n`);
} finally {
  off();
  await client.stop().catch(() => {});
}
process.exit(exitCode);
