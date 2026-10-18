import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRINTABLE_FIELDS,
  firstFailingLine,
  mutationProbeReportItem,
  mutationProbeReportItems,
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

describe("probe --summary (CLI)", { timeout: 60000 }, () => {
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

  it("survived probe whose passing test prints an error-shaped line: failing stays a dash", async () => {
    const { repo, logs } = makeRepo();
    const noisy =
      "node -e \"console.log('Error: deprecation noise'); if (!require('./fixture.js')) process.exit(1)\"";
    const { view } = await both(
      repo,
      logs,
      [
        "--file",
        "fixture.js",
        "-n",
        "1",
        "-r",
        "module.exports = 1;",
        "-t",
        noisy,
        "--require-baseline-evidence",
        "deprecation noise",
      ],
      ["--summary"],
    );
    const lines = view.stdout.trimEnd().split("\n");
    expect(lines[0]).toContain("survived");
    expect(lines[0]).toContain("failing=-");
    expect(lines[0]).not.toContain("deprecation noise");
  });

  it("a small -m keeps the totals line and says how many mutant lines were left out", async () => {
    const { repo, logs } = makeRepo();
    const plan = path.join(repo, "plan.json");
    const mutants = Array.from({ length: 6 }, () => ({
      file: "fixture.js",
      line: 1,
      replace: "module.exports = false;",
    }));
    fs.writeFileSync(plan, JSON.stringify({ test: TEST_CMD, mutants }));
    const run = await spawnCli([
      "-C",
      repo,
      "-l",
      logs,
      "-m",
      "600",
      "probe",
      "--summary",
      "--plan",
      plan,
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout.length).toBeLessThanOrEqual(600);
    expect(run.stdout).toMatch(/\.\.\. \d+ more mutant lines? omitted/);
    expect(run.stdout.trimEnd().split("\n").pop()).toBe(
      "totals: status=killed total=6 killed=6 survived=0 inconclusive=0 not_run=0 met=6 violated=0",
    );
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

describe("probe --print (CLI)", { timeout: 60000 }, () => {
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
    // A probe that had run would have left its test log and its isolated
    // worktree's artifacts in the log directory.
    expect(fs.readdirSync(logs).filter((n) => /^(exec-|wt-)/.test(n))).toEqual(
      [],
    );
  });

  it("reads the full result: a small -m does not turn existing fields into null", async () => {
    const { repo, logs } = makeRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "-l",
      logs,
      "-m",
      "700",
      "probe",
      "--print",
      "mutation_probe.result,mutation_probe.restored_verified,mutant.file,test.exitCode",
      ...SURVIVED_ARGS,
    ]);
    expect(run.code).toBe(1);
    const printed = JSON.parse(run.stdout);
    expect(printed["mutation_probe.result"]).toBe("survived");
    expect(printed["mutation_probe.restored_verified"]).toBe(true);
    expect(printed["mutant.file"]).toMatch(/fixture\.js$/);
    expect(printed["test.exitCode"]).toBe(0);
  });

  it("--print logs carries the result-full path the JSON envelope lists, at the default -m", async () => {
    const { repo, logs } = makeRepo();
    const json = await spawnCli([
      "-C",
      repo,
      "-l",
      logs,
      "probe",
      ...SURVIVED_ARGS,
    ]);
    const view = await spawnCli([
      "-C",
      repo,
      "-l",
      logs,
      "probe",
      "--print",
      "logs",
      ...SURVIVED_ARGS,
    ]);
    const jsonLogs = JSON.parse(json.stdout).logs as string[];
    const printed = JSON.parse(view.stdout).logs as string[];
    const fullIn = (list: string[]) =>
      list.filter((l) => /result-full-[^/]*\.json$/.test(l));
    expect(fullIn(jsonLogs)).toHaveLength(1);
    expect(fullIn(printed)).toHaveLength(1);
    // Each run writes its own uniquely named files: compare the kinds of
    // entry, not the unique ids.
    const kind = (l: string) =>
      path.basename(l).replace(/^(exec|result-full)-.*$/, "$1");
    expect(printed.map(kind)).toEqual(jsonLogs.map(kind));
  });

  it("every top-level field of the envelope and of the saved full result is printable", async () => {
    const { repo, logs } = makeRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "-l",
      logs,
      "-m",
      "2200",
      "probe",
      ...SURVIVED_ARGS,
    ]);
    const reduced = JSON.parse(run.stdout);
    const fullPath = (reduced.logs as string[]).find((l) =>
      /result-full-\S+\.json$/.test(l),
    ) as string;
    const full = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    for (const key of [...Object.keys(reduced), ...Object.keys(full)].filter(
      (k) => k !== "...",
    )) {
      expect(PRINTABLE_FIELDS).toContain(key);
    }
  });
});

