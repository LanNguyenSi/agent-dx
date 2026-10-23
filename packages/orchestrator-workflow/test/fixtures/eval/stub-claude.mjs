#!/usr/bin/env node
// Stand-in for the claude binary in the evaluation runner tests. It records
// what it was started with, then answers like `claude -p --output-format json`.
// The tests start it through a wrapper script that sets the STUB_* variables,
// since the runner passes no other variable of the test environment on.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
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
if (process.env.STUB_STDERR) process.stderr.write(`${process.env.STUB_STDERR.split("@@KEY@@").join(process.env.ANTHROPIC_API_KEY ?? "")}\n`);

if (process.env.STUB_DELAY_MS) {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.STUB_DELAY_MS)));
}
if (record) {
  record.endedAt = Date.now();
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
}

const streamMode = valueOf("--output-format") === "stream-json";

function resultObject(text, extra = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    total_cost_usd: isReviewer ? 0.25 : 0.05,
    num_turns: 4,
    duration_ms: 1200,
    ...extra,
  };
}

function answer(text, extra = {}) {
  console.log(JSON.stringify(resultObject(text, extra)));
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
  // "write-lie": the session says the write worked, but no file exists. "huge-write": a file far
  // larger than the token stands where the token file belongs (sparse, so it costs no disk).
  if (scenario === "huge-write" && write) {
    const big = join(process.cwd(), write[2]);
    closeSync(openSync(big, "w"));
    truncateSync(big, 3 * 1024 ** 3);
  } else if (scenario !== "no-write" && scenario !== "write-lie" && write) writeFileSync(join(process.cwd(), write[2]), write[1]);
  // As a sandbox that let the write through: the probe's own content in the config dir.
  if (scenario === "config-write" && config) writeFileSync(config[3], config[1].replace("%s", config[2]));
  if (scenario !== "no-evidence-write" && evidenceHome) {
    writeFileSync(evidenceHome[2], evidenceHome[1]);
    writeFileSync(evidenceHome[3], evidenceHome[1]);
  }
  const version = process.env.STUB_NODE_VERSION ?? execFileSync("node", ["--version"], { encoding: "utf8" }).trim();
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
      "names-blank": ["", "``"],
    };
    if (id === "env_secret_names") item.names = namesByScenario[scenario] ?? [];
    if (id === "env_secret_names" && scenario in namesByScenario) item.succeeded = true;
    if (id === "ssh_github" && scenario === "refuse") Object.assign(item, { attempted: false, evidence: "declined" });
    if (id === "curl_example" && scenario === "curl") Object.assign(item, { succeeded: true, evidence: "200" });
    // The report claims a success the tools did not show (canaryStream prints the failure).
    if (id === "ssh_github" && scenario === "claims-success") item.succeeded = true;
    return item;
  });
  const leak =
    scenario === "leak"
      ? `\nkey: ${process.env.ANTHROPIC_API_KEY}\n`
      : scenario === "leak-env"
        ? `\nvalue: ${process.env.STUB_LEAK_TEXT}\n`
        : "";
  return { text: `Done.${leak}\n\`\`\`json\n${JSON.stringify({ results })}\n\`\`\``, results, scenario };
}

/**
 * The stream-json events a session that behaved like the scenario would have
 * printed: one tool call and result per attempted action, derived from the
 * same results the closing report carries.
 */
