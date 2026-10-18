import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadRunResults, main } from "../eval/cli.js";
import type { Io } from "../eval/cli.js";
import {
  makeEntry,
  makeFixtureRepo,
  reviewerReturn,
  writeDataset,
} from "./eval-helpers.js";
import type { FixtureRepo } from "./eval-helpers.js";

const STUB = fileURLToPath(
  new URL("./fixtures/eval/stub-claude.mjs", import.meta.url),
);

let repo: FixtureRepo;
let work: string;
let dataset: string;
let out: string;
let scratch: string;
let recordDir: string;

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
      ANTHROPIC_API_KEY: "sk-test",
      STUB_RECORD_DIR: recordDir,
      STUB_FUTURE_SHA: repo.futureSha,
      ...extraEnv,
    },
  };
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

beforeAll(() => {
  repo = makeFixtureRepo();
  work = mkdtempSync(join(tmpdir(), "ow-eval-cli-"));
  dataset = join(work, "dataset");
  out = join(work, "out");
  scratch = join(work, "scratch");
  recordDir = join(work, "rec");
  mkdirSync(recordDir, { recursive: true });
  writeDataset(dataset, [
    makeEntry(repo, { id: "entry-a" }),
    makeEntry(repo, { id: "entry-c", kind: "control", known_findings: [] }),
  ]);
});

