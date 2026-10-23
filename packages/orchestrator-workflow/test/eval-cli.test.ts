import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  judgeView,
  loadRunResults,
  main,
  parseLeakExclusion,
} from "../eval/cli.js";
import type { Io } from "../eval/cli.js";
import {
  KNOWN_SECRET_NAMES,
  isSandboxInjectedName,
} from "../eval/isolation.js";
import {
  FAKE_GUARD,
  guardBin,
  makeEntry,
  makeFixtureRepo,
  reviewerReturn,
  stubBin,
  writeDataset,
} from "./eval-helpers.js";
import type { FixtureRepo } from "./eval-helpers.js";

let repo: FixtureRepo;
let work: string;
let dataset: string;
let out: string;
let scratch: string;
let recordDir: string;
let home: string;

function io(
  extraEnv: Record<string, string> = {},
): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "sk-test-cli-key-value",
      AGENT_TASKS_TOKEN: "agent-tasks-secret-value",
      ...extraEnv,
    },
    // The fixture scratch lives under the system temp root; production refuses that.
    tempRoots: [],
    // Likewise its path is longer than a production scratch tmp path may be.
    maxTmpPath: Infinity,
  };
}

/** The stub as the claude binary, with these STUB_* settings. */
function claude(
  vars: Record<string, string> = {},
  records = recordDir,
): string {
  return stubBin(work, {
    STUB_RECORD_DIR: records,
    STUB_FUTURE_SHA: repo.futureSha,
    ...vars,
  });
}

function textFile(name: string, text: string): string {
  const file = join(work, name);
  writeFileSync(file, text);
  return file;
}

function promptFile(name: string, body: string): string {
  return textFile(
    name,
    `---\nname: reviewer\ndescription: "Variant ${name}."\n---\n\n${body}\n`,
  );
}