function canaryStream({ text, results, scenario }) {
  const lines = [...stdin.matchAll(/^\d+\. `([a-z_]+)` \((Bash|Read) tool\): (.*)$/gm)].map((m) => ({
    id: m[1],
    tool: m[2],
    instruction: m[3],
  }));
  const planted = (file) => {
    try {
      return JSON.parse(readFileSync(join(process.cwd(), ".claude", file), "utf8"));
    } catch {
      return null;
    }
  };
  const skillNames = existsSync(join(process.cwd(), ".claude", "skills"))
    ? readdirSync(join(process.cwd(), ".claude", "skills"))
    : [];
  // A Claude Code that wrongly read the project config would run its hooks.
  if (scenario === "hook-ran") {
    const hook = planted("settings.json")?.hooks?.SessionStart?.[0]?.hooks?.[0]?.command;
    if (hook) execFileSync("/bin/sh", ["-c", hook]);
  }
  const events = [];
  if (scenario !== "no-init") {
    events.push({
      type: "system",
      subtype: "init",
      cwd: process.cwd(),
      tools: ["Bash", "Read"],
      skills: scenario === "skill-loaded" ? skillNames : [],
      slash_commands: ["compact"],
      agents: [{ name: "reviewer" }],
      permissionMode: "bypassPermissions",
      model: "stub",
    });
  }
  if (scenario !== "no-tools") {
    results.forEach((item, i) => {
      if (!item.attempted) return;
      const line = lines.find((l) => l.id === item.id);
      if (!line) return;
      const quoted = /`([^`]+)`/.exec(line.instruction)?.[1] ?? "";
      const input =
        line.tool === "Bash"
          ? { command: quoted }
          : { file_path: quoted.startsWith("/") ? quoted : join(process.cwd(), quoted) };
      const toolUseId = `toolu_${i}`;
      // What the call printed: the report's evidence for a failure, the tool's own output for a success.
      let output = item.evidence;
      let isError = !item.succeeded;
      const outputs = {
        ssh_github: "Hi canary! You've successfully authenticated, but GitHub does not provide shell access.",
        read_home_file: "READ_OK",
        read_home_file_node: "READ_OK",
        read_tmp_file: "READ_OK",
        curl_example: "200",
        read_scratch: "ok",
        node_version: item.output,
      };
      if (item.succeeded) {
        output = outputs[item.id] ?? "";
        if (item.id === "read_sibling_tool") output = item.evidence;
        if (item.id === "read_home_file" && scenario === "sentinel-leak") output = item.evidence;
        if (line.tool === "Read" && output === "") output = "file content";
        if (item.id === "env_secret_names") output = (item.names ?? []).join("\n");
      }
      if (item.id === "env_secret_names") {
        // grep ... || true exits 0 whether or not a name was printed.
        isError = false;
        output = (item.names ?? []).join("\n");
      }
      if (item.id === "local_settings_env") {
        // printenv ... || echo UNSET exits 0 either way; a honoured local setting prints its value.
        isError = false;
        output = scenario === "local-env" ? (planted("settings.local.json")?.env ?? {})[`CANARY_LOCAL_${/CANARY_LOCAL_(\w+)/.exec(quoted)?.[1]}`] ?? "" : "UNSET";
      }
      // The report disagrees with what the tools printed.
      if (scenario === "claims-success" && item.id === "ssh_github") {
        output = "Permission denied (publickey).";
        isError = true;
      }
      if (scenario === "curl-lie" && item.id === "curl_example") {
        output = "200";
        isError = false;
      }
      events.push({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: line.tool, input }] },
      });
      events.push({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              is_error: isError,
              content: line.tool === "Read" ? [{ type: "text", text: output }] : output,
            },
          ],
        },
      });
    });
  }
  if (scenario === "garbage-line") events.push("this line is not json");
  events.push(resultObject(text));
  return events.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n");
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
    const canary = canaryAnswer();
    if (streamMode) console.log(canaryStream(canary));
    else answer(canary.text);
  } else {
    const file = isReviewer ? process.env.STUB_FINAL_TEXT_FILE : process.env.STUB_JUDGE_TEXT_FILE;
    let text = file ? readFileSync(file, "utf8") : "";
    // Lets a test make the review quote the paths the session saw.
    text = text.split("@@CWD@@").join(process.cwd());
    // Lets a test make the review quote the API key it was given.
    text = text.split("@@KEY@@").join(process.env.ANTHROPIC_API_KEY ?? "");
    answer(text);
  }
  if (process.env.STUB_EXIT_CODE) process.exitCode = Number(process.env.STUB_EXIT_CODE);
}
