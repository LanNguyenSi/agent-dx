import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readAsset } from "../src/assets.js";

const bundleGate = readAsset("skill/references/bundle-gate-in-ci.md");
const skillMd = readAsset("skill/SKILL.md");

// Collapse line wraps and indentation so a pin matches a whole sentence
// regardless of where the asset wraps it.
const unwrap = (text: string) => text.replace(/\s+/g, " ");

const pin = (doc: string, sentence: string) => {
  expect(unwrap(doc)).toContain(sentence);
};

/** The hand-off step of the SKILL.md orchestration sequence, alone. */
function handOffStep(): string {
  const start = skillMd.indexOf("6. **Hand off.**");
  expect(start, "hand-off step not found in SKILL.md").toBeGreaterThan(-1);
  const end = skillMd.indexOf("\n## ", start);
  return skillMd.slice(start, end === -1 ? undefined : end);
}

describe("bundle gate in CI reference", () => {
  it("is linked from the SKILL.md hand-off step", () => {
    pin(
      handOffStep(),
      "To catch drift between runs as well, gate the bundles in CI as described in [bundle gate in CI](references/bundle-gate-in-ci.md).",
    );
  });

  it("states the limit of what the gate proves", () => {
    pin(
      bundleGate,
      "The gate proves that a doc was re-stamped after its sources changed, not that its content is correct; review of the doc against its sources stays mandatory.",
    );
  });

  it("requires a full-history checkout and says why", () => {
    pin(
      bundleGate,
      "Check out the full history (`fetch-depth: 0` with `actions/checkout`): the `sources-fresh` rule dates each source by its last commit and asks whether the doc's own last commit re-stamped the doc, and a shallow clone cannot answer that, so it reports `staleness not assessable` notices instead of a STALE verdict.",
    );
    expect(bundleGate).toContain("fetch-depth: 0\n");
  });

  it("names the three rollout stages", () => {
    pin(
      bundleGate,
      "1. Stage 1, warn-only: run the check on every change, publish every finding as an annotation and in the job summary, and never fail the job on a finding.",
    );
    pin(
      bundleGate,
      "2. Stage 2, block on structure and staleness: fail the job on any error-severity finding (structure: frontmatter, links, sources shape) and on any `sources-fresh` or `sources-fresh-future` warning, selected from the `--json` report with a filter; other warnings stay advisory.",
    );
    pin(
      bundleGate,
      "3. Stage 3, strict: run the check with `--strict`, which fails on every warning from every rule.",
    );
    pin(
      bundleGate,
      "The exit code alone is not the signal for stage 1 or stage 2: `okf-kit check` exits 0 when it finds only warnings (STALE and FUTURE-DATED findings are warnings) and 1 when it finds an error, so read the JSON report to decide.",
    );
  });

  it("gives the pre-commit recipe with --dirty-as-now", () => {
    pin(
      bundleGate,
      "Run `okf-kit check <bundle> --repo-root <repoRoot> --dirty-as-now` before committing: it treats every uncommitted change as one virtual commit made now, so the local run reports the same `sources-fresh` and `sources-fresh-future` verdict CI will report once the commit lands.",
    );
  });

  it("covers every configured bundle with its own repo root", () => {
    pin(
      bundleGate,
      "Run one check per bundle and pass `--repo-root <repoRoot>` explicitly:",
    );
    expect(bundleGate).toContain('--repo-root "$REPO_ROOT"');
  });

  it("keeps the example free of a concrete pin and a hard-coded runner", () => {
    expect(bundleGate).toContain("okf-kit@<pinned-version>");
    expect(bundleGate).not.toMatch(/okf-kit@\d/);
    expect(bundleGate).not.toMatch(/actions\/checkout@v\d/);
    expect(bundleGate).toContain("runs-on: ${{ inputs.runner }}");
    expect(bundleGate).not.toMatch(/runs-on: (?!\$\{\{ inputs\.runner \}\})/);
  });
});

/** The `run: |` body of the example's bundle-check step, dedented. */
function exampleRunBody(): string {
  const lines = bundleGate.split("\n");
  const start = lines.findIndex((line) => /^ {8}run: \|$/.test(line));
  expect(start, "run: | block not found in the example").toBeGreaterThan(-1);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (
      line.startsWith("```") ||
      (line.trim() !== "" && !line.startsWith(" ".repeat(10)))
    ) {
      break;
    }
    body.push(line.slice(10));
  }
  return body.join("\n") + "\n";
}

