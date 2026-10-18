import path from "node:path";
import { combinedOutput } from "../exec.js";

/**
 * Compact renderings of a finished probe for `probe --summary`,
 * `probe --print <field,...>` and `probe --report mutation-probes`. All
 * three read the same envelope-shaped value the JSON output is built from
 * and change nothing about it: they are a second view, selected by a
 * flag, so a caller does not have to write its own reader of the
 * envelope. The exit code is decided before any of them runs.
 */

/** Top-level envelope fields `--print` accepts. A name outside this set is
 * a usage error before the probe runs; a field that is valid but absent
 * from this particular run (for example `test` after a failed baseline)
 * prints `null`. */
export const PRINTABLE_FIELDS: readonly string[] = [
  "tool",
  "version",
  "command",
  "status",
  "reason",
  "message",
  "durationMs",
  "cwd",
  "truncated",
  "logs",
  "warnings",
  "mutant",
  "mutation_probe",
  "baseline",
  "test",
  "env",
  "expectation",
  "plan",
  "isolation",
  "fullResult",
  "totalDurationMs",
];

/** Validates a comma-separated `--print` value; returns the trimmed,
 * non-empty field paths (`a.b` descends into an object), or throws a
 * message naming the unknown top-level field and the accepted ones. */
export function parsePrintFields(value: string): string[] {
  const fields = value
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  if (fields.length === 0) {
    throw new Error("--print needs at least one field name");
  }
  for (const field of fields) {
    const top = field.split(".")[0];
    if (!PRINTABLE_FIELDS.includes(top)) {
      throw new Error(
        `--print: unknown field "${top}" (in "${field}"); known fields: ${PRINTABLE_FIELDS.join(", ")}`,
      );
    }
  }
  return fields;
}

function lookup(value: unknown, dotted: string): unknown {
  let current: unknown = value;
  for (const segment of dotted.split(".")) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return null;
    }
    const next = (current as Record<string, unknown>)[segment];
    if (next === undefined) return null;
    current = next;
  }
  return current;
}

/** One JSON object on one line: each requested path as a key, its value
 * from the envelope (`null` when this run has no such field). */
export function renderPrint(
  envelope: Record<string, unknown>,
  fields: readonly string[],
): string {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = lookup(envelope, field);
  return JSON.stringify(out) + "\n";
}

/** The pieces of a probe result the summary reads; the single form passes
 * its top-level fields, a plan passes `plan` (see `SummaryInput`). */
interface SummaryMutantLike {
  index?: number;
  file?: string;
  status?: string;
  reason?: string;
  mutant?: { file?: string; line?: number };
  mutation_probe?: {
    result?: string;
    expectation?: string;
    restored_verified?: boolean;
    reason?: string;
  };
  test?: { stdoutTail?: string; stderrTail?: string; logPath?: string };
  logs?: string[];
}

export interface SummaryInput {
  status: string;
  reason?: string;
  message?: string;
  warnings?: string[];
  expectation?: string;
  mutant?: SummaryMutantLike["mutant"];
  mutation_probe?: SummaryMutantLike["mutation_probe"];
  test?: SummaryMutantLike["test"];
  baseline?: { logPath?: string };
  /** The invocation cwd (`-C`); mutant file paths under it print relative. */
  cwd?: string;
  /** The saved full result (`result-full-*.json`) when one was written;
   * the truncation marker names it. */
  fullResult?: string;
  plan?: {
    baseline?: { logPath?: string };
    results: SummaryMutantLike[];
    summary?: Record<string, number>;
  };
}

// The last alternative is PHPUnit's numbered failure line,
// `1) Ns\Class::testMethod`: a number, `)`, a class name (namespace
// separators allowed) and `::` before the method. PHPUnit's closing
// `FAILURES!` and `Tests: ..., Failures: 1.` lines name no test.
const FAILURE_LINE =
  /^\s*(FAIL\b|FAILED\b|not ok\b|--- FAIL\b|[✗×✖●]|(?:\w*Error|AssertionError)\b|\d+\) [\w\\]+::\w+)/;

