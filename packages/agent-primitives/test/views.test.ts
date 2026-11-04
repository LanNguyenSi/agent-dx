import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PRINTABLE_FIELDS, parsePrintFields } from "../src/probe/summary.js";
import {
  DRIFT_PRINTABLE_FIELDS,
  HYGIENE_PRINTABLE_FIELDS,
  VERIFY_PRINTABLE_FIELDS,
  renderDriftSummary,
  renderHygieneSummary,
  renderVerifySummary,
} from "../src/views.js";
import type { DriftResult } from "../src/drift/index.js";
import type { HygieneResult } from "../src/hygiene/index.js";
import type { VerifyResult } from "../src/verify/types.js";
import { spawnCli } from "./helpers/spawn-cli.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-views-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

function initRepo(): string {
  const repo = makeTmpDir();
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  return repo;
}

function commit(repo: string, message: string): void {
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
}

/** A repo whose second commit adds one backup file: one `backup_file`
 * finding for `--base HEAD~1`. */
function hygieneRepo(): string {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  commit(repo, "base");
  fs.writeFileSync(path.join(repo, "notes.bak"), "x\n");
  commit(repo, "add backup");
  return repo;
}

/** A repo whose second commit renames `OldThing`, which the README still
 * mentions: one doc site for `--base HEAD~1 --head HEAD`. */
function driftRepo(): string {
  const repo = initRepo();
  fs.writeFileSync(
    path.join(repo, "README.md"),
    "# Readme\n\nOldThing is the entry point.\n",
  );
  fs.writeFileSync(path.join(repo, "old.ts"), "export const OldThing = 1;\n");
  commit(repo, "base");
  fs.writeFileSync(path.join(repo, "old.ts"), "export const NewThing = 1;\n");
  commit(repo, "rename");
  return repo;
}

const HYGIENE_ARGS = ["hygiene", "--base", "HEAD~1"];
const DRIFT_ARGS = ["drift", "--base", "HEAD~1", "--head", "HEAD"];
/** One passing and one failing check, both `-x`, selected with `-c`. */
const VERIFY_ARGS = [
  "verify",
  "-c",
  "good,bad",
  "-x",
  "good=node -e 0",
  "-x",
  "bad=node -e \"console.log('FAIL broken thing');process.exit(1)\"",
];

function verifyRepo(): string {
  const repo = makeTmpDir();
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "views-fixture", version: "0.0.0" }),
  );
  return repo;
}

type Case = {
  name: string;
  fields: readonly string[];
  args: string[];
  repo: () => string;
  /** Exit code of the fixture run, view or not. */
  exit: number;
  /** A dotted path of this command's result and its value in the fixture
   * run; `null` where the path does not resolve (array rows are not
   * addressable). */
  dotted: [path: string, value: unknown];
};
const CASES: Case[] = [
  {
    name: "hygiene",
    fields: HYGIENE_PRINTABLE_FIELDS,
    args: HYGIENE_ARGS,
    repo: hygieneRepo,
    exit: 1,
    dotted: ["counts.files", 1],
  },
  {
    name: "drift",
    fields: DRIFT_PRINTABLE_FIELDS,
    args: DRIFT_ARGS,
    repo: driftRepo,
    exit: 1,
    dotted: ["counts.sites", 1],
  },
  {
    name: "verify",
    fields: VERIFY_PRINTABLE_FIELDS,
    args: VERIFY_ARGS,
    repo: verifyRepo,
    exit: 1,
    dotted: ["checks.0.name", null],
  },
];