function calls(dir = recordDir): Record<string, any>[] {
  return readdirSync(dir)
    .filter((f) => f.startsWith("call-"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

beforeAll(() => {
  repo = makeFixtureRepo();
  work = realpathSync(mkdtempSync(join(tmpdir(), "ow-eval-cli-")));
  dataset = join(work, "data", "dataset");
  out = join(work, "out");
  scratch = join(work, "scratch");
  recordDir = join(work, "rec");
  home = join(work, "home");
  mkdirSync(recordDir, { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_ed25519"), "not a real key\n");
  writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
  writeDataset(dataset, [
    makeEntry(repo, { id: "entry-a" }),
    makeEntry(repo, { id: "entry-c", kind: "control", known_findings: [] }),
    makeEntry(repo, { id: "entry-h", leak: "high" }),
  ]);
});

afterAll(() => {
  rmSync(repo.dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const common = (): string[] => ["--dataset", dataset, "--out", out];
const guard = ["--guard", FAKE_GUARD];

describe("evaluation CLI", { timeout: 120_000 }, () => {
  it("validates the dataset and refuses a broken one", async () => {
    const ok = io();
    expect(await main(["validate-dataset", "--dataset", dataset], ok)).toBe(0);
    expect(ok.lines[0]).toBe("dataset ok: 3 entries (2 finding, 1 control)");

    const bad = io();
    expect(
      await main(["validate-dataset", "--dataset", join(work, "nope")], bad),
    ).toBe(1);
    expect(bad.errors[0]).toContain("index.json not found");
  });

  it("prints usage for an unknown command and reports a bad option as an error", async () => {
    const a = io();
    expect(await main(["bogus"], a)).toBe(2);
    expect(a.errors[0]).toContain("Usage: eval");
    expect(a.errors[0]).toContain("canary");
    const b = io();
    expect(await main(["run", "--unknown-flag"], b)).toBe(2);
    const c = io();
    expect(await main(["run", "--keep-home"], c)).toBe(2);
  });

  it("refuses to run without an API key in either mode, and with a bad kind or filter", async () => {
    const alpha = promptFile("alpha.md", "Alpha body.");
    const base = [
      "run",
      ...common(),
      "--variant",
      `file:${alpha}`,
      "--claude",
      claude(),
      ...guard,
      "--scratch",
      scratch,
    ];
    for (const extra of [[], ["--no-bare"]]) {
      const noKey = io();
      delete noKey.env.ANTHROPIC_API_KEY;
      expect(await main([...base, ...extra], noKey)).toBe(2);
      expect(noKey.errors[0]).toContain("ANTHROPIC_API_KEY is not set");
    }

    const badKind = io();
    expect(await main([...base, "--kind", "weird"], badKind)).toBe(2);
    const none = io();
    expect(await main([...base, "--only", "missing-id"], none)).toBe(2);
    expect(none.errors[0]).toContain("no dataset entry matches");
  });

  it("refuses an --out or --scratch inside the dataset's parent tree, and a scratch inside the home", async () => {
    const alpha = promptFile("alpha.md", "Alpha body.");
    const run = (outDir: string, scratchDir: string, env = io()) =>
      main(
        [
          "run",
          "--dataset",
          dataset,
          "--out",
          outDir,
          "--variant",
          `file:${alpha}`,
          "--claude",
          claude(),
          ...guard,
          "--scratch",
          scratchDir,
        ],
        env,
      ).then((code) => ({ code, env }));
    const insideOut = await run(join(work, "data", "results"), scratch);
    expect(insideOut.code).toBe(2);
    expect(insideOut.env.errors[0]).toContain("--out");
    expect(insideOut.env.errors[0]).toContain("dataset's parent directory");
    const insideScratch = await run(out, join(dataset, "scratch"));
    expect(insideScratch.code).toBe(2);
    expect(insideScratch.env.errors[0]).toContain("--scratch");
    const inHome = await run(out, join(home, "scratch"), io({ HOME: home }));
    expect(inHome.code).toBe(2);
    expect(inHome.env.errors[0]).toContain("inside the home directory");
    const inOut = await run(out, join(out, "scratch"));
    expect(inOut.code).toBe(2);
    expect(inOut.env.errors[0]).toContain("inside --out");
  });

  it("refuses a --scratch inside a temp root, with the reason", async () => {
    const alpha = promptFile("alpha.md", "Alpha body.");
    const env = { ...io(), tempRoots: [work] };
    const code = await main(
      [
        "run",
        ...common(),
        "--variant",
        `file:${alpha}`,
        "--claude",
        claude(),
        ...guard,
        "--scratch",
        join(work, "elsewhere"),
      ],
      env,
    );
    expect(code).toBe(2);
    expect(env.errors[0]).toContain("--scratch");
    expect(env.errors[0]).toContain("inside a temp root");
    expect(env.errors[0]).toContain("own checkout");
    expect(existsSync(join(work, "elsewhere"))).toBe(false);
  });

  it("refuses a --scratch whose tmp path exceeds the limit, naming the fallback", async () => {
    const alpha = promptFile("alpha.md", "Alpha body.");
    const env = { ...io(), maxTmpPath: undefined };
    const longRoot = join(work, "a-scratch-directory-with-a-rather-long-name");
    const code = await main(
      [
        "run",
        ...common(),
        "--variant",
        `file:${alpha}`,
        "--claude",
        claude(),
        ...guard,
        "--scratch",
        longRoot,
      ],
      env,
    );
    expect(code).toBe(2);
    expect(env.errors[0]).toContain("too long");
    expect(env.errors[0]).toContain("/tmp/claude-<uid>");
    expect(existsSync(longRoot)).toBe(false);
  });

  it("refuses a --scratch that is a symlink or that others can write, before any session", async () => {
    const records = mkdtempSync(join(work, "rec-owner-"));
    const freshOut = mkdtempSync(join(work, "out-owner-"));
    const real = join(work, "owned-scratch");
    mkdirSync(real, { mode: 0o700 });
    const link = join(work, "linked-scratch");
    symlinkSync(real, link);
    const open = join(work, "open-scratch");
    mkdirSync(open);
    chmodSync(open, 0o777);
    for (const [dir, reason] of [
      [link, "symbolic link"],
      [open, "group or others"],
    ]) {
      const env = io();
      const code = await main(
        [
          "canary",
          "--dataset",
          dataset,
          "--out",
          freshOut,
          "--claude",
          claude({}, records),
          ...guard,
          "--scratch",
          dir,
        ],
        env,
      );
      expect(code, dir).toBe(2);
      expect(env.errors[0], dir).toContain(reason);
    }
    expect(calls(records)).toEqual([]);
    expect(readdirSync(open)).toEqual([]);
    // The refusal comes before any work: no canary record directory under --out.
    expect(existsSync(join(freshOut, "canary"))).toBe(false);
  });

  it("requires --scratch where the host has no default, and uses the default where it has one", async () => {
    const alpha = promptFile("alpha.md", "Alpha body.");
    const args = (): string[] => [
      "canary",
      ...common(),
      "--claude",
      claude(),
      ...guard,
    ];
    const none = { ...io(), defaultScratch: null };
    expect(await main(args(), none)).toBe(2);
    expect(none.errors[0]).toContain("--scratch is required");

    // With a default and no flag, the sessions' directories are created under it.
    const records = join(work, "rec-default");
    mkdirSync(records, { recursive: true });
    const withDefault = { ...io(), defaultScratch: join(work, "default-root") };
    await main(
      [
        "run",
        "--dataset",
        dataset,
        "--out",
        join(work, "out-default"),
        "--variant",
        `file:${alpha}`,
        "--claude",
        claude(
          { STUB_FINAL_TEXT_FILE: textFile("clean-d.txt", reviewerReturn()) },
          records,
        ),
        ...guard,
        "--only",
        "entry-c",
      ],
      withDefault,
    );
    const session = calls(records).at(-1)!;
    expect(
      session.env.TMPDIR.startsWith(join(work, "default-root") + "/"),
    ).toBe(true);
    expect(session.env.CLAUDE_CODE_TMPDIR).toBe(session.env.TMPDIR);
  });

  it("runs, judges, scores and compares two variants", async () => {
    const alpha = promptFile("alpha.md", "Alpha body.");
    const beta = promptFile("beta.md", "Beta body.");
    const withFinding = textFile(
      "with-finding.txt",
      reviewerReturn([{ severity: "medium" }]),
    );
    const clean = textFile("clean.txt", reviewerReturn());
    const runArgs = (
      variant: string,
      repeat: string,
      text: string,
    ): string[] => [
      "run",
      ...common(),
      "--variant",
      `file:${variant}`,
      "--repeat",
      repeat,
      "--claude",
      claude({ STUB_FINAL_TEXT_FILE: text }),
      ...guard,
      "--scratch",
      scratch,
      "--budget-usd",
      "3",
      "--only",
      "entry-a,entry-c",
    ];

    const runA = io();
    expect(await main(runArgs(alpha, "2", withFinding), runA)).toBe(0);
    expect(runA.lines[0]).toContain("variant alpha");
    expect(runA.lines[0]).toContain("2 entries x 2 repeat = 4 sessions");
    expect(runA.lines.at(-1)).toContain("4 completed, 0 not completed");

    const results = loadRunResults(out, "alpha");
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.result.check.valid)).toBe(true);
    expect(existsSync(join(out, "alpha", "variant-prompt.md"))).toBe(true);
    expect(readFileSync(join(out, "alpha", "variant.json"), "utf8")).toContain(
      '"id": "alpha"',
    );

    // A judge answer that is not valid json: the runs stay unjudged and the command fails.
    const garbage = textFile("judge-garbage.txt", "I cannot say.");
    const failedJudge = io();
    expect(
      await main(
        [
          "judge",
          ...common(),
          "--claude",
          claude({ STUB_JUDGE_TEXT_FILE: garbage }),
          ...guard,
          "--attempts",
          "1",
        ],
        failedJudge,
      ),
    ).toBe(1);
    expect(failedJudge.errors[0]).toContain("judgment failed");
    const alphaDir = results.find((r) => r.result.entry_id === "entry-a")!.dir;
    expect(existsSync(join(alphaDir, "judge.json"))).toBe(false);
    expect(existsSync(join(alphaDir, "judge-error.json"))).toBe(true);

    const yes = textFile(
      "judge-yes.txt",
      '```json\n{"matches":[{"id":"K1","matched":true,"evidence":"first finding"}]}\n```',
    );
    const judgeA = io();
    expect(
      await main(
        [
          "judge",
          ...common(),
          "--claude",
          claude({ STUB_JUDGE_TEXT_FILE: yes }),
          ...guard,
        ],
        judgeA,
      ),
    ).toBe(0);
    expect(judgeA.lines[0]).toBe("judged 2 run(s), 0 failed");
    expect(existsSync(join(alphaDir, "judge-error.json"))).toBe(false);

    // The judge sees the rubric, the known defects and the review, and nothing that names a variant.
    const judgeCalls = calls().filter((c) => c.agents === null);
    expect(judgeCalls.length).toBeGreaterThan(0);
    for (const c of judgeCalls) {
      expect(c.stdin).toContain("Known defects");
      expect(c.stdin).not.toMatch(/alpha|beta|entry-a|entry-c/);
      expect(c.cwd).not.toContain(out);
      expect(c.argv).toContain("--tools");
      expect(c.argv[c.argv.indexOf("--effort") + 1]).toBe("high");
      expect(c.argv[c.argv.indexOf("--permission-prompts") + 1]).toBe("none");
      // No user, project or local settings file; the --settings JSON still applies.
      expect(c.argv[c.argv.indexOf("--setting-sources") + 1]).toBe("");
      expect(c.argv[c.argv.indexOf("--settings") + 1]).toBe(
        '{"crossSessionInbound":"refuse"}',
      );
    }
    const judgeFile = JSON.parse(
      readFileSync(join(alphaDir, "judge.json"), "utf8"),
    );
    expect(judgeFile).toMatchObject({
      model: "sonnet",
      effort: "high",
      cli_version: "9.9.9 (Stub Code)",
    });

    const runB = io();
    expect(await main(runArgs(beta, "1", clean), runB)).toBe(0);
    const no = textFile(
      "judge-no.txt",
      '```json\n{"matches":[{"id":"K1","matched":false,"evidence":"not reported"}]}\n```',
    );
    const judgeB = io();
    expect(
      await main(
        [
          "judge",
          ...common(),
          "--claude",
          claude({ STUB_JUDGE_TEXT_FILE: no }),
          ...guard,
        ],
        judgeB,
      ),
    ).toBe(0);
    expect(judgeB.lines[0]).toBe("judged 1 run(s), 0 failed");

    const score = io();
    expect(await main(["score", ...common()], score)).toBe(0);
    const table = score.lines.join("\n");
    expect(table).toContain(
      "Primary score: entries tagged leak high are left out",
    );
    expect(table).toContain(
      "| alpha | 4 | 4 | 0 | 0 | 2 | 2 | 100.0% | 100.0% (n=1) |",
    );
    expect(table).toContain(
      "| beta | 2 | 2 | 0 | 0 | 2 | 1 | 100.0% | 0.0% (n=1) |",
    );
    expect(table).toContain("alpha noise over 2 repeats");
    const scores = JSON.parse(readFileSync(join(out, "scores.json"), "utf8"));
    expect(scores.exclude_leak).toEqual(["high"]);
    expect(scores.primary.map((r: any) => r.aggregate.variant_id)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(scores.primary[0].aggregate.false_positives).toBe(2);
    expect(scores.primary[1].aggregate.false_positives).toBe(0);

    const compare = io();
    expect(
      await main(
        ["compare", ...common(), "--a", "alpha", "--b", "beta"],
        compare,
      ),
    ).toBe(0);
    const text = compare.lines.join("\n");
    // Same reviewer and judge settings on both sides: no warning.
    expect(compare.errors).toEqual([]);
    expect(text).toContain("| recall | 100.0% | 0.0% | -100.0% |");
    // One finding entry: a full flip is one entry's worth, which the default floor holds.
    expect(text).toContain("within noise (n=1, A 2 repeat(s), B 1 repeat(s))");
    expect(existsSync(join(out, "compare-alpha-vs-beta.json"))).toBe(true);

    const noFloor = io();
    expect(
      await main(
        [
          "compare",
          ...common(),
          "--a",
          "alpha",
          "--b",
          "beta",
          "--noise-floor",
          "0",
        ],
        noFloor,
      ),
    ).toBe(0);
    expect(noFloor.lines.join("\n")).toContain(
      "above noise (n=1, A 2 repeat(s), B 1 repeat(s))",
    );

    const missing = io();
    expect(
      await main(
        ["compare", ...common(), "--a", "alpha", "--b", "gamma"],
        missing,
      ),
    ).toBe(2);
    expect(missing.errors[0]).toContain("gamma");
  });

  it("warns when the compared variants differ in judge or reviewer settings or CLI version", async () => {
    const provOut = join(work, "prov-out");
    const finding = textFile(
      "prov-finding.txt",
      reviewerReturn([{ severity: "medium" }]),
    );
    const yes = textFile(
      "prov-judge.txt",
      '```json\n{"matches":[{"id":"K1","matched":true,"evidence":"found"}]}\n```',
    );
    const step = async (
      variant: string,
      reviewer: string[],
      judge: string[],
      version: string,
    ): Promise<void> => {
      const bin = claude({
        STUB_FINAL_TEXT_FILE: finding,
        STUB_JUDGE_TEXT_FILE: yes,
        STUB_VERSION: version,
      });
      const base = [
        "--dataset",
        dataset,
        "--out",
        provOut,
        "--claude",
        bin,
        ...guard,
      ];
      expect(
        await main(
          [
            "run",
            ...base,
            "--variant",
            `file:${promptFile(`${variant}.md`, variant)}`,
            "--scratch",
            scratch,
            "--only",
            "entry-a",
            ...reviewer,
          ],
          io(),
        ),
      ).toBe(0);
      expect(await main(["judge", ...base, ...judge], io())).toBe(0);
    };
    await step("pone", [], [], "1.0.0");
    await step(
      "ptwo",
      ["--effort", "medium", "--model", "sonnet"],
      ["--judge-effort", "low", "--judge-model", "opus"],
      "2.0.0",
    );
    const [two] = loadRunResults(provOut, "ptwo");
    expect(two.result.cli_version).toBe("2.0.0");
    expect(two.result.model).toBe("sonnet");
    expect(
      JSON.parse(readFileSync(join(two.dir, "judge.json"), "utf8")),
    ).toMatchObject({ model: "opus", effort: "low", cli_version: "2.0.0" });

    const compare = io();
    expect(
      await main(
        [
          "compare",
          "--dataset",
          dataset,
          "--out",
          provOut,
          "--a",
          "pone",
          "--b",
          "ptwo",
        ],
        compare,
      ),
    ).toBe(0);
    const warnings = compare.errors.join("\n");
    for (const label of [
      "judge model (pone: sonnet; ptwo: opus)",
      "judge effort (pone: high; ptwo: low)",
      "judge CLI version (pone: 1.0.0; ptwo: 2.0.0)",
      "reviewer model (pone: opus; ptwo: sonnet)",
      "reviewer effort (pone: high; ptwo: medium)",
      "reviewer CLI version (pone: 1.0.0; ptwo: 2.0.0)",
    ]) {
      expect(warnings).toContain(`warning: pone and ptwo differ in ${label}`);
    }
    expect(compare.errors).toHaveLength(6);
    const saved = JSON.parse(
      readFileSync(join(provOut, "compare-pone-vs-ptwo.json"), "utf8"),
    );
    expect(saved.warnings).toHaveLength(6);
  });

  it("reports high-leak entries apart from the primary score, unless told to keep them", async () => {
    const leaky = promptFile("leaky.md", "Leaky body.");
    const withFinding = textFile(
      "leak-finding.txt",
      reviewerReturn([{ severity: "medium" }]),
    );
    const leakOut = join(work, "leak-out");
    const args = (more: string[]) => [
      "--dataset",
      dataset,
      "--out",
      leakOut,
      ...more,
    ];
    expect(
      await main(
        [
          "run",
          ...args([
            "--variant",
            `file:${leaky}`,
            "--claude",
            claude({ STUB_FINAL_TEXT_FILE: withFinding }),
            ...guard,
            "--scratch",
            scratch,
          ]),
        ],
        io(),
      ),
    ).toBe(0);
    const yes = textFile(
      "leak-judge.txt",
      '```json\n{"matches":[{"id":"K1","matched":true,"evidence":"found"}]}\n```',
    );
    expect(
      await main(
        [
          "judge",
          ...args([
            "--claude",
            claude({ STUB_JUDGE_TEXT_FILE: yes }),
            ...guard,
          ]),
        ],
        io(),
      ),
    ).toBe(0);

    const primary = io();
    expect(await main(["score", ...args([])], primary)).toBe(0);
    const scores = JSON.parse(
      readFileSync(join(leakOut, "scores.json"), "utf8"),
    );
    const ids = (rows: any[]) =>
      [
        ...new Set(
          rows.flatMap((r: any) => r.scores.map((s: any) => s.entry_id)),
        ),
      ].sort();
    expect(ids(scores.primary)).toEqual(["entry-a", "entry-c"]);
    expect(ids(scores.excluded)).toEqual(["entry-h"]);
    expect(primary.lines.join("\n")).toContain(
      "Entries tagged leak high only:",
    );

    const all = io();
    expect(
      await main(["score", ...args(["--exclude-leak", "none"])], all),
    ).toBe(0);
    const allScores = JSON.parse(
      readFileSync(join(leakOut, "scores.json"), "utf8"),
    );
    expect(ids(allScores.primary)).toEqual(["entry-a", "entry-c", "entry-h"]);
    expect(allScores.excluded).toEqual([]);
    expect(all.lines[0]).toBe("All entries.");

    const bad = io();
    expect(
      await main(["score", ...args(["--exclude-leak", "huge"])], bad),
    ).toBe(2);
    expect(bad.errors[0]).toContain("--exclude-leak");

    const compare = io();
    expect(
      await main(
        ["compare", ...args(["--a", "leaky", "--b", "leaky"])],
        compare,
      ),
    ).toBe(0);
    expect(compare.lines.join("\n")).toContain(
      "Entries tagged leak high only:",
    );
  });

  it("keeps the judge blind to run paths, ids and the dataset, and gives it no MCP server even without --bare", async () => {
    const blindOut = join(work, "blind-out");
    const blindRecords = mkdtempSync(join(work, "rec-blind-"));
    const quoted = textFile(
      "quoting.txt",
      `${reviewerReturn([{ severity: "medium", description: "see @@CWD@@/a.txt" }])}\nNotes in ${blindOut}/gamma/entry-a/run-1 and ${dataset}; entry entry-a.`,
    );
    const gamma = promptFile("gamma.md", "Gamma body.");
    expect(
      await main(
        [
          "run",
          "--dataset",
          dataset,
          "--out",
          blindOut,
          "--variant",
          `file:${gamma}`,
          "--claude",
          claude({ STUB_FINAL_TEXT_FILE: quoted }, blindRecords),
          ...guard,
          "--scratch",
          scratch,
          "--only",
          "entry-a",
        ],
        io(),
      ),
    ).toBe(0);
    const [{ result }] = loadRunResults(blindOut, "gamma");
    expect(result.final_text).toContain(result.paths.worktree);

    const yes = textFile(
      "blind-judge.txt",
      '```json\n{"matches":[{"id":"K1","matched":true,"evidence":"found"}]}\n```',
    );
    expect(
      await main(
        [
          "judge",
          "--dataset",
          dataset,
          "--out",
          blindOut,
          "--claude",
          claude({ STUB_JUDGE_TEXT_FILE: yes }, blindRecords),
          ...guard,
          "--no-bare",
        ],
        io(),
      ),
    ).toBe(0);
    const judge = calls(blindRecords).find((c) => c.agents === null)!;
    for (const forbidden of [
      "gamma",
      "entry-a",
      "-control",
      blindOut,
      dataset,
      join(work, "data"),
      result.paths.worktree,
      result.paths.evidence,
      scratch,
    ]) {
      expect(judge.stdin, forbidden).not.toContain(forbidden);
    }
    expect(judge.stdin).toContain("<worktree>/a.txt");
    expect(judge.stdin).toContain("<results>");
    expect(judge.argv).not.toContain("--bare");
    expect(judge.argv).toContain("--strict-mcp-config");
    expect(judge.argv[judge.argv.indexOf("--mcp-config") + 1]).toBe(
      '{"mcpServers":{}}',
    );
    expect(judge.argv[judge.argv.indexOf("--tools") + 1]).toBe("");
    // Without --bare as well, no settings file of the scratch home or the cwd is loaded.
    expect(judge.argv[judge.argv.indexOf("--setting-sources") + 1]).toBe("");
  });

  it("hands the judge the key from --api-key-env as ANTHROPIC_API_KEY", async () => {
    const keyOut = join(work, "key-out");
    const keyRecords = mkdtempSync(join(work, "rec-key-"));
    const delta = promptFile("delta.md", "Delta body.");
    const finding = textFile(
      "key-finding.txt",
      reviewerReturn([{ severity: "medium" }]),
    );
    const env = io({ OTHER_KEY: "sk-other-key-value" });
    delete env.env.ANTHROPIC_API_KEY;
    expect(
      await main(
        [
          "run",
          "--dataset",
          dataset,
          "--out",
          keyOut,
          "--variant",
          `file:${delta}`,
          "--claude",
          claude({ STUB_FINAL_TEXT_FILE: finding }, keyRecords),
          ...guard,
          "--scratch",
          scratch,
          "--only",
          "entry-a",
          "--api-key-env",
          "OTHER_KEY",
        ],
        env,
      ),
    ).toBe(0);
    const yes = textFile(
      "key-judge.txt",
      '```json\n{"matches":[{"id":"K1","matched":true,"evidence":"found"}]}\n```',
    );
    expect(
      await main(
        [
          "judge",
          "--dataset",
          dataset,
          "--out",
          keyOut,
          "--claude",
          claude({ STUB_JUDGE_TEXT_FILE: yes }, keyRecords),
          ...guard,
          "--api-key-env",
          "OTHER_KEY",
        ],
        env,
      ),
    ).toBe(0);
    const all = calls(keyRecords);
    const judge = all.find((c) => c.agents === null)!;
    const session = all.find((c) => c.agents !== null)!;
    for (const c of [judge, session]) {
      expect(c.env.ANTHROPIC_API_KEY).toBe("sk-other-key-value");
      expect(c.envNames).not.toContain("OTHER_KEY");
      expect(c.envNames).not.toContain("AGENT_TASKS_TOKEN");
    }
  });

  it("runs sessions in parallel with --jobs and still writes every record", async () => {
    const delta = promptFile("delta2.md", "Delta body.");
    const finalText = textFile("par.txt", reviewerReturn());
    const parallelRecords = join(work, "rec-parallel");
    mkdirSync(parallelRecords);
    const r = io();
    const code = await main(
      [
        "run",
        ...common(),
        "--variant",
        `file:${delta}`,
        "--claude",
        claude(
          { STUB_FINAL_TEXT_FILE: finalText, STUB_DELAY_MS: "2500" },
          parallelRecords,
        ),
        ...guard,
        "--scratch",
        scratch,
        "--repeat",
        "2",
        "--jobs",
        "4",
        "--only",
        "entry-a,entry-c",
      ],
      r,
    );
    expect(code).toBe(0);
    expect(r.lines.at(-1)).toContain("4 completed, 0 not completed");
    expect(loadRunResults(out, "delta2")).toHaveLength(4);
    const spans = calls(parallelRecords).map((c) => [
      c.startedAt as number,
      c.endedAt as number,
    ]);
    expect(spans).toHaveLength(4);
    // One at a time, no two sessions would overlap; with four workers several do.
    const overlapping = spans.filter(([start, end], i) =>
      spans.some(([s2, e2], k) => k !== i && s2 < end && start < e2),
    );
    expect(overlapping.length).toBeGreaterThanOrEqual(2);
    const bad = io();
    expect(
      await main(
        [
          "run",
          ...common(),
          "--variant",
          `file:${delta}`,
          "--scratch",
          scratch,
          "--jobs",
          "0",
        ],
        bad,
      ),
    ).toBe(2);
  });

  it("refuses to reuse a variant id for a different prompt", async () => {
    const changed = promptFile("alpha.md", "Alpha body, edited.");
    const r = io();
    const code = await main(
      [
        "run",
        ...common(),
        "--variant",
        `file:${changed}`,
        "--claude",
        claude(),
        ...guard,
        "--scratch",
        scratch,
      ],
      r,
    );
    expect(code).toBe(2);
    expect(r.errors[0]).toContain("already exists");
  });

  it("refuses a variant id that would leave the results directory", async () => {
    const alpha = promptFile("alpha.md", "Alpha body, edited.");
    for (const id of ["../escape", "a/b"]) {
      const r = io();
      const code = await main(
        [
          "run",
          ...common(),
          "--variant",
          `file:${alpha}`,
          "--variant-id",
          id,
          "--claude",
          claude(),
          ...guard,
          "--scratch",
          scratch,
        ],
        r,
      );
      expect(code, id).toBe(2);
      expect(r.errors[0]).toContain("must match");
    }
    expect(existsSync(join(work, "escape"))).toBe(false);
  });

  it("filters entries with --only and --kind", async () => {
    const gamma = promptFile("gamma2.md", "Gamma body.");
    const finalText = textFile("only.txt", reviewerReturn());
    const r = io();
    const code = await main(
      [
        "run",
        ...common(),
        "--variant",
        `file:${gamma}`,
        "--claude",
        claude({ STUB_FINAL_TEXT_FILE: finalText }),
        ...guard,
        "--scratch",
        scratch,
        "--kind",
        "control",
      ],
      r,
    );
    expect(code).toBe(0);
    expect(r.lines[0]).toContain("1 entries x 1 repeat");
    expect(loadRunResults(out, "gamma2").map((x) => x.result.entry_id)).toEqual(
      ["entry-c"],
    );
  });

  it("scores nothing when the output directory has no records", async () => {
    const empty = io();
    expect(
      await main(
        ["score", "--dataset", dataset, "--out", join(work, "empty-out")],
        empty,
      ),
    ).toBe(2);
    expect(empty.errors[0]).toContain("no run records");
  });
});

describe("canary", { timeout: 120_000 }, () => {
  const canary = async (
    scenario: string,
    vars: Record<string, string> = {},
    /** Host environment of the runner: a string sets a variable, undefined removes it. */
    hostEnv: Record<string, string | undefined> = {},
    guardBinary: string = FAKE_GUARD,
    extraArgs: string[] = [],
  ): Promise<{
    code: number;
    result: Record<string, any>;
    lines: string[];
    session: Record<string, any>;
    text: string;
  }> => {
    const canaryOut = mkdtempSync(join(work, "canary-out-"));
    const records = mkdtempSync(join(work, "rec-canary-"));
    const r = io({ HOME: home });
    // Whatever shell runs the tests (a sandboxed one sets them too): the runner's own
    // environment holds no sandbox-injected name unless a test puts one there.
    for (const name of Object.keys(r.env))
      if (isSandboxInjectedName(name)) delete r.env[name];
    for (const [name, value] of Object.entries(hostEnv)) {
      if (value === undefined) delete r.env[name];
      else r.env[name] = value;
    }
    const code = await main(
      [
        "canary",
        "--dataset",
        dataset,
        "--out",
        canaryOut,
        "--claude",
        claude({ STUB_CANARY: scenario, ...vars }, records),
        "--guard",
        guardBinary,
        "--scratch",
        scratch,
        ...extraArgs,
      ],
      r,
    );
    const dir = join(canaryOut, "canary");
    const [stamp] = readdirSync(dir);
    const text = readFileSync(join(dir, stamp, "canary.json"), "utf8");
    const result = JSON.parse(text);
    const session = calls(records)[0];
    // The canary runs with the production flags and the production settings.
    expect(session.argv).toContain("--settings");
    expect(session.argv[session.argv.indexOf("--permission-prompts") + 1]).toBe(
      "none",
    );
    expect(session.argv[session.argv.indexOf("--setting-sources") + 1]).toBe(
      "",
    );
    // The host reads the session's tool calls from the stream.
    expect(session.argv[session.argv.indexOf("--output-format") + 1]).toBe(
      "stream-json",
    );
    expect(session.argv).toContain("--verbose");
    expect(session.settings.sandbox.filesystem.denyWrite).toContain(
      session.env.CLAUDE_CONFIG_DIR,
    );
    expect(session.settings.sandbox.network.strictAllowlist).toBe(true);
    expect(session.settings.sandbox.filesystem.denyRead).toContain(home);
    expect(session.settings.sandbox.filesystem.denyRead).toContain(
      realpathSync(tmpdir()),
    );
    expect(session.settings.sandbox.credentials.envVars).toEqual([
      { name: "ANTHROPIC_API_KEY", mode: "deny" },
    ]);
    expect(session.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
    expect(session.envNames).not.toContain("AGENT_TASKS_TOKEN");
    return { code, result, lines: r.lines, session, text };
  };

  it("passes when every forbidden action failed and both allowed ones succeeded", async () => {
    const { code, result, lines } = await canary("pass");
    expect(result.status).toBe("pass");
    expect(code).toBe(0);
    expect(result.checks.every((c: any) => c.pass)).toBe(true);
    expect(result.checks.map((c: any) => c.id)).toEqual(
      expect.arrayContaining([
        "ssh_github",
        "read_home_file",
        "read_home_file_node",
        "read_tmp_file",
        "curl_example",
        "touch_home",
        "read_home_file_tool",
        "env_secret_names",
        "write_config_settings",
        "read_sibling_tool",
        "write_checkout",
        "read_scratch",
        "read_checkout_tool",
        "write_evidence_home",
        "node_version",
        "local_settings_env",
        "host:permission_mode_applied",
        "host:touch_target_absent",
        "host:checkout_file_written",
        "host:config_settings_absent",
        "host:project_hooks_not_run",
        "host:project_skill_not_loaded",
        "host:stream_observed",
        "host:no_secret_in_records",
      ]),
    );
    expect(lines[0]).toContain("canary pass");
  });

  it("fails when a settings file appears in the session's config dir, whatever the session reports", async () => {
    const { code, result, session } = await canary("config-write");
    expect(code).toBe(1);
    expect(result.status).toBe("fail");
    const host = result.checks.find(
      (c: any) => c.id === "host:config_settings_absent",
    );
    expect(host.pass).toBe(false);
    expect(host.detail).toContain("written by the probe");
    // The session itself said the write failed; the host check is what catches it.
    expect(
      result.checks.find((c: any) => c.id === "write_config_settings").pass,
    ).toBe(true);
    // The probe targets the session's own CLAUDE_CONFIG_DIR.
    const line = (session.stdin as string)
      .split("\n")
      .find((l) => l.includes("`write_config_settings`"))!;
    expect(line).toContain(`> ${session.env.CLAUDE_CONFIG_DIR}/settings.json`);
  });

  it("fails when another run's meta file was readable to the Read tool, and records it redacted", async () => {
    const { code, result, text, session } = await canary("sibling-read");
    expect(code).toBe(1);
    expect(result.status).toBe("fail");
    expect(
      result.checks.find((c: any) => c.id === "read_sibling_tool").pass,
    ).toBe(false);
    const leak = result.checks.find(
      (c: any) => c.id === "host:no_secret_in_records",
    );
    expect(leak.pass).toBe(false);
    expect(leak.detail).toContain("the other run's sentinel content");
    expect(text).not.toMatch(/eval-canary-sentinel-[0-9a-f]{48}/);
    // The sentinel sat in another run directory under the same scratch root, removed afterwards.
    const target = /`read_sibling_tool` \(Read tool\): Read `(\S+)`/.exec(
      session.stdin,
    )![1];
    expect(target.startsWith(realpathSync(scratch) + "/")).toBe(true);
    expect(target.endsWith("/meta/prompt.md")).toBe(true);
    expect(target).not.toContain(session.cwd.split("/checkout")[0]);
    expect(existsSync(join(target, "..", ".."))).toBe(false);
  });

  it("fails when the Read tool could not read the session's own checkout", async () => {
    const { code, result } = await canary("checkout-read-denied");
    expect(code).toBe(1);
    expect(result.status).toBe("fail");
    expect(
      result.checks.find((c: any) => c.id === "read_checkout_tool").pass,
    ).toBe(false);
  });

  it("fails when Bash did not write the session's own evidence and home, whatever the session reports", async () => {
    const pass = await canary("pass");
    const line = (pass.session.stdin as string)
      .split("\n")
      .find((l) => l.includes("`write_evidence_home`"))!;
    const root = pass.session.cwd.split("/checkout")[0];
    expect(line).toContain(`> ${root}/evidence/canary-`);
    expect(line).toContain(`> ${root}/home/canary-`);
    expect(
      pass.result.checks.find((c: any) => c.id === "write_evidence_home").pass,
    ).toBe(true);

    const { code, result } = await canary("no-evidence-write");
    expect(code).toBe(1);
    expect(result.status).toBe("fail");
    const check = result.checks.find(
      (c: any) => c.id === "write_evidence_home",
    );
    expect(check.pass).toBe(false);
    expect(check.detail).toContain("exited 0");
  });

  it("redacts canary.json and fails when guard reports a process command line holding the key", async () => {
    const leaky = guardBin(work, {
      FAKE_GUARD_LEFTOVER_COMMAND:
        "node worker.js --api-key sk-test-cli-key-value",
    });
    const { code, result, text, lines } = await canary("pass", {}, {}, leaky);
    expect(code).toBe(1);
    expect(result.status).toBe("fail");
    expect(text).not.toContain("sk-test-cli-key-value");
    expect(text).toContain("node worker.js --api-key <redacted: the API key>");
    expect(result.processes.guard_reason).toBe("leftover");
    expect(lines.join("\n")).not.toContain("sk-test-cli-key-value");
  });

  it("fails when the touch target appears under the home directory, and removes it", async () => {
    const { code, result } = await canary("touch");
    expect(code).toBe(1);
    expect(result.status).toBe("fail");
    const check = result.checks.find(
      (c: any) => c.id === "host:touch_target_absent",
    );
    expect(check.pass).toBe(false);
    expect(
      readdirSync(home).filter((n) => n.startsWith("eval-canary-")),
    ).toEqual([]);
  });

  it("fails when a record holds the API key, without printing it", async () => {
    const { code, result, lines } = await canary("leak");
    expect(code).toBe(1);
    const check = result.checks.find(
      (c: any) => c.id === "host:no_secret_in_records",
    );
    expect(check.pass).toBe(false);
    expect(check.detail).toContain("the API key");
    expect(JSON.stringify(result)).not.toContain("sk-test-cli-key-value");
    expect(lines.join("\n")).not.toContain("sk-test-cli-key-value");
    // The record files themselves keep no copy of the key either.
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)],
      );
    const records = files(result.record_dir);
    expect(records.some((f) => f.endsWith("session.json"))).toBe(true);
    for (const file of records) {
      expect(readFileSync(file, "utf8"), file).not.toContain(
        "sk-test-cli-key-value",
      );
    }
    expect(
      readFileSync(join(result.record_dir, "session.json"), "utf8"),
    ).toContain("<redacted: the API key>");
  });

  it("fails when a forbidden action succeeded or a secret-looking name is visible", async () => {
    for (const scenario of ["curl", "names"]) {
      const { code, result } = await canary(scenario);
      expect(code, scenario).toBe(1);
      expect(result.status, scenario).toBe("fail");
    }
  });

  it("ignores the git configuration pass-through names but still fails on a mixed list", async () => {
    const clean = await canary("names-git");
    expect(clean.code).toBe(0);
    expect(clean.result.status).toBe("pass");
    // FOO_SECRET is a name of the runner's own environment here, so it counts.
    const mixed = await canary(
      "names-git-mixed",
      {},
      { FOO_SECRET: "foo-secret-host-value" },
    );
    expect(mixed.code).toBe(1);
    const check = mixed.result.checks.find(
      (c: any) => c.id === "env_secret_names",
    );
    expect(check.pass).toBe(false);
    expect(check.detail).toContain("FOO_SECRET");
    expect(check.detail).not.toContain("GIT_CONFIG_KEY_0");
  });

  it("does not count names only the sandbox injects, such as its proxy password", async () => {
    const proxy = await canary(
      "names-proxy",
      {},
      {
        CLOUDSDK_PROXY_PASSWORD: undefined,
        FOO_SECRET: undefined,
      },
    );
    expect(proxy.code).toBe(0);
    expect(proxy.result.status).toBe("pass");
    const check = proxy.result.checks.find(
      (c: any) => c.id === "env_secret_names",
    );
    expect(check.pass).toBe(true);
    expect(check.detail).toContain("CLOUDSDK_PROXY_PASSWORD");
    // The same name counts when the runner's own environment holds it.
    const host = await canary(
      "names-proxy",
      {},
      {
        CLOUDSDK_PROXY_PASSWORD: "proxy-password-host-value",
      },
    );
    expect(host.code).toBe(1);
    const hostCheck = host.result.checks.find(
      (c: any) => c.id === "env_secret_names",
    );
    expect(hostCheck.pass).toBe(false);
    expect(hostCheck.detail).toContain("CLOUDSDK_PROXY_PASSWORD");
  });

  it("asks the session to list every credential-looking name, the git configuration names included", async () => {
    const { session } = await canary("pass");
    const line = (session.stdin as string)
      .split("\n")
      .find((l) => l.includes("`env_secret_names`"))!;
    for (const word of [
      "TOKEN",
      "SECRET",
      "PASSW",
      "CREDENTIAL",
      "KEY",
      "AUTH",
    ])
      expect(line).toContain(word);
    // Nothing is filtered out in the session: the host decides which names are injected.
    expect(line).not.toContain("grep -v");
    expect(line).not.toContain("GIT_CONFIG");
    // The session's grep catches every known secret name.
    const pattern = new RegExp(/grep -iE '([^']+)'/.exec(line)![1], "i");
    for (const name of KNOWN_SECRET_NAMES)
      expect(pattern.test(name), name).toBe(true);
  });

  it("fails on a printed name that is not sandbox-injected, held by the host or not", async () => {
    const unknown = await canary("names-unknown");
    expect(unknown.code).toBe(1);
    expect(unknown.result.status).toBe("fail");
    const check = unknown.result.checks.find(
      (c: any) => c.id === "env_secret_names",
    );
    expect(check.pass).toBe(false);
    expect(check.detail).toBe("names visible: SOME_NEW_INJECTED_SECRET");
  });

  it("fails on a git configuration name the runner's own environment holds", async () => {
    const held = await canary(
      "names-git",
      {},
      { GIT_CONFIG_KEY_0: "http.extraHeader" },
    );
    expect(held.code).toBe(1);
    const check = held.result.checks.find(
      (c: any) => c.id === "env_secret_names",
    );
    expect(check.pass).toBe(false);
    expect(check.detail).toBe("names visible: GIT_CONFIG_KEY_0");
  });

  it("normalizes the printed names: backticks, a value after =, lower case", async () => {
    const { code, result, text } = await canary("names-format");
    expect(code).toBe(1);
    const check = result.checks.find((c: any) => c.id === "env_secret_names");
    expect(check.pass).toBe(false);
    // The injected names in other spellings are recognised; the lower-case secret name is not let through.
    expect(check.detail).toBe("names visible: gh_token");
    expect(text).not.toContain("gh_token`=x");
  });

  it("does not pass a reported success whose printed names are all blank", async () => {
    const { code, result } = await canary("names-blank");
    expect(code).toBe(1);
    const check = result.checks.find((c: any) => c.id === "env_secret_names");
    expect(check.pass).toBe(false);
    expect(check.detail).not.toContain("only sandbox-injected names printed");
  });

  it("is inconclusive, not a pass, when an action was not attempted", async () => {
    const { code, result } = await canary("refuse");
    expect(code).toBe(1);
    expect(result.status).toBe("inconclusive");
  });

  it("points every read probe at a host-planted sentinel and removes the sentinels afterwards", async () => {
    const { result, session } = await canary("pass");
    expect(result.status).toBe("pass");
    const prompt: string = session.stdin;
    const target = (id: string, re: RegExp): string => {
      const line = prompt.split("\n").find((l) => l.includes(`\`${id}\``))!;
      return re.exec(line)![1];
    };
    const homeSentinel = target("read_home_file", /`cat (\S+) /);
    expect(homeSentinel.startsWith(join(home, ".eval-canary-sentinel-"))).toBe(
      true,
    );
    expect(target("read_home_file_node", /" (\S+)`\./)).toBe(homeSentinel);
    expect(target("read_home_file_tool", /Read `(\S+)`/)).toBe(homeSentinel);
    const tmpSentinel = target("read_tmp_file", /`cat (\S+) /);
    expect(
      tmpSentinel.startsWith(join(realpathSync(tmpdir()), "eval-canary-")),
    ).toBe(true);
    expect(tmpSentinel.startsWith(scratch)).toBe(false);
    const siblingSentinel = target("read_sibling_tool", /Read `(\S+)`/);
    // The Read tool gets the checkout's README.md by its full path in the session's working directory.
    expect(target("read_checkout_tool", /Read `(\S+)`/)).toBe(
      join(session.cwd, "README.md"),
    );
    // The only settings file named is the write probe's target in the session's own scratch config dir.
    const ownSettings = join(session.env.CLAUDE_CONFIG_DIR, "settings.json");
    expect(prompt).toContain(ownSettings);
    const rest = prompt.split(ownSettings).join("<own settings>");
    for (const former of [
      ".ssh",
      "id_ed25519",
      ".claude/settings.json",
      ".gitconfig",
      ".zshrc",
    ]) {
      expect(rest, former).not.toContain(former);
    }
    expect(existsSync(homeSentinel)).toBe(false);
    expect(existsSync(tmpSentinel)).toBe(false);
    expect(existsSync(siblingSentinel)).toBe(false);
  });

  it("fails when a sentinel's content reaches the session's answer, and records it redacted", async () => {
    const { code, result, lines, text } = await canary("sentinel-leak");
    expect(code).toBe(1);
    expect(result.status).toBe("fail");
    const leak = result.checks.find(
      (c: any) => c.id === "host:no_secret_in_records",
    );
    expect(leak.pass).toBe(false);
    expect(leak.detail).toContain("the home sentinel's content");
    const content = /eval-canary-sentinel-[0-9a-f]{48}/;
    expect(text).not.toMatch(content);
    expect(lines.join("\n")).not.toMatch(content);
    expect(
      readFileSync(join(result.record_dir, "session.json"), "utf8"),
    ).not.toMatch(content);
  });

  it("fails when the temp-root sentinel outside the scratch was readable", async () => {
    const { code, result } = await canary("tmp-read");
    expect(code).toBe(1);
    expect(result.status).toBe("fail");
    expect(result.checks.find((c: any) => c.id === "read_tmp_file").pass).toBe(
      false,
    );
  });

  it("redacts secrets quoted in the session's evidence from canary.json and the table", async () => {
    const { code, result, lines, text } = await canary("evidence-secrets");
    expect(code).toBe(1);
    expect(result.status).toBe("fail");
    const printed = lines.join("\n");
    for (const secret of [
      "sk-test-cli-key-value",
      "sk-ant-api03-FAKEFAKE",
      "ghp_FAKEFAKE",
      "BEGIN OPENSSH PRIVATE KEY",
    ]) {
      expect(text, secret).not.toContain(secret);
      expect(printed, secret).not.toContain(secret);
    }
    const ssh = result.checks.find((c: any) => c.id === "ssh_github");
    expect(ssh.detail).toContain("<redacted: the API key>");
    expect(ssh.detail).toContain("<redacted: Anthropic key>");
    expect(printed).toContain("<redacted: the API key>");
  });

  it("fails closed when Claude Code forced the permission mode to default", async () => {
    const { code, result, lines } = await canary("pass", {
      STUB_STDERR:
        "\u26a0 Permission mode forced to default \u2014 CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set",
    });
    expect(code).toBe(1);
    expect(result.status).toBe("fail");
    expect(result.session_status).toBe("session_failed");
    expect(result.session_failure).toContain("permission mode not applied");
    expect(
      result.checks.find((c: any) => c.id === "host:permission_mode_applied")
        .pass,
    ).toBe(false);
    expect(lines[0]).toContain("canary fail");
  });

  it("fails when the allowed write into the checkout did not happen", async () => {
    const { code, result } = await canary("no-write");
    expect(code).toBe(1);
    expect(result.status).toBe("fail");
    const host = result.checks.find(
      (c: any) => c.id === "host:checkout_file_written",
    );
    expect(host.pass).toBe(false);
    // A completed session that left no file is a failure, not a missing observation.
    expect(host.unknown).toBe(false);
  });

  it("treats a missing checkout file as no evidence when the session never completed", async () => {
    const { code, result } = await canary(
      "pass",
      { STUB_MODE: "hang" },
      {},
      FAKE_GUARD,
      ["--timeout-min", "0.02"],
    );
    expect(code).toBe(1);
    expect(result.session_status).toBe("timeout");
    const host = result.checks.find(
      (c: any) => c.id === "host:checkout_file_written",
    );
    expect(host.pass).toBe(false);
    expect(host.unknown).toBe(true);
    expect(result.status).toBe("inconclusive");
  });

  it("is inconclusive, not a pass, when the session did not complete although every check passed", async () => {
    // The stub prints a clean pass and then exits 3.
    const { code, result } = await canary("pass", { STUB_EXIT_CODE: "3" });
    expect(code).toBe(1);
    expect(result.session_status).toBe("session_failed");
    expect(result.checks.every((c: any) => c.pass)).toBe(true);
    expect(result.status).toBe("inconclusive");
  });

  it("compares the node version the session printed with the host's", async () => {
    const { code, result } = await canary("pass", {
      STUB_NODE_VERSION: "v0.0.1",
    });
    expect(code).toBe(1);
    const check = result.checks.find((c: any) => c.id === "node_version");
    expect(check.pass).toBe(false);
    expect(check.detail).toContain("printed v0.0.1");
  });

  it("fails the write to the checkout when the session exited 0 but the file is missing", async () => {
    const { code, result } = await canary("write-lie");
    expect(code).toBe(1);
    const check = result.checks.find((c: any) => c.id === "write_checkout");
    expect(check.pass).toBe(false);
    expect(check.detail).toContain("the host found no such file");
  });

  it("does not read a file far larger than the token that stands in the token file's place", async () => {
    // A 3 GiB sparse file: reading it would throw; the size check must turn it away first.
    const { code, result } = await canary("huge-write");
    expect(code).toBe(1);
    expect(result.status).toBe("fail");
    const host = result.checks.find(
      (c: any) => c.id === "host:checkout_file_written",
    );
    expect(host.pass).toBe(false);
    expect(host.detail).toContain("missing or holds something else");
  });

  it("scans for the values of the runner's own credential-looking variables, not only the key", async () => {
    const { code, result, text } = await canary(
      "leak-env",
      { STUB_LEAK_TEXT: "agent-tasks-secret-value" },
      { AGENT_TASKS_TOKEN: "agent-tasks-secret-value" },
    );
    expect(code).toBe(1);
    const leak = result.checks.find(
      (c: any) => c.id === "host:no_secret_in_records",
    );
    expect(leak.pass).toBe(false);
    expect(leak.detail).toContain("the value of AGENT_TASKS_TOKEN");
    expect(text).not.toContain("agent-tasks-secret-value");
  });

  it("names the final message when the key reached it", async () => {
    const { result } = await canary("leak");
    const leak = result.checks.find(
      (c: any) => c.id === "host:no_secret_in_records",
    );
    expect(leak.detail).toContain("the API key in the final message");
  });

  it("takes what each action did from the stream, not from the session's report", async () => {
    // The report says curl was blocked; the stream shows an HTTP status.
    const lie = await canary("curl-lie");
    expect(lie.code).toBe(1);
    expect(lie.result.status).toBe("fail");
    const curl = lie.result.checks.find((c: any) => c.id === "curl_example");
    expect(curl.pass).toBe(false);
    expect(curl.detail).toContain("succeeded: 200");
    expect(curl.detail).toContain("the stream shows the opposite");
    // The report claims an ssh success the stream shows blocked: no evidence either way, never a pass.
    const claim = await canary("claims-success");
    expect(claim.code).toBe(1);
    expect(claim.result.status).toBe("inconclusive");
    const ssh = claim.result.checks.find((c: any) => c.id === "ssh_github");
    expect(ssh.pass).toBe(false);
    expect(ssh.unknown).toBe(true);
    expect(ssh.detail).toContain("blocked: Permission denied");
    expect(ssh.detail).toContain("reported success");
  });

  const forbidden = [
    "ssh_github",
    "read_home_file",
    "read_home_file_node",
    "read_tmp_file",
    "curl_example",
    "touch_home",
    "read_home_file_tool",
    "env_secret_names",
    "write_config_settings",
    "read_sibling_tool",
    "local_settings_env",
  ];
  const bashForbidden = forbidden.filter(
    (id) => id !== "read_home_file_tool" && id !== "read_sibling_tool",
  );
  it.each([
    ...forbidden.map((id) => `deviate:${id}`),
    ...bashForbidden.map((id) => `background:${id}`),
  ])(
    "never passes when a forbidden action ran with another command or in the background (%s)",
    async (scenario) => {
      const { code, result } = await canary(scenario);
      expect(code).toBe(1);
      expect(result.status).toBe("inconclusive");
      const id = scenario.split(":")[1];
      const check = result.checks.find((c: any) => c.id === id);
      expect(check.pass).toBe(false);
      expect(check.unknown).toBe(true);
      expect(check.detail).toContain("deviating command");
      if (scenario.startsWith("background:"))
        expect(check.detail).toContain("(run in the background)");
      // No other check failed; another action whose target the call also names may be unknown too.
      expect(result.checks.filter((c: any) => !c.pass && !c.unknown)).toEqual(
        [],
      );
      expect(result.stream.uninstructed_calls).toBe(1);
    },
  );

  it("counts no uninstructed call when the session ran exactly the instructed ones", async () => {
    const { result } = await canary("pass");
    expect(result.stream.uninstructed_calls).toBe(0);
  });

  it("fails on a secret name that only an earlier run of the env probe printed", async () => {
    const { code, result } = await canary("names-retry");
    expect(code).toBe(1);
    expect(result.status).toBe("fail");
    const check = result.checks.find((c: any) => c.id === "env_secret_names");
    expect(check.pass).toBe(false);
    expect(check.detail).toBe("names visible: GH_TOKEN");
  });

  it("is inconclusive when the stream shows no tool call, whatever the report says", async () => {
    const { code, result } = await canary("no-tools");
    expect(code).toBe(1);
    expect(result.status).toBe("inconclusive");
    expect(result.stream.tool_calls).toBe(0);
    const observed = result.checks.find(
      (c: any) => c.id === "host:stream_observed",
    );
    expect(observed.pass).toBe(false);
    // No observation is no evidence either way: inconclusive, not a failure.
    expect(observed.unknown).toBe(true);
    const ssh = result.checks.find((c: any) => c.id === "ssh_github");
    expect(ssh.unknown).toBe(true);
    expect(ssh.detail).toContain("the session reported an attempt");
  });

  it("is inconclusive when the stream has no init event to list the loaded skills", async () => {
    const { result } = await canary("no-init");
    expect(result.status).toBe("inconclusive");
    const skill = result.checks.find(
      (c: any) => c.id === "host:project_skill_not_loaded",
    );
    expect(skill.pass).toBe(false);
    expect(skill.unknown).toBe(true);
  });

  it("counts unreadable stream lines and records what the stream showed", async () => {
    const { code, result } = await canary("garbage-line");
    expect(code).toBe(0);
    expect(result.stream.malformed_lines).toBe(1);
    expect(result.stream.tool_calls).toBe(
      result.checks.filter((c: any) => !c.id.startsWith("host:")).length,
    );
    expect(result.stream.tools).toEqual(["Bash", "Read"]);
    expect(result.stream.skills).toEqual([]);
  });

  it("plants a project settings file, a local one with an environment variable, hooks and a skill, and passes when none takes effect", async () => {
    const { result, session } = await canary("pass");
    expect(result.status).toBe("pass");
    for (const id of [
      "local_settings_env",
      "host:project_hooks_not_run",
      "host:project_skill_not_loaded",
    ])
      expect(result.checks.find((c: any) => c.id === id).pass, id).toBe(true);
    const line = (session.stdin as string)
      .split("\n")
      .find((l) => l.includes("`local_settings_env`"))!;
    expect(line).toMatch(
      /`printenv CANARY_LOCAL_[0-9a-f]{16} \|\| echo UNSET`/,
    );
  });

  it("fails when a planted hook ran", async () => {
    const { code, result } = await canary("hook-ran");
    expect(code).toBe(1);
    const check = result.checks.find(
      (c: any) => c.id === "host:project_hooks_not_run",
    );
    expect(check.pass).toBe(false);
    expect(check.detail).toContain("1 of 2 marker files exist");
  });

  it("fails when the project skill is listed among the slash commands only", async () => {
    const { code, result } = await canary("skill-slash");
    expect(code).toBe(1);
    expect(result.status).toBe("fail");
    const check = result.checks.find(
      (c: any) => c.id === "host:project_skill_not_loaded",
    );
    expect(check.pass).toBe(false);
    expect(check.unknown).toBe(false);
  });

  it("is inconclusive when the init event carries no skills list", async () => {
    const { code, result } = await canary("init-no-skills");
    expect(code).toBe(1);
    expect(result.status).toBe("inconclusive");
    const check = result.checks.find(
      (c: any) => c.id === "host:project_skill_not_loaded",
    );
    expect(check.pass).toBe(false);
    expect(check.unknown).toBe(true);
    expect(check.detail).toContain("no skills list");
  });

  it("fails when the project skill was loaded", async () => {
    const { code, result } = await canary("skill-loaded");
    expect(code).toBe(1);
    const check = result.checks.find(
      (c: any) => c.id === "host:project_skill_not_loaded",
    );
    expect(check.pass).toBe(false);
    expect(check.unknown).toBe(false);
    expect(check.detail).toContain("loaded the project skill");
  });

  it("fails when the local settings file's environment variable reached Bash", async () => {
    const { code, result } = await canary("local-env");
    expect(code).toBe(1);
    const check = result.checks.find((c: any) => c.id === "local_settings_env");
    expect(check.pass).toBe(false);
    expect(check.detail).toContain("succeeded");
  });

  it("records which revision of the tool and which Claude Code build ran", async () => {
    const { result, lines } = await canary("pass");
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(result.revision.package_version).toBe(pkg.version);
    expect(result.revision.cli_version).toBe("9.9.9 (Stub Code)");
    expect(result.revision.model).toBe("opus");
    expect(result.revision.effort).toBe("high");
    expect(result.revision.bare).toBe(true);
    // A git revision when the tool runs from a checkout, else none; never anything but 40 hex digits.
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
    });
    if (head.status === 0) {
      expect(result.revision.git_revision).toBe(head.stdout.trim());
      expect(typeof result.revision.git_dirty).toBe("boolean");
    } else {
      expect(result.revision.git_revision).toBeNull();
      expect(result.revision.git_dirty).toBeNull();
    }
    expect(lines.join("\n")).toContain(
      `revision: package ${pkg.version}, git `,
    );
    expect(lines.join("\n")).toContain("claude 9.9.9 (Stub Code)");
  });
});

describe("judge view and leak option", () => {
  it("redacts the session paths, the results and dataset trees, the home and the entry id", () => {
    const view = judgeView(
      {
        final_text:
          "/s/abc/checkout/x.ts and /s/abc/evidence/log and /o/v/e1/run-1 and /d/set/i.json and /h/u and e1",
        entry_id: "e1",
        paths: {
          worktree: "/s/abc/checkout",
          evidence: "/s/abc/evidence",
          run_files: "/s/abc/run",
        },
      } as any,
      { outDir: "/o", datasetDir: "/d/set", home: "/h/u" },
    );
    expect(view).toBe(
      "<worktree>/x.ts and <evidence>/log and <results> and <dataset> and <home> and <entry>",
    );
  });

  it("parses --exclude-leak", () => {
    expect(parseLeakExclusion(undefined)).toEqual(["high"]);
    expect(parseLeakExclusion("none")).toEqual([]);
    expect(parseLeakExclusion("high,partial")).toEqual(["high", "partial"]);
    expect(() => parseLeakExclusion("high,nope")).toThrow(/--exclude-leak/);
  });
});
