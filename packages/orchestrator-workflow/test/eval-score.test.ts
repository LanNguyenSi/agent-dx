import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  aggregate,
  buildJudgePrompt,
  checkReturn,
  compareVariants,
  computeNoise,
  entryMeans,
  fencedBlocks,
  parseJudgeAnswer,
  provenanceWarnings,
  runProvenance,
  scoreRun,
  splitByLeak,
} from "../eval/score.js";
import type { JudgeFile, RunResult, RunScore } from "../eval/score.js";
import {
  DEFAULT_REVISION,
  degradeReviewerPrompt,
  makeVariant,
  resolveVariant,
  sha256,
  splitPrompt,
} from "../eval/variants.js";
import { renderAggregates, renderComparison } from "../eval/report.js";
import { knownFinding, makeEntry, reviewerReturn } from "./eval-helpers.js";
import type { DatasetEntry } from "../eval/dataset.js";

function entry(over: Partial<DatasetEntry> = {}): DatasetEntry {
  return makeEntry(
    {
      dir: "/r",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      futureSha: "c".repeat(40),
    },
    over,
  );
}

function result(text: string, over: Partial<RunResult> = {}): RunResult {
  return {
    schema: 2,
    entry_id: "entry-a",
    kind: "finding",
    repeat: 1,
    started_at: "x",
    variant: { id: "v", source: "s", sha256: "h" },
    prompt_sha256: "p",
    model: "m",
    effort: "e",
    status: "completed",
    failure: null,
    exit_code: 0,
    signal: null,
    wall_ms: 2000,
    session_wall_ms: 1500,
    cost_usd: 1,
    turns: 3,
    session_ms: 1000,
    final_text: text,
    check: checkReturn(text),
    scratch_id: "0123456789ab",
    paths: { worktree: "/w", evidence: "/e", run_files: "/r" },
    checkout: {
      head_sha: "h",
      setup_ok: true,
      dirty_after_setup: false,
      cleaned_up: true,
    },
    processes: { setup: [], session: null },
    previous_status: null,
    ...over,
  };
}

describe("fencedBlocks", () => {
  it("returns tagged blocks in order and honours longer fences", () => {
    const blocks = fencedBlocks(
      "intro\n```yaml\na: 1\n```\ntext\n````md\n```inner\nx\n```\n````\n~~~json\n{}\n~~~\n",
    );
    expect(blocks.map((b) => b.tag)).toEqual(["yaml", "md", "json"]);
    expect(blocks[1].body).toBe("```inner\nx\n```");
  });

  it("treats an unclosed fence as running to the end", () => {
    expect(fencedBlocks("```yaml\na: 1")).toEqual([
      { tag: "yaml", body: "a: 1" },
    ]);
  });
});

describe("checkReturn", () => {
  it("accepts a contract-shaped return and reads its findings", () => {
    const check = checkReturn(
      reviewerReturn([{ severity: "medium" }, { severity: "low" }]),
    );
    expect(check.valid).toBe(true);
    expect(check.yaml_blocks).toBe(1);
    expect(check.acceptance_recommendation).toBe("fix_required");
    expect(check.findings.map((f) => f.severity)).toEqual(["medium", "low"]);
  });

  it("rejects empty output", () => {
    expect(checkReturn("  \n")).toMatchObject({
      valid: false,
      reasons: ["empty output"],
    });
  });

  it("rejects a message without a yaml block", () => {
    const check = checkReturn("Looks fine to me.");
    expect(check.valid).toBe(false);
    expect(check.reasons).toEqual(["no yaml fenced block"]);
  });

  it("rejects two yaml blocks", () => {
    const one = reviewerReturn();
    const check = checkReturn(`${one}\n\n${one}`);
    expect(check.valid).toBe(false);
    expect(check.yaml_blocks).toBe(2);
    expect(check.reasons[0]).toContain("2 yaml fenced blocks");
  });

  it("names a missing mandatory field", () => {
    const text = reviewerReturn().replace(
      /acceptance_recommendation: .*\n/,
      "",
    );
    const check = checkReturn(text);
    expect(check.valid).toBe(false);
    expect(check.reasons.join("\n")).toContain("acceptance_recommendation");
  });

  it("names a bad enum value", () => {
    const text = reviewerReturn().replace(
      "method_applied: rigorous",
      "method_applied: thorough",
    );
    const check = checkReturn(text);
    expect(check.valid).toBe(false);
    expect(check.reasons.join("\n")).toContain("method_applied");
  });

  it("rejects yaml that does not parse", () => {
    const check = checkReturn("```yaml\nfindings: [unclosed\n```");
    expect(check.valid).toBe(false);
    expect(check.reasons.length).toBeGreaterThan(0);
  });
});