describe.each(CASES)(
  "$name --summary and --print (CLI)",
  { timeout: 60000 },
  (c) => {
    it("--summary prints a totals line, keeps the JSON run's exit code, and takes precedence over -f", async () => {
      const repo = c.repo();
      const logs = makeTmpDir();
      const json = await spawnCli(["-C", repo, "-l", logs, ...c.args]);
      expect(json.code).toBe(c.exit);
      for (const format of [[], ["-f", "text"]]) {
        const view = await spawnCli([
          "-C",
          repo,
          "-l",
          logs,
          ...format,
          ...c.args,
          "--summary",
        ]);
        expect(view.code).toBe(c.exit);
        const lines = view.stdout.trimEnd().split("\n");
        expect(lines.length).toBeGreaterThanOrEqual(2);
        expect(lines[lines.length - 1]).toMatch(
          new RegExp(`^totals: status=${JSON.parse(json.stdout).status}\\b`),
        );
        // Not the JSON envelope and not the `-f text` block.
        expect(view.stdout.startsWith("{")).toBe(false);
        expect(view.stdout).not.toContain("status: ");
      }
    });

    it("--print prints the named fields as one JSON line, exit code unchanged, null for a field the run did not produce", async () => {
      const repo = c.repo();
      const logs = makeTmpDir();
      const json = await spawnCli(["-C", repo, "-l", logs, ...c.args]);
      const envelope = JSON.parse(json.stdout);
      const view = await spawnCli([
        "-C",
        repo,
        "-l",
        logs,
        ...c.args,
        "--print",
        `status,command,${c.dotted[0]},fullResult`,
      ]);
      expect(view.code).toBe(c.exit);
      expect(view.stdout.trimEnd().split("\n")).toHaveLength(1);
      const printed = JSON.parse(view.stdout);
      expect(printed.status).toBe(envelope.status);
      expect(printed.command).toBe(c.name);
      // Array rows are not addressable: such a path prints null.
      expect(printed[c.dotted[0]]).toBe(c.dotted[1]);
      expect(Object.keys(printed)).toEqual([
        "status",
        "command",
        c.dotted[0],
        "fullResult",
      ]);
    });

    it("--print reads the unreduced result: a small -m does not shorten or cut a printed field", async () => {
      const repo = c.repo();
      const logs = makeTmpDir();
      const reduced = await spawnCli([
        "-C",
        repo,
        "-l",
        logs,
        "-m",
        "600",
        ...c.args,
      ]);
      expect(JSON.parse(reduced.stdout).truncated).toBe(true);
      const full = await spawnCli([
        "-C",
        repo,
        "-l",
        logs,
        "-m",
        "100000",
        ...c.args,
      ]);
      const key =
        c.name === "verify"
          ? "checks"
          : c.name === "drift"
            ? "sites"
            : "findings";
      const view = await spawnCli([
        "-C",
        repo,
        "-l",
        logs,
        "-m",
        "100000",
        ...c.args,
        "--print",
        key,
      ]);
      // Two runs: drop what differs between any two (timings, log paths).
      const stable = (value: unknown): unknown =>
        JSON.parse(
          JSON.stringify(value, (k, v) =>
            k === "durationMs" || k === "logPath" ? undefined : v,
          ),
        );
      expect(stable(JSON.parse(view.stdout)[key])).toEqual(
        stable(JSON.parse(full.stdout)[key]),
      );
      const small = await spawnCli([
        "-C",
        repo,
        "-l",
        logs,
        "-m",
        "600",
        ...c.args,
        "--print",
        key,
      ]);
      // Bounded only as printed text, never reduced inside: it still holds
      // the whole field up to the text bound.
      expect(small.stdout.length).toBeLessThanOrEqual(600);
      expect(small.code).toBe(c.exit);
    });

    it("--print logs names the saved full result of a reduced run, as the emitted envelope does", async () => {
      const repo = c.repo();
      const logs = makeTmpDir();
      const view = await spawnCli([
        "-C",
        repo,
        "-l",
        logs,
        "-m",
        "600",
        ...c.args,
        "--print",
        "logs",
      ]);
      const printed = JSON.parse(view.stdout);
      expect(
        (printed.logs as string[]).some((l) =>
          /result-full-\S+\.json$/.test(l),
        ),
      ).toBe(true);
    });

    it("every top-level field of the envelope, reduced or full, and of the saved full result is printable", async () => {
      const repo = c.repo();
      const logs = makeTmpDir();
      const keys = new Set<string>();
      for (const max of ["600", "100000"]) {
        const run = await spawnCli([
          "-C",
          repo,
          "-l",
          logs,
          "-m",
          max,
          ...c.args,
        ]);
        const envelope = JSON.parse(run.stdout);
        for (const key of Object.keys(envelope)) keys.add(key);
        const saved = (envelope.logs as string[]).find((l) =>
          /result-full-\S+\.json$/.test(l),
        );
        if (saved !== undefined) {
          const full = JSON.parse(fs.readFileSync(saved, "utf8"));
          for (const key of Object.keys(full)) keys.add(key);
        }
      }
      for (const key of [...keys].filter((k) => k !== "...")) {
        expect(c.fields).toContain(key);
      }
    });

    it("--summary together with --print is a usage error naming the command, exit 2, before anything runs", async () => {
      const repo = c.repo();
      const run = await spawnCli([
        "-C",
        repo,
        ...c.args,
        "--summary",
        "--print",
        "status",
      ]);
      expect(run.code).toBe(2);
      const parsed = JSON.parse(run.stdout);
      expect(parsed.status).toBe("usage_error");
      expect(parsed.message).toBe(
        `${c.name}: --summary and --print are mutually exclusive`,
      );
    });

    it("--print with an unknown field is a usage error listing this command's own fields", async () => {
      const repo = c.repo();
      const run = await spawnCli(["-C", repo, ...c.args, "--print", "nope"]);
      expect(run.code).toBe(2);
      const parsed = JSON.parse(run.stdout);
      expect(parsed.status).toBe("usage_error");
      expect(parsed.message).toContain('unknown field "nope"');
      expect(parsed.message).toContain(c.fields.join(", "));
    });
  },
);

