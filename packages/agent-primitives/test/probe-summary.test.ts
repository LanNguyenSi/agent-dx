import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MATCH_LINE_DERIVATION_NOTICE_PREFIX,
  PRINTABLE_FIELDS,
  firstFailingLine,
  mutationProbeReportItem,
  mutationProbeReportItems,
  parsePrintFields,
  renderPrint,
  renderProbeSummary,
} from "../src/probe/summary.js";
import { probe, probePlan } from "../src/probe/index.js";
import { LINK_MANIFEST_FILE } from "../src/probe/link-manifest.js";
import { writeMarker } from "../src/lock.js";
import { spawnCli } from "./helpers/spawn-cli.js";

const tmpDirs: string[] = [];
const savedEnv: Array<[string, string | undefined]> = [];
afterEach(() => {
  for (const [key, value] of savedEnv.splice(0)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

/** The line `--summary` adds when a killed mutant's output belongs to no
 * toolchain the build-failure detection recognizes (these tests' own
 * `FAIL fixture is false` script is one). */
const detectionLine = (count: number): string =>
  `build-failure detection: not available for ${count} killed mutant${count === 1 ? "" : "s"} (recognized: go test, tsc, vitest output); a compile error there still reads as killed, check the log`;

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
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/fixture\.js:1 \| killed \|/);
    expect(lines[0]).toContain("expectation=met");
    expect(lines[0]).toContain("restored=true");
    expect(lines[0]).toContain("failing=FAIL fixture is false");
    expect(lines[0]).toMatch(/log=\S*exec-\S+\.log$/);
    expect(lines[1]).toBe(detectionLine(1));
    expect(lines[2]).toBe(
      "totals: status=killed total=1 killed=1 survived=0 inconclusive=0 not_run=0 met=1 violated=0 build_failed=0",
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
      "totals: status=killed total=6 killed=6 survived=0 inconclusive=0 not_run=0 met=6 violated=0 build_failed=0",
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
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^#0 \S*fixture\.js:1 \| killed /);
    expect(lines[1]).toMatch(/^#1 \S*fixture\.js:1 \| survived /);
    expect(lines[2]).toBe(detectionLine(1));
    expect(lines[3]).toBe(
      "totals: status=survived total=2 killed=1 survived=1 inconclusive=0 not_run=0 met=1 violated=1 build_failed=0",
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

  it("single not-applicable probe: totals count the mutant, the note ends with line=, exit 2 as in JSON", async () => {
    const { repo, logs } = makeRepo();
    const args = [
      "--file",
      "fixture.js",
      "-n",
      "1",
      "-M",
      "not-there",
      "-w",
      "x",
      "-t",
      TEST_CMD,
    ];
    const { json, view } = await both(repo, logs, args, ["--summary"]);
    expect(json.code).toBe(2);
    expect(view.code).toBe(2);
    const lines = view.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe(
      "totals: status=inconclusive reason=mutant_not_applicable total=1 killed=0 survived=0 inconclusive=1 not_run=0 met=0 violated=0 build_failed=0",
    );
    expect(lines[lines.length - 1]).toBe(
      "note: substring not found on line 1 line=module.exports = true;",
    );
  });

  it("--plan with a not-applicable mutant: file:line id, log=- and a line= column on its row; the killed row unchanged", async () => {
    const { repo, logs } = makeRepo();
    const plan = path.join(repo, "plan.json");
    fs.writeFileSync(
      plan,
      JSON.stringify({
        test: TEST_CMD,
        mutants: [
          { file: "fixture.js", line: 1, match: "not-there", with: "x" },
          { file: "fixture.js", line: 1, replace: "module.exports = false;" },
        ],
      }),
    );
    const { json, view } = await both(
      repo,
      logs,
      ["--plan", plan],
      ["--summary"],
    );
    expect(view.code).toBe(json.code);
    const lines = view.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe(
      "#0 fixture.js:1 | inconclusive(mutant_not_applicable) | expectation=- | restored=- | failing=- | log=- | line=module.exports = true;",
    );
    expect(lines[1]).toMatch(
      /^#1 fixture\.js:1 \| killed \| expectation=met \| restored=true \| failing=FAIL fixture is false \| log=\S+\.log$/,
    );
    expect(lines[2]).toBe(detectionLine(1));
    expect(lines[3]).toContain(
      "status=inconclusive reason=mutant_inconclusive total=2 killed=1 survived=0 inconclusive=1",
    );
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

  it("--print truncated agrees with the emitted envelope: true when -m reduced it, false when it fit", async () => {
    const { repo, logs } = makeRepo();
    const run = (max: string, extra: string[] = []) =>
      spawnCli([
        "-C",
        repo,
        "-l",
        logs,
        "-m",
        max,
        "probe",
        ...SURVIVED_ARGS,
        ...extra,
      ]);
    // Bound derived from this run's own envelope size, so it reduces on any
    // platform whatever the length of the temp paths: half of it.
    const whole = await run("100000");
    const bound = String(Math.max(1, Math.floor(whole.stdout.length / 2)));
    const reduced = await run(bound);
    expect(JSON.parse(reduced.stdout).truncated).toBe(true);
    const printed = await run(bound, ["--print", "truncated"]);
    expect(JSON.parse(printed.stdout)).toEqual({ truncated: true });
    const fits = await run("100000", ["--print", "truncated"]);
    expect(JSON.parse(fits.stdout)).toEqual({ truncated: false });
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

  it("firstFailingLine prefers the failure over the numbered line of a risky-test section below it", () => {
    const stdoutTail = [
      "PHPUnit 10.5.20 by Sebastian Bergmann and contributors.",
      "",
      "....R...F                                                             8 / 8 (100%)",
      "",
      "Time: 00:00.012, Memory: 8.00 MB",
      "",
      "There was 1 failure:",
      "",
      "1) App\\Tests\\FooTest::testBar",
      "Failed asserting that 41 matches expected 42.",
      "",
      "/app/tests/FooTest.php:17",
      "",
      "There was 1 risky test:",
      "",
      "1) App\\Tests\\FooTest::testRisked",
      "This test did not perform any assertions",
      "",
      "/app/tests/FooTest.php:23",
      "",
      "FAILURES!",
      "Tests: 8, Assertions: 7, Failures: 1, Risky: 1.",
    ].join("\n");
    expect(firstFailingLine({ stdoutTail, stderrTail: "" })).toBe(
      "1) App\\Tests\\FooTest::testBar",
    );
  });

  it("firstFailingLine matches a PHPUnit failure line whose test name carries a data set", () => {
    const numbered =
      "1) App\\Tests\\FooTest::testBar with data set #0 ('a', 'b')";
    const named = '1) App\\Tests\\FooTest::testBar with data set "empty"';
    for (const line of [numbered, named]) {
      const stdoutTail = [
        "There was 1 failure:",
        "",
        line,
        "Failed asserting that two strings are equal.",
      ].join("\n");
      expect(firstFailingLine({ stdoutTail, stderrTail: "" })).toBe(line);
    }
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

  it("single-form mutant_not_applicable: totals count the mutant and the note ends with line=", () => {
    const text = renderProbeSummary({
      status: "inconclusive",
      reason: "mutant_not_applicable",
      warnings: ["substring not found on line 45"],
      line_content: "  return a + b; ",
    });
    expect(text.trimEnd().split("\n")).toEqual([
      "totals: status=inconclusive reason=mutant_not_applicable total=1 killed=0 survived=0 inconclusive=1 not_run=0 met=0 violated=0 build_failed=0",
      "note: substring not found on line 45 line=return a + b;",
    ]);
  });

  it("single-form mutant_not_applicable without line_content: counts the mutant, prints no line= part", () => {
    const text = renderProbeSummary({
      status: "inconclusive",
      reason: "mutant_not_applicable",
      warnings: ["line 99 is out of range (file has 3 lines)"],
    });
    expect(text).toContain("total=1");
    expect(text).toContain("inconclusive=1");
    expect(text).toContain(
      "note: line 99 is out of range (file has 3 lines)\n",
    );
    expect(text).not.toContain("line=");
  });

  it("a refusal after a -M line derivation: the note is the refusal, not the derivation notice", () => {
    const derivationNotice = `${MATCH_LINE_DERIVATION_NOTICE_PREFIX} line 2 of fixture.js`;
    const refusal = `${path.join("/repo", ".agent-primitives.json")}: not valid JSON`;
    const text = renderProbeSummary({
      status: "usage_error",
      reason: "defaults_file_invalid",
      warnings: [derivationNotice, refusal],
    });
    const lines = text.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe(`note: ${refusal}`);
    expect(text).not.toContain("derived from the unique -M/--match");
  });

  it("a refusal with no derivation: the note is still its first warning, byte for byte", () => {
    const refusal = `${path.join("/repo", ".agent-primitives.json")}: not valid JSON`;
    const text = renderProbeSummary({
      status: "usage_error",
      reason: "defaults_file_invalid",
      warnings: [refusal],
    });
    const lines = text.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe(`note: ${refusal}`);
  });

  it("an explicit message outranks both the derivation notice and a later warning", () => {
    const text = renderProbeSummary({
      status: "usage_error",
      reason: "plan_unreadable",
      message: "plan file could not be read",
      warnings: [
        `${MATCH_LINE_DERIVATION_NOTICE_PREFIX} line 2 of fixture.js`,
        "a later warning",
      ],
    });
    expect(text).toContain("note: plan file could not be read");
    expect(text).not.toContain("derived from the unique -M/--match");
  });

  it("a derivation notice as the only warning still prints (the first-warning fallback)", () => {
    const derivationNotice = `${MATCH_LINE_DERIVATION_NOTICE_PREFIX} line 2 of fixture.js`;
    const text = renderProbeSummary({
      status: "usage_error",
      reason: "usage_error",
      warnings: [derivationNotice],
    });
    expect(text.trimEnd().split("\n").at(-1)).toBe(`note: ${derivationNotice}`);
  });

  it("a plan's mutant_not_applicable row: file:line id, log=- (never ran), line= appended last", () => {
    const text = renderProbeSummary({
      status: "inconclusive",
      reason: "mutant_inconclusive",
      plan: {
        baseline: { logPath: "/logs/b0.log" },
        results: [
          {
            index: 2,
            file: "src/Foo.php",
            status: "inconclusive",
            reason: "mutant_not_applicable",
            mutant: { line: 45 },
            line_content: "    return $total + $tax;",
            logs: [],
          },
        ],
        summary: { total: 1, inconclusive: 1 },
      },
    });
    expect(text.trimEnd().split("\n")[0]).toBe(
      "#2 src/Foo.php:45 | inconclusive(mutant_not_applicable) | expectation=- | restored=- | failing=- | log=- | line=return $total + $tax;",
    );
  });

  it("a plan row whose dry run left a log names it; a row without line_content prints no line= part", () => {
    const text = renderProbeSummary({
      status: "inconclusive",
      reason: "mutant_inconclusive",
      plan: {
        baseline: { logPath: "/logs/b0.log" },
        results: [
          {
            index: 0,
            file: "a.ts",
            status: "inconclusive",
            reason: "mutant_not_applicable",
            mutant: { line: 3 },
            logs: ["/logs/dry-run.log"],
          },
        ],
        summary: { total: 1, inconclusive: 1 },
      },
    });
    expect(text).toContain("a.ts:3 | inconclusive(mutant_not_applicable)");
    expect(text).toContain("log=/logs/dry-run.log");
    expect(text).not.toContain("line=");
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
    // and no mutant/mutation_probe records to merge; the replay
    // definition is filled from the plan entry's own file, line, match
    // and with, so the item says what was probed.
    expect(rows[2].status).toBe("inconclusive");
    expect(rows[2].reason).toBe("mutant_not_applicable");
    expect(items[2]).toEqual({
      mutant: "",
      file: rows[2].file,
      anchor: 1,
      before: "nonexistent text",
      after: "x",
      verified_applied_via: "",
      result: "not_applicable",
      expectation: "not_applicable",
      reason: "target text no longer present",
      restored_verified: "",
      replayed: false,
    });
  });

  it("--plan whose baseline fails: every never-reached row's reason is the envelope's own reason", async () => {
    const { repo, logs } = makeRepo();
    const plan = path.join(repo, "plan.json");
    fs.writeFileSync(
      plan,
      JSON.stringify({
        test: 'node -e "process.exit(1)"',
        mutants: [
          { file: "fixture.js", line: 1, replace: "module.exports = false;" },
          { file: "fixture.js", line: 1, replace: "module.exports = 1;" },
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
    const envelope = JSON.parse(json.stdout);
    expect(envelope.status).toBe("inconclusive");
    expect(envelope.reason).toBe("baseline_failed");
    // The run stopped at the baseline, so both rows are never-reached
    // `not_run` entries carrying no reason of their own; the envelope's
    // top-level reason is what every `not_applicable` item reports.
    const items = JSON.parse(view.stdout);
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.result).toBe("not_applicable");
      expect(item.reason, JSON.stringify(item)).toBe(envelope.reason);
    }
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

  it("a --plan whose report exceeds the default -m prints a valid array of whole items and one stderr warning naming the omitted count and the full result file", async () => {
    const { repo, logs } = makeRepo();
    const pad = "x".repeat(300);
    fs.writeFileSync(
      path.join(repo, "long.js"),
      `const PAD = "${pad}";\nmodule.exports = true;\n`,
    );
    const plan = path.join(repo, "plan.json");
    fs.writeFileSync(
      plan,
      JSON.stringify({
        test: "node -e \"if (!require('./long.js')) process.exit(1)\"",
        mutants: Array.from({ length: 12 }, (_, i) => ({
          file: "long.js",
          line: 1,
          replace: `const PAD = "${pad}${i}";`,
        })),
      }),
    );
    const run = await spawnCli([
      "-C",
      repo,
      "-l",
      logs,
      "probe",
      "--report",
      "mutation-probes",
      "--plan",
      plan,
    ]);
    // The exit code is the run's own (every mutant survived), unchanged
    // by the report being cut.
    expect(run.code).toBe(1);
    // The printed report is valid JSON of whole items, bounded, not a
    // mid-string cut of the full array.
    const items = JSON.parse(run.stdout);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.length).toBeLessThan(12);
    expect(run.stdout.length).toBeLessThanOrEqual(8000);
    for (const item of items) expect(Object.keys(item)).toEqual(REPORT_KEYS);
    // One warning line, naming how many items fell out and the path of
    // the full, untruncated result, which carries all twelve.
    const warning = run.stderr.trimEnd().split("\n");
    expect(warning).toHaveLength(1);
    const omitted = warning[0].match(/(\d+) items omitted/);
    expect(omitted, run.stderr).not.toBeNull();
    expect(items.length + Number(omitted![1])).toBe(12);
    const named = warning[0].match(/full result: (.+)\)$/);
    expect(named, run.stderr).not.toBeNull();
    const full = JSON.parse(fs.readFileSync(named![1], "utf8"));
    expect(full.plan.results).toHaveLength(12);
  });

  it("a small --plan report at the default -m prints whole with no stderr warning", async () => {
    const { repo, logs } = makeRepo();
    const plan = path.join(repo, "plan.json");
    fs.writeFileSync(
      plan,
      JSON.stringify({
        test: TEST_CMD,
        mutants: [
          { file: "fixture.js", line: 1, replace: "module.exports = false;" },
        ],
      }),
    );
    const run = await spawnCli([
      "-C",
      repo,
      "-l",
      logs,
      "probe",
      "--report",
      "mutation-probes",
      "--plan",
      plan,
    ]);
    expect(run.code).toBe(0);
    const items = JSON.parse(run.stdout);
    expect(items).toHaveLength(1);
    expect(items[0].result).toBe("killed");
    expect(run.stderr).toBe("");
  });

  it("single probe whose -M target is missing: the item carries the definition from --file, -n, -M and -w", async () => {
    const { repo, logs } = makeRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "-l",
      logs,
      "probe",
      "--report",
      "mutation-probes",
      "--file",
      "fixture.js",
      "-n",
      "1",
      "-M",
      "nonexistent text",
      "-w",
      "x",
      "-t",
      TEST_CMD,
    ]);
    expect(run.code).toBe(2);
    const items = JSON.parse(run.stdout);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(Object.keys(item)).toEqual(REPORT_KEYS);
    expect(item.file).toBe("fixture.js");
    expect(item.anchor).toBe(1);
    expect(item.before).toBe("nonexistent text");
    expect(item.after).toBe("x");
    expect(item.mutant).toBe("");
    expect(item.verified_applied_via).toBe("");
    expect(item.restored_verified).toBe("");
    expect(item.result).toBe("not_applicable");
    expect(item.expectation).toBe("not_applicable");
    expect(item.reason).toBe("target text no longer present");
    expect(item.replayed).toBe(false);
  });

  it("single probe with -r on a line out of range: empty before (a whole-line replacement has no substring) and the replacement as after", async () => {
    const { repo, logs } = makeRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "-l",
      logs,
      "probe",
      "--report",
      "mutation-probes",
      "--file",
      "fixture.js",
      "-n",
      "99",
      "-r",
      "x",
      "-t",
      TEST_CMD,
    ]);
    expect(run.code).toBe(2);
    const items = JSON.parse(run.stdout);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.file).toBe("fixture.js");
    expect(item.anchor).toBe(99);
    expect(item.before).toBe("");
    expect(item.after).toBe("x");
    expect(item.result).toBe("not_applicable");
    expect(item.reason).toBe("target text no longer present");
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

  it("a record without mutation_probe is not_applicable even when the run's own status says killed", () => {
    const item = mutationProbeReportItem(
      { status: "killed", mutant: killed.mutant },
      false,
    );
    expect(item.result).toBe("not_applicable");
    expect(item.expectation).toBe("not_applicable");
  });

  it("fills the replay definition from the probe's own inputs when no mutant record exists", () => {
    const item = mutationProbeReportItem(
      { status: "inconclusive", reason: "mutant_not_applicable" },
      false,
      {
        file: "src/a.ts",
        line: 12,
        before: "return a + b;",
        after: "return a - b;",
      },
    );
    expect(item.file).toBe("src/a.ts");
    expect(item.anchor).toBe(12);
    expect(item.before).toBe("return a + b;");
    expect(item.after).toBe("return a - b;");
    const wholeLine = mutationProbeReportItem(
      { status: "inconclusive", reason: "mutant_not_applicable" },
      false,
      { file: "src/a.ts", line: 99, after: "module.exports = 1;" },
    );
    expect(wholeLine.before).toBe("");
    expect(wholeLine.after).toBe("module.exports = 1;");
  });

  it("a computed mutant record wins over the definition fallback", () => {
    const item = mutationProbeReportItem(killed, false, {
      file: "other.ts",
      line: 99,
      before: "old",
      after: "new",
    });
    expect(item.file).toBe("/repo/src/a.ts");
    expect(item.anchor).toBe(12);
    expect(item.before).toBe("return a + b;");
    expect(item.after).toBe("return a - b;");
  });

  it("mutationProbeReportItems fills each row's definition by its own index", () => {
    const items = mutationProbeReportItems(
      {
        results: [
          { index: 0, ...killed },
          { index: 1, status: "inconclusive", reason: "mutant_not_applicable" },
        ],
      },
      false,
      [
        { file: "a.ts", line: 1, after: "r" },
        { file: "b.ts", line: 7, before: "m", after: "w" },
      ],
    );
    expect(items[0].file).toBe("/repo/src/a.ts");
    expect(items[0].anchor).toBe(12);
    expect(items[1].file).toBe("b.ts");
    expect(items[1].anchor).toBe(7);
    expect(items[1].before).toBe("m");
    expect(items[1].after).toBe("w");
    expect(items[1].result).toBe("not_applicable");
  });

  it("replayed is the flag's value on every item", () => {
    expect(mutationProbeReportItem(killed, true).replayed).toBe(true);
    expect(mutationProbeReportItem(killed, false).replayed).toBe(false);
  });

  it("a row's own reason always wins over the envelope fallback reason", () => {
    const items = mutationProbeReportItems(
      {
        results: [
          { index: 0, status: "inconclusive", reason: "pre_failed" },
          {
            index: 1,
            status: "inconclusive",
            reason: "restore_failed",
            mutation_probe: { result: "not_run", reason: "aborted" },
          },
        ],
      },
      false,
      undefined,
      "baseline_failed",
    );
    expect(items[0].reason).toBe("pre_failed");
    expect(items[1].reason).toBe("aborted");
  });

  it("a measured killed or survived row keeps an empty reason beside a fallback reason", () => {
    const survived = {
      ...killed,
      mutation_probe: {
        ...killed.mutation_probe,
        result: "survived",
        expectation: "violated",
      },
    };
    const items = mutationProbeReportItems(
      { results: [killed, survived] },
      false,
      undefined,
      "baseline_failed",
    );
    expect(items[0].result).toBe("killed");
    expect(items[0].reason).toBe("");
    expect(items[1].result).toBe("survived");
    expect(items[1].reason).toBe("");
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

describe("renderProbeSummary: a plan naming more than one test command", () => {
  const row = (
    index: number,
    baselineIndex: number,
    testCommand: string,
    killed: boolean,
  ) => ({
    index,
    file: "/work/repo/a.ts",
    ...(killed
      ? {
          status: "killed",
          mutant: { file: "/work/repo/a.ts", line: index + 1 },
          mutation_probe: {
            result: "killed",
            expectation: "met",
            restored_verified: true,
          },
          test: {
            stdoutTail: "",
            stderrTail: "",
            logPath: `/logs/m${index}.log`,
          },
        }
      : { status: "not_run", reason: "baseline_failed" }),
    logs: [],
    baseline_index: baselineIndex,
    test_command: testCommand,
  });
  const summary = {
    total: 2,
    killed: 1,
    survived: 0,
    inconclusive: 0,
    not_run: 1,
    met: 1,
    violated: 0,
  };

  it("one command: no test= column and no baseline line, byte for byte what a plan without baselines prints", () => {
    const plan = {
      baseline: { logPath: "/logs/b0.log" },
      results: [row(0, 0, "npm test", true), row(1, 0, "npm test", false)],
      summary,
    };
    const input = {
      status: "inconclusive",
      reason: "mutant_inconclusive",
      cwd: "/work/repo",
    };
    const without = renderProbeSummary({ ...input, plan });
    const withOne = renderProbeSummary({
      ...input,
      plan: {
        ...plan,
        baselines: [
          {
            index: 0,
            command: "npm test",
            status: "passed",
            logPath: "/logs/b0.log",
            entries: [0, 1],
          },
        ],
      },
    });
    expect(withOne).toBe(without);
    expect(withOne).not.toContain("test=");
    expect(withOne).not.toContain("baseline[");
    expect(withOne.split("\n")[1]).toBe(
      "#1 a.ts | not_run(baseline_failed) | expectation=- | restored=- | failing=- | log=/logs/b0.log",
    );
  });

  it("two commands: each mutant line ends in its test= column, one baseline line per command sits above the totals, and log= falls back to the row's own baseline", () => {
    const text = renderProbeSummary({
      status: "inconclusive",
      reason: "mutant_inconclusive",
      cwd: "/work/repo",
      plan: {
        baseline: { logPath: "/logs/b0.log" },
        baselines: [
          {
            index: 0,
            command: "npm test",
            status: "passed",
            logPath: "/logs/b0.log",
            entries: [0],
          },
          {
            index: 1,
            command: "npm run  test:b",
            status: "failed",
            reason: "baseline_failed",
            logPath: "/logs/b1.log",
            entries: [1],
          },
        ],
        results: [
          row(0, 0, "npm test", true),
          row(1, 1, "npm run  test:b", false),
        ],
        summary,
      },
    });
    expect(text.trimEnd().split("\n")).toEqual([
      "#0 a.ts:1 | killed | expectation=met | restored=true | failing=- | log=/logs/m0.log | test=npm test",
      "#1 a.ts | not_run(baseline_failed) | expectation=- | restored=- | failing=- | log=/logs/b1.log | test=npm run test:b",
      detectionLine(1),
      "baseline[0] | passed | entries=0 | log=/logs/b0.log | test=npm test",
      "baseline[1] | failed(baseline_failed) | entries=1 | log=/logs/b1.log | test=npm run test:b",
      "totals: status=inconclusive reason=mutant_inconclusive total=2 killed=1 survived=0 inconclusive=0 not_run=1 met=1 violated=0 build_failed=0",
    ]);
  });

  it("a tight maxChars drops the mutant lines first, then the baseline lines, and always keeps the totals line", () => {
    const input = {
      status: "killed",
      plan: {
        baselines: [
          { index: 0, command: "npm test", status: "passed", entries: [0] },
          { index: 1, command: "npm run b", status: "passed", entries: [1] },
        ],
        results: [row(0, 0, "npm test", true), row(1, 1, "npm run b", true)],
        summary: { ...summary, killed: 2, not_run: 0, met: 2 },
      },
    };
    const full = renderProbeSummary(input).trimEnd().split("\n");
    const totals = full[full.length - 1];
    const baselineLines = full.filter((l) => l.startsWith("baseline["));
    expect(baselineLines).toHaveLength(2);

    const marker = /^\.\.\. 2 more mutant lines omitted /;
    // Room for the tail alone: the mutant lines give way (named by the
    // marker), every baseline line and the totals stay.
    const noMutants = renderProbeSummary(
      input,
      baselineLines.join("\n").length + totals.length + 2,
    )
      .trimEnd()
      .split("\n");
    expect(noMutants[0]).toMatch(marker);
    expect(noMutants.slice(1)).toEqual([...baselineLines, totals]);

    // Room for one baseline line beside the totals: the last one goes.
    const oneBaseline = renderProbeSummary(
      input,
      baselineLines[0].length + totals.length + 2,
    )
      .trimEnd()
      .split("\n");
    expect(oneBaseline[0]).toMatch(marker);
    expect(oneBaseline.slice(1)).toEqual([baselineLines[0], totals]);

    // Room for the totals alone: no baseline line is left.
    const totalsOnly = renderProbeSummary(input, totals.length + 1)
      .trimEnd()
      .split("\n");
    expect(totalsOnly[0]).toMatch(marker);
    expect(totalsOnly.slice(1)).toEqual([totals]);
  });
});

describe(
  "probe --plan naming two test commands: the compact views (CLI)",
  { timeout: 60000 },
  () => {
    function twoCommandPlan(repo: string): string {
      const plan = path.join(repo, "plan.json");
      fs.writeFileSync(
        plan,
        JSON.stringify({
          test: TEST_CMD,
          mutants: [
            { file: "fixture.js", line: 1, replace: "module.exports = false;" },
            {
              file: "fixture.js",
              line: 1,
              replace: "module.exports = 1;",
              test: 'node -e "process.exit(1)"',
            },
          ],
        }),
      );
      return plan;
    }

    it("--summary ends each mutant line in its test= column and prints one baseline line per command above the totals", async () => {
      const { repo, logs } = makeRepo();
      const { json, view } = await both(
        repo,
        logs,
        ["--plan", twoCommandPlan(repo)],
        ["--summary"],
      );
      expect(view.code).toBe(json.code);
      const lines = view.stdout.trimEnd().split("\n");
      expect(lines).toHaveLength(6);
      expect(lines[0]).toMatch(/^#0 \S*fixture\.js:1 \| killed /);
      expect(lines[0].endsWith(` | test=${TEST_CMD}`)).toBe(true);
      expect(lines[2]).toBe(detectionLine(1));
      expect(lines[3]).toMatch(/^baseline\[0\] \| passed \| entries=0 \| log=/);
      expect(lines[4]).toMatch(
        /^baseline\[1\] \| failed\(baseline_failed\) \| entries=1 \| log=/,
      );
      // The never-run mutant's log= is its own command's baseline log,
      // read from the same output (each spawned run logs to its own file).
      const secondBaselineLog = /\| log=(\S+) \|/.exec(lines[4])?.[1];
      expect(secondBaselineLog).toMatch(/\.log$/);
      expect(lines[1]).toMatch(
        /^#1 \S*fixture\.js \| not_run\(baseline_failed\) /,
      );
      expect(
        lines[1].endsWith(
          ` | log=${secondBaselineLog} | test=node -e "process.exit(1)"`,
        ),
      ).toBe(true);
      expect(lines[5]).toBe(
        "totals: status=inconclusive reason=mutant_inconclusive total=2 killed=1 survived=0 inconclusive=0 not_run=1 met=1 violated=0 build_failed=0",
      );
    });

    it("--print plan.baselines prints every baseline, and --report keeps its eleven fields per item", async () => {
      const { repo, logs } = makeRepo();
      const plan = twoCommandPlan(repo);
      const { view } = await both(
        repo,
        logs,
        ["--plan", plan],
        ["--print", "plan.baselines"],
      );
      const printed = JSON.parse(view.stdout)["plan.baselines"];
      expect(
        printed.map((b: { command: string; status: string }) => [
          b.command,
          b.status,
        ]),
      ).toEqual([
        [TEST_CMD, "passed"],
        ['node -e "process.exit(1)"', "failed"],
      ]);

      const report = await both(
        repo,
        logs,
        ["--plan", plan],
        ["--report", "mutation-probes"],
      );
      const items = JSON.parse(report.view.stdout);
      expect(items).toHaveLength(2);
      for (const item of items) expect(Object.keys(item)).toEqual(REPORT_KEYS);
      expect(items[0].result).toBe("killed");
      expect(items[1].result).toBe("not_applicable");
      expect(items[1].reason).toBe("baseline_failed");
    });
  },
);

describe("renderProbeSummary note precedence (table)", () => {
  const message = "plan file could not be read";
  const refusal = 'link "no-such-src" does not exist; drop --link';
  const manifestWarning =
    "ignoring the worktree link manifest /repo/.git/worktrees/wt/agent-primitives-links.json: it is not valid JSON";
  const defaultsWarning = "/repo/.agent-primitives.json: not valid JSON";
  const notice = `${MATCH_LINE_DERIVATION_NOTICE_PREFIX} line 2 of fixture.js`;

  interface NoteCase {
    name: string;
    input: { message?: string; refusal?: string; warnings?: string[] };
    /** `null`: no note line at all. `""`: an empty note text, which
     * prints no note line either (an input that outranks the others
     * still outranks). Anything else: the exact expected note. */
    expected: string | null;
    /** The pipeline cannot produce this input today, so the row pins the
     * precedence contract for direct callers of `renderProbeSummary`
     * rather than a shipped run: `message` is the summary's own
     * library-facing rank (no CLI path fills it), and a defaults-file
     * refusal is itself the refusal its message names, so a defaults
     * warning never sits alone or before a different refusal. */
    defensive?: boolean;
  }
  const cases: NoteCase[] = [
    { name: "no message, no refusal, no warning", input: {}, expected: null },
    {
      name: "message alone",
      input: { message },
      expected: message,
      defensive: true,
    },
    {
      name: "refusal alone (carried beside its appended warning)",
      input: { refusal, warnings: [refusal] },
      expected: refusal,
    },
    {
      name: "manifest-link warning alone",
      input: { warnings: [manifestWarning] },
      expected: manifestWarning,
    },
    {
      name: "defaults warning alone",
      input: { warnings: [defaultsWarning] },
      expected: defaultsWarning,
      defensive: true,
    },
    {
      name: "derivation notice alone (the last-resort fallback)",
      input: { warnings: [notice] },
      expected: notice,
    },
    {
      name: "message and refusal: the message wins",
      input: { message, refusal, warnings: [refusal] },
      expected: message,
      defensive: true,
    },
    {
      name: "manifest-link warning before the refusal: the refusal wins",
      input: { refusal, warnings: [manifestWarning, refusal] },
      expected: refusal,
    },
    {
      name: "defaults warning before the refusal: the refusal wins",
      input: { refusal, warnings: [defaultsWarning, refusal] },
      expected: refusal,
      defensive: true,
    },
    {
      name: "manifest-link and defaults warnings before the refusal: the refusal wins",
      input: { refusal, warnings: [manifestWarning, defaultsWarning, refusal] },
      expected: refusal,
      defensive: true,
    },
    {
      name: "derivation notice before the refusal: the refusal wins",
      input: { refusal, warnings: [notice, refusal] },
      expected: refusal,
    },
    {
      name: "all three warnings before the refusal: the refusal wins",
      input: { refusal, warnings: [notice, manifestWarning, refusal] },
      expected: refusal,
    },
    {
      name: "no refusal: the first non-notice warning wins over the notice",
      input: { warnings: [notice, manifestWarning] },
      expected: manifestWarning,
    },
    {
      name: "manifest and defaults warnings, no refusal: the earlier pushed wins",
      input: { warnings: [manifestWarning, defaultsWarning] },
      expected: manifestWarning,
      defensive: true,
    },
    {
      name: "message outranks the refusal and every warning",
      input: {
        message,
        refusal,
        warnings: [notice, manifestWarning, defaultsWarning, refusal],
      },
      expected: message,
      defensive: true,
    },
    {
      name: "an empty message still outranks (absent vs empty)",
      input: { message: "", refusal, warnings: [manifestWarning, refusal] },
      expected: "",
      defensive: true,
    },
  ];
  for (const testCase of cases) {
    it(`note: ${testCase.name}`, () => {
      const text = renderProbeSummary({
        status: "usage_error",
        reason: "link_source_not_found",
        ...testCase.input,
      });
      const lines = text.trimEnd().split("\n");
      if (testCase.expected === null || testCase.expected === "") {
        expect(text).not.toContain("note: ");
      } else {
        expect(lines[lines.length - 1]).toBe(`note: ${testCase.expected}`);
      }
    });
  }
});

/** A linked worktree whose git administration directory carries a link
 * manifest that cannot be read, so `trustedManifestLinks` pushes its
 * warning before any link-source refusal, in the single and the plan
 * form alike. */
function makeManifestLinkRepo(): {
  base: string;
  repo: string;
  wt: string;
  logs: string;
} {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ap-summary-manifest-"));
  tmpDirs.push(base);
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd });
  git(base, ["init", "-q", "-b", "main", repo]);
  for (const [key, value] of [
    ["user.email", "test@example.com"],
    ["user.name", "test"],
  ] as const) {
    git(repo, ["config", key, value]);
  }
  fs.writeFileSync(path.join(repo, "fixture.js"), "module.exports = true;\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "fixture"]);
  const wt = path.join(base, "wt");
  git(repo, ["worktree", "add", "-q", wt, "-b", "summary-wt", "main"]);
  const admin = fs
    .readFileSync(path.join(wt, ".git"), "utf8")
    .trim()
    .replace(/^gitdir:\s*/, "");
  fs.writeFileSync(path.join(admin, LINK_MANIFEST_FILE), "{ not json", {
    mode: 0o600,
  });
  const logs = path.join(base, "logs");
  fs.mkdirSync(logs);
  return { base, repo, wt, logs };
}

/** The refused link source: inside the containment root, so the refusal
 * is `link_source_not_found` (one outside it answers `file_outside_root`). */
const MISSING_LINK = "no-such-src";
const REFUSAL_MARK = `"${MISSING_LINK}"`;

describe(
  "probe --summary: a manifest-link warning before a link-source refusal (end to end)",
  { timeout: 60000 },
  () => {
    it("single form: the note is the refusal, the JSON warnings keep their order", async () => {
      const { wt, logs } = makeManifestLinkRepo();
      const base = ["-C", wt, "-l", logs, "-m", "100000", "probe"];
      const args = [
        "--file",
        "fixture.js",
        "-n",
        "1",
        "-r",
        "module.exports = false;",
        "-t",
        TEST_CMD,
        "--link",
        MISSING_LINK,
      ];
      const json = await spawnCli([...base, ...args]);
      const view = await spawnCli([...base, "--summary", ...args]);
      expect(json.code).toBe(2);
      expect(view.code).toBe(2);
      const envelope = JSON.parse(json.stdout) as {
        status: string;
        reason?: string;
        warnings: string[];
      };
      expect(envelope.status).toBe("usage_error");
      expect(envelope.reason).toBe("link_source_not_found");
      // The envelope is unchanged: the manifest warning stays first, the
      // refusal's message last, exactly as they were pushed.
      expect(envelope.warnings[0]).toContain(
        "ignoring the worktree link manifest",
      );
      const refusal = envelope.warnings[envelope.warnings.length - 1];
      expect(refusal).toContain(REFUSAL_MARK);
      const lines = view.stdout.trimEnd().split("\n");
      expect(lines[lines.length - 1]).toBe(`note: ${refusal}`);
      expect(view.stdout).not.toContain("ignoring the worktree link manifest");

      // The pipeline carries the refusal's own text on its result,
      // beside the warning it appends (same as the plan form).
      const result = await probe({
        file: "fixture.js",
        line: 1,
        form: "replace",
        replaceText: "module.exports = false;",
        testCommand: TEST_CMD,
        isolation: "inplace",
        expect: "fail",
        links: [MISSING_LINK],
        cwd: wt,
        logDir: logs,
      });
      expect(result.status).toBe("usage_error");
      expect(result.reason).toBe("link_source_not_found");
      expect(result.refusal).toBe(refusal);
      expect(result.warnings[0]).toContain(
        "ignoring the worktree link manifest",
      );
    });

    it("plan form: the refusal is carried explicitly, the summary never prints the manifest warning", async () => {
      const { base, wt, logs } = makeManifestLinkRepo();
      const plan = path.join(base, "plan.json");
      fs.writeFileSync(
        plan,
        JSON.stringify({
          test: TEST_CMD,
          mutants: [
            {
              file: "fixture.js",
              line: 1,
              replace: "module.exports = false;",
            },
          ],
        }),
      );
      const planArgs = ["--plan", plan, "--link", MISSING_LINK];
      const json = await spawnCli([
        "-C",
        wt,
        "-l",
        logs,
        "-m",
        "100000",
        "probe",
        ...planArgs,
      ]);
      const view = await spawnCli([
        "-C",
        wt,
        "-l",
        logs,
        "-m",
        "100000",
        "probe",
        "--summary",
        ...planArgs,
      ]);
      expect(json.code).toBe(2);
      expect(view.code).toBe(2);
      const envelope = JSON.parse(json.stdout) as {
        status: string;
        reason?: string;
        warnings: string[];
      };
      expect(envelope.status).toBe("usage_error");
      expect(envelope.reason).toBe("link_source_not_found");
      expect(envelope.warnings[0]).toContain(
        "ignoring the worktree link manifest",
      );
      const refusal = envelope.warnings[envelope.warnings.length - 1];
      expect(refusal).toContain(REFUSAL_MARK);
      // A refused plan counts its never-run mutants, so its summary
      // carries no note line at all (the note belongs to runs that name
      // no mutant); what must not appear anywhere is the manifest
      // warning, and the totals line names the refusal's reason.
      const lines = view.stdout.trimEnd().split("\n");
      expect(lines[lines.length - 1]).toContain(
        "totals: status=usage_error reason=link_source_not_found",
      );
      expect(view.stdout).not.toContain("note:");
      expect(view.stdout).not.toContain("ignoring the worktree link manifest");

      // The pipeline carries the refusal's own text on its result,
      // beside the warning it appends, so the summary input never has
      // to pick it out of `warnings`.
      const result = await probePlan({
        mutants: [
          {
            file: "fixture.js",
            line: 1,
            form: "replace",
            replaceText: "module.exports = false;",
          },
        ],
        testCommand: TEST_CMD,
        isolation: "inplace",
        expect: "fail",
        links: [MISSING_LINK],
        cwd: wt,
        logDir: logs,
      });
      expect(result.status).toBe("usage_error");
      expect(result.reason).toBe("link_source_not_found");
      expect(result.refusal).toBe(refusal);
      expect(result.warnings[0]).toContain(
        "ignoring the worktree link manifest",
      );
    });
  },
);

describe(
  "probe --summary: a manifest-link warning before a run-setup or dry-run refusal (end to end)",
  { timeout: 60000 },
  () => {
    /** The manifest-link repo plus an `outside.js` one directory above
     * the worktree root: a `--file ../outside.js` run then refuses at the
     * shared setup's containment check (single form) or the plan's own
     * (plan form) with the manifest warning already pushed ahead of the
     * refusal's message. */
    function withOutsideFile(base: string): void {
      fs.writeFileSync(
        path.join(base, "outside.js"),
        "module.exports = true;\n",
      );
    }

    it("single form: a containment refusal names itself as the note, not the manifest warning", async () => {
      const { base, wt, logs } = makeManifestLinkRepo();
      withOutsideFile(base);
      const cliBase = ["-C", wt, "-l", logs, "-m", "100000", "probe"];
      const args = [
        "--file",
        "../outside.js",
        "-n",
        "1",
        "-r",
        "x",
        "-t",
        "true",
        "-i",
        "inplace",
      ];
      const json = await spawnCli([...cliBase, ...args]);
      const view = await spawnCli([...cliBase, "--summary", ...args]);
      expect(json.code).toBe(2);
      expect(view.code).toBe(2);
      const envelope = JSON.parse(json.stdout) as {
        status: string;
        reason?: string;
        warnings: string[];
      };
      expect(envelope.status).toBe("inconclusive");
      expect(envelope.reason).toBe("file_outside_root");
      expect(envelope.warnings[0]).toContain(
        "ignoring the worktree link manifest",
      );
      const refusal = envelope.warnings[envelope.warnings.length - 1];
      expect(refusal).toContain("outside the containment root");
      expect(refusal).toContain("outside.js");
      const lines = view.stdout.trimEnd().split("\n");
      expect(lines[lines.length - 1]).toBe(`note: ${refusal}`);
      expect(view.stdout).not.toContain("ignoring the worktree link manifest");

      const result = await probe({
        file: "../outside.js",
        line: 1,
        form: "replace",
        replaceText: "x",
        testCommand: "true",
        isolation: "inplace",
        expect: "fail",
        cwd: wt,
        logDir: logs,
      });
      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("file_outside_root");
      expect(result.refusal).toBe(refusal);
      expect(result.warnings[result.warnings.length - 1]).toBe(refusal);
    });

    it("plan form: the carried refusal lands on the result; a refused plan prints no note line", async () => {
      const { base, wt, logs } = makeManifestLinkRepo();
      withOutsideFile(base);
      const plan = path.join(base, "plan-outside.json");
      fs.writeFileSync(
        plan,
        JSON.stringify({
          test: "true",
          mutants: [{ file: "../outside.js", line: 1, replace: "x" }],
        }),
      );
      const planArgs = ["--plan", plan];
      const json = await spawnCli([
        "-C",
        wt,
        "-l",
        logs,
        "-m",
        "100000",
        "probe",
        ...planArgs,
      ]);
      const view = await spawnCli([
        "-C",
        wt,
        "-l",
        logs,
        "-m",
        "100000",
        "probe",
        "--summary",
        ...planArgs,
      ]);
      expect(json.code).toBe(2);
      expect(view.code).toBe(2);
      const envelope = JSON.parse(json.stdout) as {
        status: string;
        reason?: string;
        warnings: string[];
      };
      expect(envelope.status).toBe("usage_error");
      expect(envelope.reason).toBe("file_outside_root");
      expect(envelope.warnings[0]).toContain(
        "ignoring the worktree link manifest",
      );
      const refusal = envelope.warnings[envelope.warnings.length - 1];
      expect(refusal).toContain("outside the containment root");
      // Every never-run mutant is counted on the totals line, so this
      // summary has no note line at all; what must not leak is the
      // manifest warning, and the totals line names the refusal's reason.
      const lines = view.stdout.trimEnd().split("\n");
      expect(lines[lines.length - 1]).toContain(
        "totals: status=usage_error reason=file_outside_root",
      );
      expect(view.stdout).not.toContain("note:");
      expect(view.stdout).not.toContain("ignoring the worktree link manifest");

      // The plan-side carry is for the library caller reading the
      // result directly: the refusal's own text, last in `warnings`.
      const result = await probePlan({
        mutants: [
          { file: "../outside.js", line: 1, form: "replace", replaceText: "x" },
        ],
        testCommand: "true",
        isolation: "inplace",
        expect: "fail",
        cwd: wt,
        logDir: logs,
      });
      expect(result.status).toBe("usage_error");
      expect(result.reason).toBe("file_outside_root");
      expect(result.refusal).toBe(refusal);
      expect(result.warnings[result.warnings.length - 1]).toBe(refusal);
    });

    it("plan form with no mutants: the note is the plan_empty refusal (parse path), not the manifest warning", async () => {
      // The one refused-plan shape whose summary names no mutant: the
      // totals line reads `total=0`, so the note line exists. The
      // message comes from plan parsing (the parsed usage-error path),
      // where it is the only warning; the plan-form carry into the
      // summary input is equivalent here and is pinned on the library
      // result instead.
      const { base, wt, logs } = makeManifestLinkRepo();
      const plan = path.join(base, "plan-empty.json");
      fs.writeFileSync(plan, JSON.stringify({ test: "true", mutants: [] }));
      const planArgs = ["--plan", plan];
      const json = await spawnCli([
        "-C",
        wt,
        "-l",
        logs,
        "-m",
        "100000",
        "probe",
        ...planArgs,
      ]);
      const view = await spawnCli([
        "-C",
        wt,
        "-l",
        logs,
        "-m",
        "100000",
        "probe",
        "--summary",
        ...planArgs,
      ]);
      expect(json.code).toBe(2);
      expect(view.code).toBe(2);
      const envelope = JSON.parse(json.stdout) as {
        status: string;
        reason?: string;
        warnings: string[];
      };
      expect(envelope.status).toBe("usage_error");
      expect(envelope.reason).toBe("plan_empty");
      // The manifest push comes after this check, so this refusal runs
      // with an empty `warnings` of its own; what must still hold is the
      // CLI's plan-form carry: the note line exists and names it.
      const refusal = envelope.warnings[envelope.warnings.length - 1];
      expect(refusal).toContain("plan.mutants is empty");
      const lines = view.stdout.trimEnd().split("\n");
      expect(lines[lines.length - 1]).toBe(`note: ${refusal}`);
      expect(view.stdout).not.toContain("ignoring the worktree link manifest");
    });

    it("dry-run mutant_not_applicable: the note is the dry run's message, not the manifest warning", async () => {
      const { wt, logs } = makeManifestLinkRepo();
      const cliBase = ["-C", wt, "-l", logs, "-m", "100000", "probe"];
      const args = ["--file", "fixture.js", "-n", "5", "-r", "x", "-t", "true"];
      const json = await spawnCli([...cliBase, ...args]);
      const view = await spawnCli([...cliBase, "--summary", ...args]);
      expect(json.code).toBe(2);
      expect(view.code).toBe(2);
      const envelope = JSON.parse(json.stdout) as {
        status: string;
        reason?: string;
        warnings: string[];
      };
      expect(envelope.status).toBe("inconclusive");
      expect(envelope.reason).toBe("mutant_not_applicable");
      expect(envelope.warnings[0]).toContain(
        "ignoring the worktree link manifest",
      );
      const refusal = envelope.warnings[envelope.warnings.length - 1];
      expect(refusal).toContain("line 5 is out of range");
      const lines = view.stdout.trimEnd().split("\n");
      expect(lines[lines.length - 1]).toBe(`note: ${refusal}`);
      expect(view.stdout).not.toContain("ignoring the worktree link manifest");

      const result = await probe({
        file: "fixture.js",
        line: 5,
        form: "replace",
        replaceText: "x",
        testCommand: "true",
        isolation: "inplace",
        expect: "fail",
        cwd: wt,
        logDir: logs,
      });
      expect(result.status).toBe("inconclusive");
      expect(result.reason).toBe("mutant_not_applicable");
      expect(result.refusal).toBe(refusal);
      expect(result.warnings[result.warnings.length - 1]).toBe(refusal);
    });
  },
);

describe("probe/probePlan refusal carry (table)", { timeout: 60000 }, () => {
  /** Permission bits do not bind uid 0: the mode-`000` and mode-`500`
   * fixtures below would not refuse there, so those rows skip. */
  const unrootedOnly =
    typeof process.getuid === "function" && process.getuid() !== 0;

  /** A committed `fixture.js` with `const dup` on two lines (the
   * `match_ambiguous` fixture) and three content lines (so `-n 5` is out
   * of range for the dry-run row). */
  function carryRepo(extra?: (repo: string) => void): {
    repo: string;
    logs: string;
  } {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-carry-repo-"));
    const logs = fs.mkdtempSync(path.join(os.tmpdir(), "ap-carry-logs-"));
    tmpDirs.push(repo, logs);
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "test"]);
    fs.writeFileSync(
      path.join(repo, "fixture.js"),
      'const dup = 1;\nmodule.exports = true;\nconst dup2 = "dup";\n',
    );
    git(["add", "."]);
    git(["commit", "-qm", "fixture"]);
    extra?.(repo);
    return { repo, logs };
  }

  /** A real diff touching `fixture.js` and `extra.js`: the
   * `patch_file_ambiguous` fixture (`git apply --numstat` parses its
   * paths without ever touching disk). */
  function twoPathPatch(repo: string): string {
    fs.writeFileSync(path.join(repo, "extra.js"), "module.exports = 1;\n");
    execFileSync("git", ["add", "extra.js"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "extra"], { cwd: repo });
    fs.appendFileSync(path.join(repo, "fixture.js"), "// touched\n");
    fs.appendFileSync(path.join(repo, "extra.js"), "// touched\n");
    const patch = path.join(repo, "two.patch");
    fs.writeFileSync(
      patch,
      execFileSync("git", ["diff"], { cwd: repo, encoding: "utf8" }),
    );
    return patch;
  }

  /** A private lock directory with `mode`; the caller restores the bits
   * it needs for removal. */
  function makeLockDir(mode: number): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-carry-lock-"));
    fs.chmodSync(dir, mode);
    tmpDirs.push(dir);
    const previous = process.env.AGENT_PRIMITIVES_LOCK_DIR;
    savedEnv.push(["AGENT_PRIMITIVES_LOCK_DIR", previous]);
    process.env.AGENT_PRIMITIVES_LOCK_DIR = dir;
    return dir;
  }

  interface CarryCase {
    name: string;
    status: string;
    reason: string;
    /** Warnings pushed BEFORE the refusal appended its own message: the
     * assertion pins that the refusal added exactly one entry at the end
     * and left everything pushed before it alone. */
    prior: number;
    /** A substring the first warning must carry (the manifest row). */
    firstWarningIncludes?: string;
    /** Needs uid 0's permission model to be inert (see `unrootedOnly`). */
    needsUnrooted?: boolean;
    run: () => ReturnType<typeof probe> | ReturnType<typeof probePlan>;
  }

  const cases: CarryCase[] = [
    {
      name: "file_required",
      status: "usage_error",
      reason: "file_required",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo();
        return probe({
          form: "replace",
          replaceText: "x",
          testCommand: "true",
          isolation: "inplace",
          expect: "fail",
          cwd: repo,
          logDir: logs,
        });
      },
    },
    {
      name: "line_required",
      status: "usage_error",
      reason: "line_required",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo();
        return probe({
          file: "fixture.js",
          form: "replace",
          replaceText: "x",
          testCommand: "true",
          isolation: "inplace",
          expect: "fail",
          cwd: repo,
          logDir: logs,
        });
      },
    },
    {
      name: "match_not_found",
      status: "usage_error",
      reason: "match_not_found",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo();
        return probe({
          file: "fixture.js",
          form: "match",
          matchText: "no-such-text",
          withText: "y",
          testCommand: "true",
          isolation: "inplace",
          expect: "fail",
          cwd: repo,
          logDir: logs,
        });
      },
    },
    {
      name: "match_ambiguous",
      status: "usage_error",
      reason: "match_ambiguous",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo();
        return probe({
          file: "fixture.js",
          form: "match",
          matchText: "dup",
          withText: "y",
          testCommand: "true",
          isolation: "inplace",
          expect: "fail",
          cwd: repo,
          logDir: logs,
        });
      },
    },
    {
      name: "patch_not_readable",
      status: "usage_error",
      reason: "patch_not_readable",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo();
        return probe({
          file: "fixture.js",
          form: "patch",
          patchPath: "no-such.patch",
          testCommand: "true",
          isolation: "inplace",
          expect: "fail",
          cwd: repo,
          logDir: logs,
        });
      },
    },
    {
      name: "patch listing fails: mutant_not_applicable",
      status: "inconclusive",
      reason: "mutant_not_applicable",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo((dir) =>
          fs.writeFileSync(path.join(dir, "bad.patch"), "not a patch at all\n"),
        );
        return probe({
          form: "patch",
          patchPath: "bad.patch",
          testCommand: "true",
          isolation: "inplace",
          expect: "fail",
          cwd: repo,
          logDir: logs,
        });
      },
    },
    {
      name: "patch_file_ambiguous",
      status: "usage_error",
      reason: "patch_file_ambiguous",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo();
        twoPathPatch(repo);
        return probe({
          form: "patch",
          patchPath: "two.patch",
          testCommand: "true",
          isolation: "inplace",
          expect: "fail",
          cwd: repo,
          logDir: logs,
        });
      },
    },
    {
      name: "defaults_file_invalid",
      status: "usage_error",
      reason: "defaults_file_invalid",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo((dir) =>
          fs.writeFileSync(
            path.join(dir, ".agent-primitives.json"),
            "{ not json\n",
          ),
        );
        return probe({
          file: "fixture.js",
          line: 1,
          form: "replace",
          replaceText: "x",
          testCommand: "true",
          isolation: "inplace",
          expect: "fail",
          cwd: repo,
          logDir: logs,
        });
      },
    },
    {
      name: "file_outside_root via an unresolvable path (single)",
      status: "inconclusive",
      reason: "file_outside_root",
      prior: 0,
      needsUnrooted: true,
      run: async () => {
        const { repo, logs } = carryRepo((dir) =>
          fs.mkdirSync(path.join(dir, "closed")),
        );
        fs.chmodSync(path.join(repo, "closed"), 0o000);
        try {
          return await probe({
            file: "closed/two.js",
            line: 1,
            form: "replace",
            replaceText: "x",
            testCommand: "true",
            isolation: "inplace",
            expect: "fail",
            cwd: repo,
            logDir: logs,
          });
        } finally {
          fs.chmodSync(path.join(repo, "closed"), 0o700);
        }
      },
    },
    {
      name: "link_source_not_found",
      status: "usage_error",
      reason: "link_source_not_found",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo();
        return probe({
          file: "fixture.js",
          line: 1,
          form: "replace",
          replaceText: "x",
          testCommand: "true",
          isolation: "inplace",
          expect: "fail",
          links: ["no-such-src"],
          cwd: repo,
          logDir: logs,
        });
      },
    },
    {
      name: "file_outside_root from the shared setup (single)",
      status: "inconclusive",
      reason: "file_outside_root",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ap-carry-out-"));
        tmpDirs.push(outside);
        const target = path.join(outside, "outside.js");
        fs.writeFileSync(target, "module.exports = true;\n");
        return probe({
          file: target,
          line: 1,
          form: "replace",
          replaceText: "x",
          testCommand: "true",
          isolation: "inplace",
          expect: "fail",
          cwd: repo,
          logDir: logs,
        });
      },
    },
    {
      name: "file_outside_root behind a manifest-link warning (single)",
      status: "inconclusive",
      reason: "file_outside_root",
      prior: 1,
      firstWarningIncludes: "ignoring the worktree link manifest",
      run: () => {
        const { base, wt, logs } = makeManifestLinkRepo();
        fs.writeFileSync(
          path.join(base, "outside.js"),
          "module.exports = true;\n",
        );
        return probe({
          file: "../outside.js",
          line: 1,
          form: "replace",
          replaceText: "x",
          testCommand: "true",
          isolation: "inplace",
          expect: "fail",
          cwd: wt,
          logDir: logs,
        });
      },
    },
    {
      name: "lock_unavailable",
      status: "inconclusive",
      reason: "lock_unavailable",
      prior: 0,
      needsUnrooted: true,
      run: async () => {
        const { repo, logs } = carryRepo();
        const dir = makeLockDir(0o500);
        try {
          return await probe({
            file: "fixture.js",
            line: 1,
            form: "replace",
            replaceText: "x",
            testCommand: "true",
            isolation: "inplace",
            expect: "fail",
            cwd: repo,
            logDir: logs,
          });
        } finally {
          fs.chmodSync(dir, 0o700);
        }
      },
    },
    {
      name: "stale_probe_marker",
      status: "inconclusive",
      reason: "stale_probe_marker",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo();
        makeLockDir(0o700);
        const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"])
          .pid as number;
        // setup looks the marker up under the resolved path; macOS
        // os.tmpdir() sits behind the /var -> /private/var symlink.
        const target = fs.realpathSync(path.resolve(repo, "fixture.js"));
        writeMarker(target, {
          targetPath: target,
          backupPath: path.join(repo, "fixture.js.ap-backup"),
          preHash: "0".repeat(64),
          mutatedHash: "1".repeat(64),
          pid: deadPid,
          timestamp: new Date().toISOString(),
        });
        return probe({
          file: "fixture.js",
          line: 1,
          form: "replace",
          replaceText: "x",
          testCommand: "true",
          isolation: "inplace",
          expect: "fail",
          cwd: repo,
          logDir: logs,
        });
      },
    },
    {
      name: "pre_failed from the baseline gate",
      status: "inconclusive",
      reason: "pre_failed",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo();
        return probe({
          file: "fixture.js",
          line: 1,
          form: "replace",
          replaceText: "x",
          testCommand: "true",
          preCommand: "exit 3",
          isolation: "inplace",
          expect: "fail",
          cwd: repo,
          logDir: logs,
        });
      },
    },
    {
      name: "dry-run mutant_not_applicable",
      status: "inconclusive",
      reason: "mutant_not_applicable",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo();
        return probe({
          file: "fixture.js",
          line: 5,
          form: "replace",
          replaceText: "x",
          testCommand: "true",
          isolation: "inplace",
          expect: "fail",
          cwd: repo,
          logDir: logs,
        });
      },
    },
    {
      name: "plan_empty",
      status: "usage_error",
      reason: "plan_empty",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo();
        return probePlan({
          mutants: [],
          testCommand: "true",
          isolation: "inplace",
          expect: "fail",
          cwd: repo,
          logDir: logs,
        });
      },
    },
    {
      name: "plan_invalid: no test command",
      status: "usage_error",
      reason: "plan_invalid",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo();
        return probePlan({
          mutants: [
            { file: "fixture.js", line: 1, form: "replace", replaceText: "x" },
          ],
          isolation: "inplace",
          expect: "fail",
          cwd: repo,
          logDir: logs,
        });
      },
    },
    {
      name: "plan_invalid: line required",
      status: "usage_error",
      reason: "plan_invalid",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo();
        return probePlan({
          mutants: [{ file: "fixture.js", form: "replace", replaceText: "x" }],
          testCommand: "true",
          isolation: "inplace",
          expect: "fail",
          cwd: repo,
          logDir: logs,
        });
      },
    },
    {
      name: "defaults_file_invalid (plan)",
      status: "usage_error",
      reason: "defaults_file_invalid",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo((dir) =>
          fs.writeFileSync(
            path.join(dir, ".agent-primitives.json"),
            "{ not json\n",
          ),
        );
        return probePlan({
          mutants: [
            { file: "fixture.js", line: 1, form: "replace", replaceText: "x" },
          ],
          testCommand: "true",
          isolation: "inplace",
          expect: "fail",
          cwd: repo,
          logDir: logs,
        });
      },
    },
    {
      name: "link_source_not_found (plan)",
      status: "usage_error",
      reason: "link_source_not_found",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo();
        return probePlan({
          mutants: [
            { file: "fixture.js", line: 1, form: "replace", replaceText: "x" },
          ],
          testCommand: "true",
          isolation: "inplace",
          expect: "fail",
          links: ["no-such-src"],
          cwd: repo,
          logDir: logs,
        });
      },
    },
    {
      name: "file_outside_root from the shared setup (plan)",
      status: "usage_error",
      reason: "file_outside_root",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ap-carry-out-"));
        tmpDirs.push(outside);
        const target = path.join(outside, "outside.js");
        fs.writeFileSync(target, "module.exports = true;\n");
        return probePlan({
          mutants: [
            { file: target, line: 1, form: "replace", replaceText: "x" },
          ],
          testCommand: "true",
          isolation: "inplace",
          expect: "fail",
          cwd: repo,
          logDir: logs,
        });
      },
    },
    {
      name: "file_outside_root via an unresolvable path (plan)",
      status: "usage_error",
      reason: "file_outside_root",
      prior: 0,
      needsUnrooted: true,
      run: async () => {
        const { repo, logs } = carryRepo((dir) =>
          fs.mkdirSync(path.join(dir, "closed")),
        );
        fs.chmodSync(path.join(repo, "closed"), 0o000);
        try {
          return await probePlan({
            mutants: [
              {
                file: "closed/two.js",
                line: 1,
                form: "replace",
                replaceText: "x",
              },
            ],
            testCommand: "true",
            isolation: "inplace",
            expect: "fail",
            cwd: repo,
            logDir: logs,
          });
        } finally {
          fs.chmodSync(path.join(repo, "closed"), 0o700);
        }
      },
    },
    {
      name: "patch_not_readable (plan)",
      status: "usage_error",
      reason: "patch_not_readable",
      prior: 0,
      run: () => {
        const { repo, logs } = carryRepo();
        return probePlan({
          mutants: [
            { file: "fixture.js", form: "patch", patchPath: "no-such.patch" },
          ],
          testCommand: "true",
          isolation: "inplace",
          expect: "fail",
          cwd: repo,
          logDir: logs,
        });
      },
    },
  ];

  for (const testCase of cases) {
    const declare = testCase.needsUnrooted && !unrootedOnly ? it.skip : it;
    declare(`refusal: ${testCase.name}`, async () => {
      const result = await testCase.run();
      expect(result.status).toBe(testCase.status);
      expect(result.reason).toBe(testCase.reason);
      // The refusal's own text is carried, and it is exactly the warning
      // the refusal appended: last, added once, with nothing before it
      // moved, dropped or doubled.
      expect(typeof result.refusal).toBe("string");
      expect(result.refusal).toBe(result.warnings[result.warnings.length - 1]);
      expect(result.warnings).toHaveLength(testCase.prior + 1);
      if (testCase.firstWarningIncludes !== undefined) {
        expect(result.warnings[0]).toContain(testCase.firstWarningIncludes);
      }
    });
  }
});