describe("judge prompt and answer", () => {
  const known = [knownFinding("K1"), knownFinding("K2", "high")];

  it("puts the rubric, every known defect and the review into the prompt, without ids of runs", () => {
    const prompt = buildJudgePrompt(known, "REVIEW TEXT");
    expect(prompt).toContain(
      "Judge the class, not the wording or the line numbers",
    );
    expect(prompt).toContain("K1 [medium, correctness]: defect K1");
    expect(prompt).toContain("K2 [high, correctness]: defect K2");
    expect(prompt).toContain("<review>\nREVIEW TEXT\n</review>");
  });

  it("parses a complete answer from the last json block", () => {
    const answer =
      'Reasoning.\n```json\n{"matches":[{"id":"K1","matched":true,"evidence":"finding 1"},{"id":"K2","matched":false,"evidence":"not reported"}]}\n```';
    const parsed = parseJudgeAnswer(answer, ["K1", "K2"]);
    expect(parsed.ok).toBe(true);
    expect(parsed.matches.map((m) => [m.id, m.matched])).toEqual([
      ["K1", true],
      ["K2", false],
    ]);
  });

  it("accepts a bare json answer", () => {
    const parsed = parseJudgeAnswer(
      '{"matches":[{"id":"K1","matched":false}]}',
      ["K1"],
    );
    expect(parsed.ok).toBe(true);
  });

  it("rejects a missing, duplicate or unknown id", () => {
    const missing = parseJudgeAnswer(
      '{"matches":[{"id":"K1","matched":false}]}',
      ["K1", "K2"],
    );
    expect(missing.errors).toContain("known defect K2 was not answered");
    const dup = parseJudgeAnswer(
      '{"matches":[{"id":"K1","matched":false},{"id":"K1","matched":false}]}',
      ["K1"],
    );
    expect(dup.errors.some((e) => e.includes("answered twice"))).toBe(true);
    const unknown = parseJudgeAnswer(
      '{"matches":[{"id":"K9","matched":false}]}',
      ["K1"],
    );
    expect(unknown.errors.some((e) => e.includes("unknown id K9"))).toBe(true);
    expect(unknown.ok).toBe(false);
    expect(unknown.matches).toEqual([]);
  });

  it("rejects a non-boolean verdict and a match without evidence", () => {
    expect(
      parseJudgeAnswer('{"matches":[{"id":"K1","matched":"yes"}]}', ["K1"])
        .errors[0],
    ).toContain("expected a boolean");
    expect(
      parseJudgeAnswer(
        '{"matches":[{"id":"K1","matched":true,"evidence":" "}]}',
        ["K1"],
      ).errors[0],
    ).toContain("needs evidence");
  });

  it("rejects text that is not json", () => {
    expect(parseJudgeAnswer("no idea", ["K1"]).errors[0]).toContain(
      "not valid JSON",
    );
    expect(parseJudgeAnswer('{"other":1}', ["K1"]).errors[0]).toContain(
      "matches array",
    );
  });
});

