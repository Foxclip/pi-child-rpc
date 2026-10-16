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
import { existsSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseIcaclsMode } from "./user/reads-probe.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const supervisorPath = join(here, "supervisor.mjs");
const TASK = "task with enough length to pass the short-task warning threshold for tests";

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
  return { out, dir, code };
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

// 11. Stagnation sensor: N consecutive SUCCESSFUL calls with no usable
//     content (killed client / HTTP 400 / permission denied) → L1 steer
//     (the failure shape --max-errors never sees: those calls do not fail)
run({
  name: "stagnation sensor → L1 steer → recovery",
  args: [TASK, "--stagnation", "3", "--max-errors", "0"],
  phases: [
    [
      { msg: [{ toolCall: "bash", args: { cmd: "probe1" } }] },
      { toolEnd: { durationMs: 5, result: "killed at 270s (no output)" } },
      { msg: [{ toolCall: "bash", args: { cmd: "probe2" } }] },
      { toolEnd: { durationMs: 5, result: "400 Failed to load image or audio file (HTTP 400)" } },
      { msg: [{ toolCall: "bash", args: { cmd: "probe3" } }] },
      { toolEnd: { durationMs: 5, result: "Permission denied" } },
    ],
    [...tool("bash", { cmd: "next" }), ...done("Switched approach; report saved.")],
  ],
  expect: ["L1 stagnation steer", "3 consecutive tool calls returned no usable content", "\"status\":\"completed\""],
  expectNot: ["L2 fork"],
});

// 12. Hard timeout WITH finalization: budget warning at 90%, finalize prompt at
//     the wall clock, child settles with a report → completed-finalized, exit 0
run({
  name: "hard timeout → finalization window → completed-finalized",
  args: [TASK, "--timeout", "0.15", "--finalize", "0.5"],
  phases: [
    [{ pauseMs: 7000 }], // task run (silence; idle-timeout is 300s, no stall)
    [{ pauseMs: 1500 }], // budget-warning prompt (90% of 9s = 8.1s) — child silent
    [
      say("FINAL REPORT: partial — items 1-2 done, item 3 unfinished (out of time)."),
      { writeFile: "report.md" },
      { settled: {} },
    ],
  ],
  expect: [
    "BUDGET WARNING",
    "HARD TIMEOUT",
    "finalization window",
    "\"status\":\"completed\"",
    "\"exitReason\":\"completed-finalized\"",
  ],
  expectExit: 0,
});

// 13. Hard timeout with --finalize 0 (legacy behavior) → immediate hard-timeout
run({
  name: "hard timeout, --finalize 0 → immediate hard-timeout",
  args: [TASK, "--timeout", "0.1", "--finalize", "0"],
  phases: [
    [{ pauseMs: 12000 }],
  ],
  expect: ["\"exitReason\":\"hard-timeout\"", "\"status\":\"stuck\""],
  expectNot: ["finalization window", "BUDGET WARNING"],
  expectExit: 3,
});

// 14. Run manifest: pi-child-result.json in the cwd (always, every outcome)
{
  const r = run({
    name: "manifest written (pi-child-result.json)",
    args: [TASK],
    phases: [[...tool("bash", { cmd: "ls" }), ...done("All done, report saved.")]],
    expect: ["\"status\":\"completed\""],
  });
  const mf = join(r.dir, "pi-child-result.json");
  let m = null;
  try { m = JSON.parse(readFileSync(mf, "utf8")); } catch { /* missing/invalid */ }
  const okm = !!m && m.v === 1 && m.result?.status === "completed" &&
    typeof m.result?.manifest === "string" && m.result.manifest.endsWith("pi-child-result.json") &&
    typeof m.startedAt === "string" && typeof m.finishedAt === "string";
  if (okm) { passCount++; console.log("PASS: manifest fields"); }
  else {
    failCount++;
    console.log(`FAIL: manifest fields (exists=${existsSync(mf)} m=${JSON.stringify(m)?.slice(0, 200)})`);
  }
}

// 15. --timeout 0 = unlimited (no wall clock): the run must NOT be cut by a
//     wall clock — with the pre-v0.10.1 semantics (--timeout 0 = "die now",
//     since elapsed > 0 on the first tick) this run would hard-timeout;
//     now it completes normally. No deadline note, no budget warning either.
run({
  name: "--timeout 0 = unlimited (completes, no wall clock)",
  args: [TASK, "--timeout", "0"],
  phases: [
    // phase 0 = the task prompt's response: 2.5s of silence (LONGER than the
    // pre-v0.10.1 die-now tick — elapsed > 0 fired on the first loop tick when
    // --timeout 0) — then normal work + settle. Must all fit in one phase: the
    // supervisor prompts only once, and steer/fork prompts consume later ones.
    [{ pauseMs: 2500 }, ...tool("bash", { cmd: "ls" }), ...done("Done, report saved.")],
  ],
  expect: ["\"status\":\"completed\""],
  expectNot: ["HARD TIMEOUT", "BUDGET WARNING", "HARD DEADLINE", "\"exitReason\":\"hard-timeout\""],
  expectExit: 0,
});

// 16. reads-probe parsing (the 2026-10-16 regression: an ANCESTOR-INHERITED
//     agent deny must not count as mode state — the clean can never remove
//     inherited ACEs, so counting them triggered a re-apply that failed)
{
  const cases = [
    ["inherited NO_ACCESS only → allow", parseIcaclsMode(
      `sibling DESKTOP-N9PF8BH\\agent:(I)(OI)(CI)(N)\nBUILTIN\\Administrators:(OI)(CI)(F)`, "agent"), "allow"],
    ["no agent ACE → allow", parseIcaclsMode(
      `sibling BUILTIN\\Administrators:(OI)(CI)(F)\nCREATOR OWNER:(OI)(CI)(F)`, "agent"), "allow"],
    ["explicit F deny → deny", parseIcaclsMode(
      `sibling DESKTOP-X\\agent:(OI)(CI)(F)`, "agent"), "deny"],
    ["explicit N deny (legacy) → deny", parseIcaclsMode(
      `sibling DESKTOP-X\\agent:(OI)(CI)(N)`, "agent"), "deny"],
    ["grant only → unknown", parseIcaclsMode(
      `sibling DESKTOP-X\\agent:(OI)(CI)(M)`, "agent"), "unknown"],
    ["legacy DENY-mask → unknown (safe: forces re-apply)", parseIcaclsMode(
      `sibling DESKTOP-X\\agent:(DENY)(D,WO,WD,AD,DC,WA)`, "agent"), "unknown"],
    ["inherited N + explicit grant → unknown (inherited ignored)", parseIcaclsMode(
      `sibling DESKTOP-X\\agent:(I)(OI)(CI)(N)\nDESKTOP-X\\agent:(OI)(CI)(M)`, "agent"), "unknown"],
  ];
  for (const [name, got, want] of cases) {
    if (got === want) { passCount++; console.log(`PASS: ${name}`); }
    else { failCount++; console.log(`FAIL: ${name} (got ${got}, want ${want})`); }
  }
}

console.log(`\n=== ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount === 0 ? 0 : 1);
