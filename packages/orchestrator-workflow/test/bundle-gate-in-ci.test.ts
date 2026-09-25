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
      "The checker itself exits 2 for a usage error such as a missing bundle directory. The other could-not-run causes carry other statuses: a missing command exits 127 and is caught by the exit status check; a failed install exits 1 from the package runner (`npx`), the same status as a finding, and is caught only because it leaves no parseable report; a report that does not parse is caught by the report check whatever the status.",
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
    expect(recipe).not.toMatch(/> *report\.json/);
  });
});

/*
 * Execute the pre-commit recipe under bash -eo pipefail against a stub
 * okf-kit and a stub mktemp that creates its file in an empty directory (the
 * macOS mktemp ignores TMPDIR), and check that the temporary report is gone
 * afterwards, on a clean check and on a failing one.
 */
describe("bundle gate in CI pre-commit recipe: temp report cleanup", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "bundle-gate-precommit-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "okf-kit"),
      `#!/bin/bash\nprintf '%s' '{"findings":[]}'\nexit "\${STUB_EXIT:-0}"\n`,
    );
    chmodSync(join(bin, "okf-kit"), 0o755);
    writeFileSync(
      join(bin, "mktemp"),
      `#!/bin/bash\nf="$STUB_TMP/report.$$"\n: > "$f"\nprintf '%s\\n' "$f" >> "$STUB_MKTEMP_LOG"\nprintf '%s\\n' "$f"\n`,
    );
    chmodSync(join(bin, "mktemp"), 0o755);
    writeFileSync(join(root, "hook.sh"), shBlockAfter("### Pre-commit parity"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    [0, 0],
    [1, 1],
  ])("checker exit %i: hook exits %i and leaves no temp file", (exit, want) => {
    const temp = mkdtempSync(join(root, "tmp-"));
    const work = mkdtempSync(join(root, "work-"));
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", join(root, "hook.sh")],
      {
        cwd: work,
        env: {
          PATH: `${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}`,
          HOME: work,
          STUB_TMP: temp,
          STUB_MKTEMP_LOG: join(work, "..", `${basename(work)}.mktemp.log`),
          STUB_EXIT: String(exit),
        },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(want);
    // The recipe did create its report through mktemp, and removed it.
    expect(
      readFileSync(join(work, "..", `${basename(work)}.mktemp.log`), "utf8"),
    ).toMatch(/report\.\d+\n$/);
    expect(readdirSync(temp)).toEqual([]);
    expect(readdirSync(work)).toEqual([]);
  });
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
