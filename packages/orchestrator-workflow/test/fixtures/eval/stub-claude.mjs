#!/usr/bin/env node
// Stand-in for the claude binary in the evaluation runner tests. It records
// what it was started with, then answers like `claude -p --output-format json`.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const recordDir = process.env.STUB_RECORD_DIR;
const mode = process.env.STUB_MODE ?? "ok";

let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    return `error: ${error.message.split("\n")[0]}`;
  }
}

const agentsIndex = argv.indexOf("--agents");
const isReviewer = agentsIndex >= 0;
if (recordDir) {
  const n = readdirSync(recordDir).filter((f) => f.startsWith("call-")).length;
  writeFileSync(
    join(recordDir, `call-${n}.json`),
    JSON.stringify(
      {
        argv,
        cwd: process.cwd(),
        stdin,
        env: {
          GH_TOKEN: process.env.GH_TOKEN,
          GITHUB_TOKEN: process.env.GITHUB_TOKEN,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          HOME: process.env.HOME,
          CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        },
        agents: isReviewer ? JSON.parse(readFileSync(argv[agentsIndex + 1], "utf8")) : null,
        remotes: isReviewer ? git(["remote"]) : null,
        head: isReviewer ? git(["rev-parse", "HEAD"]) : null,
        branch: isReviewer ? git(["branch", "--show-current"]) : null,
        refs: isReviewer ? git(["for-each-ref", "--format=%(refname)"]) : null,
        futureReachable: isReviewer && process.env.STUB_FUTURE_SHA
          ? git(["cat-file", "-e", `${process.env.STUB_FUTURE_SHA}^{commit}`]).startsWith("error")
            ? "no"
            : "yes"
          : null,
        setupMarker: isReviewer ? existsSync("node_modules/marker") : null,
        fetchHead: isReviewer ? existsSync(".git/FETCH_HEAD") : null,
      },
      null,
      2,
    ),
  );
}

if (mode === "hang" || mode === "hang-stubborn") {
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  if (recordDir) writeFileSync(join(recordDir, "child.pid"), String(child.pid));
  if (mode === "hang-stubborn") process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "error") {
  console.log(JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 1 }));
  process.exit(1);
} else if (mode === "garbage") {
  console.log("not json at all");
} else {
  const file = isReviewer ? process.env.STUB_FINAL_TEXT_FILE : process.env.STUB_JUDGE_TEXT_FILE;
  const text = file ? readFileSync(file, "utf8") : "";
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: text,
      total_cost_usd: isReviewer ? 0.25 : 0.05,
      num_turns: 4,
      duration_ms: 1200,
    }),
  );
}