describe("scoreRun", () => {
  const finding = entry({
    known_findings: [
      knownFinding("K1"),
      knownFinding("K2", "high"),
      knownFinding("K3", "low"),
    ],
  });
  const judge: JudgeFile = {
    matches: [
      { id: "K1", matched: true, evidence: "e" },
      { id: "K2", matched: false, evidence: "" },
    ],
    model: "sonnet",
    cost_usd: 0.1,
  };

  it("counts only medium-plus known findings and the judge's matches", () => {
    const score = scoreRun(
      finding,
      result(reviewerReturn([{ severity: "high" }])),
      judge,
    );
    expect(score).toMatchObject({
      known_total: 2,
      known_matched: 1,
      matched_ids: ["K1"],
      medium_plus: 1,
      valid: true,
    });
  });

  it("ignores a judgment for a low or an unknown id", () => {
    const loose: JudgeFile = {
      matches: [
        { id: "K3", matched: true, evidence: "the low one" },
        { id: "K9", matched: true, evidence: "not a known defect" },
        { id: "K1", matched: true, evidence: "e" },
        { id: "K1", matched: true, evidence: "twice" },
      ],
      model: "sonnet",
      cost_usd: 0.1,
    };
    const score = scoreRun(finding, result(reviewerReturn()), loose);
    expect(score.known_total).toBe(2);
    expect(score.known_matched).toBe(1);
    expect(score.matched_ids).toEqual(["K1"]);
  });

  it("leaves a finding run unjudged until a judgment exists", () => {
    expect(
      scoreRun(finding, result(reviewerReturn()), null).known_matched,
    ).toBeNull();
  });

  it("takes the session time, not the whole run, as the duration", () => {
    expect(scoreRun(finding, result(reviewerReturn()), judge).wall_ms).toBe(
      1500,
    );
    expect(
      scoreRun(
        finding,
        result(reviewerReturn(), { session_wall_ms: null }),
        judge,
      ).wall_ms,
    ).toBe(2000);
  });

  it("scores an empty output as zero recall without a judgment", () => {
    const score = scoreRun(finding, result("", { status: "timeout" }), null);
    expect(score.known_matched).toBe(0);
    expect(score.valid).toBe(false);
  });

  it("counts medium-plus findings of a control run as false positives", () => {
    const control = entry({ kind: "control", known_findings: [] });
    const score = scoreRun(
      control,
      result(
        reviewerReturn([
          { severity: "low" },
          { severity: "medium" },
          { severity: "critical" },
        ]),
        {
          kind: "control",
        },
      ),
      null,
    );
    expect(score.medium_plus).toBe(2);
    expect(score.known_matched).toBe(0);
  });
});

function s(over: Partial<RunScore>): RunScore {
  return {
    entry_id: "e1",
    kind: "finding",
    leak: "none",
    repeat: 1,
    status: "completed",
    valid: true,
    medium_plus: 0,
    known_total: 2,
    known_matched: 1,
    matched_ids: ["K1"],
    cost_usd: 1,
    wall_ms: 10_000,
    ...over,
  };
}

describe("aggregate", () => {
  it("computes recall, false positives, validity, cost and time", () => {
    const agg = aggregate("v", [
      s({ entry_id: "e1", known_total: 2, known_matched: 1 }),
      s({ entry_id: "e2", known_total: 1, known_matched: 1, valid: false }),
      s({
        entry_id: "c1",
        kind: "control",
        known_total: 0,
        known_matched: 0,
        medium_plus: 2,
      }),
      s({
        entry_id: "c2",
        kind: "control",
        known_total: 0,
        known_matched: 0,
        medium_plus: 0,
        cost_usd: 3,
      }),
    ]);
    expect(agg.n_runs).toBe(4);
    expect(agg.n_entries).toBe(4);
    expect(agg.recall).toBeCloseTo(2 / 3);
    expect(agg.recall_macro).toBeCloseTo(0.75);
    expect(agg.false_positives).toBe(2);
    expect(agg.false_positives_per_control_run).toBe(1);
    expect(agg.controls_with_false_positive).toBe(1);
    expect(agg.validity_rate).toBe(0.75);
    expect(agg.cost_total_usd).toBe(6);
    expect(agg.cost_mean_usd).toBe(1.5);
    expect(agg.wall_mean_s).toBe(10);
  });

  it("excludes setup failures, counts timeouts apart and leaves unjudged runs out of recall", () => {
    const agg = aggregate("v", [
      s({ known_matched: null }),
      s({ entry_id: "e2", status: "setup_failed" }),
      s({ entry_id: "e3", status: "timeout", valid: false, known_matched: 0 }),
    ]);
    expect(agg.n_runs).toBe(2);
    expect(agg.n_setup_failed).toBe(1);
    expect(agg.n_completed).toBe(1);
    expect(agg.unjudged_finding_runs).toBe(1);
    expect(agg.judged_finding_runs).toBe(0);
    expect(agg.recall).toBeNull();
    expect(agg.n_timeouts).toBe(1);
    expect(agg.n_session_failed).toBe(0);
  });

  it("counts session failures and timeouts apart and keeps them out of recall, false positives and validity", () => {
    const agg = aggregate("v", [
      s({ entry_id: "e1", known_total: 1, known_matched: 1 }),
      s({
        entry_id: "e2",
        known_total: 1,
        known_matched: 0,
        valid: false,
        status: "session_failed",
      }),
      s({
        entry_id: "e3",
        known_total: 1,
        known_matched: 0,
        valid: false,
        status: "timeout",
      }),
      s({
        entry_id: "c1",
        kind: "control",
        known_total: 0,
        known_matched: 0,
        medium_plus: 0,
      }),
      s({
        entry_id: "c2",
        kind: "control",
        known_total: 0,
        known_matched: 0,
        medium_plus: 3,
        valid: false,
        status: "session_failed",
      }),
    ]);
    expect(agg.n_session_failed).toBe(2);
    expect(agg.n_timeouts).toBe(1);
    expect(agg.n_completed).toBe(2);
    expect(agg.recall).toBe(1);
    expect(agg.recall_entries).toBe(1);
    expect(agg.false_positives).toBe(0);
    expect(agg.control_entries).toBe(1);
    expect(agg.validity_rate).toBe(1);
    // Cost and time count every session that ran.
    expect(agg.n_runs).toBe(5);
    expect(agg.cost_total_usd).toBe(5);
  });

  it("weighs every entry once, whatever its repeat count", () => {
    const agg = aggregate("v", [
      s({ entry_id: "e1", repeat: 1, known_total: 1, known_matched: 1 }),
      s({ entry_id: "e1", repeat: 2, known_total: 1, known_matched: 1 }),
      s({ entry_id: "e1", repeat: 3, known_total: 1, known_matched: 1 }),
      s({ entry_id: "e2", repeat: 1, known_total: 1, known_matched: 0 }),
    ]);
    // Pooled runs would give 3/4; per-entry means give (1 + 0) / 2.
    expect(agg.recall).toBe(0.5);
    expect(agg.n_repeats).toBe(3);
    expect(agg.recall_by_repeat).toEqual([
      { repeat: 1, recall: 0.5, entries: 2 },
      { repeat: 2, recall: 1, entries: 1 },
      { repeat: 3, recall: 1, entries: 1 },
    ]);
  });

  it("reports null rates when there is nothing to divide by", () => {
    const agg = aggregate("v", []);
    expect(agg.recall).toBeNull();
    expect(agg.validity_rate).toBeNull();
    expect(agg.cost_mean_usd).toBeNull();
  });
});

