#!/usr/bin/env node
// reads-probe.mjs (user variant) — classify the reads-mode state of a
// directory from its icacls output.
//
// The mode is defined by the EXPLICIT agent ACEs on a sibling of the project:
//   - full-control (F) or NO_ACCESS (N) deny  => "deny"
//   - no explicit agent ACE at all             => "allow"
//   - anything else (or unreadable)            => "unknown" (forces re-apply)
//
// INHERITED agent ACEs (icacls lines like `agent:(I)(OI)(CI)(N)`) are
// deliberately ignored: they are effective via inheritance from an out-of-scope
// ancestor (e.g. the legacy tier-1 NO_ACCESS deny on C:\Users\<host>) and are
// NOT part of the mode state apply-denies.ps1 manages. A clean can never remove
// them from the child's own DACL, so counting them made the probe disagree with
// the cleanable state and triggered a full re-apply that then failed on the
// very same ACEs (2026-10-16: die 90 on every launch in allow mode).
//
// CLI:    node reads-probe.mjs <user> <dir>   → prints allow|deny|unknown
// Module: import { parseIcaclsMode, detectReadsMode } from "./reads-probe.mjs"
//         (hypervisor.mjs uses detectReadsMode; test-guard.mjs
//          unit-tests parseIcaclsMode)

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function parseIcaclsMode(out, user) {
  // (I) = inherited ACE: outside this script's management scope (see above).
  const agentLines = String(out ?? "")
    .split(/\r?\n/)
    .filter((l) => l.includes(user + ":") && !l.includes(user + ":(I)"));
  if (agentLines.length === 0) return "allow";
  // F = full-control deny, N = NO_ACCESS deny (the legacy tier-1 setup used N)
  if (agentLines.some((l) => /\bF\b|\bN\b/.test(l))) return "deny";
  return "unknown";
}

// Probe = the first sibling directory of the project (same pick as the
// selftest). Returns "allow" | "deny" | "unknown".
export function detectReadsMode({ user, project }) {
  let sample = "";
  try {
    const parent = dirname(project);
    for (const n of readdirSync(parent)) {
      if (n === basename(project)) continue;
      const p = join(parent, n);
      try { if (statSync(p).isDirectory()) { sample = p; break; } } catch { /* gone */ }
    }
  } catch { /* fall through */ }
  if (!sample) return "unknown";
  let out = "";
  try { out = execFileSync("icacls", [sample], { encoding: "utf8" }); } catch { return "unknown"; }
  return parseIcaclsMode(out, user);
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("reads-probe.mjs");
if (isMain) {
  const [user, dir] = process.argv.slice(2);
  if (!user || !dir) {
    console.error("usage: node reads-probe.mjs <user> <dir>");
    process.exit(2);
  }
  let out = "";
  try { out = execFileSync("icacls", [dir], { encoding: "utf8" }); } catch {
    console.log("unknown");
    process.exit(0);
  }
  console.log(parseIcaclsMode(out, user));
}