/** The fenced `sh` block that follows a heading, alone. */
function shBlockAfter(marker: string): string {
  const at = bundleGate.indexOf(marker);
  expect(at, `${marker} not found`).toBeGreaterThan(-1);
  const open = bundleGate.indexOf("```sh\n", at);
  const close = bundleGate.indexOf("\n```", open + 6);
  return bundleGate.slice(open + 6, close);
}

describe("bundle gate in CI reference: could-not-run and report placement", () => {
  it("fails every stage when the checker could not run", () => {
    pin(
      bundleGate,
      "Any other outcome means the checker could not run: an exit status other than 0 or 1, or a report that does not parse. It fails the job at every stage, including stage 1.",
    );
  });

  it("keeps the exit-2 usage error apart from the other could-not-run causes", () => {
    pin(
      bundleGate,
      "The checker itself exits 2 whenever it cannot complete the check, for example on a usage error such as a missing bundle directory. The other could-not-run causes carry other statuses: a missing command exits 127 and is caught by the exit status check; a failed install exits 1 from the package runner (`npx`), the same status as a finding, and is caught only because it leaves no parseable report; a report that does not parse is caught by the report check when the status is 0 or 1 (any other status already failed the exit status check).",
    );
    expect(unwrap(bundleGate)).not.toMatch(
      /exit 2 for a usage error such as[^.]*(failed install|missing command)/,
    );
  });

  it("names jq as a prerequisite of the example", () => {
    pin(
      bundleGate,
      "the example below uses `jq`, so it needs `jq` on the runner;",
    );
  });

  it("describes the annotation escaping", () => {
    pin(
      bundleGate,
      "The annotation line escapes `%`, carriage return and line feed in the message, and additionally `:` and `,` in the `file` property, as the workflow command syntax requires, so a message with a line break stays one whole annotation.",
    );
  });

  it("describes the pre-commit cleanup and where the trap belongs", () => {
    pin(
      bundleGate,
      "The `trap` removes the temporary report when the hook exits, also when the check fails.",
    );
    pin(
      bundleGate,
      "Create the report and set the trap once, above the loop, and reuse the one file for every bundle: a trap set inside the loop is re-armed for the latest report only and leaves the earlier ones behind.",
    );
    pin(
      bundleGate,
      "The `trap` replaces an EXIT trap the hook already set; a hook that has one adds the `rm` to that trap instead.",
    );
  });

  it("states that the pre-commit loop carries the verdict without set -e", () => {
    pin(
      bundleGate,
      "The loop checks each exit status itself, as the CI example does, so the hook fails with the checker's verdict whether or not it runs under `set -e`: exit 2 when the checker exits with a status other than 0 or 1, exit 1 on a failing check, exit 2 when the bundle list is not made of whole `<bundle> <repoRoot>` pairs, and 0 otherwise. Reading the report belongs to the stage decision at the comment.",
    );
    pin(
      bundleGate,
      "The `set --` line replaces the hook's positional parameters with the bundle list; git passes a pre-commit hook none, and a hook that needs its own arguments saves them before the loop.",
    );
  });

  it("carries the pin as an environment value", () => {
    expect(bundleGate).toContain(
      "          OKF_KIT_VERSION: <pinned-version>\n",
    );
    expect(exampleRunBody()).toContain('"okf-kit@$OKF_KIT_VERSION"');
  });

  it("keeps the stage 2 filter of the prose and the example identical", () => {
    const standalone = shBlockAfter("The stage 2 selection");
    const filter = /jq '([^']*)'/.exec(standalone)?.[1];
    expect(filter, "stage 2 filter not found").toBeDefined();
    expect(unwrap(exampleRunBody())).toContain(unwrap(filter ?? "<none>"));
  });

  it("keeps ${{ }} expressions out of the run body", () => {
    expect(exampleRunBody()).not.toContain("${{");
  });

  it("writes the pre-commit report outside the work tree", () => {
    const recipe = shBlockAfter("### Pre-commit parity");
    expect(recipe).toContain('report="$(mktemp)"');
    expect(recipe).toContain('--dirty-as-now --json > "$report"');
    // mktemp and the trap sit above the per-bundle loop, not inside it.
    const loop = recipe.indexOf("while ");
    expect(loop, "per-bundle loop not found").toBeGreaterThan(-1);
    for (const line of [
      'report="$(mktemp)"',
      "trap 'rm -f \"$report\"' EXIT",
    ]) {
      expect(recipe.indexOf(line), line).toBeGreaterThan(-1);
      expect(recipe.indexOf(line), line).toBeLessThan(loop);
    }
    expect(recipe).not.toMatch(/> *report\.json/);
  });
});