describe("computeNoise", () => {
  it("needs at least two repeats", () => {
    expect(computeNoise([s({})])).toBeNull();
  });

  it("measures the spread between repeats on common entries", () => {
    const runs = [
      s({
        entry_id: "e1",
        repeat: 1,
        known_total: 2,
        known_matched: 2,
        matched_ids: ["K1", "K2"],
      }),
      s({
        entry_id: "e1",
        repeat: 2,
        known_total: 2,
        known_matched: 1,
        matched_ids: ["K1"],
      }),
      s({
        entry_id: "c1",
        kind: "control",
        repeat: 1,
        known_total: 0,
        known_matched: 0,
        matched_ids: [],
        medium_plus: 1,
      }),
      s({
        entry_id: "c1",
        kind: "control",
        repeat: 2,
        known_total: 0,
        known_matched: 0,
        matched_ids: [],
        medium_plus: 0,
        valid: false,
      }),
      s({ entry_id: "only-first", repeat: 1 }),
    ];
    const noise = computeNoise(runs)!;
    expect(noise.repeats).toEqual([1, 2]);
    expect(noise.entries_compared).toBe(2);
    expect(noise.recall_entries).toBe(1);
    expect(noise.control_entries).toBe(1);
    expect(noise.recall_by_repeat).toEqual([1, 0.5]);
    expect(noise.recall_range).toBe(0.5);
    expect(noise.false_positives_by_repeat).toEqual([1, 0]);
    expect(noise.false_positives_range).toBe(1);
    expect(noise.false_positive_rate_range).toBe(1);
    expect(noise.validity_range).toBe(0.5);
    expect(noise.flip_rate).toBe(0.5);
  });

  it("reports zero spread for identical repeats", () => {
    const runs = [1, 2].map((repeat) => s({ repeat }));
    const noise = computeNoise(runs)!;
    expect(noise.recall_range).toBe(0);
    expect(noise.flip_rate).toBe(0);
  });

  it("uses only entries judged in every repeat for the recall figures", () => {
    const runs = [
      s({ entry_id: "e1", repeat: 1, known_total: 1, known_matched: 1 }),
      s({ entry_id: "e1", repeat: 2, known_total: 1, known_matched: 1 }),
      // e2 is judged in repeat 1 only: it must not enter either repeat's recall.
      s({ entry_id: "e2", repeat: 1, known_total: 1, known_matched: 0 }),
      s({ entry_id: "e2", repeat: 2, known_total: 1, known_matched: null }),
    ];
    const noise = computeNoise(runs)!;
    expect(noise.entries_compared).toBe(2);
    expect(noise.recall_entries).toBe(1);
    expect(noise.recall_by_repeat).toEqual([1, 1]);
    expect(noise.recall_range).toBe(0);
  });

  it("leaves session failures out of the noise", () => {
    const runs = [
      s({ entry_id: "e1", repeat: 1, known_total: 1, known_matched: 1 }),
      s({ entry_id: "e1", repeat: 2, known_total: 1, known_matched: 1 }),
      s({ entry_id: "e2", repeat: 1, known_total: 1, known_matched: 1 }),
      s({
        entry_id: "e2",
        repeat: 2,
        known_total: 1,
        known_matched: 0,
        status: "session_failed",
      }),
    ];
    const noise = computeNoise(runs)!;
    expect(noise.entries_compared).toBe(1);
    expect(noise.recall_range).toBe(0);
  });
});