describe("hygiene --summary", () => {
  it("prints one line per finding then the totals line", async () => {
    const repo = hygieneRepo();
    const run = await spawnCli(["-C", repo, ...HYGIENE_ARGS, "--summary"]);
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^backup_file \| notes\.bak \| /);
    expect(lines[1]).toBe(
      "totals: status=fail files=1 findings=1 backup_files=1 extend_only_rewrites=0 test_case_drops=0 warnings=0",
    );
  });

  it("a clean range prints only the totals line and exits 0", async () => {
    const repo = hygieneRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "hygiene",
      "--base",
      "HEAD",
      "--summary",
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout.trimEnd().split("\n")).toEqual([
      "totals: status=ok files=0 findings=0 backup_files=0 extend_only_rewrites=0 test_case_drops=0 warnings=0",
    ]);
  });
});

describe("drift --summary", () => {
  it("prints one line per site then the totals line", async () => {
    const repo = driftRepo();
    const run = await spawnCli(["-C", repo, ...DRIFT_ARGS, "--summary"]);
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines).toEqual([
      "README.md:3 | OldThing | doc | OldThing is the entry point.",
      "totals: status=fail removed=1 sites=1 allowlisted=0 warnings=0",
    ]);
  });
});

describe("a reduced run (small -m)", () => {
  it("drift --summary neither prints nor counts the envelope's own reduction and overrun notices", async () => {
    const repo = driftRepo();
    const json = await spawnCli(["-C", repo, "-m", "400", ...DRIFT_ARGS]);
    const warnings = JSON.parse(json.stdout).warnings as string[];
    // The fixture really produces both notices in the JSON view.
    expect(warnings.some((w) => w.startsWith("envelope is "))).toBe(true);
    expect(
      warnings.some((w) => w.startsWith("result reduced to the fixed fields")),
    ).toBe(true);
    const run = await spawnCli([
      "-C",
      repo,
      "-m",
      "400",
      ...DRIFT_ARGS,
      "--summary",
    ]);
    expect(run.code).toBe(1);
    expect(run.stdout).not.toContain("warning:");
    expect(run.stdout).not.toContain("requested max-chars");
    expect(run.stdout).not.toContain("fixed fields only");
    expect(run.stdout).toMatch(/ warnings=0 fullResult=\S+result-full-/);
  });

  it("drift --print truncated,warnings under a bound that reduces the envelope prints truncated: true beside the reduction warnings", async () => {
    const repo = driftRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "-m",
      "600",
      ...DRIFT_ARGS,
      "--print",
      "truncated,warnings",
    ]);
    const printed = JSON.parse(run.stdout);
    expect(printed.truncated).toBe(true);
    expect(
      (printed.warnings as string[]).some((w) => w.startsWith("envelope is ")),
    ).toBe(true);
  });
});

describe("drift --summary under --strict", () => {
  it("flags an allowlisted site that --strict reports in sites", async () => {
    const repo = driftRepo();
    const run = await spawnCli([
      "-C",
      repo,
      ...DRIFT_ARGS,
      "--allow",
      "README.md",
      "--strict",
      "--summary",
    ]);
    expect(run.stdout.trimEnd().split("\n")).toEqual([
      "README.md:3 | OldThing | doc | allowlisted | OldThing is the entry point.",
      "totals: status=fail removed=1 sites=1 allowlisted=1 warnings=0",
    ]);
    // Without --strict the allowlisted site is not a row.
    const plain = await spawnCli([
      "-C",
      repo,
      ...DRIFT_ARGS,
      "--allow",
      "README.md",
      "--summary",
    ]);
    expect(plain.stdout.trimEnd().split("\n")).toEqual([
      "totals: status=ok removed=1 sites=0 allowlisted=1 warnings=0",
    ]);
  });
});

