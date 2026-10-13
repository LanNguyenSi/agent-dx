import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  firstFailingLine,
  parsePrintFields,
  renderPrint,
  renderProbeSummary,
} from "../src/probe/summary.js";
import { spawnCli } from "./helpers/spawn-cli.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeRepo(): { repo: string; logs: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-summary-repo-"));
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), "ap-summary-logs-"));
  tmpDirs.push(repo, logs);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  fs.writeFileSync(path.join(repo, "fixture.js"), "module.exports = true;\n");
  git(["add", "."]);
  git(["commit", "-qm", "fixture"]);
  return { repo, logs };
}

const TEST_CMD =
  "node -e \"if (!require('./fixture.js')) { console.log('FAIL fixture is false'); process.exit(1) }\"";

const KILLED_ARGS = [
  "--file",
  "fixture.js",
  "-n",
  "1",
  "-r",
  "module.exports = false;",
  "-t",
  TEST_CMD,
];
const SURVIVED_ARGS = [
  "--file",
  "fixture.js",
  "-n",
  "1",
  "-r",
  "module.exports = 1;",
  "-t",
  TEST_CMD,
];

async function both(
  repo: string,
  logs: string,
  probeArgs: string[],
  extra: string[],
) {
  const base = ["-C", repo, "-l", logs, "-m", "100000", "probe"];
  const json = await spawnCli([...base, ...probeArgs]);
  const view = await spawnCli([...base, ...extra, ...probeArgs]);
  return { json, view, envelope: JSON.parse(json.stdout) };
}

describe("probe --summary (CLI)", () => {
  it("single killed probe: one mutant line and a totals line, exit code unchanged", async () => {
    const { repo, logs } = makeRepo();
    const { json, view } = await both(repo, logs, KILLED_ARGS, ["--summary"]);
    expect(json.code).toBe(0);
    expect(view.code).toBe(json.code);
    const lines = view.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/fixture\.js:1 \| killed \|/);
    expect(lines[0]).toContain("expectation=met");
    expect(lines[0]).toContain("restored=true");
    expect(lines[0]).toContain("failing=FAIL fixture is false");
    expect(lines[0]).toMatch(/log=\S*exec-\S+\.log$/);
    expect(lines[1]).toBe(
      "totals: status=killed total=1 killed=1 survived=0 inconclusive=0 not_run=0 met=1 violated=0",
    );
  });

  it("single survived probe: exit 1 as in JSON, no failing test, violated expectation", async () => {
    const { repo, logs } = makeRepo();
    const { json, view } = await both(repo, logs, SURVIVED_ARGS, ["--summary"]);
    expect(json.code).toBe(1);
    expect(view.code).toBe(1);
    const lines = view.stdout.trimEnd().split("\n");
    expect(lines[0]).toContain("survived");
    expect(lines[0]).toContain("expectation=violated");
    expect(lines[0]).toContain("failing=-");
    expect(lines[1]).toContain("survived=1");
    expect(lines[1]).toContain("violated=1");
  });

  it("inconclusive pre_failed probe: verdict not_run with the reason, exit 2 as in JSON", async () => {
    const { repo, logs } = makeRepo();
    const { json, view, envelope } = await both(
      repo,
      logs,
      [...KILLED_ARGS, "--pre", "exit 3"],
      ["--summary"],
    );
    expect(envelope.status).toBe("inconclusive");
    expect(envelope.reason).toBe("pre_failed");
    expect(json.code).toBe(2);
    expect(view.code).toBe(2);
    const lines = view.stdout.trimEnd().split("\n");
    expect(lines[0]).toContain("not_run(pre_failed)");
    expect(lines[1]).toContain("status=inconclusive reason=pre_failed");
    expect(lines[1]).toContain("not_run=1");
  });

  it("--plan: one line per mutant with its index, totals from the plan summary", async () => {
    const { repo, logs } = makeRepo();
    const plan = path.join(repo, "plan.json");
    fs.writeFileSync(
      plan,
      JSON.stringify({
        test: TEST_CMD,
        mutants: [
          { file: "fixture.js", line: 1, replace: "module.exports = false;" },
          { file: "fixture.js", line: 1, replace: "module.exports = 1;" },
        ],
      }),
    );
    const { json, view } = await both(
      repo,
      logs,
      ["--plan", plan],
      ["--summary"],
    );
    expect(json.code).toBe(1);
    expect(view.code).toBe(1);
    const lines = view.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^#0 \S*fixture\.js:1 \| killed /);
    expect(lines[1]).toMatch(/^#1 \S*fixture\.js:1 \| survived /);
    expect(lines[2]).toBe(
      "totals: status=survived total=2 killed=1 survived=1 inconclusive=0 not_run=0 met=1 violated=1",
    );
  });

  it("unreadable plan file: totals line with the reason and the parser message, exit as in JSON", async () => {
    const { repo, logs } = makeRepo();
    const { json, view } = await both(
      repo,
      logs,
      ["--plan", path.join(repo, "missing.json")],
      ["--summary"],
    );
    expect(view.code).toBe(json.code);
    expect(view.stdout).toContain(
      "status=usage_error reason=plan_not_readable",
    );
    expect(view.stdout).toContain("note:");
  });

  it("--summary together with --print is a usage error", async () => {
    const { repo, logs } = makeRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "-l",
      logs,
      "probe",
      "--summary",
      "--print",
      "status",
      ...KILLED_ARGS,
    ]);
    expect(run.code).not.toBe(0);
    expect(JSON.parse(run.stdout).status).toBe("usage_error");
  });
});

