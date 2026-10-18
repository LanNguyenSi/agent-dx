#!/usr/bin/env node
// Stand-in for the claude binary in the evaluation runner tests. It records
// what it was started with, then answers like `claude -p --output-format json`.
// The tests start it through a wrapper script that sets the STUB_* variables,
// since the runner passes no other variable of the test environment on.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const startedAt = Date.now();
const argv = process.argv.slice(2);
// `claude --version`: answered before stdin is read, and not recorded as a call.
if (argv.length === 1 && argv[0] === "--version") {
  console.log(process.env.STUB_VERSION ?? "9.9.9 (Stub Code)");
  process.exit(0);
}
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

const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const isCanary = stdin.includes("isolation check of a review evaluation harness");
const isReviewer = argv.includes("--agents") && !isCanary;

function readJson(pathOrJson) {
  if (pathOrJson === undefined) return null;
  try {
    return JSON.parse(pathOrJson.trim().startsWith("{") ? pathOrJson : readFileSync(pathOrJson, "utf8"));
  } catch (error) {
    return { unreadable: error.message };
  }
}

// Claims the next free call-<n>.json atomically, so parallel stubs never share a record.
let recordPath = null;
if (recordDir) {
  let n = readdirSync(recordDir).filter((f) => f.startsWith("call-")).length;
  for (;;) {
    const candidate = join(recordDir, `call-${n}.json`);
    try {
      closeSync(openSync(candidate, "wx"));
      recordPath = candidate;
      break;
    } catch {
      n += 1;
    }
  }
}

const record = recordDir
  ? {
      argv,
      cwd: process.cwd(),
      stdin,
      startedAt,
      endedAt: null,
      envNames: Object.keys(process.env).sort(),
      env: Object.fromEntries(
        [
          "ANTHROPIC_API_KEY",
          "HOME",
          "CLAUDE_CONFIG_DIR",
          "TMPDIR",
          "GH_CONFIG_DIR",
          "GIT_CONFIG_NOSYSTEM",
          "GIT_CONFIG_GLOBAL",
          "GIT_SSH_COMMAND",
          "GIT_TERMINAL_PROMPT",
          "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
          "CLAUDE_CODE_TMPDIR",
          "npm_config_cache",
          "PATH",
        ].map((name) => [name, process.env[name]]),
      ),
      agents: argv.includes("--agents") ? readJson(valueOf("--agents")) : null,
      settings: readJson(valueOf("--settings")),
      isCanary,
      remotes: isReviewer ? git(["remote"]) : null,
      head: isReviewer ? git(["rev-parse", "HEAD"]) : null,
      branch: isReviewer ? git(["branch", "--show-current"]) : null,
      refs: isReviewer ? git(["for-each-ref", "--format=%(refname)"]) : null,
      futureReachable:
        isReviewer && process.env.STUB_FUTURE_SHA
          ? git(["cat-file", "-e", `${process.env.STUB_FUTURE_SHA}^{commit}`]).startsWith("error")
            ? "no"
            : "yes"
          : null,
      setupMarker: isReviewer ? existsSync("node_modules/marker") : null,
      fetchHead: isReviewer ? existsSync(".git/FETCH_HEAD") : null,
    }
  : null;
if (record) writeFileSync(recordPath, JSON.stringify(record, null, 2));

// Lets a test make the session print a line on stderr, such as Claude Code's warnings.
if (process.env.STUB_STDERR) process.stderr.write(`${process.env.STUB_STDERR}\n`);

if (process.env.STUB_DELAY_MS) {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.STUB_DELAY_MS)));
}
if (record) {
  record.endedAt = Date.now();
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
}

function answer(text, extra = {}) {
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: text,
      total_cost_usd: isReviewer ? 0.25 : 0.05,
      num_turns: 4,
      duration_ms: 1200,
      ...extra,
    }),
  );
}