describe("verify --summary and the -x without -c hint (CLI)", () => {
  it("prints one line per check with the first failure, then the totals line", async () => {
    const repo = verifyRepo();
    const run = await spawnCli(["-C", repo, ...VERIFY_ARGS, "--summary"]);
    expect(run.code).toBe(1);
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^good \| pass \| exit=0 \| \d+ms \| passed=1 /);
    expect(lines[1]).toMatch(/^bad \| fail \| exit=1 \| \d+ms \| /);
    expect(lines[1]).toContain("first failure: ");
    expect(lines[2]).toBe("warning: bad: detector_matched_nothing");
    expect(lines[3]).toMatch(
      /^totals: status=fail checks=2 pass=1 fail=1 skipped=0 error=0 totalDurationMs=\d+ warnings=1 fullResult=\S+result-full-\S+\.json$/,
    );
  });

  it("a skipped check shows its reason and the warnings print as warning: lines", async () => {
    const repo = verifyRepo();
    const run = await spawnCli([
      "-C",
      repo,
      "verify",
      "-c",
      "missing",
      "--summary",
    ]);
    expect(run.code).toBe(2);
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(
      /^missing \| skipped \| exit=- \| 0ms \| .* \| reason=no_script$/,
    );
    expect(lines[1]).toBe(
      "warning: missing: no_script: no -x override or matching package.json script; pass -c with the checks this repo has",
    );
  });

  it("--print truncated follows the max-failures marker of the emitted envelope", async () => {
    const repo = verifyRepo();
    // tsc-shaped lines: the tsc detector reports one failure per line, so
    // --max-failures 1 really caps the list.
    const noisy = `node -e "for (let i=0;i<5;i++) console.log('src/a.ts('+(i+1)+',1): error TS2322: bad '+i); process.exit(1)"`;
    const args = [
      "-C",
      repo,
      "verify",
      "-c",
      "typecheck",
      "-x",
      `typecheck=${noisy}`,
      "--max-failures",
      "1",
    ];
    const json = await spawnCli(args);
    const view = await spawnCli([...args, "--print", "truncated"]);
    expect(JSON.parse(json.stdout).truncated).toBe(true);
    expect(JSON.parse(view.stdout)).toEqual({ truncated: true });
    const uncapped = await spawnCli([
      ...args.slice(0, -2),
      "--print",
      "truncated",
    ]);
    expect(JSON.parse(uncapped.stdout)).toEqual({ truncated: false });
  });

  it("-x without -c puts the hint in warnings; -c or neither does not", async () => {
    const repo = verifyRepo();
    const withX = await spawnCli([
      "-C",
      repo,
      "verify",
      "-x",
      "a=node -e 0",
      "--print",
      "warnings",
    ]);
    const warnings = JSON.parse(withX.stdout).warnings as string[];
    expect(warnings[0]).toBe(
      "hint: -x given without -c: the default check list (build,typecheck,lint,test) still runs; pass -c <names> to choose the run set",
    );
    const withC = await spawnCli([
      "-C",
      repo,
      "verify",
      "-c",
      "a",
      "-x",
      "a=node -e 0",
      "--print",
      "warnings",
    ]);
    expect(JSON.parse(withC.stdout).warnings).toEqual([]);
    const withEmptyC = await spawnCli([
      "-C",
      repo,
      "verify",
      "-c",
      "",
      "-x",
      "a=node -e 0",
      "--print",
      "warnings",
    ]);
    expect(JSON.parse(withEmptyC.stdout).warnings).toEqual([]);
    const neither = await spawnCli([
      "-C",
      repo,
      "verify",
      "--print",
      "warnings",
    ]);
    expect(
      (JSON.parse(neither.stdout).warnings as string[]).some((w) =>
        w.startsWith("hint:"),
      ),
    ).toBe(false);
  });
});

