import { parse as parseYaml } from "yaml";

import { validateReviewReport } from "../src/review-report.js";
import { MEDIUM_PLUS } from "./dataset.js";
import type { DatasetEntry, EntryKind, KnownFinding } from "./dataset.js";

/* ------------------------------------------------------------------ */
/* Return validity                                                      */
/* ------------------------------------------------------------------ */

export interface FencedBlock {
  tag: string;
  body: string;
}

/**
 * Fenced code blocks of a text, in order. A fence opens with three or more
 * backticks or tildes (up to three spaces of indent) and closes on a line of
 * the same character, at least as long, with nothing else on it; an unclosed
 * fence runs to the end of the text.
 */
export function fencedBlocks(text: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const lines = text.split(/\r?\n/);
  let open: {
    char: string;
    length: number;
    tag: string;
    body: string[];
  } | null = null;
  for (const line of lines) {
    if (open === null) {
      const match = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
      if (match !== null) {
        open = {
          char: match[1][0],
          length: match[1].length,
          tag: match[2].toLowerCase(),
          body: [],
        };
      }
      continue;
    }
    const closer = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
    if (
      closer !== null &&
      closer[1][0] === open.char &&
      closer[1].length >= open.length
    ) {
      blocks.push({ tag: open.tag, body: open.body.join("\n") });
      open = null;
    } else {
      open.body.push(line);
    }
  }
  if (open !== null) blocks.push({ tag: open.tag, body: open.body.join("\n") });
  return blocks;
}

export interface ReportedFinding {
  severity: string;
  category: string | null;
  description: string | null;
}

export interface ReturnCheck {
  /** Exactly one yaml fence, and it passes the reviewer contract validator. */
  valid: boolean;
  reasons: string[];
  warnings: string[];
  yaml_blocks: number;
  acceptance_recommendation: string | null;
  findings: ReportedFinding[];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Validity of a reviewer's final message. Deterministic and structural: the
 * message must carry exactly one `yaml` fenced block and that block must pass
 * the reviewer output contract (mandatory fields and enum spellings).
 */
export function checkReturn(finalText: string): ReturnCheck {
  const empty: ReturnCheck = {
    valid: false,
    reasons: [],
    warnings: [],
    yaml_blocks: 0,
    acceptance_recommendation: null,
    findings: [],
  };
  if (finalText.trim().length === 0) {
    return { ...empty, reasons: ["empty output"] };
  }
  const yamlBlocks = fencedBlocks(finalText).filter(
    (b) => b.tag === "yaml" || b.tag === "yml",
  );
  if (yamlBlocks.length !== 1) {
    return {
      ...empty,
      yaml_blocks: yamlBlocks.length,
      reasons: [
        yamlBlocks.length === 0
          ? "no yaml fenced block"
          : `${yamlBlocks.length} yaml fenced blocks, expected exactly one`,
      ],
    };
  }
  const validation = validateReviewReport(finalText);
  const reasons = validation.diagnostics.map(
    (d) => `${d.path}: expected ${d.expected}, got ${d.got}`,
  );
  let report: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = parseYaml(yamlBlocks[0].body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      report = parsed as Record<string, unknown>;
    }
  } catch {
    report = null;
  }
  const findings: ReportedFinding[] = [];
  if (report !== null && Array.isArray(report.findings)) {
    for (const item of report.findings) {
      if (typeof item === "object" && item !== null) {
        const rec = item as Record<string, unknown>;
        findings.push({
          severity: str(rec.severity) ?? "",
          category: str(rec.category),
          description: str(rec.description),
        });
      }
    }
  }
  return {
    valid: validation.valid,
    reasons,
    warnings: validation.warnings,
    yaml_blocks: 1,
    acceptance_recommendation: report
      ? str(report.acceptance_recommendation)
      : null,
    findings,
  };
}

/** Count of reported findings at medium severity or higher. */
export function mediumPlusCount(check: ReturnCheck): number {
  return check.findings.filter((f) => MEDIUM_PLUS.includes(f.severity)).length;
}

/* ------------------------------------------------------------------ */
/* Run records                                                          */
/* ------------------------------------------------------------------ */

export type RunStatus =
  | "completed"
  | "timeout"
  | "session_failed"
  | "setup_failed";

