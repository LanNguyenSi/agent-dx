import { parse as parseYaml } from "yaml";

import { validateReviewReport } from "../src/review-report.js";
import { MEDIUM_PLUS } from "./dataset.js";
import type {
  DatasetEntry,
  EntryKind,
  KnownFinding,
  LeakTag,
} from "./dataset.js";

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

/** What a guarded command left behind, as the run record keeps it. */
export interface ProcessRecord {
  /** `agent-primitives guard`'s reason (`none`, `timeout`, `rss_cap`, `leftover`, ...), or null when it reported nothing. */
  guard_reason: string | null;
  /** Processes guard killed after the command ended on its own, plus its survivors. */
  guard_leftovers: number;
  /** Processes killed at a limit (timeout or memory cap). */
  guard_killed: number;
  leftover_check_failed: boolean;
  peak_rss_mib: number | null;
  /** Processes still working inside the run's scratch afterwards, killed by the sweep. */
  swept: { pid: number; cwd: string }[];
  sweep_unavailable: string | null;
  /** First entries of guard's own process lists. */
  processes: { pid: number; in_group: boolean; command: string }[];
}

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
  /** `claude --version` of the binary that ran the session, or null when it could not be read (absent in older records). */
  cli_version?: string | null;
  status: RunStatus;
  /** Why a run did not complete, or null. */
  failure: string | null;
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
  /** Opaque name of the run's scratch directory. */
  scratch_id: string;
  /** The paths the session saw, for redaction before judging. */
  paths: { worktree: string; evidence: string; run_files: string };
  checkout: {
    head_sha: string;
    setup_ok: boolean;
    dirty_after_setup: boolean;
    cleaned_up: boolean;
  };
  processes: { setup: ProcessRecord[]; session: ProcessRecord | null };
  /** Status of the record this run replaced when a failed run was retried. */
  previous_status: RunStatus | null;
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
  /** The judge's `--effort` (absent in older files). */
  effort?: string | null;
  /** `claude --version` of the judge binary (absent in older files). */
  cli_version?: string | null;
  cost_usd: number | null;
}

/* ------------------------------------------------------------------ */
/* Per-run score and aggregation                                        */
/* ------------------------------------------------------------------ */