describe("compareVariants", () => {
  const aRuns = [1, 2].flatMap((repeat) => [
    s({
      entry_id: "e1",
      repeat,
      known_total: 2,
      known_matched: 2,
      matched_ids: ["K1", "K2"],
    }),
    s({
      entry_id: "e2",
      repeat,
      known_total: 2,
      known_matched: repeat === 1 ? 1 : 2,
      matched_ids: ["K1"],
    }),
    s({
      entry_id: "c1",
      kind: "control",
      repeat,
      known_total: 0,
      known_matched: 0,
      matched_ids: [],
      medium_plus: 0,
    }),
  ]);
  const bRuns = [
    s({
      entry_id: "e1",
      known_total: 2,
      known_matched: 0,
      matched_ids: [],
      valid: false,
    }),
    s({
      entry_id: "e2",
      known_total: 2,
      known_matched: 2,
      matched_ids: ["K1", "K2"],
    }),
    s({
      entry_id: "c1",
      kind: "control",
      known_total: 0,
      known_matched: 0,
      matched_ids: [],
      medium_plus: 2,
    }),
  ];

  it("gives deltas, the noise reference and a paired recall count", () => {
    const comparison = compareVariants(
      { id: "a", scores: aRuns, noise: computeNoise(aRuns) },
      { id: "b", scores: bRuns },
      0,
    );
    expect(comparison.recall.a).toBeCloseTo(7 / 8);
    expect(comparison.recall.b).toBe(0.5);
    expect(comparison.recall.delta).toBeCloseTo(-3 / 8);
    expect(comparison.recall.noise).toBeCloseTo(1 / 4);
    expect(comparison.recall.exceeds_noise).toBe(true);
    expect(comparison.false_positives.delta).toBe(2);
    expect(comparison.false_positives.exceeds_noise).toBe(true);
    expect(comparison.validity.delta).toBeCloseTo(-1 / 3);
    expect(comparison.paired_recall).toEqual({
      entries: 2,
      b_higher: 1,
      equal: 0,
      b_lower: 1,
    });
    expect(comparison.recall.n).toBe(2);
    expect(comparison.recall.a_repeats).toBe(2);
    expect(comparison.recall.b_repeats).toBe(1);
  });

  it("applies a noise floor of one entry's worth when the range is zero", () => {
    // Two identical repeats: A's recall range is 0 on 4 entries.
    const ids = ["e1", "e2", "e3", "e4"];
    const a = [1, 2].flatMap((repeat) =>
      ids.map((id) =>
        s({ entry_id: id, repeat, known_total: 1, known_matched: 1 }),
      ),
    );
    const b = ids.map((id, i) =>
      s({ entry_id: id, known_total: 1, known_matched: i === 0 ? 0 : 1 }),
    );
    const zeroFloor = compareVariants(
      { id: "a", scores: a, noise: computeNoise(a) },
      { id: "b", scores: b },
      0,
    );
    expect(zeroFloor.recall.noise).toBe(0);
    expect(zeroFloor.recall.delta).toBe(-0.25);
    expect(zeroFloor.recall.exceeds_noise).toBe(true);
    const defaultFloor = compareVariants(
      { id: "a", scores: a, noise: computeNoise(a) },
      { id: "b", scores: b },
    );
    // One entry of four is 0.25: a one-entry change is not above the floor.
    expect(defaultFloor.recall.floor).toBe(0.25);
    expect(defaultFloor.recall.threshold).toBe(0.25);
    expect(defaultFloor.recall.exceeds_noise).toBe(false);
    const twoEntries = b.map((r, i) =>
      i === 1 ? { ...r, known_matched: 0 } : r,
    );
    expect(
      compareVariants(
        { id: "a", scores: a, noise: computeNoise(a) },
        { id: "b", scores: twoEntries },
      ).recall.exceeds_noise,
    ).toBe(true);
  });

  it("pairs entries and uses per-entry means when the repeat counts differ", () => {
    // A: e1 judged three times (1, 1, 0), e2 once (0). B: each once.
    const a = [
      s({ entry_id: "e1", repeat: 1, known_total: 1, known_matched: 1 }),
      s({ entry_id: "e1", repeat: 2, known_total: 1, known_matched: 1 }),
      s({ entry_id: "e1", repeat: 3, known_total: 1, known_matched: 0 }),
      s({ entry_id: "e2", repeat: 1, known_total: 1, known_matched: 0 }),
      // Only A has e3: it is not paired.
      s({ entry_id: "e3", repeat: 1, known_total: 1, known_matched: 1 }),
    ];
    const b = [
      s({ entry_id: "e1", known_total: 1, known_matched: 1 }),
      s({ entry_id: "e2", known_total: 1, known_matched: 1 }),
    ];
    const c = compareVariants(
      { id: "a", scores: a, noise: null },
      { id: "b", scores: b },
    );
    expect(c.recall.n).toBe(2);
    expect(c.recall.a).toBeCloseTo((2 / 3 + 0) / 2);
    expect(c.recall.b).toBe(1);
    expect(c.recall.a_repeats).toBe(3);
    expect(c.recall.b_repeats).toBe(1);
    expect(c.recall.exceeds_noise).toBeNull();
  });

  it("keeps setup failures and session failures out of the paired recall", () => {
    const a = [
      s({ entry_id: "e1", repeat: 1, known_total: 1, known_matched: 1 }),
      // A setup failure scores 0 matched (no output); it must not halve e1.
      s({
        entry_id: "e1",
        repeat: 2,
        known_total: 1,
        known_matched: 0,
        status: "setup_failed",
      }),
      s({
        entry_id: "e1",
        repeat: 3,
        known_total: 1,
        known_matched: 0,
        status: "session_failed",
      }),
    ];
    const b = [s({ entry_id: "e1", known_total: 1, known_matched: 1 })];
    const c = compareVariants(
      { id: "a", scores: a, noise: null },
      { id: "b", scores: b },
    );
    expect(c.recall.a).toBe(1);
    expect(c.recall.delta).toBe(0);
    expect(c.paired_recall.equal).toBe(1);
    expect(entryMeans(a).get("e1")!.judged_repeats).toEqual([1]);
  });

  it("treats a delta exactly as large as the noise range as within noise", () => {
    // Recall by repeat is 1 and 0.5 (range 0.5, mean 0.75); B scores 0.25.
    const a = [
      s({
        repeat: 1,
        known_total: 2,
        known_matched: 2,
        matched_ids: ["K1", "K2"],
      }),
      s({ repeat: 2, known_total: 2, known_matched: 1, matched_ids: ["K1"] }),
    ];
    const b = [
      s({ repeat: 1, known_total: 2, known_matched: 1, matched_ids: ["K1"] }),
      s({ repeat: 2, known_total: 2, known_matched: 0, matched_ids: [] }),
    ];
    const comparison = compareVariants(
      { id: "a", scores: a, noise: computeNoise(a) },
      { id: "b", scores: b },
      0,
    );
    expect(comparison.recall.delta).toBe(-0.5);
    expect(comparison.recall.noise).toBe(0.5);
    expect(comparison.recall.exceeds_noise).toBe(false);
  });

  it("marks a delta within the noise range", () => {
    const b = aRuns.map((r) => ({ ...r }));
    const comparison = compareVariants(
      { id: "a", scores: aRuns, noise: computeNoise(aRuns) },
      { id: "b", scores: b },
    );
    expect(comparison.recall.delta).toBe(0);
    expect(comparison.recall.exceeds_noise).toBe(false);
  });

  it("has no verdict without a noise measurement", () => {
    const comparison = compareVariants(
      { id: "a", scores: bRuns, noise: null },
      { id: "b", scores: bRuns },
    );
    expect(comparison.recall.exceeds_noise).toBeNull();
  });
});