export interface RunResult {
  schema: number;
  entry_id: string;
  kind: EntryKind;
  repeat: number;
  started_at: string;
  variant: { id: string; source: string; sha256: string };
  prompt_sha256: string;
  model: string;
  effort: string;
  status: RunStatus;
  exit_code: number | null;
  signal: string | null;
  /** Whole run, checkout and setup included. */
  wall_ms: number;
  /** The review session alone, as measured around the claude process. */
  session_wall_ms: number | null;
  cost_usd: number | null;
  turns: number | null;
  session_ms: number | null;
  final_text: string;
  check: ReturnCheck;
  checkout: {
    head_sha: string;
    setup_ok: boolean;
    dirty_after_setup: boolean;
    cleaned_up: boolean;
  };
}

/* ------------------------------------------------------------------ */
/* Blind judge                                                          */
/* ------------------------------------------------------------------ */

export const JUDGE_RUBRIC = [
  "You grade a code review against a list of known defects. Each known defect was confirmed and fixed after an earlier review.",
  "",
  "A known defect is MATCHED when the review reports, as one of its findings, a defect of the same class: the same root cause and the same kind of failure in the same change. Judge the class, not the wording or the line numbers. A finding at a different site, in different words, or under a different severity label still counts when it names the same underlying flaw.",
  "",
  "A known defect is NOT matched when:",
  "- the review only touches the same file or topic but names a different flaw;",
  '- the review gives a generic remark (for example "add more tests") that would not lead the author to the known defect;',
  "- the defect appears only in a summary, a residual-risk note or a withdrawn item, and not as a finding;",
  "- you cannot tell, in which case decide not matched and say why.",
  "",
  "Use only the two inputs below. Do not guess what the review author knew.",
].join("\n");

export function buildJudgePrompt(
  known: KnownFinding[],
  reviewerOutput: string,
): string {
  const ids = known.map((k) => k.id);
  const list = known
    .map((k) => {
      const files =
        k.files && k.files.length > 0 ? `\n  files: ${k.files.join(", ")}` : "";
      return `- ${k.id} [${k.severity}, ${k.category}]: ${k.description}${files}`;
    })
    .join("\n");
  return [
    JUDGE_RUBRIC,
    "",
    "## Known defects",
    "",
    list,
    "",
    "## Review under test",
    "",
    "<review>",
    reviewerOutput,
    "</review>",
    "",
    "## Answer",
    "",
    `Answer with exactly one fenced json block and nothing after it. It has one entry per known defect (${ids.join(", ")}), each exactly once:`,
    "",
    "```json",
    '{"matches": [{"id": "K1", "matched": true, "evidence": "quote or paraphrase of the review finding that matches, or why not"}]}',
    "```",
  ].join("\n");
}

export interface JudgeMatch {
  id: string;
  matched: boolean;
  evidence: string;
}

export interface JudgeParse {
  ok: boolean;
  matches: JudgeMatch[];
  errors: string[];
}

/** Parses the judge's answer; every known id must appear exactly once. */
export function parseJudgeAnswer(text: string, knownIds: string[]): JudgeParse {
  const blocks = fencedBlocks(text).filter((b) => b.tag === "json");
  const source =
    blocks.length > 0 ? blocks[blocks.length - 1].body : text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return {
      ok: false,
      matches: [],
      errors: [
        `answer is not valid JSON: ${error instanceof Error ? error.message : error}`,
      ],
    };
  }
  const errors: string[] = [];
  const matches: JudgeMatch[] = [];
  const list =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).matches
      : undefined;
  if (!Array.isArray(list)) {
    return { ok: false, matches: [], errors: ["answer needs a matches array"] };
  }
  const seen = new Set<string>();
  list.forEach((item, i) => {
    const rec =
      typeof item === "object" && item !== null
        ? (item as Record<string, unknown>)
        : null;
    if (rec === null) {
      errors.push(`matches[${i}]: expected an object`);
      return;
    }
    const id = rec.id;
    if (typeof id !== "string" || !knownIds.includes(id)) {
      errors.push(`matches[${i}].id: unknown id ${String(id)}`);
      return;
    }
    if (seen.has(id)) {
      errors.push(`matches[${i}].id: ${id} answered twice`);
      return;
    }
    seen.add(id);
    if (typeof rec.matched !== "boolean") {
      errors.push(`matches[${i}].matched: expected a boolean for ${id}`);
      return;
    }
    const evidence = typeof rec.evidence === "string" ? rec.evidence : "";
    if (rec.matched && evidence.trim().length === 0) {
      errors.push(`matches[${i}].evidence: a match for ${id} needs evidence`);
      return;
    }
    matches.push({ id, matched: rec.matched, evidence });
  });
  for (const id of knownIds) {
    if (!seen.has(id)) errors.push(`known defect ${id} was not answered`);
  }
  return {
    ok: errors.length === 0,
    matches: errors.length === 0 ? matches : [],
    errors,
  };
}