describe("probe --print (CLI)", () => {
  it("prints the selected fields, dotted paths descend, exit code unchanged", async () => {
    const { repo, logs } = makeRepo();
    const { json, view } = await both(repo, logs, SURVIVED_ARGS, [
      "--print",
      "status, mutation_probe.result,mutation_probe.restored_verified,test.logPath",
    ]);
    expect(view.code).toBe(json.code);
    const printed = JSON.parse(view.stdout);
    expect(printed["test.logPath"]).toMatch(/exec-\S+\.log$/);
    delete printed["test.logPath"];
    expect(printed).toEqual({
      status: "survived",
      "mutation_probe.result": "survived",
      "mutation_probe.restored_verified": true,
    });
  });

  it("a valid field absent from this run prints null", async () => {
    const { repo, logs } = makeRepo();
    const { view } = await both(
      repo,
      logs,
      [...KILLED_ARGS, "--pre", "exit 3"],
      ["--print", "test,plan.summary"],
    );
    expect(JSON.parse(view.stdout)).toEqual({
      test: null,
      "plan.summary": null,
    });
  });

  it("an unknown field is a usage error naming the field, and no probe runs", async () => {
    const { repo, logs } = makeRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "-l",
      logs,
      "probe",
      "--print",
      "status,verdict",
      ...KILLED_ARGS,
    ]);
    expect(run.code).not.toBe(0);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.status).toBe("usage_error");
    expect(envelope.message).toContain('unknown field "verdict"');
    expect(fs.readFileSync(path.join(repo, "fixture.js"), "utf8")).toBe(
      "module.exports = true;\n",
    );
  });
});

describe("summary helpers", () => {
  it("parsePrintFields trims, drops empty entries and rejects unknown top-level names", () => {
    expect(parsePrintFields("status, logs,,mutation_probe.result")).toEqual([
      "status",
      "logs",
      "mutation_probe.result",
    ]);
    expect(() => parsePrintFields(" , ")).toThrow(/at least one field/);
    expect(() => parsePrintFields("status,nope.x")).toThrow(
      /unknown field "nope"/,
    );
  });

  it("renderPrint returns null for a missing nested path", () => {
    expect(renderPrint({ a: { b: 1 } }, ["a.b", "a.c", "a.b.d"])).toBe(
      '{"a.b":1,"a.c":null,"a.b.d":null}\n',
    );
  });

  it("firstFailingLine picks the first failure-shaped line, else a dash", () => {
    expect(
      firstFailingLine({
        stdoutTail: "ok 1 - a\nnot ok 2 - b\nnot ok 3 - c",
        stderrTail: "",
      }),
    ).toBe("not ok 2 - b");
    expect(firstFailingLine({ stdoutTail: "all green", stderrTail: "" })).toBe(
      "-",
    );
    expect(firstFailingLine(undefined)).toBe("-");
  });

  it("renderProbeSummary falls back to the baseline log for a run with no test phase", () => {
    const text = renderProbeSummary({
      status: "baseline_failed",
      reason: "baseline_failed",
      mutant: { file: "a.ts", line: 4 },
      mutation_probe: { result: "not_run", reason: "baseline_failed" },
      baseline: { logPath: "/logs/base.log" },
    });
    expect(text).toContain("a.ts:4 | not_run(baseline_failed)");
    expect(text).toContain("log=/logs/base.log");
  });
});