describe("provenance warnings", () => {
  const run = (over: Partial<RunResult> = {}): RunResult =>
    ({ effort: "high", cli_version: "2.1.302", ...over }) as RunResult;
  const judge = (over: Partial<JudgeFile> = {}): JudgeFile => ({
    matches: [],
    model: "sonnet",
    effort: "high",
    cli_version: "2.1.302",
    cost_usd: null,
    ...over,
  });

  it("is silent when both variants ran and were judged with the same settings", () => {
    const same = [runProvenance(run(), judge()), runProvenance(run(), null)];
    expect(
      provenanceWarnings({ id: "a", runs: same }, { id: "b", runs: same }),
    ).toEqual([]);
  });

  it("counts a field missing from an older record as unknown, and no judged run as none", () => {
    const old = { effort: "high" } as RunResult;
    const legacy = {
      matches: [],
      model: "sonnet",
      cost_usd: null,
    } as JudgeFile;
    const warnings = provenanceWarnings(
      { id: "a", runs: [runProvenance(old, legacy)] },
      { id: "b", runs: [runProvenance(run(), null)] },
    );
    expect(warnings).toEqual([
      "a and b differ in judge model (a: sonnet; b: none); the comparison mixes settings",
      "a and b differ in judge effort (a: unknown; b: none); the comparison mixes settings",
      "a and b differ in judge CLI version (a: unknown; b: none); the comparison mixes settings",
      "a and b differ in reviewer CLI version (a: unknown; b: 2.1.302); the comparison mixes settings",
    ]);
  });
});