export interface JudgeFile {
  matches: JudgeMatch[];
  model: string | null;
  cost_usd: number | null;
}

/* ------------------------------------------------------------------ */
/* Per-run score and aggregation                                        */
/* ------------------------------------------------------------------ */

export interface RunScore {
  entry_id: string;
  kind: EntryKind;
  repeat: number;
  status: RunStatus;
  valid: boolean;
  medium_plus: number;
  known_total: number;
  /** null when the run needs a judgment and has none yet. */
  known_matched: number | null;
  matched_ids: string[];
  cost_usd: number | null;
  wall_ms: number;
}

function knownMediumPlus(entry: DatasetEntry): KnownFinding[] {
  return entry.known_findings.filter((k) => MEDIUM_PLUS.includes(k.severity));
}

/** Scores one run; `judge` is the blind judge's file for a finding entry. */
export function scoreRun(
  entry: DatasetEntry,
  result: RunResult,
  judge: JudgeFile | null,
): RunScore {
  const known = knownMediumPlus(entry);
  let matchedIds: string[] = [];
  let knownMatched: number | null = null;
  if (entry.kind === "control") {
    knownMatched = 0;
  } else if (result.final_text.trim().length === 0) {
    knownMatched = 0;
  } else if (judge !== null) {
    matchedIds = judge.matches
      .filter((m) => m.matched && known.some((k) => k.id === m.id))
      .map((m) => m.id);
    knownMatched = matchedIds.length;
  }
  return {
    entry_id: entry.id,
    kind: entry.kind,
    repeat: result.repeat,
    status: result.status,
    valid: result.check.valid,
    medium_plus: mediumPlusCount(result.check),
    known_total: known.length,
    known_matched: knownMatched,
    matched_ids: matchedIds,
    cost_usd: result.cost_usd,
    wall_ms: result.session_wall_ms ?? result.wall_ms,
  };
}

export interface VariantAggregate {
  variant_id: string;
  /** Runs counted (setup failures excluded). */
  n_runs: number;
  n_excluded: number;
  n_entries: number;
  n_finding_runs: number;
  n_control_runs: number;
  validity_rate: number | null;
  /** Matched known defects over all known defects of judged finding runs. */
  recall: number | null;
  /** Mean of the per-run recall values. */
  recall_macro: number | null;
  judged_finding_runs: number;
  unjudged_finding_runs: number;
  /** Medium-or-higher findings reported on control runs. */
  false_positives: number;
  false_positives_per_control_run: number | null;
  controls_with_false_positive: number;
  cost_total_usd: number;
  cost_mean_usd: number | null;
  wall_total_s: number;
  wall_mean_s: number | null;
  timeouts: number;
}

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