afterAll(() => {
  rmSync(repo.dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const common = (): string[] => ["--dataset", dataset, "--out", out];

describe("evaluation CLI", () => {
  it("validates the dataset and refuses a broken one", async () => {
    const ok = io();
    expect(await main(["validate-dataset", "--dataset", dataset], ok)).toBe(0);
    expect(ok.lines[0]).toBe("dataset ok: 2 entries (1 finding, 1 control)");

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
    const b = io();
    expect(await main(["run", "--unknown-flag"], b)).toBe(2);
  });

  it("refuses to run without an API key in bare mode, and with a bad kind or filter", async () => {
    const alpha = promptFile("alpha.md", "Alpha body.");
    const base = [
      "run",
      ...common(),
      "--variant",
      `file:${alpha}`,
      "--claude",
      STUB,
      "--scratch",
      scratch,
    ];
    const noKey = io();
    delete noKey.env.ANTHROPIC_API_KEY;
    expect(await main(base, noKey)).toBe(2);
    expect(noKey.errors[0]).toContain("ANTHROPIC_API_KEY");

    const badKind = io();
    expect(await main([...base, "--kind", "weird"], badKind)).toBe(2);
    const none = io();
    expect(await main([...base, "--only", "missing-id"], none)).toBe(2);
    expect(none.errors[0]).toContain("no dataset entry matches");
  });

  it("runs, judges, scores and compares two variants", async () => {
    const alpha = promptFile("alpha.md", "Alpha body.");
    const beta = promptFile("beta.md", "Beta body.");
    const withFinding = textFile(
      "with-finding.txt",
      reviewerReturn([{ severity: "medium" }]),
    );
    const clean = textFile("clean.txt", reviewerReturn());
    const runArgs = (variant: string, repeat: string): string[] => [
      "run",
      ...common(),
      "--variant",
      `file:${variant}`,
      "--repeat",
      repeat,
      "--claude",
      STUB,
      "--scratch",
      scratch,
      "--budget-usd",
      "3",
    ];

    const runA = io({ STUB_FINAL_TEXT_FILE: withFinding });
    expect(await main(runArgs(alpha, "2"), runA)).toBe(0);
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
    const failedJudge = io({ STUB_JUDGE_TEXT_FILE: garbage });
    expect(
      await main(
        ["judge", ...common(), "--claude", STUB, "--attempts", "1"],
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
    const judgeA = io({ STUB_JUDGE_TEXT_FILE: yes });
    expect(await main(["judge", ...common(), "--claude", STUB], judgeA)).toBe(
      0,
    );
    expect(judgeA.lines[0]).toBe("judged 2 run(s), 0 failed");
    expect(existsSync(join(alphaDir, "judge-error.json"))).toBe(false);

    // The judge sees the rubric, the known defects and the review, and nothing that names a variant.
    const judgeCalls = readdirSync(recordDir)
      .filter((f) => f.startsWith("call-"))
      .map((f) => JSON.parse(readFileSync(join(recordDir, f), "utf8")))
      .filter((c) => c.agents === null);
    expect(judgeCalls.length).toBeGreaterThan(0);
    for (const c of judgeCalls) {
      expect(c.stdin).toContain("Known defects");
      expect(c.stdin).not.toMatch(/alpha|beta|entry-a|entry-c/);
      expect(c.cwd).not.toContain(out);
      expect(c.argv).toContain("--tools");
    }

    const runB = io({ STUB_FINAL_TEXT_FILE: clean });
    expect(await main(runArgs(beta, "1"), runB)).toBe(0);
    const no = textFile(
      "judge-no.txt",
      '```json\n{"matches":[{"id":"K1","matched":false,"evidence":"not reported"}]}\n```',
    );
    const judgeB = io({ STUB_JUDGE_TEXT_FILE: no });
    expect(await main(["judge", ...common(), "--claude", STUB], judgeB)).toBe(
      0,
    );
    expect(judgeB.lines[0]).toBe("judged 1 run(s), 0 failed");

    const score = io();
    expect(await main(["score", ...common()], score)).toBe(0);
    const table = score.lines.join("\n");
    expect(table).toContain("| alpha | 4 | 2 | 100.0% | 100.0% |");
    expect(table).toContain("| beta | 2 | 2 | 100.0% | 0.0% |");
    expect(table).toContain("alpha noise over 2 repeats");
    const scores = JSON.parse(readFileSync(join(out, "scores.json"), "utf8"));
    expect(scores.map((r: any) => r.aggregate.variant_id)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(scores[0].aggregate.false_positives).toBe(2);
    expect(scores[1].aggregate.false_positives).toBe(0);

    const compare = io();
    expect(
      await main(
        ["compare", ...common(), "--a", "alpha", "--b", "beta"],
        compare,
      ),
    ).toBe(0);
    const text = compare.lines.join("\n");
    expect(text).toContain("| recall | 100.0% | 0.0% | -100.0% |");
    expect(text).toContain("above noise");
    expect(existsSync(join(out, "compare-alpha-vs-beta.json"))).toBe(true);

    const missing = io();
    expect(
      await main(
        ["compare", ...common(), "--a", "alpha", "--b", "gamma"],
        missing,
      ),
    ).toBe(2);
    expect(missing.errors[0]).toContain("gamma");
  }, 120_000);

  it("runs sessions in parallel with --jobs and still writes every record", async () => {
    const delta = promptFile("delta.md", "Delta body.");
    const finalText = textFile("par.txt", reviewerReturn());
    const parallelRecords = join(work, "rec-parallel");
    mkdirSync(parallelRecords);
    const r = io({
      STUB_FINAL_TEXT_FILE: finalText,
      STUB_DELAY_MS: "2500",
      STUB_RECORD_DIR: parallelRecords,
    });
    const code = await main(
      [
        "run",
        ...common(),
        "--variant",
        `file:${delta}`,
        "--claude",
        STUB,
        "--scratch",
        scratch,
        "--repeat",
        "2",
        "--jobs",
        "4",
      ],
      r,
    );
    expect(code).toBe(0);
    expect(r.lines.at(-1)).toContain("4 completed, 0 not completed");
    expect(loadRunResults(out, "delta")).toHaveLength(4);
    const spans = readdirSync(parallelRecords)
      .filter((f) => f.startsWith("call-"))
      .map((f) => JSON.parse(readFileSync(join(parallelRecords, f), "utf8")))
      .map((c) => [c.startedAt as number, c.endedAt as number]);
    expect(spans).toHaveLength(4);
    // One at a time, no two sessions would overlap; with four workers several do.
    const overlapping = spans.filter(([start, end], i) =>
      spans.some(([s2, e2], k) => k !== i && s2 < end && start < e2),
    );
    expect(overlapping.length).toBeGreaterThanOrEqual(2);
    const bad = io();
    expect(
      await main(
        ["run", ...common(), "--variant", `file:${delta}`, "--jobs", "0"],
        bad,
      ),
    ).toBe(2);
  }, 60_000);

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
        STUB,
        "--scratch",
        scratch,
      ],
      r,
    );
    expect(code).toBe(2);
    expect(r.errors[0]).toContain("already exists");
  });

  it("filters entries with --only and --kind", async () => {
    const gamma = promptFile("gamma.md", "Gamma body.");
    const finalText = textFile("only.txt", reviewerReturn());
    const r = io({ STUB_FINAL_TEXT_FILE: finalText });
    const code = await main(
      [
        "run",
        ...common(),
        "--variant",
        `file:${gamma}`,
        "--claude",
        STUB,
        "--scratch",
        scratch,
        "--kind",
        "control",
      ],
      r,
    );
    expect(code).toBe(0);
    expect(r.lines[0]).toContain("1 entries x 1 repeat");
    expect(loadRunResults(out, "gamma").map((x) => x.result.entry_id)).toEqual([
      "entry-c",
    ]);
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