describe("leak tags", () => {
  it("splits scores by the excluded leak tags", () => {
    const runs = [
      s({ entry_id: "e1", leak: "none" }),
      s({ entry_id: "e2", leak: "partial" }),
      s({ entry_id: "e3", leak: "high" }),
    ];
    const high = splitByLeak(runs, ["high"]);
    expect(high.kept.map((r) => r.entry_id)).toEqual(["e1", "e2"]);
    expect(high.excluded.map((r) => r.entry_id)).toEqual(["e3"]);
    const both = splitByLeak(runs, ["high", "partial"]);
    expect(both.kept.map((r) => r.entry_id)).toEqual(["e1"]);
    expect(splitByLeak(runs, []).kept).toHaveLength(3);
  });

  it("carries the entry's leak tag into the run score", () => {
    const tagged = entry({ leak: "high" });
    expect(scoreRun(tagged, result(reviewerReturn()), null).leak).toBe("high");
  });
});

describe("report rendering", () => {
  it("renders an aggregate table with exclusions and noise notes", () => {
    const runs = [1, 2].map((repeat) => s({ repeat }));
    const text = renderAggregates([
      {
        aggregate: aggregate("v1", [
          ...runs,
          s({ entry_id: "x", status: "setup_failed" }),
        ]),
        noise: computeNoise(runs),
      },
    ]);
    expect(text).toContain("| v1 | 2 | 2 | 0 | 0 | 1 | 2 |");
    expect(text).toContain("1 run(s) excluded after a setup failure");
    expect(text).toContain("noise over 2 repeats");
  });

  it("never prints a negative zero for a tiny negative delta", () => {
    const a = [s({ wall_ms: 10_200 })];
    const b = [s({ wall_ms: 10_000 })];
    const text = renderComparison(
      compareVariants(
        { id: "a", scores: a, noise: null },
        { id: "b", scores: b },
      ),
    );
    expect(text).toContain("| wall mean s | 10 | 10 | 0 |");
    expect(text).not.toMatch(/\|\s-0(\.0+)?%?\s\|/);
  });

  it("renders a comparison with verdicts", () => {
    const text = renderComparison(
      compareVariants(
        { id: "a", scores: [s({})], noise: null },
        { id: "b", scores: [s({})] },
      ),
    );
    expect(text).toContain("| recall |");
    expect(text).toContain(
      "no noise reference (n=1, A 1 repeat(s), B 1 repeat(s))",
    );
  });
});