export function aggregate(
  variantId: string,
  scores: RunScore[],
): VariantAggregate {
  const counted = scores.filter((s) => s.status !== "setup_failed");
  const findingRuns = counted.filter((s) => s.kind === "finding");
  const controlRuns = counted.filter((s) => s.kind === "control");
  const judged = findingRuns.filter((s) => s.known_matched !== null);
  const known = judged.reduce((sum, s) => sum + s.known_total, 0);
  const matched = judged.reduce((sum, s) => sum + (s.known_matched ?? 0), 0);
  const perRun = judged
    .filter((s) => s.known_total > 0)
    .map((s) => (s.known_matched ?? 0) / s.known_total);
  const falsePositives = controlRuns.reduce((sum, s) => sum + s.medium_plus, 0);
  const costs = counted
    .map((s) => s.cost_usd)
    .filter((c): c is number => c !== null);
  const wallTotal = counted.reduce((sum, s) => sum + s.wall_ms, 0) / 1000;
  return {
    variant_id: variantId,
    n_runs: counted.length,
    n_excluded: scores.length - counted.length,
    n_entries: new Set(counted.map((s) => s.entry_id)).size,
    n_finding_runs: findingRuns.length,
    n_control_runs: controlRuns.length,
    validity_rate: ratio(counted.filter((s) => s.valid).length, counted.length),
    recall: ratio(matched, known),
    recall_macro:
      perRun.length === 0
        ? null
        : perRun.reduce((a, b) => a + b, 0) / perRun.length,
    judged_finding_runs: judged.length,
    unjudged_finding_runs: findingRuns.length - judged.length,
    false_positives: falsePositives,
    false_positives_per_control_run: ratio(falsePositives, controlRuns.length),
    controls_with_false_positive: controlRuns.filter((s) => s.medium_plus > 0)
      .length,
    cost_total_usd: costs.reduce((a, b) => a + b, 0),
    cost_mean_usd:
      costs.length === 0
        ? null
        : costs.reduce((a, b) => a + b, 0) / costs.length,
    wall_total_s: wallTotal,
    wall_mean_s: counted.length === 0 ? null : wallTotal / counted.length,
    timeouts: counted.filter((s) => s.status === "timeout").length,
  };
}

/* ------------------------------------------------------------------ */
/* Noise and comparison                                                 */
/* ------------------------------------------------------------------ */

export interface NoiseReport {
  repeats: number[];
  /** Entries present in every repeat (and judged, for the recall figures). */
  entries_compared: number;
  recall_by_repeat: (number | null)[];
  false_positives_by_repeat: number[];
  validity_by_repeat: (number | null)[];
  /** Largest minus smallest value across the repeats. */
  recall_range: number | null;
  false_positives_range: number;
  /** Range of the per-control-entry false-positive rate across repeats. */
  false_positive_rate_range: number | null;
  validity_range: number | null;
  /** Known defects matched in some repeat and missed in another. */
  flip_rate: number | null;
}

function spread(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) return null;
  return Math.max(...nums) - Math.min(...nums);
}

/**
 * Run-to-run noise of one variant: the same entries scored once per repeat,
 * compared across repeats. Needs at least two repeats; returns null otherwise.
 */
export function computeNoise(scores: RunScore[]): NoiseReport | null {
  const counted = scores.filter((s) => s.status !== "setup_failed");
  const repeats = [...new Set(counted.map((s) => s.repeat))].sort(
    (a, b) => a - b,
  );
  if (repeats.length < 2) return null;
  const byEntry = new Map<string, Map<number, RunScore>>();
  for (const s of counted) {
    const inner = byEntry.get(s.entry_id) ?? new Map<number, RunScore>();
    inner.set(s.repeat, s);
    byEntry.set(s.entry_id, inner);
  }
  const common = [...byEntry.entries()]
    .filter(([, inner]) => repeats.every((r) => inner.has(r)))
    .map(([id]) => id);
  const pick = (repeat: number): RunScore[] =>
    common.map((id) => byEntry.get(id)!.get(repeat)!);

  const recallBy: (number | null)[] = [];
  const fpBy: number[] = [];
  const fpRateBy: (number | null)[] = [];
  const validBy: (number | null)[] = [];
  for (const repeat of repeats) {
    const runs = pick(repeat);
    const findings = runs.filter(
      (s) => s.kind === "finding" && s.known_matched !== null,
    );
    recallBy.push(
      ratio(
        findings.reduce((sum, s) => sum + (s.known_matched ?? 0), 0),
        findings.reduce((sum, s) => sum + s.known_total, 0),
      ),
    );
    const controls = runs.filter((s) => s.kind === "control");
    const fp = controls.reduce((sum, s) => sum + s.medium_plus, 0);
    fpBy.push(fp);
    fpRateBy.push(ratio(fp, controls.length));
    validBy.push(ratio(runs.filter((s) => s.valid).length, runs.length));
  }

  let flips = 0;
  let pairs = 0;
  for (const id of common) {
    const runs = repeats.map((r) => byEntry.get(id)!.get(r)!);
    if (
      runs[0].kind !== "finding" ||
      runs.some((s) => s.known_matched === null)
    )
      continue;
    const allIds = new Set(runs.flatMap((s) => s.matched_ids));
    // Each matched id counts as a pair; a pair flips when a repeat misses it.
    for (const kid of allIds) {
      pairs += 1;
      if (!runs.every((s) => s.matched_ids.includes(kid))) flips += 1;
    }
  }

  return {
    repeats,
    entries_compared: common.length,
    recall_by_repeat: recallBy,
    false_positives_by_repeat: fpBy,
    validity_by_repeat: validBy,
    recall_range: spread(recallBy),
    false_positives_range: Math.max(...fpBy) - Math.min(...fpBy),
    false_positive_rate_range: spread(fpRateBy),
    validity_range: spread(validBy),
    flip_rate: ratio(flips, pairs),
  };
}