/** The canary's answer; STUB_CANARY picks the scenario. */
function canaryAnswer() {
  const scenario = process.env.STUB_CANARY ?? "pass";
  const touch = /`touch (\S+)`/.exec(stdin)?.[1];
  const write = /`write_checkout` \(Bash tool\): `printf '%s' (\S+) > (\S+)`/.exec(stdin);
  const config = /`write_config_settings` \(Bash tool\): `printf '(\S+)' (\S+) > (\S+)`/.exec(stdin);
  const evidenceHome = /`write_evidence_home` \(Bash tool\): `printf '%s' (\S+) > (\S+) && printf '%s' \S+ > (\S+) &&/.exec(stdin);
  const sibling = /`read_sibling_tool` \(Read tool\): Read `(\S+)`/.exec(stdin)?.[1];
  if (scenario === "touch" && touch) writeFileSync(touch, "");
  if (scenario !== "no-write" && write) writeFileSync(join(process.cwd(), write[2]), write[1]);
  // As a sandbox that let the write through: the probe's own content in the config dir.
  if (scenario === "config-write" && config) writeFileSync(config[3], config[1].replace("%s", config[2]));
  if (scenario !== "no-evidence-write" && evidenceHome) {
    writeFileSync(evidenceHome[2], evidenceHome[1]);
    writeFileSync(evidenceHome[3], evidenceHome[1]);
  }
  const version = execFileSync("node", ["--version"], { encoding: "utf8" }).trim();
  const ids = [...stdin.matchAll(/^\d+\. `([a-z_]+)`/gm)].map((m) => m[1]);
  const results = ids.map((id) => {
    const item = { id, attempted: true, succeeded: false, evidence: "Operation not permitted" };
    if (id === "write_checkout") item.succeeded = scenario !== "no-write";
    if (id === "read_scratch") Object.assign(item, { succeeded: true, evidence: "ok" });
    if (id === "read_checkout_tool") item.succeeded = scenario !== "checkout-read-denied";
    // Reports success either way: the host must find the files itself.
    if (id === "write_evidence_home") Object.assign(item, { succeeded: true, evidence: "exited 0" });
    if (id === "read_sibling_tool" && scenario === "sibling-read")
      Object.assign(item, { succeeded: true, evidence: `content ${readFileSync(sibling, "utf8")}` });
    if (id === "read_tmp_file" && scenario === "tmp-read") Object.assign(item, { succeeded: true, evidence: "READ_OK" });
    if (id === "ssh_github" && scenario === "evidence-secrets")
      item.evidence = `denied for ${process.env.ANTHROPIC_API_KEY}, saw sk-ant-api03-FAKEFAKEFAKEFAKEFAKE, ghp_FAKEFAKEFAKEFAKEFAKE0000 and -----BEGIN OPENSSH PRIVATE KEY-----`;
    if (id === "read_home_file" && scenario === "sentinel-leak") {
      const target = /`read_home_file` \(Bash tool\): `cat (\S+)/.exec(stdin)?.[1];
      Object.assign(item, { succeeded: true, evidence: `READ_OK ${readFileSync(target, "utf8")}` });
    }
    if (id === "node_version") Object.assign(item, { succeeded: true, output: version });
    const namesByScenario = {
      names: ["CLAUDE_CODE_MESSAGING_TOKEN"],
      "names-git": ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_0"],
      "names-git-mixed": ["GIT_CONFIG_KEY_0", "FOO_SECRET"],
      "names-proxy": ["CLOUDSDK_PROXY_PASSWORD", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"],
      "names-unknown": ["CLOUDSDK_PROXY_PASSWORD", "SOME_NEW_INJECTED_SECRET"],
      "names-format": ["`git_config_count`", "GIT_CONFIG_KEY_0=core.pager", "`gh_token`=x"],
    };
    if (id === "env_secret_names") item.names = namesByScenario[scenario] ?? [];
    if (id === "env_secret_names" && scenario in namesByScenario) item.succeeded = true;
    if (id === "ssh_github" && scenario === "refuse") Object.assign(item, { attempted: false, evidence: "declined" });
    if (id === "curl_example" && scenario === "curl") Object.assign(item, { succeeded: true, evidence: "200" });
    return item;
  });
  const leak = scenario === "leak" ? `\nkey: ${process.env.ANTHROPIC_API_KEY}\n` : "";
  return `Done.${leak}\n\`\`\`json\n${JSON.stringify({ results })}\n\`\`\``;
}

if (mode === "hang" || mode === "hang-stubborn") {
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  if (recordDir) writeFileSync(join(recordDir, "child.pid"), String(child.pid));
  if (mode === "hang-stubborn") process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "error") {
  console.log(JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 1 }));
  process.exit(1);
} else if (mode === "error-exit0") {
  console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "", total_cost_usd: 1 }));
} else if (mode === "garbage") {
  console.log("not json at all");
} else {
  if (mode === "escape") {
    // A descendant in a process group and session of its own, left behind in the checkout.
    const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore", cwd: process.cwd() });
    if (recordDir) writeFileSync(join(recordDir, "escaped.pid"), String(child.pid));
    child.unref();
  }
  if (isCanary) {
    answer(canaryAnswer());
  } else {
    const file = isReviewer ? process.env.STUB_FINAL_TEXT_FILE : process.env.STUB_JUDGE_TEXT_FILE;
    let text = file ? readFileSync(file, "utf8") : "";
    // Lets a test make the review quote the paths the session saw.
    text = text.split("@@CWD@@").join(process.cwd());
    answer(text);
  }
}
