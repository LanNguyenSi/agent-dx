#!/usr/bin/env node
// Stand-in for `agent-primitives guard` in the evaluation tests (the real
// binary is not a dependency of this package). It takes the same arguments
// (`[global options] guard <timeout-s> <max-rss-MiB> -- <cmd...>`), runs the
// command in a process group of its own, kills the group at the timeout,
// kills what the command left in its group, and prints a guard-shaped JSON
// envelope. It finds nothing outside the group, like the real guard for a
// process cut loose between two polls. Its own argv goes to the log dir.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const logDir = argv[argv.indexOf("--log-dir") + 1];
const at = argv.indexOf("guard");
const timeoutS = Number(argv[at + 1]);
const maxRss = Number(argv[at + 2]);
const [cmd, ...args] = argv.slice(argv.indexOf("--", at) + 1);
if (logDir) {
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "fake-guard-argv.json"), JSON.stringify({ argv, cwd: process.cwd() }));
}

function envelope(reason, exitCode, childExitCode, extra = {}) {
  console.log(
    JSON.stringify({
      tool: "agent-primitives",
      command: "guard",
      status: reason === "none" || reason === "child_exit" ? "pass" : "fail",
      reason,
      exitCode,
      childExitCode,
      limits: { timeoutMs: timeoutS * 1000, maxRssMiB: maxRss, pollMs: 200 },
      peakRssMiB: 1,
      peakProcessRssMiB: 1,
      polls: 1,
      failedPolls: 0,
      killedCount: 0,
      killed: [],
      leftoverCount: 0,
      leftovers: [],
      survivorCount: 0,
      survivors: [],
      leftoverCheckFailed: false,
      ...extra,
    }),
  );
  process.exit(exitCode);
}

const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Gone already.
  }
}, timeoutS * 1000);
child.on("error", () => {
  clearTimeout(timer);
  envelope("spawn_failed", 2, null);
});
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  const childExitCode = code ?? 128 + (constants.signals[signal] ?? 0);
  if (timedOut) {
    envelope("timeout", 124, childExitCode, {
      killedCount: 1,
      killed: [{ pid: child.pid, pgid: child.pid, rssMiB: 1, inGroup: true, command: cmd }],
    });
  }
  let left = 0;
  try {
    process.kill(-child.pid, 0);
    left = 1;
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is empty.
  }
  if (left > 0) {
    envelope("leftover", 122, childExitCode, {
      leftoverCount: left,
      leftovers: [{ pid: -1, pgid: child.pid, rssMiB: 1, inGroup: true, command: "(group member)" }],
    });
  }
  envelope("none", childExitCode, childExitCode);
});