export interface MetricDelta {
  a: number | null;
  b: number | null;
  /** b minus a. */
  delta: number | null;
  /** Noise range of variant a for this metric, when measured. */
  noise: number | null;
  /** True when |delta| is larger than the noise range; null when unmeasured. */
  exceeds_noise: boolean | null;
}

export interface Comparison {
  a: string;
  b: string;
  recall: MetricDelta;
  false_positives: MetricDelta;
  validity: MetricDelta;
  cost_mean_usd: MetricDelta;
  wall_mean_s: MetricDelta;
  /** Entries both variants ran, with b's mean recall above, equal to or below a's. */
  paired_recall: {
    entries: number;
    b_higher: number;
    equal: number;
    b_lower: number;
  };
}

function delta(
  a: number | null,
  b: number | null,
  noise: number | null,
): MetricDelta {
  const d = a === null || b === null ? null : b - a;
  return {
    a,
    b,
    delta: d,
    noise,
    exceeds_noise: d === null || noise === null ? null : Math.abs(d) > noise,
  };
}

function meanRecallByEntry(scores: RunScore[]): Map<string, number> {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const s of scores) {
    if (s.kind !== "finding" || s.known_matched === null || s.known_total === 0)
      continue;
    if (s.status === "setup_failed") continue;
    const cur = sums.get(s.entry_id) ?? { sum: 0, n: 0 };
    cur.sum += s.known_matched / s.known_total;
    cur.n += 1;
    sums.set(s.entry_id, cur);
  }
  return new Map([...sums].map(([id, v]) => [id, v.sum / v.n]));
}

export function compareVariants(
  a: {
    aggregate: VariantAggregate;
    scores: RunScore[];
    noise: NoiseReport | null;
  },
  b: { aggregate: VariantAggregate; scores: RunScore[] },
): Comparison {
  const ma = meanRecallByEntry(a.scores);
  const mb = meanRecallByEntry(b.scores);
  let higher = 0;
  let equal = 0;
  let lower = 0;
  let entries = 0;
  for (const [id, va] of ma) {
    const vb = mb.get(id);
    if (vb === undefined) continue;
    entries += 1;
    if (Math.abs(vb - va) < 1e-9) equal += 1;
    else if (vb > va) higher += 1;
    else lower += 1;
  }
  const noise = a.noise;
  return {
    a: a.aggregate.variant_id,
    b: b.aggregate.variant_id,
    recall: delta(
      a.aggregate.recall,
      b.aggregate.recall,
      noise?.recall_range ?? null,
    ),
    false_positives: delta(
      a.aggregate.false_positives_per_control_run,
      b.aggregate.false_positives_per_control_run,
      noise?.false_positive_rate_range ?? null,
    ),
    validity: delta(
      a.aggregate.validity_rate,
      b.aggregate.validity_rate,
      noise?.validity_range ?? null,
    ),
    cost_mean_usd: delta(
      a.aggregate.cost_mean_usd,
      b.aggregate.cost_mean_usd,
      null,
    ),
    wall_mean_s: delta(a.aggregate.wall_mean_s, b.aggregate.wall_mean_s, null),
    paired_recall: { entries, b_higher: higher, equal, b_lower: lower },
  };
}
