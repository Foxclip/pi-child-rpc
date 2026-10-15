// test-supervisor.mjs — static regression tests for supervisor.mjs
//
// Runs the real supervisor.mjs against a FAKE RpcClient: PI_PACKAGE_DIR points
// at a scratch package whose dist/index.js exports a RpcClient that replays
// scripted child events (no model, no network). Deterministic and fast.
//
// Usage: node test-supervisor.mjs
//
// Event script format (PI_TEST_JSON env → path to JSON file):
//   { phases: [ [events...], [events...], ... ] }
//   prompt() consumes phase 0 (the task response); each later prompt()/steer()
//   (fork re-prompts, corrective steers) consumes the next phase. A missing
//   phase = "silent" (nothing more happens).
//   Event items:
//     { "msg": [ {thinking}, {text}, {toolCall:"bash",args:{...}} ] }
//         → assistant message entry + text deltas + tool_execution_start
//     { "toolEnd": { isError?, durationMs?, result? } }
//         → tool_execution_end for the open call
//     { "writeFile": "report.md" }   → creates that file (cwd = test tmp dir)
//     { "settled": { "aborted": false } }
//     { "abortSettled": true }       → agent_settled {aborted:true} (external)
//     { "pauseMs": 1500 }            → silence (for stall tests)

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const supervisorPath = join(here, "supervisor.mjs");

// ---------------------------------------------------------------------------
// Fake pi package (PI_PACKAGE_DIR override)
// ---------------------------------------------------------------------------
const FAKE_INDEX = `
import { readFileSync, writeFileSync as wfs } from "node:fs";
const spec = process.env.PI_TEST_JSON ? JSON.parse(readFileSync(process.env.PI_TEST_JSON, "utf8")) : { phases: [] };
class RpcClient {
  constructor(opts) {
    this.opts = opts;
    this.handlers = [];
    this.entries = [];
    this.lastText = "";
    this.phase = 0;
    this.forkCalls = [];
    this.abortCalls = 0;
    this.steers = [];
    this.prompts = [];
  }
  onEvent(cb) { this.handlers.push(cb); }
  emit(ev) { for (const h of this.handlers) h(ev); }
  async start() {
    // No replay here: nothing happens until the supervisor prompts the task.
    this.entries.push({ type: "session", id: "session-0", sessionId: "fake-session" });
    this.emit({ type: "session_start", sessionId: "fake-session" });
  }
  async prompt(text) {
    this.prompts.push(text);
    const id = "user-" + this.entries.length;
    this.entries.push({ type: "message", id, message: { role: "user", content: [{ type: "text", text }] } });
    this.replay();
    return "accepted";
  }
  async steer(msg) {
    this.steers.push(msg);
    const id = "user-" + this.entries.length;
    this.entries.push({ type: "message", id, message: { role: "user", content: [{ type: "text", text: msg }] } });
    this.replay();
    return "accepted";
  }
  replay() {
    if (this.phase >= spec.phases.length) return;
    const events = spec.phases[this.phase++] ?? [];
    let i = 0;
    const next = () => {
      if (i >= events.length) return;
      const ev = events[i++];
      this.play(ev);
      // pauseMs keeps the event stream silent (stall tests); everything else
      // plays back as fast as the event loop allows.
      if (ev.pauseMs) setTimeout(next, ev.pauseMs);
      else setImmediate(next);
    };
    next();
  }
  play(ev) {
    if (ev.msg) {
      const blocks = [];
      for (const b of ev.msg) {
        if (b.thinking !== undefined) blocks.push({ type: "thinking", thinking: b.thinking });
        if (b.text !== undefined) {
          blocks.push({ type: "text", text: b.text });
          this.lastText = b.text;
          this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: b.text } });
        }
        if (b.toolCall !== undefined) {
          blocks.push({ type: "toolCall", id: "tc-" + Math.random().toString(36).slice(2), name: b.toolCall, arguments: b.args });
          this.emit({ type: "tool_execution_start", toolName: b.toolCall, args: b.args ?? {} });
        }
      }
      this.entries.push({ type: "message", id: "asst-" + this.entries.length, message: { role: "assistant", content: blocks } });
    } else if (ev.toolEnd) {
      this.emit({ type: "tool_execution_end", isError: !!ev.toolEnd.isError, durationMs: ev.toolEnd.durationMs ?? 5, result: ev.toolEnd.result ?? "ok" });
    } else if (ev.writeFile) {
      wfs(ev.writeFile, "artifact\\n", "utf8");
    } else if (ev.settled) {
      this.emit({ type: "agent_settled", aborted: !!ev.settled.aborted });
    } else if (ev.abortSettled) {
      this.emit({ type: "agent_settled", aborted: true });
    }
    // pauseMs is handled by replay() scheduling, not by play()
  }
  async abort() { this.abortCalls++; }
  async clearQueue() {}
  async fork(checkpointId) {
    this.forkCalls.push(checkpointId);
    return { sessionId: "fake-forked", sessionFile: "/tmp/fake-forked.jsonl", checkpointId, cancelled: false };
  }
  async getState() { return { sessionId: "fake-session", sessionFile: "/tmp/fake-session.jsonl", entries: this.entries }; }
  async getEntries() { return { entries: this.entries }; }
  async getLastAssistantText() { return { text: this.lastText }; }
  async stop() {}
}
export { RpcClient };
`;