describe("summary helpers", () => {
  it("parsePrintFields trims, drops empty entries and rejects unknown top-level names", () => {
    expect(parsePrintFields("status, logs,,mutation_probe.result")).toEqual([
      "status",
      "logs",
      "mutation_probe.result",
    ]);
    expect(parsePrintFields("fullResult")).toEqual(["fullResult"]);
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

  it("firstFailingLine names the numbered PHPUnit failure line", () => {
    const stdoutTail = [
      "PHPUnit 10.5.20 by Sebastian Bergmann and contributors.",
      "",
      "....F                                                               5 / 5 (100%)",
      "",
      "Time: 00:00.012, Memory: 8.00 MB",
      "",
      "There was 1 failure:",
      "",
      "1) App\\Tests\\CartTest::testTotal",
      "Failed asserting that 41 matches expected 42.",
      "",
      "/app/tests/CartTest.php:17",
      "",
      "FAILURES!",
      "Tests: 5, Assertions: 6, Failures: 1.",
    ].join("\n");
    expect(firstFailingLine({ stdoutTail, stderrTail: "" })).toBe(
      "1) App\\Tests\\CartTest::testTotal",
    );
  });

  it("firstFailingLine keeps each runner's line and finds none in a passing PHPUnit tail", () => {
    const cases: Array<[string, string]> = [
      [" FAIL  test/a.test.ts > adds", "FAIL test/a.test.ts > adds"],
      ["ok 1 - a\nnot ok 2 - b", "not ok 2 - b"],
      [
        "=== RUN   TestAdd\n--- FAIL: TestAdd (0.00s)",
        "--- FAIL: TestAdd (0.00s)",
      ],
      [
        "FAILED tests/test_a.py::test_add - assert 1 == 2",
        "FAILED tests/test_a.py::test_add - assert 1 == 2",
      ],
      ["  ● adds › two numbers", "● adds › two numbers"],
      [
        "AssertionError: expected 1 to be 2",
        "AssertionError: expected 1 to be 2",
      ],
    ];
    for (const [stdoutTail, expected] of cases) {
      expect(firstFailingLine({ stdoutTail, stderrTail: "" })).toBe(expected);
    }
    const passing = [
      "PHPUnit 10.5.20 by Sebastian Bergmann and contributors.",
      "",
      ".....                                                               5 / 5 (100%)",
      "",
      "Time: 00:00.010, Memory: 8.00 MB",
      "",
      "OK (5 tests, 6 assertions)",
    ].join("\n");
    expect(firstFailingLine({ stdoutTail: passing, stderrTail: "" })).toBe("-");
  });

  it("renderProbeSummary prints failing only for a killed verdict", () => {
    const test = { stdoutTail: "Error: noise\nFAIL x", stderrTail: "" };
    const killed = renderProbeSummary({
      status: "killed",
      mutation_probe: { result: "killed", expectation: "met" },
      test,
    });
    expect(killed).toContain("failing=Error: noise");
    const survived = renderProbeSummary({
      status: "survived",
      mutation_probe: { result: "survived", expectation: "violated" },
      test,
    });
    expect(survived).toContain("failing=- |");
  });

  it("renderProbeSummary reports restored_verified as it is, true, false or unknown", () => {
    const line = (restored: boolean | undefined) =>
      renderProbeSummary({
        status: "killed",
        mutation_probe: { result: "killed", restored_verified: restored },
      }).split("\n")[0];
    expect(line(true)).toContain("restored=true");
    expect(line(false)).toContain("restored=false");
    expect(line(undefined)).toContain("restored=-");
  });

  it("renderProbeSummary prints mutant files relative to the cwd", () => {
    const text = renderProbeSummary({
      status: "killed",
      cwd: "/work/repo",
      mutant: { file: "/work/repo/src/a.ts", line: 3 },
      mutation_probe: { result: "killed" },
    });
    expect(text).toMatch(/^src\/a\.ts:3 \| killed/);
    expect(
      renderProbeSummary({
        status: "killed",
        cwd: "/work/repo",
        mutant: { file: "/elsewhere/a.ts", line: 3 },
        mutation_probe: { result: "killed" },
      }),
    ).toMatch(/^\/elsewhere\/a\.ts:3/);
  });

  it("renderProbeSummary bounds only the mutant lines: the totals line survives a small maxChars", () => {
    const results = Array.from({ length: 40 }, (_, index) => ({
      index,
      mutant: { file: "src/some/long/path/file.ts", line: index + 1 },
      mutation_probe: { result: "killed", expectation: "met" },
      test: { logPath: "/logs/exec-123.log" },
    }));
    const input = {
      status: "killed",
      plan: {
        results,
        summary: { total: 40, killed: 40, met: 40 },
      },
    };
    for (const max of [300, 500, 2000]) {
      const text = renderProbeSummary(input, max);
      expect(text.length).toBeLessThanOrEqual(max);
      expect(text.trimEnd().split("\n").pop()).toMatch(
        /^totals: status=killed total=40 killed=40 /,
      );
      expect(text).toMatch(/\.\.\. \d+ more mutant lines omitted/);
    }
    expect(renderProbeSummary(input)).not.toContain("omitted");
  });

  it("renderProbeSummary's marker names the full result file when one was written", () => {
    const results = Array.from({ length: 40 }, (_, index) => ({
      index,
      mutant: { file: "src/some/long/path/file.ts", line: index + 1 },
      mutation_probe: { result: "killed", expectation: "met" },
      test: { logPath: "/logs/exec-123.log" },
    }));
    const plan = { results, summary: { total: 40, killed: 40, met: 40 } };
    const withFile = renderProbeSummary(
      {
        status: "killed",
        plan,
        fullResult: "/logs/result-full-abc.json",
      },
      600,
    );
    expect(withFile.length).toBeLessThanOrEqual(600);
    expect(withFile).toContain(
      "characters); raise -m or read the full result: /logs/result-full-abc.json",
    );
    const withoutFile = renderProbeSummary({ status: "killed", plan }, 600);
    expect(withoutFile.length).toBeLessThanOrEqual(600);
    expect(withoutFile).toContain(
      "characters); raise -m (no full result file was written)",
    );
    expect(withoutFile).not.toContain("read the full result");
  });

  it("renderProbeSummary drops a long full result path rather than exceed -m", () => {
    const results = Array.from({ length: 40 }, (_, index) => ({
      index,
      mutant: { file: "src/some/long/path/file.ts", line: index + 1 },
      mutation_probe: { result: "killed", expectation: "met" },
      test: { logPath: "/logs/exec-123.log" },
    }));
    const plan = { results, summary: { total: 40, killed: 40, met: 40 } };
    const longPath = `/var/folders/8v/${"x".repeat(40)}/T/agent-primitives/${"y".repeat(36)}/result-full-${"z".repeat(36)}.json`;
    for (const max of [250, 300]) {
      const text = renderProbeSummary(
        { status: "killed", plan, fullResult: longPath },
        max,
      );
      expect(text.length, text).toBeLessThanOrEqual(max);
      expect(text).toContain("raise -m; the full result path did not fit");
      expect(text).not.toContain(longPath);
    }
    const roomy = renderProbeSummary(
      { status: "killed", plan, fullResult: longPath },
      1200,
    );
    expect(roomy.length).toBeLessThanOrEqual(1200);
    expect(roomy).toContain(`raise -m or read the full result: ${longPath}`);
  });

  it("renderProbeSummary keeps the totals line and drops the note under a tiny maxChars", () => {
    const planInput = {
      status: "usage_error",
      reason: "plan_unreadable",
      message: "plan file could not be read",
      plan: { results: [], summary: { total: 0 } },
    };
    const zeroInput = {
      status: "baseline_failed",
      warnings: ["something went wrong before any mutant"],
    };
    for (const input of [planInput, zeroInput]) {
      expect(renderProbeSummary(input, 1000)).toContain("note: ");
      for (const max of [1, 50]) {
        const text = renderProbeSummary(input, max);
        const lines = text.trimEnd().split("\n");
        expect(lines[lines.length - 1]).toMatch(/^totals: /);
        expect(text).not.toContain("note: ");
      }
    }
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

// The eleven fields of one orchestrator implementer `mutation_probes`
// entry, in the contract's fixed order: `--report mutation-probes` must
// print exactly these, in this order, per mutant.
const REPORT_KEYS = [
  "mutant",
  "file",
  "anchor",
  "before",
  "after",
  "verified_applied_via",
  "result",
  "expectation",
  "reason",
  "restored_verified",
  "replayed",
];

describe("probe --report mutation-probes (CLI)", { timeout: 60000 }, () => {
  it("--plan of three (killed, survived, missing target): three eleven-field items, each value equal to the default envelope of the same run", async () => {
    const { repo, logs } = makeRepo();
    const plan = path.join(repo, "plan.json");
    fs.writeFileSync(
      plan,
      JSON.stringify({
        test: TEST_CMD,
        mutants: [
          { file: "fixture.js", line: 1, replace: "module.exports = false;" },
          { file: "fixture.js", line: 1, replace: "module.exports = 1;" },
          { file: "fixture.js", line: 1, match: "nonexistent text", with: "x" },
        ],
      }),
    );
    const base = ["-C", repo, "-l", logs, "-m", "100000", "probe"];
    const json = await spawnCli([...base, "--plan", plan]);
    const view = await spawnCli([
      ...base,
      "--report",
      "mutation-probes",
      "--plan",
      plan,
    ]);
    // The view replaces the envelope; the exit code is unchanged.
    expect(json.code).toBe(2);
    expect(view.code).toBe(json.code);
    const envelope = JSON.parse(json.stdout);
    interface Row {
      status: unknown;
      file: unknown;
      reason: unknown;
      mutant: Record<string, unknown>;
      mutation_probe: Record<string, unknown>;
    }
    const rows = envelope.plan.results as Row[];
    const items = JSON.parse(view.stdout);
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(Object.keys(item)).toEqual(REPORT_KEYS);
    }
    // A killed/survived item: every one of the eleven fields equals the
    // envelope's own record for the same mutant, field by field.
    const compareVerdictItem = (item: Record<string, unknown>, row: Row) => {
      expect(item.mutant).toBe(row.mutation_probe.mutant);
      expect(item.file).toBe(row.mutant.file);
      expect(item.anchor).toBe(row.mutant.line);
      expect(item.before).toBe(row.mutant.before);
      expect(item.after).toBe(row.mutant.after);
      expect(item.verified_applied_via).toBe(
        row.mutation_probe.verified_applied_via,
      );
      expect(item.result).toBe(row.mutation_probe.result);
      expect(item.expectation).toBe(row.mutation_probe.expectation);
      expect(item.reason).toBe("");
      expect(item.restored_verified).toBe(row.mutation_probe.restored_verified);
      expect(item.replayed).toBe(false);
    };
    expect(rows[0].status).toBe("killed");
    compareVerdictItem(items[0], rows[0]);
    expect(items[0].result).toBe("killed");
    expect(items[0].expectation).toBe("met");
    expect(rows[1].status).toBe("survived");
    compareVerdictItem(items[1], rows[1]);
    expect(items[1].result).toBe("survived");
    expect(items[1].expectation).toBe("violated");
    // The missing-target mutant: the envelope records `status:
    // "inconclusive"`, `reason: "mutant_not_applicable"` and the file,
    // and no mutant/mutation_probe records to merge.
    expect(rows[2].status).toBe("inconclusive");
    expect(rows[2].reason).toBe("mutant_not_applicable");
    expect(items[2]).toEqual({
      mutant: "",
      file: rows[2].file,
      anchor: "",
      before: "",
      after: "",
      verified_applied_via: "",
      result: "not_applicable",
      expectation: "not_applicable",
      reason: "target text no longer present",
      restored_verified: "",
      replayed: false,
    });
  });

  it("single probe without --replayed: one item, replayed false, every field equal to the envelope", async () => {
    const { repo, logs } = makeRepo();
    const { json, view, envelope } = await both(repo, logs, KILLED_ARGS, [
      "--report",
      "mutation-probes",
    ]);
    expect(json.code).toBe(0);
    expect(view.code).toBe(json.code);
    const items = JSON.parse(view.stdout);
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0])).toEqual(REPORT_KEYS);
    const item = items[0];
    expect(item.mutant).toBe(envelope.mutation_probe.mutant);
    expect(item.file).toBe(envelope.mutant.file);
    expect(item.anchor).toBe(envelope.mutant.line);
    expect(item.before).toBe(envelope.mutant.before);
    expect(item.after).toBe(envelope.mutant.after);
    expect(item.verified_applied_via).toBe(
      envelope.mutation_probe.verified_applied_via,
    );
    expect(item.result).toBe("killed");
    expect(item.expectation).toBe("met");
    expect(item.reason).toBe("");
    expect(item.restored_verified).toBe(true);
    expect(item.replayed).toBe(false);
  });

  it("single probe with --replayed: the item carries replayed true, every other field unchanged", async () => {
    const { repo, logs } = makeRepo();
    const base = ["-C", repo, "-l", logs, "-m", "100000", "probe"];
    const plain = await spawnCli([
      ...base,
      "--report",
      "mutation-probes",
      ...KILLED_ARGS,
    ]);
    const replayed = await spawnCli([
      ...base,
      "--report",
      "mutation-probes",
      "--replayed",
      ...KILLED_ARGS,
    ]);
    expect(plain.code).toBe(0);
    expect(replayed.code).toBe(plain.code);
    const without = JSON.parse(plain.stdout)[0];
    const withFlag = JSON.parse(replayed.stdout)[0];
    expect(withFlag.replayed).toBe(true);
    expect(without.replayed).toBe(false);
    const rest = (item: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(item).filter(([key]) => key !== "replayed"),
      );
    expect(rest(withFlag)).toEqual(rest(without));
  });

  it("--plan with --replayed: every printed item carries replayed true", async () => {
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
    const run = await spawnCli([
      "-C",
      repo,
      "-l",
      logs,
      "-m",
      "100000",
      "probe",
      "--report",
      "mutation-probes",
      "--replayed",
      "--plan",
      plan,
    ]);
    const items = JSON.parse(run.stdout);
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.replayed).toBe(true);
  });

  it("--report together with --summary is a usage error and no probe runs", async () => {
    const { repo, logs } = makeRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "-l",
      logs,
      "probe",
      "--report",
      "mutation-probes",
      "--summary",
      ...KILLED_ARGS,
    ]);
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stdout).status).toBe("usage_error");
    expect(fs.readdirSync(logs).filter((n) => /^(exec-|wt-)/.test(n))).toEqual(
      [],
    );
  });

  it("--report together with --print is a usage error and no probe runs", async () => {
    const { repo, logs } = makeRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "-l",
      logs,
      "probe",
      "--report",
      "mutation-probes",
      "--print",
      "status",
      ...KILLED_ARGS,
    ]);
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stdout).status).toBe("usage_error");
    expect(fs.readdirSync(logs).filter((n) => /^(exec-|wt-)/.test(n))).toEqual(
      [],
    );
  });

  it("--replayed without --report is a usage error and no probe runs", async () => {
    const { repo, logs } = makeRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "-l",
      logs,
      "probe",
      "--replayed",
      ...KILLED_ARGS,
    ]);
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stdout).status).toBe("usage_error");
    expect(fs.readdirSync(logs).filter((n) => /^(exec-|wt-)/.test(n))).toEqual(
      [],
    );
  });

  it("an unknown --report kind is a usage error naming it, and no probe runs", async () => {
    const { repo, logs } = makeRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "-l",
      logs,
      "probe",
      "--report",
      "verdicts",
      ...KILLED_ARGS,
    ]);
    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.status).toBe("usage_error");
    expect(envelope.message).toContain('unknown report "verdicts"');
    expect(fs.readdirSync(logs).filter((n) => /^(exec-|wt-)/.test(n))).toEqual(
      [],
    );
  });
});