/*
 * Execute the pre-commit recipe under bash and sh, each with and without -e,
 * against a stub okf-kit and a stub mktemp that creates its file in an empty
 * directory (the macOS mktemp ignores TMPDIR). The hook's exit status must
 * carry the checker's verdict without relying on set -e, and the temporary
 * report must be gone afterwards, with one and with two configured bundles.
 */
describe("bundle gate in CI pre-commit recipe: exit status and temp report cleanup", () => {
  let root: string;

  // The bundle lists the tests substitute for the recipe's own `set --` line.
  const bundleLists: Record<string, string> = {
    one: "set -- docs/okf .\n",
    two: "set -- docs/okf . docs/b sub\n",
    odd: "set -- docs/okf . docs/b\n",
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "bundle-gate-precommit-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "okf-kit"),
      `#!/bin/bash\nprintf '%s\\n' "$*" >> "$STUB_CHECK_LOG"\nprintf '%s' '{"findings":[]}'\nexit "\${STUB_EXIT:-0}"\n`,
    );
    chmodSync(join(bin, "okf-kit"), 0o755);
    writeFileSync(
      join(bin, "mktemp"),
      `#!/bin/bash\nf="$STUB_TMP/report.$$"\n: > "$f"\nprintf '%s\\n' "$f" >> "$STUB_MKTEMP_LOG"\nprintf '%s\\n' "$f"\n`,
    );
    chmodSync(join(bin, "mktemp"), 0o755);
    const recipe = shBlockAfter("### Pre-commit parity");
    expect(recipe).toContain(bundleLists.one);
    for (const [name, list] of Object.entries(bundleLists)) {
      writeFileSync(
        join(root, `hook-${name}.sh`),
        recipe.replace(bundleLists.one ?? "", list),
      );
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function runHook(shell: string, flags: string[], list: string, exit: number) {
    const temp = mkdtempSync(join(root, "tmp-"));
    const work = mkdtempSync(join(root, "work-"));
    const mktempLog = join(root, `${basename(work)}.mktemp.log`);
    const checkLog = join(root, `${basename(work)}.check.log`);
    const result = spawnSync(shell, [...flags, join(root, `hook-${list}.sh`)], {
      cwd: work,
      env: {
        PATH: `${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}`,
        HOME: work,
        STUB_TMP: temp,
        STUB_MKTEMP_LOG: mktempLog,
        STUB_CHECK_LOG: checkLog,
        STUB_EXIT: String(exit),
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    const read = (file: string) => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return "";
      }
    };
    return {
      result,
      mktemp: read(mktempLog),
      checked: read(checkLog).trim().split("\n").filter(Boolean),
      tempFiles: readdirSync(temp),
      workFiles: readdirSync(work),
    };
  }

  const shells: Array<[string, string[]]> = [
    ["bash", ["--noprofile", "--norc", "-eo", "pipefail"]],
    ["bash", ["--noprofile", "--norc"]],
    ["sh", ["-e"]],
    ["sh", []],
  ];
  // [bundle list, checker exit, hook exit, checks run]
  const outcomes: Array<[string, number, number, number]> = [
    ["one", 0, 0, 1],
    ["one", 1, 1, 1],
    ["one", 2, 2, 1],
    ["one", 127, 2, 1],
    ["two", 0, 0, 2],
    ["two", 1, 1, 1],
    ["two", 2, 2, 1],
    ["odd", 0, 2, 1],
  ];
  const cases = shells.flatMap(([shell, flags]) =>
    outcomes.map(
      ([list, exit, want, checks]) =>
        [
          `${shell} ${flags.join(" ")}`.trim(),
          list,
          exit,
          want,
          checks,
          shell,
          flags,
        ] as const,
    ),
  );

  it.each(cases)(
    "%s: bundle list %s, checker exit %i, hook exits %i after %i check(s) and leaves no temp file",
    (_label, list, exit, want, checks, shell, flags) => {
      const run = runHook(shell, [...flags], list, exit);
      const output = run.result.stdout + run.result.stderr;
      expect(run.result.status, output).toBe(want);
      // One report through mktemp for the whole loop, removed at exit.
      expect(run.mktemp).toMatch(/^[^\n]*report\.\d+\n$/);
      expect(run.checked).toHaveLength(checks);
      expect(run.checked[0]).toBe(
        "check docs/okf --repo-root . --dirty-as-now --json",
      );
      if (checks === 2) {
        expect(run.checked[1]).toBe(
          "check docs/b --repo-root sub --dirty-as-now --json",
        );
      }
      if (exit !== 0 && exit !== 1) {
        expect(run.result.stderr).toContain(
          `bundle check could not run for docs/okf (exit ${exit})`,
        );
      }
      if (list === "odd") {
        expect(run.result.stderr).toContain(
          "bundle list needs <bundle> <repoRoot> pairs",
        );
      }
      expect(run.tempFiles).toEqual([]);
      expect(run.workFiles).toEqual([]);
    },
  );
});

/*
 * Execute the example's run body under the shell GitHub Actions uses for
 * `shell: bash`, against a stub `npx` that prints a canned report and exits
 * like the checker: 1 on an error finding, 1 on a warning under --strict,
 * otherwise 0. STUB_FORCE_EXIT makes it print nothing and exit with that code.
 */
const stubNpx = `#!/bin/bash
printf '%s\\n' "$*" >> "$STUB_ARGS_LOG"
if [ -n "\${STUB_FORCE_EXIT:-}" ]; then
  printf '%s' "\${STUB_STDOUT:-}"
  exit "$STUB_FORCE_EXIT"
fi
cat "$STUB_REPORT"
strict=0
for arg in "$@"; do [ "$arg" = "--strict" ] && strict=1; done
if jq -e '[.findings[] | select(.severity == "error")] | length > 0' "$STUB_REPORT" > /dev/null; then exit 1; fi
if [ "$strict" = 1 ] && jq -e '[.findings[] | select(.severity == "warning")] | length > 0' "$STUB_REPORT" > /dev/null; then exit 1; fi
exit 0
`;

type Finding = {
  ruleId: string;
  severity: string;
  file: string;
  message: string;
};

const fixtures: Record<string, Finding[]> = {
  clean: [],
  stale: [
    {
      ruleId: "sources-fresh",
      severity: "warning",
      file: "a.md",
      message: "STALE: src/x.ts changed",
    },
  ],
  future: [
    {
      ruleId: "sources-fresh-future",
      severity: "warning",
      file: "a.md",
      message: "FUTURE-DATED: updated after head",
    },
  ],
  structural: [
    {
      ruleId: "frontmatter-present",
      severity: "error",
      file: "b.md",
      message: "no frontmatter",
    },
  ],
  advisory: [
    {
      ruleId: "citations-resolve",
      severity: "warning",
      file: "a.md",
      message: "cited file missing",
    },
  ],
  special: [
    {
      ruleId: "citations-resolve",
      severity: "warning",
      file: "c,d:e.md",
      message: "100% cited\r\nsecond line",
    },
  ],
};

describe("bundle gate in CI example: stage decisions", () => {
  let root: string;
  let bin: string;
  let step: string;

  // Resolved once, so a run with a reduced PATH still finds the shell.
  let bash = "bash";

  beforeAll(() => {
    bash = spawnSync("bash", ["-c", "command -v bash"], {
      encoding: "utf8",
    }).stdout.trim();
    root = mkdtempSync(join(tmpdir(), "bundle-gate-"));
    bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "npx"), stubNpx);
    chmodSync(join(bin, "npx"), 0o755);
    step = join(root, "step.sh");
    writeFileSync(step, exampleRunBody());
    for (const [name, findings] of Object.entries(fixtures)) {
      writeFileSync(
        join(root, `${name}.json`),
        JSON.stringify({ bundleDir: "docs/okf", findings, summary: {} }),
      );
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  let runCount = 0;
  function runStep(
    stage: string,
    stub: { report?: string; forceExit?: number; stdout?: string },
    path?: string,
  ) {
    runCount += 1;
    const dir = join(root, `run-${runCount}`);
    const work = join(dir, "work");
    const temp = join(dir, "temp");
    mkdirSync(work, { recursive: true });
    mkdirSync(temp);
    const summary = join(dir, "summary.md");
    writeFileSync(summary, "");
    const argsLog = join(dir, "args.log");
    const env: NodeJS.ProcessEnv = {
      PATH: path ?? `${bin}${delimiter}${process.env.PATH ?? ""}`,
      HOME: dir,
      OKF_KIT_VERSION: "9.9.9-test",
      BUNDLE: "docs/okf",
      REPO_ROOT: ".",
      STAGE: stage,
      RUNNER_TEMP: temp,
      GITHUB_STEP_SUMMARY: summary,
      STUB_ARGS_LOG: argsLog,
      STUB_REPORT: stub.report ? join(root, `${stub.report}.json`) : "",
      STUB_STDOUT: stub.stdout ?? "",
    };
    if (stub.forceExit !== undefined)
      env.STUB_FORCE_EXIT = String(stub.forceExit);
    const result = spawnSync(
      bash,
      ["--noprofile", "--norc", "-eo", "pipefail", step],
      {
        cwd: work,
        env,
        encoding: "utf8",
      },
    );
    let args = "";
    try {
      args = readFileSync(argsLog, "utf8");
    } catch {
      args = "";
    }
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      summary: readFileSync(summary, "utf8"),
      args,
      workFiles: readdirSync(work),
    };
  }

  const decisions: Array<[string, string, number]> = [
    ["clean", "warn", 0],
    ["clean", "block", 0],
    ["clean", "strict", 0],
    ["stale", "warn", 0],
    ["stale", "block", 1],
    ["stale", "strict", 1],
    ["future", "block", 1],
    ["structural", "warn", 0],
    ["structural", "block", 1],
    ["structural", "strict", 1],
    ["advisory", "warn", 0],
    ["advisory", "block", 0],
    ["advisory", "strict", 1],
  ];

  it.each(decisions)(
    "%s report at stage %s exits %i",
    (report, stage, expected) => {
      const run = runStep(stage, { report });
      expect(run.status, run.stdout + run.stderr).toBe(expected);
      expect(run.summary).toContain("### Bundle check: docs/okf");
      for (const finding of fixtures[report] ?? []) {
        expect(run.stdout).toContain(
          `::${finding.severity} file=docs/okf/${finding.file}::${finding.ruleId}: ${finding.message}`,
        );
        expect(run.summary).toContain(
          `- ${finding.severity} ${finding.ruleId} ${finding.file}:`,
        );
      }
    },
  );

  it("passes --strict only at stage 3 and takes the version from the environment", () => {
    expect(runStep("strict", { report: "clean" }).args).toMatch(
      /^-y okf-kit@9\.9\.9-test check docs\/okf --repo-root \. --json --strict$/m,
    );
    expect(runStep("block", { report: "clean" }).args).not.toContain(
      "--strict",
    );
  });

  const couldNotRun: Array<[number, string]> = [
    [2, "warn"],
    [2, "block"],
    [2, "strict"],
    [127, "warn"],
    [127, "block"],
    [127, "strict"],
  ];

  it.each(couldNotRun)("checker exit %i fails stage %s", (forceExit, stage) => {
    const run = runStep(stage, { forceExit });
    expect(run.status, run.stdout + run.stderr).toBe(2);
    expect(run.stdout).toContain(
      `bundle check could not run (exit ${forceExit})`,
    );
  });

  it.each([["warn"], ["block"], ["strict"]])(
    "an unparseable report fails stage %s even on exit 0",
    (stage) => {
      const run = runStep(stage, {
        forceExit: 0,
        stdout: "npm notice something\n",
      });
      expect(run.status, run.stdout + run.stderr).toBe(2);
      expect(run.stdout).toContain(
        "bundle check could not run (no parseable report)",
      );
    },
  );

  it.each([["warn"], ["block"], ["strict"]])(
    "a failed install (exit 1, empty report) fails stage %s",
    (stage) => {
      const run = runStep(stage, { forceExit: 1 });
      expect(run.status, run.stdout + run.stderr).toBe(2);
      expect(run.stdout).toContain(
        "bundle check could not run (no parseable report)",
      );
    },
  );

  it.each([["warn"], ["block"], ["strict"]])(
    "exit 2 fails stage %s even when a parseable report was printed",
    (stage) => {
      const report = JSON.stringify({
        bundleDir: "docs/okf",
        findings: [],
        summary: {},
      });
      const run = runStep(stage, { forceExit: 2, stdout: report });
      expect(run.status, run.stdout + run.stderr).toBe(2);
      expect(run.stdout).toContain("bundle check could not run (exit 2)");
    },
  );

  it("escapes %, CR and LF in the annotation message and the file property", () => {
    const run = runStep("warn", { report: "special" });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain(
      "::warning file=docs/okf/c%2Cd%3Ae.md::citations-resolve: 100%25 cited%0D%0Asecond line\n",
    );
  });

  it.each([["warn"], ["block"], ["strict"]])(
    "a runner without jq fails stage %s with its own message",
    (stage) => {
      const run = runStep(stage, { report: "clean" }, bin);
      expect(run.status, run.stdout + run.stderr).toBe(2);
      expect(run.stdout).toContain("bundle check could not run (jq not found)");
      expect(run.args).toBe("");
    },
  );

  it("an unknown stage fails the job", () => {
    const run = runStep("bogus", { report: "clean" });
    expect(run.status).toBe(2);
    expect(run.stdout).toContain("unknown stage: bogus");
  });

  it("writes the report outside the work tree", () => {
    expect(runStep("block", { report: "stale" }).workFiles).toEqual([]);
  });
});