export interface RunScore {
  entry_id: string;
  kind: EntryKind;
  leak: LeakTag;
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
  const knownIds = new Set(known.map((k) => k.id));
  let matchedIds: string[] = [];
  let knownMatched: number | null = null;
  if (entry.kind === "control") {
    knownMatched = 0;
  } else if (result.final_text.trim().length === 0) {
    knownMatched = 0;
  } else if (judge !== null) {
    // Only known medium-or-higher ids count; a judge file naming a low or an
    // unknown id does not raise recall.
    matchedIds = [
      ...new Set(
        judge.matches
          .filter((m) => m.matched && knownIds.has(m.id))
          .map((m) => m.id),
      ),
    ];
    knownMatched = matchedIds.length;
  }
  return {
    entry_id: entry.id,
    kind: entry.kind,
    leak: entry.leak,
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

/** A run whose return is scored: the session ran to its end. */
export function isCompleted(score: RunScore): boolean {
  return score.status === "completed";
}

/** A run that started a session (a setup failure never did). */
function ranSession(score: RunScore): boolean {
  return score.status !== "setup_failed";
}

/** Splits scores into those kept and those of entries with an excluded leak tag. */
export function splitByLeak(
  scores: RunScore[],
  excluded: readonly LeakTag[],
): { kept: RunScore[]; excluded: RunScore[] } {
  return {
    kept: scores.filter((s) => !excluded.includes(s.leak)),
    excluded: scores.filter((s) => excluded.includes(s.leak)),
  };
}

interface EntryMeans {
  kind: EntryKind;
  known_total: number;
  /** Mean matched count over the entry's judged completed runs, or null. */
  matched: number | null;
  /** Mean medium-or-higher count over the entry's completed runs, or null. */
  medium_plus: number | null;
  /** Share of the entry's completed runs that are valid, or null. */
  valid: number | null;
  /** Mean cost over the entry's sessions with a reported cost, or null. */
  cost: number | null;
  /** Mean session wall time over the entry's sessions, or null. */
  wall_ms: number | null;
  /** Repeats behind `matched`, behind the other quality means, and behind cost and time. */
  judged_repeats: number[];
  completed_repeats: number[];
  session_repeats: number[];
}

function mean(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Per-entry means over repeats. Every entry then weighs the same however
 * many repeats it has, so unequal repeat counts do not tilt a total.
 */
export function entryMeans(scores: RunScore[]): Map<string, EntryMeans> {
  const groups = new Map<string, RunScore[]>();
  for (const s of scores) {
    const list = groups.get(s.entry_id) ?? [];
    list.push(s);
    groups.set(s.entry_id, list);
  }
  const out = new Map<string, EntryMeans>();
  for (const [id, runs] of groups) {
    const completed = runs.filter(isCompleted);
    const judged = completed.filter(
      (s) => s.kind === "finding" && s.known_matched !== null,
    );
    const sessions = runs.filter(ranSession);
    const costs = sessions
      .map((s) => s.cost_usd)
      .filter((c): c is number => c !== null);
    out.set(id, {
      kind: runs[0].kind,
      known_total: runs[0].known_total,
      matched: mean(judged.map((s) => s.known_matched ?? 0)),
      medium_plus: mean(completed.map((s) => s.medium_plus)),
      valid: mean(completed.map((s) => (s.valid ? 1 : 0))),
      cost: mean(costs),
      wall_ms: mean(sessions.map((s) => s.wall_ms)),
      judged_repeats: judged.map((s) => s.repeat),
      completed_repeats: completed.map((s) => s.repeat),
      session_repeats: sessions.map((s) => s.repeat),
    });
  }
  return out;
}

export interface RepeatRecall {
  repeat: number;
  recall: number | null;
  entries: number;
}

export interface VariantAggregate {
  variant_id: string;
  /** Runs that started a session (setup failures excluded). */
  n_runs: number;
  n_setup_failed: number;
  n_completed: number;
  /** Sessions that ended with an error or without a parseable result. */
  n_session_failed: number;
  n_timeouts: number;
  /** Entries with at least one completed run. */
  n_entries: number;
  /** Distinct repeat numbers among the completed runs. */
  n_repeats: number;
  n_finding_runs: number;
  n_control_runs: number;
  /** Mean over entries of the share of valid completed runs. */
  validity_rate: number | null;
  /** Sum over finding entries of the mean matched count, over the sum of their known defects. */
  recall: number | null;
  /** Finding entries behind `recall`: those with a judged completed run. */
  recall_entries: number;
  /** Mean over those entries of their mean per-run recall. */
  recall_macro: number | null;
  /** Recall of each repeat on its own judged completed runs. */
  recall_by_repeat: RepeatRecall[];
  judged_finding_runs: number;
  unjudged_finding_runs: number;
  /** Medium-or-higher findings reported on completed control runs, in total. */
  false_positives: number;
  /** Sum over control entries of the mean medium-or-higher count, over the number of those entries. */
  false_positives_per_control_run: number | null;
  control_entries: number;
  controls_with_false_positive: number;
  cost_total_usd: number;
  cost_mean_usd: number | null;
  wall_total_s: number;
  wall_mean_s: number | null;
}

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

/**
 * Aggregate of one variant. Only completed runs count toward validity,
 * recall and false positives; session failures and timeouts are counted on
 * their own, and setup failures are left out of everything but their count.
 * Repeats enter as per-entry means (see `entryMeans`).
 */
export function aggregate(
  variantId: string,
  scores: RunScore[],
): VariantAggregate {
  const sessions = scores.filter(ranSession);
  const completed = sessions.filter(isCompleted);
  const findingRuns = completed.filter((s) => s.kind === "finding");
  const controlRuns = completed.filter((s) => s.kind === "control");
  const judged = findingRuns.filter((s) => s.known_matched !== null);
  const means = [...entryMeans(scores).values()];

  const recallEntries = means.filter(
    (m) => m.kind === "finding" && m.matched !== null && m.known_total > 0,
  );
  const known = recallEntries.reduce((sum, m) => sum + m.known_total, 0);
  const matched = recallEntries.reduce((sum, m) => sum + (m.matched ?? 0), 0);
  const controls = means.filter(
    (m) => m.kind === "control" && m.medium_plus !== null,
  );
  const validities = means
    .map((m) => m.valid)
    .filter((v): v is number => v !== null);

  const repeats = [...new Set(completed.map((s) => s.repeat))].sort(
    (a, b) => a - b,
  );
  const byRepeat = repeats.map((repeat) => {
    const runs = judged.filter((s) => s.repeat === repeat && s.known_total > 0);
    return {
      repeat,
      recall: ratio(
        runs.reduce((sum, s) => sum + (s.known_matched ?? 0), 0),
        runs.reduce((sum, s) => sum + s.known_total, 0),
      ),
      entries: runs.length,
    };
  });

  const costs = sessions
    .map((s) => s.cost_usd)
    .filter((c): c is number => c !== null);
  const wallTotal = sessions.reduce((sum, s) => sum + s.wall_ms, 0) / 1000;
  return {
    variant_id: variantId,
    n_runs: sessions.length,
    n_setup_failed: scores.length - sessions.length,
    n_completed: completed.length,
    n_session_failed: sessions.filter((s) => s.status === "session_failed")
      .length,
    n_timeouts: sessions.filter((s) => s.status === "timeout").length,
    n_entries: new Set(completed.map((s) => s.entry_id)).size,
    n_repeats: repeats.length,
    n_finding_runs: findingRuns.length,
    n_control_runs: controlRuns.length,
    validity_rate: mean(validities),
    recall: ratio(matched, known),
    recall_entries: recallEntries.length,
    recall_macro: mean(
      recallEntries.map((m) => (m.matched ?? 0) / m.known_total),
    ),
    recall_by_repeat: byRepeat,
    judged_finding_runs: judged.length,
    unjudged_finding_runs: findingRuns.length - judged.length,
    false_positives: controlRuns.reduce((sum, s) => sum + s.medium_plus, 0),
    false_positives_per_control_run: ratio(
      controls.reduce((sum, m) => sum + (m.medium_plus ?? 0), 0),
      controls.length,
    ),
    control_entries: controls.length,
    controls_with_false_positive: controlRuns.filter((s) => s.medium_plus > 0)
      .length,
    cost_total_usd: costs.reduce((a, b) => a + b, 0),
    cost_mean_usd: mean(costs),
    wall_total_s: wallTotal,
    wall_mean_s: sessions.length === 0 ? null : wallTotal / sessions.length,
  };
}

/* ------------------------------------------------------------------ */
/* Noise and comparison                                                 */
/* ------------------------------------------------------------------ */

export interface NoiseReport {
  repeats: number[];
  /** Entries with a completed run in every repeat. */
  entries_compared: number;
  /** Finding entries among them judged in every repeat: the recall figures use only these. */
  recall_entries: number;
  /** Control entries among them: the false-positive figures use only these. */
  control_entries: number;
  recall_by_repeat: (number | null)[];
  false_positives_by_repeat: number[];
  /** False positives per control entry, per repeat. */
  false_positive_rate_by_repeat: (number | null)[];
  validity_by_repeat: (number | null)[];
  /** Largest minus smallest value across the repeats. */
  recall_range: number | null;
  false_positives_range: number;
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
 * compared across repeats. Only completed runs count, and every figure uses
 * one fixed set of entries in every repeat (recall: the finding entries
 * judged in every repeat). Needs at least two repeats; returns null otherwise.
 */
export function computeNoise(scores: RunScore[]): NoiseReport | null {
  const completed = scores.filter(isCompleted);
  const repeats = [...new Set(completed.map((s) => s.repeat))].sort(
    (a, b) => a - b,
  );
  if (repeats.length < 2) return null;
  const byEntry = new Map<string, Map<number, RunScore>>();
  for (const s of completed) {
    const inner = byEntry.get(s.entry_id) ?? new Map<number, RunScore>();
    inner.set(s.repeat, s);
    byEntry.set(s.entry_id, inner);
  }
  const common = [...byEntry.entries()]
    .filter(([, inner]) => repeats.every((r) => inner.has(r)))
    .map(([id]) => id);
  const runsOf = (id: string): RunScore[] =>
    repeats.map((r) => byEntry.get(id)!.get(r)!);
  const recallSet = common.filter((id) =>
    runsOf(id).every((s) => s.kind === "finding" && s.known_matched !== null),
  );
  const controlSet = common.filter((id) => runsOf(id)[0].kind === "control");

  const recallBy: (number | null)[] = [];
  const fpBy: number[] = [];
  const fpRateBy: (number | null)[] = [];
  const validBy: (number | null)[] = [];
  for (const repeat of repeats) {
    const at = (id: string): RunScore => byEntry.get(id)!.get(repeat)!;
    const findings = recallSet.map(at);
    recallBy.push(
      ratio(
        findings.reduce((sum, s) => sum + (s.known_matched ?? 0), 0),
        findings.reduce((sum, s) => sum + s.known_total, 0),
      ),
    );
    const fp = controlSet.map(at).reduce((sum, s) => sum + s.medium_plus, 0);
    fpBy.push(fp);
    fpRateBy.push(ratio(fp, controlSet.length));
    validBy.push(
      ratio(common.map(at).filter((s) => s.valid).length, common.length),
    );
  }

  let flips = 0;
  let pairs = 0;
  for (const id of recallSet) {
    const runs = runsOf(id);
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
    recall_entries: recallSet.length,
    control_entries: controlSet.length,
    recall_by_repeat: recallBy,
    false_positives_by_repeat: fpBy,
    false_positive_rate_by_repeat: fpRateBy,
    validity_by_repeat: validBy,
    recall_range: spread(recallBy),
    false_positives_range: Math.max(...fpBy) - Math.min(...fpBy),
    false_positive_rate_range: spread(fpRateBy),
    validity_range: spread(validBy),
    flip_rate: ratio(flips, pairs),
  };
}

/** Default noise floor: one entry's worth of the metric. */
export const DEFAULT_NOISE_FLOOR_ENTRIES = 1;

export interface MetricDelta {
  a: number | null;
  b: number | null;
  /** b minus a, on the paired entries. */
  delta: number | null;
  /** Entries both variants have values for; a and b are computed on exactly these. */
  n: number;
  /** Distinct repeats behind a and b on those entries. */
  a_repeats: number;
  b_repeats: number;
  /** Noise range of variant a for this metric, when measured. */
  noise: number | null;
  /** Noise floor: the configured number of entries' worth of the metric (entries / n). */
  floor: number | null;
  /** The larger of noise and floor: what |delta| has to exceed. */
  threshold: number | null;
  /** True when |delta| is larger than the threshold; null when a's noise is unmeasured. */
  exceeds_noise: boolean | null;
}

export interface Comparison {
  a: string;
  b: string;
  noise_floor_entries: number;
  recall: MetricDelta;
  false_positives: MetricDelta;
  validity: MetricDelta;
  cost_mean_usd: MetricDelta;
  wall_mean_s: MetricDelta;
  /** Paired finding entries with b's mean recall above, equal to or below a's. */
  paired_recall: {
    entries: number;
    b_higher: number;
    equal: number;
    b_lower: number;
  };
}

function distinct(list: number[]): number {
  return new Set(list).size;
}

function pairedDelta(
  ma: Map<string, EntryMeans>,
  mb: Map<string, EntryMeans>,
  pick: (m: EntryMeans) => number | null,
  repeatsOf: (m: EntryMeans) => number[],
  combine: (values: { a: number; b: number; m: EntryMeans }[]) => {
    a: number | null;
    b: number | null;
  },
  noise: number | null,
  /** Entries' worth of the floor; null for a metric that is not a rate over entries. */
  floorEntries: number | null,
): MetricDelta {
  const rows: { a: number; b: number; m: EntryMeans }[] = [];
  const aRepeats: number[] = [];
  const bRepeats: number[] = [];
  for (const [id, ea] of ma) {
    const eb = mb.get(id);
    if (eb === undefined) continue;
    const va = pick(ea);
    const vb = pick(eb);
    if (va === null || vb === null) continue;
    rows.push({ a: va, b: vb, m: ea });
    aRepeats.push(...repeatsOf(ea));
    bRepeats.push(...repeatsOf(eb));
  }
  const { a, b } = combine(rows);
  const d = a === null || b === null ? null : b - a;
  const n = rows.length;
  const floor = n === 0 || floorEntries === null ? null : floorEntries / n;
  const threshold = noise === null ? null : Math.max(noise, floor ?? 0);
  return {
    a,
    b,
    delta: d,
    n,
    a_repeats: distinct(aRepeats),
    b_repeats: distinct(bRepeats),
    noise,
    floor,
    threshold,
    exceeds_noise:
      d === null || threshold === null ? null : Math.abs(d) > threshold,
  };
}

const meanOf =
  (side: "a" | "b") =>
  (rows: { a: number; b: number }[]): number | null =>
    mean(rows.map((r) => r[side]));

function meanBoth(rows: { a: number; b: number }[]): {
  a: number | null;
  b: number | null;
} {
  return { a: meanOf("a")(rows), b: meanOf("b")(rows) };
}

/**
 * Variant B against variant A. Every metric is paired: it is computed for
 * both variants on exactly the entries both have values for, from per-entry
 * means over repeats. The verdict compares |delta| with the larger of A's
 * run-to-run range and a floor of `noiseFloorEntries` entries' worth of the
 * metric, so a zero range from identical repeats does not turn every delta
 * into a difference.
 */
export function compareVariants(
  a: { id: string; scores: RunScore[]; noise: NoiseReport | null },
  b: { id: string; scores: RunScore[] },
  noiseFloorEntries: number = DEFAULT_NOISE_FLOOR_ENTRIES,
): Comparison {
  const ma = entryMeans(a.scores);
  const mb = entryMeans(b.scores);
  const finding = (m: EntryMeans): boolean =>
    m.kind === "finding" && m.known_total > 0;

  const recall = pairedDelta(
    ma,
    mb,
    (m) => (finding(m) ? m.matched : null),
    (m) => m.judged_repeats,
    (rows) => {
      const known = rows.reduce((sum, r) => sum + r.m.known_total, 0);
      return {
        a: ratio(
          rows.reduce((sum, r) => sum + r.a, 0),
          known,
        ),
        b: ratio(
          rows.reduce((sum, r) => sum + r.b, 0),
          known,
        ),
      };
    },
    a.noise?.recall_range ?? null,
    noiseFloorEntries,
  );

  let higher = 0;
  let equal = 0;
  let lower = 0;
  for (const [id, ea] of ma) {
    const eb = mb.get(id);
    if (eb === undefined || !finding(ea)) continue;
    if (ea.matched === null || eb.matched === null) continue;
    const va = ea.matched / ea.known_total;
    const vb = eb.matched / eb.known_total;
    if (Math.abs(vb - va) < 1e-9) equal += 1;
    else if (vb > va) higher += 1;
    else lower += 1;
  }

  return {
    a: a.id,
    b: b.id,
    noise_floor_entries: noiseFloorEntries,
    recall,
    false_positives: pairedDelta(
      ma,
      mb,
      (m) => (m.kind === "control" ? m.medium_plus : null),
      (m) => m.completed_repeats,
      meanBoth,
      a.noise?.false_positive_rate_range ?? null,
      noiseFloorEntries,
    ),
    validity: pairedDelta(
      ma,
      mb,
      (m) => m.valid,
      (m) => m.completed_repeats,
      meanBoth,
      a.noise?.validity_range ?? null,
      noiseFloorEntries,
    ),
    cost_mean_usd: pairedDelta(
      ma,
      mb,
      (m) => m.cost,
      (m) => m.session_repeats,
      meanBoth,
      null,
      null,
    ),
    wall_mean_s: pairedDelta(
      ma,
      mb,
      (m) => (m.wall_ms === null ? null : m.wall_ms / 1000),
      (m) => m.session_repeats,
      meanBoth,
      null,
      null,
    ),
    paired_recall: {
      entries: higher + equal + lower,
      b_higher: higher,
      equal,
      b_lower: lower,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Provenance of a comparison                                           */
/* ------------------------------------------------------------------ */

/** What a run and its judgment were produced with. */
export interface RunProvenance {
  reviewer_effort: string | null;
  reviewer_cli: string | null;
  /** null when the run has no judgment. */
  judge: {
    model: string | null;
    effort: string | null;
    cli: string | null;
  } | null;
}

export function runProvenance(
  result: RunResult,
  judge: JudgeFile | null,
): RunProvenance {
  return {
    reviewer_effort: result.effort ?? null,
    reviewer_cli: result.cli_version ?? null,
    judge:
      judge === null
        ? null
        : {
            model: judge.model ?? null,
            effort: judge.effort ?? null,
            cli: judge.cli_version ?? null,
          },
  };
}

const PROVENANCE_FIELDS: {
  label: string;
  pick: (p: RunProvenance) => string | null | undefined;
  judged: boolean;
}[] = [
  { label: "judge model", pick: (p) => p.judge?.model, judged: true },
  { label: "judge effort", pick: (p) => p.judge?.effort, judged: true },
  { label: "judge CLI version", pick: (p) => p.judge?.cli, judged: true },
  { label: "reviewer effort", pick: (p) => p.reviewer_effort, judged: false },
  { label: "reviewer CLI version", pick: (p) => p.reviewer_cli, judged: false },
];

/**
 * One warning per setting in which variants A and B differ: judge model,
 * judge effort, reviewer effort and the CLI versions. A value missing from a
 * record counts as `unknown`; a variant without any judged run as `none`.
 */
export function provenanceWarnings(
  a: { id: string; runs: RunProvenance[] },
  b: { id: string; runs: RunProvenance[] },
): string[] {
  const valuesOf = (
    runs: RunProvenance[],
    field: (typeof PROVENANCE_FIELDS)[number],
  ): string => {
    const values = new Set(
      runs
        .filter((p) => !field.judged || p.judge !== null)
        .map((p) => field.pick(p) ?? "unknown"),
    );
    return values.size === 0 ? "none" : [...values].sort().join(" + ");
  };
  const warnings: string[] = [];
  for (const field of PROVENANCE_FIELDS) {
    const va = valuesOf(a.runs, field);
    const vb = valuesOf(b.runs, field);
    if (va !== vb)
      warnings.push(
        `${a.id} and ${b.id} differ in ${field.label} (${a.id}: ${va}; ${b.id}: ${vb}); the comparison mixes settings`,
      );
  }
  return warnings;
}