describe("mutationProbeReportItem (report builder)", () => {
  const killed = {
    status: "killed",
    mutant: {
      file: "/repo/src/a.ts",
      line: 12,
      before: "return a + b;",
      after: "return a - b;",
    },
    mutation_probe: {
      mutant: "/repo/src/a.ts:12: return a + b; -> return a - b;",
      verified_applied_via:
        "/repo/src/a.ts:12\n- return a + b;\n+ return a - b;",
      result: "killed",
      restored_verified: true,
      expectation: "met",
    },
  };

  it("carries a killed mutant's eleven fields straight from the two records", () => {
    expect(mutationProbeReportItem(killed, false)).toEqual({
      mutant: killed.mutation_probe.mutant,
      file: "/repo/src/a.ts",
      anchor: 12,
      before: "return a + b;",
      after: "return a - b;",
      verified_applied_via: killed.mutation_probe.verified_applied_via,
      result: "killed",
      expectation: "met",
      reason: "",
      restored_verified: true,
      replayed: false,
    });
  });

  it("maps every internal result value that is not a measured verdict to not_applicable", () => {
    for (const internal of ["not_run", "inconclusive", "restore_failed"]) {
      const withProbe = mutationProbeReportItem(
        {
          status: "inconclusive",
          reason: internal,
          mutant: killed.mutant,
          mutation_probe: { result: internal },
        },
        false,
      );
      expect(withProbe.result).toBe("not_applicable");
      expect(withProbe.expectation).toBe("not_applicable");
      const noProbe = mutationProbeReportItem(
        { status: internal, mutant: killed.mutant },
        false,
      );
      expect(noProbe.result).toBe("not_applicable");
    }
  });

  it("expectation is not_applicable whenever result is, even beside a stale expectation", () => {
    const item = mutationProbeReportItem(
      {
        status: "inconclusive",
        reason: "pre_failed",
        mutation_probe: { result: "not_run", expectation: "met" },
      },
      false,
    );
    expect(item.result).toBe("not_applicable");
    expect(item.expectation).toBe("not_applicable");
  });

  it("reason stays empty for a measured verdict even when the record carries one", () => {
    const item = mutationProbeReportItem(
      {
        status: "killed",
        reason: "stale",
        mutation_probe: killed.mutation_probe,
      },
      false,
    );
    expect(item.result).toBe("killed");
    expect(item.reason).toBe("");
  });

  it("spells mutant_not_applicable as the contract's canonical reason", () => {
    const fromEntry = mutationProbeReportItem(
      { status: "inconclusive", reason: "mutant_not_applicable", file: "a.ts" },
      false,
    );
    expect(fromEntry.reason).toBe("target text no longer present");
    expect(fromEntry.file).toBe("a.ts");
    const fromProbe = mutationProbeReportItem(
      {
        status: "inconclusive",
        reason: "mutant_not_applicable",
        mutation_probe: {
          result: "inconclusive",
          reason: "mutant_not_applicable",
        },
      },
      false,
    );
    expect(fromProbe.reason).toBe("target text no longer present");
  });

  it("carries any other not_applicable reason verbatim and omits it when there is none", () => {
    const carried = mutationProbeReportItem(
      {
        status: "inconclusive",
        mutation_probe: { result: "not_run", reason: "pre_failed" },
      },
      false,
    );
    expect(carried.reason).toBe("pre_failed");
    const bare = mutationProbeReportItem({ status: "not_run" }, false);
    expect(bare.result).toBe("not_applicable");
    expect(bare.reason).toBe("");
  });

  it("absent records print as empty strings, never an invented value", () => {
    const item = mutationProbeReportItem(
      { status: "inconclusive", reason: "mutant_not_applicable" },
      false,
    );
    expect(item.mutant).toBe("");
    expect(item.anchor).toBe("");
    expect(item.before).toBe("");
    expect(item.after).toBe("");
    expect(item.verified_applied_via).toBe("");
    expect(item.restored_verified).toBe("");
  });

  it("replayed is the flag's value on every item", () => {
    expect(mutationProbeReportItem(killed, true).replayed).toBe(true);
    expect(mutationProbeReportItem(killed, false).replayed).toBe(false);
  });

  it("mutationProbeReportItems prints one item per plan result, and none for an envelope with no plan", () => {
    const items = mutationProbeReportItems(
      { results: [killed, killed] },
      false,
    );
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.result === "killed")).toBe(true);
    expect(mutationProbeReportItems(undefined, false)).toEqual([]);
  });
});