const fakePkg = mkdtempSync(join(tmpdir(), "pi-fake-pkg-"));
mkdirSync(join(fakePkg, "dist"), { recursive: true });
writeFileSync(join(fakePkg, "dist", "cli.js"), "// dummy cli entry\n");
writeFileSync(join(fakePkg, "dist", "index.js"), FAKE_INDEX);

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
let passCount = 0;
let failCount = 0;

function run({ name, args = [], phases, expect, expectExit = 0, expectNot = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-sup-test-"));
  const specFile = join(dir, "script.json");
  writeFileSync(specFile, JSON.stringify({ phases }));
  // spawnSync (not execFileSync): [supervisor]/[info] lines go to STDERR and
  // must be included in the assertions.
  const r = spawnSync("node", [supervisorPath, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PI_PACKAGE_DIR: fakePkg,
      PI_TEST_JSON: specFile,
      PI_PROVIDER: "fake",
      PI_MODEL: "fake/model",
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
  });
  const code = r.status ?? 1;
  const out = ((r.stdout ?? "") + (r.stderr ?? "")).toString();
  const ok =
    code === expectExit &&
    expect.every((s) => out.includes(s)) &&
    expectNot.every((s) => !out.includes(s));
  if (ok) {
    passCount++;
    console.log(`PASS: ${name}`);
  } else {
    failCount++;
    console.log(`FAIL: ${name}`);
    console.log(`  exit=${code} (expected ${expectExit})`);
    for (const s of expect) if (!out.includes(s)) console.log(`  missing: ${JSON.stringify(s)}`);
    for (const s of expectNot) if (out.includes(s)) console.log(`  unexpected: ${JSON.stringify(s)}`);
    console.log("--- output (last 40 lines) ---");
    console.log(out.split("\n").slice(-40).join("\n"));
  }
  return out;
}

// tool start+end pair helper
const tool = (name, args, isError = false) => [
  { msg: [{ toolCall: name, args }] },
  { toolEnd: { isError, durationMs: 5 } },
];
const think = (t) => ({ msg: [{ thinking: t }] });
const say = (t) => ({ msg: [{ text: t }] });
const done = (t = "Done.") => [say(t), { settled: {} }];

// 1. External abort (host repetition guard) → L2 fork → completed
run({
  name: "external abort → L2 fork → completed",
  args: ["task with enough length to pass the short-task warning threshold for tests"],
  phases: [
    [say("working on it"), ...tool("bash", { cmd: "ls" }), { abortSettled: true }],
    done("Done. Report written to report.md."),
  ],
  expect: ["L2 fork #1", "\"status\":\"completed\"", "\"exitReason\":\"completed\""],
  expectNot: ["degenerate settle"],
});

// 2. Stall (no events) → L2 fork → completed
run({
  name: "stall → L2 fork → completed",
  args: ["task with enough length to pass the short-task warning threshold for tests", "--idle-timeout", "1", "--tool-timeout", "1"],
  phases: [
    [say("ok"), { pauseMs: 2500 }, { settled: {} }],
    done("Finished after fork."),
  ],
  expect: ["L2 fork #1", "stalled", "\"status\":\"completed\""],
});

// 3. Error loop → L1 steer → recovery → completed
run({
  name: "error loop → L1 steer → recovery",
  args: ["task with enough length to pass the short-task warning threshold for tests", "--max-errors", "3"],
  phases: [
    [...tool("bash", { cmd: "a" }, true), ...tool("bash", { cmd: "b" }, true), ...tool("bash", { cmd: "c" }, true)],
    [...tool("bash", { cmd: "d" }), ...done("Recovered; report saved.")],
  ],
  expect: ["L1 error-loop steer", "3 consecutive tool calls failed", "\"status\":\"completed\""],
  expectNot: ["L2 fork"],
});

// 4. Tool loop → L1 steer → model reports → completed (no fork)
run({
  name: "tool loop → L1 steer → completed",
  args: ["task with enough length to pass the short-task warning threshold for tests", "--loop-threshold", "3"],
  phases: [
    [...tool("bash", { cmd: "x" }), ...tool("bash", { cmd: "x" }), ...tool("bash", { cmd: "x" })],
    done("Done, report saved to notes.txt"),
  ],
  expect: ["L1 steer", "loop on bash", "\"status\":\"completed\""],
  expectNot: ["L2 fork"],
});

// 5. Degenerate settle (empty stop: no text, no tool calls) → ladder → stuck (no budget)
run({
  name: "degenerate empty stop, no budget → stuck",
  args: ["task with enough length to pass the short-task warning threshold for tests", "--max-steers", "1", "--max-forks", "0"],
  phases: [
    [think("hmm"), { settled: {} }],
    [think("still thinking"), { settled: {} }],
  ],
  expect: ["degenerate settle", "no text and no tool activity", "\"exitReason\":\"degenerate-settle\"", "\"status\":\"stuck\""],
  expectExit: 3,
});

// 6. Normal completion → no intervention
run({
  name: "normal completion → no intervention",
  args: ["task with enough length to pass the short-task warning threshold for tests"],
  phases: [
    [think("planning"), ...tool("bash", { cmd: "ls" }), ...done("All done. The report is in report.md.")],
  ],
  expect: ["\"status\":\"completed\"", "\"exitReason\":\"completed\""],
  expectNot: ["L1 steer", "L2 fork", "degenerate"],
});

// 7. Stray thinking-only tail AFTER a real answer → completed (regression:
//    2026-10-15 live test — local models end turns with stray thinking tails;
//    that must NOT trigger the degenerate ladder)
run({
  name: "stray thinking tail after real answer → completed",
  args: ["task with enough length to pass the short-task warning threshold for tests", "--max-steers", "2", "--max-forks", "2"],
  phases: [
    [
      think("thinking about the task"),
      ...tool("bash", { cmd: "ls" }),
      say("The answer is 42. I verified it with the tool and everything looks fine."),
      think("ok now stop"),
      { settled: {} },
    ],
  ],
  expect: ["\"status\":\"completed\"", "\"exitReason\":\"completed\""],
  expectNot: ["degenerate settle", "L1 steer", "L2 fork"],
});

// 8. Unknown CLI flag → exit 2 with "unknown flag" (must NOT become task text)
run({
  name: "unknown CLI flag rejected",
  args: ["--bogus-flag", "x", "task with enough length to pass the short-task warning threshold for tests"],
  phases: [],
  expect: ["unknown flag", "--bogus-flag"],
  expectExit: 2,
});

// 9. Missing --expect-file at settle → steer → file created → completed
run({
  name: "missing expect-file → steer → completed after artifact",
  args: ["task with enough length to pass the short-task warning threshold for tests", "--expect-file", "report.md"],
  phases: [
    [say("working on the report"), { settled: {} }],
    [{ writeFile: "report.md" }, ...done("Done, report.md written")],
  ],
  expect: ["missing expected file", "report.md", "\"status\":\"completed\""],
});

// 10. Autonomous text-loop (long text without tool calls) → L1 steer → back on task
//     (the "thinking loop" — invisible to every other sensor)
run({
  name: "autonomous text-loop → L1 steer → completed",
  args: [
    "task with enough length to pass the short-task warning threshold for tests",
    "--max-text", "200",
    "--max-steers", "2", "--max-forks", "2",
  ],
  phases: [
    [say("A".repeat(300))], // no settle: the sensor fires mid-stream
    [...tool("bash", { cmd: "ls" }), ...done("Back on task. Finished.")],
  ],
  expect: ["L1 text-loop steer", "thinking loop", "\"status\":\"completed\""],
  expectNot: ["L2 fork"],
});

console.log(`\n=== ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount === 0 ? 0 : 1);