describe("view renderers: -m bound", () => {
  const hygiene = (n: number): HygieneResult => ({
    status: "fail",
    base: "a",
    head: "b",
    baseSha: "a",
    headSha: "b",
    mergeBase: "a",
    maxDeletePercent: 20,
    extendOnly: [],
    findings: Array.from({ length: n }, (_, i) => ({
      kind: "backup_file" as const,
      path: `f${i}.bak`,
      detail: "leftover",
    })),
    counts: {
      files: n,
      backupFiles: n,
      extendOnlyRewrites: 0,
      testCaseDrops: 0,
    },
    warnings: [],
  });

  it("keeps the totals line, replaces the rows that do not fit with a marker naming the count, and names the full result when it fits", () => {
    const full = "/tmp/result-full-x.json";
    const out = renderHygieneSummary(hygiene(30), 600, full);
    expect(out.length).toBeLessThanOrEqual(600);
    const lines = out.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toMatch(
      /^totals: status=fail files=30 findings=30 /,
    );
    const marker = lines.find((l) => l.startsWith("... "));
    expect(marker).toMatch(
      /^\.\.\. \d+ more lines? omitted \(-m 600 characters\); raise -m or read the full result: \/tmp\/result-full-x\.json$/,
    );
    const kept = lines.filter((l) => l.startsWith("backup_file")).length;
    expect(marker).toContain(`... ${30 - kept} more lines`);
  });

  it("without a saved full result the marker says only to raise -m, and an unbounded -m prints every row", () => {
    const out = renderHygieneSummary(hygiene(30), 600);
    expect(out).toContain("; raise -m\n");
    expect(out).not.toContain("full result");
    const all = renderHygieneSummary(hygiene(30), Number.MAX_SAFE_INTEGER);
    expect(all.trimEnd().split("\n")).toHaveLength(31);
    expect(all).not.toContain("omitted");
  });

  it("drift and verify rows are bounded the same way, the totals line surviving even a tiny -m", () => {
    const drift: DriftResult = {
      status: "fail",
      base: "a",
      head: "b",
      baseSha: "a",
      headSha: "b",
      mergeBase: "a",
      removedIdentifiers: [],
      sites: Array.from({ length: 10 }, (_, i) => ({
        path: `d${i}.md`,
        line: i + 1,
        identifier: "Old",
        kind: "doc" as const,
        text: "Old is here",
      })),
      allowlisted: [],
      counts: { removed: 1, sites: 10, allowlisted: 0 },
      warnings: [],
    };
    const d = renderDriftSummary(drift, 50);
    expect(d.trimEnd().split("\n").pop()).toMatch(
      /^totals: status=fail removed=1 sites=10 /,
    );
    const verify: VerifyResult = {
      status: "fail",
      checks: Array.from({ length: 4 }, (_, i) => ({
        name: `c${i}`,
        status: "fail" as const,
        exitCode: 1,
        durationMs: 1,
        timedOut: false,
        summary: { passed: 0, failed: 1, skipped: 0, errors: 0, warnings: 0 },
        failures: [{ message: "boom" }],
      })),
      totalDurationMs: 4,
      warnings: [],
      logs: [],
      truncatedByMaxFailures: false,
    };
    const v = renderVerifySummary(verify, 50);
    expect(v.trimEnd().split("\n").pop()).toMatch(
      /^totals: status=fail checks=4 pass=0 fail=4 /,
    );
  });
});

describe("probe's own views are unchanged by the shared field-list parameter", () => {
  it("parsePrintFields defaults to probe's list, and an explicit list narrows it", () => {
    expect(parsePrintFields("status,mutation_probe.result")).toEqual(
      parsePrintFields("status,mutation_probe.result", PRINTABLE_FIELDS),
    );
    expect(() => parsePrintFields("findings")).toThrow(
      /unknown field "findings"/,
    );
    expect(parsePrintFields("findings", HYGIENE_PRINTABLE_FIELDS)).toEqual([
      "findings",
    ]);
    expect(() =>
      parsePrintFields("mutation_probe", HYGIENE_PRINTABLE_FIELDS),
    ).toThrow(/unknown field "mutation_probe".*known fields: tool, version/);
  });

  it("probe's field list does not include another command's fields", () => {
    for (const field of ["findings", "sites", "checks", "counts"]) {
      expect(PRINTABLE_FIELDS).not.toContain(field);
    }
  });
});