/** The first line of the test's output tails that looks like a failing
 * test, else `-`. A heuristic over free text: the envelope has no
 * structured failing-test field, and runners differ. */
export function firstFailingLine(test: SummaryMutantLike["test"]): string {
  const text = combinedOutput(test?.stdoutTail ?? "", test?.stderrTail ?? "");
  for (const raw of text.split("\n")) {
    if (FAILURE_LINE.test(raw)) {
      const line = raw.trim().replace(/\s+/g, " ");
      return line.length > 140 ? line.slice(0, 137) + "..." : line;
    }
  }
  return "-";
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function relativeTo(cwd: string | undefined, file: string): string {
  if (cwd === undefined || !path.isAbsolute(file)) return file;
  const rel = path.relative(cwd, file);
  return rel.startsWith("..") || path.isAbsolute(rel) ? file : rel;
}

function mutantLine(
  row: SummaryMutantLike,
  baselineLog: string,
  cwd: string | undefined,
): string {
  const rawFile = row.mutant?.file ?? row.file;
  const file = rawFile === undefined ? undefined : relativeTo(cwd, rawFile);
  const where =
    file === undefined
      ? "(no mutant)"
      : row.mutant?.line !== undefined
        ? `${file}:${row.mutant.line}`
        : file;
  const id = row.index !== undefined ? `#${row.index} ${where}` : where;
  const probe = row.mutation_probe;
  const verdict = probe?.result ?? row.status ?? "inconclusive";
  const reason = probe?.reason ?? row.reason;
  const log =
    row.test?.logPath ??
    (row.logs && row.logs.length > 0
      ? row.logs[row.logs.length - 1]
      : undefined) ??
    baselineLog;
  const parts = [
    id,
    reason !== undefined && verdict !== "killed" && verdict !== "survived"
      ? `${verdict}(${reason})`
      : verdict,
    `expectation=${probe?.expectation ?? "-"}`,
    `restored=${probe?.restored_verified === undefined ? "-" : String(probe.restored_verified)}`,
    // Only a killed mutant has a failing test to name: a survived one
    // passed, so an error-shaped line in its output is noise.
    `failing=${verdict === "killed" ? firstFailingLine(row.test) : "-"}`,
    `log=${log || "-"}`,
  ];
  return parts.join(" | ");
}

/**
 * One line per mutant (id, verdict, expectation, restored_verified, first
 * failing test, log path) and a final `totals:` line. A run that never
 * reached a mutant (usage error, plan file refusal) prints its status and
 * reason on the totals line alone.
 *
 * `maxChars` bounds the mutant lines only: the totals line (and the note
 * line, when it fits) always survive, and a marker line names how many
 * mutant lines were left out.
 */
export function renderProbeSummary(
  input: SummaryInput,
  maxChars: number = Number.POSITIVE_INFINITY,
): string {
  const lines: string[] = [];
  let counts: Record<string, number>;
  if (input.plan !== undefined) {
    const baselineLog = input.plan.baseline?.logPath ?? "";
    for (const row of input.plan.results) {
      lines.push(mutantLine(row, baselineLog, input.cwd));
    }
    const s = input.plan.summary ?? {};
    counts = {
      total: s.total ?? input.plan.results.length,
      killed: s.killed ?? 0,
      survived: s.survived ?? 0,
      inconclusive: s.inconclusive ?? 0,
      not_run: s.not_run ?? 0,
      met: s.met ?? 0,
      violated: s.violated ?? 0,
    };
  } else {
    const hasMutant =
      input.mutation_probe !== undefined || input.mutant !== undefined;
    if (hasMutant) {
      lines.push(
        mutantLine(
          {
            mutant: input.mutant,
            mutation_probe: input.mutation_probe,
            test: input.test,
            status: input.status,
            reason: input.reason,
          },
          input.baseline?.logPath ?? "",
          input.cwd,
        ),
      );
    }
    const result = input.mutation_probe?.result;
    counts = {
      total: hasMutant ? 1 : 0,
      killed: result === "killed" ? 1 : 0,
      survived: result === "survived" ? 1 : 0,
      inconclusive:
        hasMutant &&
        result !== "killed" &&
        result !== "survived" &&
        result !== "not_run"
          ? 1
          : 0,
      not_run: hasMutant && result === "not_run" ? 1 : 0,
      met: input.mutation_probe?.expectation === "met" ? 1 : 0,
      violated: input.mutation_probe?.expectation === "violated" ? 1 : 0,
    };
  }
  const head = `status=${input.status}${input.reason !== undefined ? ` reason=${input.reason}` : ""}`;
  const tail: string[] = [
    `totals: ${head} total=${counts.total} killed=${counts.killed} survived=${counts.survived} inconclusive=${counts.inconclusive} not_run=${counts.not_run} met=${counts.met} violated=${counts.violated}`,
  ];
  const note = input.message ?? input.warnings?.[0];
  if (counts.total === 0 && note !== undefined) {
    tail.push(`note: ${oneLine(note)}`);
  }
  const size = (rows: string[]): number =>
    rows.reduce((n, r) => n + r.length + 1, 0);
  // Drop the note before the totals when even the tail does not fit.
  while (tail.length > 1 && size(tail) > maxChars) tail.pop();
  const markerWith = (omitted: number, hint: string): string =>
    `... ${omitted} more mutant line${omitted === 1 ? "" : "s"} omitted (-m ${maxChars} characters); ${hint}`;
  // The path joins the marker only when the marker with it fits beside the
  // tail even with no mutant line kept: a long path must not push the
  // summary past -m. Otherwise a short hint says the path did not fit.
  const pathHint =
    input.fullResult !== undefined
      ? `raise -m or read the full result: ${input.fullResult}`
      : undefined;
  const hint =
    pathHint !== undefined &&
    markerWith(lines.length, pathHint).length + 1 + size(tail) <= maxChars
      ? pathHint
      : input.fullResult !== undefined
        ? "raise -m; the full result path did not fit"
        : "raise -m (no full result file was written)";
  const marker = (omitted: number): string => markerWith(omitted, hint);
  let kept = lines.length;
  if (size(lines) + size(tail) > maxChars) {
    while (
      kept > 0 &&
      size(lines.slice(0, kept)) +
        marker(lines.length - kept).length +
        1 +
        size(tail) >
        maxChars
    ) {
      kept -= 1;
    }
  }
  const out = lines.slice(0, kept);
  if (kept < lines.length) out.push(marker(lines.length - kept));
  return [...out, ...tail].join("\n") + "\n";
}

/** The internal refusal reason that says the mutant's target text can no
 * longer be found in the file: `MutantNotApplicable.reasonCode` in
 * `src/probe/mutant.ts`, reported verbatim as the result's own `reason`
 * (and as `mutation_probe.reason` at the mutant-phase site). The report
 * spells it in the implementer contract's own words instead. */
const MUTANT_NOT_APPLICABLE = "mutant_not_applicable";

/** The contract's canonical reason for that case (see the orchestrator
 * implementer contract: `reason` carries `target text no longer present`
 * for a probe whose mutant can no longer be applied). */
export const TARGET_TEXT_NO_LONGER_PRESENT = "target text no longer present";

/** One item of the `--report mutation-probes` array: the eleven fields
 * of one orchestrator implementer `mutation_probes` entry, merged from
 * the mutant record and the `mutation_probe` object, so a caller pastes
 * the printed item instead of merging the two sibling records by hand.
 * A field whose source record is absent prints as the empty string (a
 * missing sibling record is never invented); `restored_verified` is then
 * `""` too, the contract's own not-recorded spelling, never a boolean
 * the probe did not measure. Key order is the contract order. */
export interface MutationProbeReportItem {
  mutant: string;
  file: string;
  anchor: number | string;
  before: string;
  after: string;
  verified_applied_via: string;
  result: "killed" | "survived" | "not_applicable";
  expectation: "met" | "violated" | "not_applicable";
  reason: string;
  restored_verified: boolean | string;
  replayed: boolean;
}

/** The `mutant` record of one mutant's envelope record, as far as the
 * report reads it. */
type ReportMutantRecord = {
  file?: string;
  line?: number;
  before?: string;
  after?: string;
};

/** The `mutation_probe` object of one mutant's envelope record, as far
 * as the report reads it. */
type ReportProbeRecord = {
  mutant?: string;
  verified_applied_via?: string;
  result?: string;
  restored_verified?: boolean;
  reason?: string;
  expectation?: string;
};

/**
 * One `mutation_probes` item from one mutant's record:
 *
 * - `file`, `anchor`, `before`, `after` come from the `mutant` record
 *   (`anchor` is the line number the record carries), falling back to the
 *   run record's own `file` for a plan entry whose mutant was never
 *   computed;
 * - `mutant`, `verified_applied_via`, `restored_verified` come from
 *   `mutation_probe`;
 * - `result` is `killed`/`survived` from `mutation_probe.result` (or the
 *   entry's own status once no probe exists to report one), every other
 *   internal value (`not_run`, `inconclusive`, an absent record) mapping
 *   to `not_applicable`;
 * - `expectation` is the probe's `met`/`violated`, and always
 *   `not_applicable` when `result` is `not_applicable` (nothing was
 *   measured to compare against an expectation);
 * - `reason` is the empty string unless `result` is `not_applicable`;
 *   then `mutant_not_applicable` becomes `target text no longer present`
 *   and any other internal reason string is carried verbatim;
 * - `replayed` is the `--replayed` flag's value (`false` for a newly run
 *   probe, `true` when the caller says these items replay prior-round
 *   definitions).
 */
export function mutationProbeReportItem(
  source: Record<string, unknown>,
  replayed: boolean,
): MutationProbeReportItem {
  const probe = source.mutation_probe as ReportProbeRecord | undefined;
  const mutant = source.mutant as ReportMutantRecord | undefined;
  const status = source.status as string | undefined;
  const file = source.file as string | undefined;
  const recordReason = source.reason as string | undefined;
  const measured = probe?.result ?? status;
  const result: MutationProbeReportItem["result"] =
    measured === "killed" || measured === "survived"
      ? measured
      : "not_applicable";
  const expectation: MutationProbeReportItem["expectation"] =
    result === "not_applicable"
      ? "not_applicable"
      : probe?.expectation === "met" || probe?.expectation === "violated"
        ? probe.expectation
        : "not_applicable";
  const internalReason = probe?.reason ?? recordReason;
  const reason =
    result === "not_applicable"
      ? internalReason === MUTANT_NOT_APPLICABLE
        ? TARGET_TEXT_NO_LONGER_PRESENT
        : (internalReason ?? "")
      : "";
  return {
    mutant: probe?.mutant ?? "",
    file: mutant?.file ?? file ?? "",
    anchor: mutant?.line ?? "",
    before: mutant?.before ?? "",
    after: mutant?.after ?? "",
    verified_applied_via: probe?.verified_applied_via ?? "",
    result,
    expectation,
    reason,
    restored_verified: probe?.restored_verified ?? "",
    replayed,
  };
}

/** The `--report mutation-probes` array for a `--plan` run: one item per
 * `plan.results[]` entry, in plan order (one per mutant, including the
 * `not_run` entries a stopped plan never reached). An envelope with no
 * `plan` value (a run that refused before any mutant existed) reports
 * the empty array. */
export function mutationProbeReportItems(
  plan: { results?: unknown } | undefined,
  replayed: boolean,
): MutationProbeReportItem[] {
  const rows =
    plan !== undefined && Array.isArray(plan.results) ? plan.results : [];
  return rows.map((row) =>
    mutationProbeReportItem(row as Record<string, unknown>, replayed),
  );
}