describe("prompt variants", () => {
  const prompt = [
    "---",
    "name: reviewer",
    'description: "A reviewer."',
    "---",
    "",
    "Intro line.",
    "",
    "Check, at minimum:",
    "",
    "- item one",
    "- item two",
    "",
    "Rules:",
    "",
    "- rule one",
    "",
  ].join("\n");

  it("drops exactly the check list and keeps everything else", () => {
    const degraded = degradeReviewerPrompt(prompt);
    expect(degraded).not.toContain("Check, at minimum:");
    expect(degraded).not.toContain("item one");
    expect(degraded).toContain("Intro line.");
    expect(degraded).toContain("Rules:\n\n- rule one");
    expect(degraded.split("\n").length).toBe(prompt.split("\n").length - 5);
  });

  it("refuses a prompt whose anchors are gone or reordered", () => {
    expect(() => degradeReviewerPrompt("no anchors")).toThrow(
      /anchor not found/,
    );
    expect(() => degradeReviewerPrompt("Rules:\nCheck, at minimum:\n")).toThrow(
      /must come after/,
    );
    expect(() => degradeReviewerPrompt("Check, at minimum:\n- x")).toThrow(
      /Rules:/,
    );
  });

  it("splits frontmatter from body", () => {
    const { frontmatter, body } = splitPrompt(prompt);
    expect(frontmatter).toEqual({
      name: "reviewer",
      description: "A reviewer.",
    });
    expect(body.startsWith("\nIntro line.")).toBe(true);
    expect(splitPrompt("plain text")).toEqual({
      frontmatter: {},
      body: "plain text",
    });
  });

  it("hashes the whole file text", () => {
    const v = makeVariant("v1", "src", prompt);
    expect(v.sha256).toBe(sha256(prompt));
    expect(v.sha256).toHaveLength(64);
  });

  const repoRoot = new URL("../../..", import.meta.url).pathname;
  const hasRevision = ((): boolean => {
    try {
      execFileSync(
        "git",
        ["-C", repoRoot, "cat-file", "-e", `${DEFAULT_REVISION}^{commit}`],
        { stdio: "ignore" },
      );
      return true;
    } catch {
      return false;
    }
  })();

  it("resolves the working-tree prompt through a file spec", () => {
    const file = join(
      repoRoot,
      "packages/orchestrator-workflow/assets/agents/reviewer.md",
    );
    const variant = resolveVariant({
      spec: `file:${file}`,
      id: "tree",
      repoRoot,
      revision: "unused",
    });
    expect(variant.id).toBe("tree");
    expect(variant.source).toBe("file:reviewer.md");
    expect(variant.text).toContain("Check, at minimum:");
    expect(degradeReviewerPrompt(variant.text)).not.toContain(
      "Check, at minimum:",
    );
  });

  it.skipIf(!hasRevision)(
    "resolves the shipped prompt at the default revision, and degrades it",
    () => {
      const current = resolveVariant({
        spec: "current",
        repoRoot,
        revision: DEFAULT_REVISION,
      });
      const degraded = resolveVariant({
        spec: "degraded",
        repoRoot,
        revision: DEFAULT_REVISION,
      });
      expect(current.id).toBe("current");
      expect(current.text).toContain("Check, at minimum:");
      expect(degraded.text).not.toContain("Check, at minimum:");
      expect(degraded.text.length).toBeLessThan(current.text.length);
      expect(degraded.sha256).not.toBe(current.sha256);
      expect(current.source).toContain(DEFAULT_REVISION);
    },
  );

  it("refuses a variant id that could leave the results directory", () => {
    for (const id of ["a/b", "..", "../x", "UPPER", "x", "has.dot"]) {
      expect(() => makeVariant(id, "src", prompt), id).toThrow(/must match/);
    }
    const file = join(
      repoRoot,
      "packages/orchestrator-workflow/assets/agents/reviewer.md",
    );
    // The file stem "reviewer" is fine; an explicit bad id is not.
    expect(
      resolveVariant({ spec: `file:${file}`, repoRoot, revision: "unused" }).id,
    ).toBe("reviewer");
    expect(() =>
      resolveVariant({
        spec: `file:${file}`,
        id: "../escape",
        repoRoot,
        revision: "unused",
      }),
    ).toThrow(/must match/);
  });

  it("rejects an unknown variant spec and an empty file spec", () => {
    const base = { repoRoot: ".", revision: "x" };
    expect(() => resolveVariant({ ...base, spec: "other" })).toThrow(
      /unknown variant/,
    );
    expect(() => resolveVariant({ ...base, spec: "file:" })).toThrow(
      /needs a path/,
    );
  });
});
