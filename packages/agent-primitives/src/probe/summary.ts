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
  "line_content",
];

/** Validates a comma-separated `--print` value; returns the trimmed,
 * non-empty field paths (`a.b` descends into an object), or throws a
 * message naming the unknown top-level field and the accepted ones.
 * `allowed` is the command's own field list; it defaults to probe's, so
 * probe's output and messages are unchanged. */
export function parsePrintFields(
  value: string,
  allowed: readonly string[] = PRINTABLE_FIELDS,
): string[] {
  const fields = value
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  if (fields.length === 0) {
    throw new Error("--print needs at least one field name");
  }
  for (const field of fields) {
    const top = field.split(".")[0];
    if (!allowed.includes(top)) {
      throw new Error(
        `--print: unknown field "${top}" (in "${field}"); known fields: ${allowed.join(", ")}`,
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
  /** The refused line's content, as `ProbeResult.line_content` carries
   * it for a `mutant_not_applicable` dry-run refusal; the row ends in a
   * `line=` column naming it. */
  line_content?: string;
  /** A plan row's own baseline group (`plan.baselines[i]`) and the test
   * command it ran. */
  baseline_index?: number;
  test_command?: string;
}

/** The pieces of one `plan.baselines[]` entry the summary reads. */
interface SummaryBaselineLike {
  index?: number;
  command?: string;
  status?: string;
  reason?: string;
  logPath?: string;
  entries?: number[];
}

export interface SummaryInput {
  status: string;
  reason?: string;
  message?: string;
  warnings?: string[];
  expectation?: string;
  mutant?: SummaryMutantLike["mutant"];
  /** See `SummaryMutantLike.line_content`: the single form's own
   * `line_content` (a `mutant_not_applicable` refusal prints no mutant
   * line, so this rides onto the `note:` line instead). */
  line_content?: string;
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
    /** One per distinct test command. With more than one, every mutant
     * line ends in its `test=` column and each baseline gets its own
     * line above the totals; with one (or none), the summary is exactly
     * what a plan naming one command always printed. */
    baselines?: SummaryBaselineLike[];
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
  /** The `test=` column, appended last so every column before it stays
   * where a plan naming one command has always printed it. */
  testCommand?: string,
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
  // A `mutant_not_applicable` mutant never applied and never ran, so it
  // has no log of its own: print a dash rather than point at a baseline
  // log as though it were the mutant's run. A dry run that did produce
  // a log (a refused `git apply`) still names it, and every other
  // never-ran reason keeps the baseline fallback -- there the baseline
  // log is the evidence the row is about.
  const neverRan =
    (row.logs === undefined || row.logs.length === 0) &&
    reason === MUTANT_NOT_APPLICABLE;
  const log = neverRan
    ? "-"
    : (row.test?.logPath ??
      (row.logs && row.logs.length > 0
        ? row.logs[row.logs.length - 1]
        : undefined) ??
      baselineLog);
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
    ...(testCommand !== undefined ? [`test=${oneLine(testCommand)}`] : []),
    // Last, after `test=`: the line a refused mutant's `-M` target was
    // looked for on, which the refusal's `line_content` quotes.
    ...(row.line_content !== undefined
      ? [`line=${oneLine(row.line_content)}`]
      : []),
  ];
  return parts.join(" | ");
}

/** One line per baseline of a plan naming more than one test command:
 * its position, its status (with the reason a failed one carries), the
 * mutants measured against it, its log, and its command, last. */
function baselineLine(entry: SummaryBaselineLike, position: number): string {
  const status = entry.status ?? "-";
  return [
    `baseline[${String(entry.index ?? position)}]`,
    entry.reason !== undefined ? `${status}(${entry.reason})` : status,
    `entries=${entry.entries !== undefined && entry.entries.length > 0 ? entry.entries.join(",") : "-"}`,
    `log=${entry.logPath ?? "-"}`,
    `test=${oneLine(entry.command ?? "-")}`,
  ].join(" | ");
}

/**
 * One line per mutant (id, verdict, expectation, restored_verified, first
 * failing test, log path) and a final `totals:` line. A run that never
 * reached a mutant (usage error, plan file refusal) prints its status and
 * reason on the totals line alone. A plan naming more than one test
 * command also ends every mutant line in a `test=` column and prints one
 * line per baseline above the totals; a plan naming one prints neither.
 *
 * `maxChars` bounds the mutant lines only: the totals line (and the note
 * and baseline lines, when they fit) always survive, and a marker line
 * names how many mutant lines were left out.
 */
export function renderProbeSummary(
  input: SummaryInput,
  maxChars: number = Number.POSITIVE_INFINITY,
): string {
  const lines: string[] = [];
  const baselineLines: string[] = [];
  let counts: Record<string, number>;
  if (input.plan !== undefined) {
    const baselineLog = input.plan.baseline?.logPath ?? "";
    const baselines = input.plan.baselines ?? [];
    const severalCommands = baselines.length > 1;
    for (const row of input.plan.results) {
      // A row's `log=` fallback is its own group's baseline: the one it
      // was (or would have been) measured against.
      const group =
        row.baseline_index !== undefined
          ? baselines[row.baseline_index]
          : undefined;
      lines.push(
        mutantLine(
          row,
          group?.logPath ?? baselineLog,
          input.cwd,
          severalCommands
            ? (row.test_command ?? group?.command ?? "-")
            : undefined,
        ),
      );
    }
    if (severalCommands) {
      for (const [position, entry] of baselines.entries()) {
        baselineLines.push(baselineLine(entry, position));
      }
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
    // A single probe refused as `mutant_not_applicable` carries neither
    // a `mutant` nor a `mutation_probe` record (the refusal-shape rule
    // in `session.ts`), so the record test above misses it -- but a
    // mutant was named and refused, and the plan form counts its row:
    // the single form counts it too, as `total=1 inconclusive=1`.
    const refusedNotApplicable =
      !hasMutant && input.reason === MUTANT_NOT_APPLICABLE;
    counts = {
      total: hasMutant || refusedNotApplicable ? 1 : 0,
      killed: result === "killed" ? 1 : 0,
      survived: result === "survived" ? 1 : 0,
      inconclusive:
        (hasMutant || refusedNotApplicable) &&
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
  const totals = `totals: ${head} total=${counts.total} killed=${counts.killed} survived=${counts.survived} inconclusive=${counts.inconclusive} not_run=${counts.not_run} met=${counts.met} violated=${counts.violated}`;
  const tail: string[] = [...baselineLines, totals];
  const note = input.message ?? input.warnings?.[0];
  // The refused line's content rides on the note (the single form prints
  // no mutant line for a refusal, so this is where `line=` appears); a
  // note carrying it survives even with a mutant counted, unlike a bare
  // warning note that only explains a zero-mutant run.
  const linePart =
    input.line_content !== undefined
      ? `line=${oneLine(input.line_content)}`
      : undefined;
  const noteText = [note !== undefined ? oneLine(note) : undefined, linePart]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  if (
    noteText !== "" &&
    (counts.total === 0 ||
      linePart !== undefined ||
      input.reason === MUTANT_NOT_APPLICABLE)
  ) {
    tail.push(`note: ${noteText}`);
  }
  const size = (rows: string[]): number =>
    rows.reduce((n, r) => n + r.length + 1, 0);
  // Drop the note, then the baseline lines (last first), before the
  // totals when even the tail does not fit.
  while (tail.length > 1 && size(tail) > maxChars) {
    const totalsAt = tail.indexOf(totals);
    tail.splice(totalsAt < tail.length - 1 ? tail.length - 1 : totalsAt - 1, 1);
  }
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

/** The internal refusal reason that says the dry run found the mutant
 * cannot be applied at all: `MutantNotApplicable.reasonCode` in
 * `src/probe/mutant.ts`, reported verbatim as the result's own `reason`
 * (and as `mutation_probe.reason` at the mutant-phase site). Target text
 * that can no longer be found is only ONE of its causes: the same code
 * covers a replacement identical to the original line or to the matched
 * text, an empty `-M`, a line out of range, and a patch that does not
 * apply, touches other paths, or overflows the numstat check; the
 * default envelope's `warnings` name the specific cause
 * (`MutantNotApplicable.reason`). The report spells every cause in the
 * implementer contract's own words instead. */
const MUTANT_NOT_APPLICABLE = "mutant_not_applicable";

/** The contract's canonical reason for that case (see the orchestrator
 * implementer contract: `reason` carries `target text no longer present`
 * for a probe whose mutant can no longer be applied, whatever the
 * internal cause named in the default envelope's `warnings`). */
export const TARGET_TEXT_NO_LONGER_PRESENT = "target text no longer present";

/** One item of the `--report mutation-probes` array: the eleven fields
 * of one orchestrator implementer `mutation_probes` entry, merged from
 * the mutant record and the `mutation_probe` object, so a caller pastes
 * the printed item instead of merging the two sibling records by hand.
 * A field whose source record is absent prints as the empty string (a
 * missing sibling record is never invented), except for the four replay
 * definition fields (`file`, `anchor`, `before`, `after`), which fall
 * back to the probe's own inputs when no `mutant` record exists (see
 * `ReportItemDefinition`); `restored_verified` is then `""` too, the
 * contract's own not-recorded spelling, never a boolean the probe did
 * not measure. Key order is the contract order. */
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

/** The replay definition as the probe received it, used to fill `file`,
 * `anchor`, `before` and `after` of an item whose `mutant` record was
 * never computed: `--file` and `-n` (or the plan entry's file and line),
 * with `before`/`after` from `-M`/`-w` (or the entry's match/with). A
 * whole-line replacement (`-r`, an entry's `replace`) has no `before`
 * substring: `before` stays empty and `after` is the replacement text.
 * Without this fill an item would read as "no definition recorded", a
 * non-regression, hiding the very case the replay is for. */
export interface ReportItemDefinition {
  file?: string;
  line?: number;
  before?: string;
  after?: string;
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
 *   (`anchor` is the line number the record carries), a plan entry whose
 *   mutant was never computed falling back to the run record's own
 *   `file`, and a probe with no `mutant` record at all falling back to
 *   the definition it was given (`definition`, see its own docblock:
 *   `--file`/`-n` or the entry's file and line, `-M`/`-w` or the entry's
 *   match/with, an empty `before` with `-r`'s replacement as `after`);
 * - `mutant`, `verified_applied_via`, `restored_verified` come from
 *   `mutation_probe`;
 * - `result` is the `killed`/`survived` verdict read ONLY from
 *   `mutation_probe.result`: every other internal value (`not_run`,
 *   `inconclusive`) and an absent `mutation_probe` map to
 *   `not_applicable`, because a real record never carries a measured
 *   result without the probe that measured it, and reading the run's
 *   own `status` in its place would invent one;
 * - `expectation` is the probe's `met`/`violated`, and always
 *   `not_applicable` when `result` is `not_applicable` (nothing was
 *   measured to compare against an expectation);
 * - `reason` is the empty string unless `result` is `not_applicable`;
 *   then `mutant_not_applicable` becomes the contract's canonical
 *   `target text no longer present` (that code's several causes are
 *   named by the default envelope's `warnings`), and any other internal
 *   reason string is carried verbatim. A row that carries neither a
 *   `mutation_probe.reason` nor a row `reason` falls back to the
 *   `fallbackReason` argument (the run envelope's own top-level
 *   `reason`, see `mutationProbeReportItems`); a row's own reason
 *   always wins over the fallback;
 * - `replayed` is the `--replayed` flag's value (`false` for a newly run
 *   probe, `true` when the caller says these items replay prior-round
 *   definitions).
 */
export function mutationProbeReportItem(
  source: Record<string, unknown>,
  replayed: boolean,
  definition?: ReportItemDefinition,
  fallbackReason?: string,
): MutationProbeReportItem {
  const probe = source.mutation_probe as ReportProbeRecord | undefined;
  const mutant = source.mutant as ReportMutantRecord | undefined;
  const file = source.file as string | undefined;
  const recordReason = source.reason as string | undefined;
  const measured = probe?.result;
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
  const internalReason = probe?.reason ?? recordReason ?? fallbackReason;
  const reason =
    result === "not_applicable"
      ? internalReason === MUTANT_NOT_APPLICABLE
        ? TARGET_TEXT_NO_LONGER_PRESENT
        : (internalReason ?? "")
      : "";
  return {
    mutant: probe?.mutant ?? "",
    file: mutant?.file ?? file ?? definition?.file ?? "",
    anchor: mutant?.line ?? definition?.line ?? "",
    before: mutant?.before ?? definition?.before ?? "",
    after: mutant?.after ?? definition?.after ?? "",
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
 * `not_run` entries a stopped plan never reached). `definitions` is
 * indexed by a result's own `index` (the plan file's mutants in plan
 * order) and carries each entry's replay definition for the rows whose
 * `mutant` record was never computed. `fallbackReason` is the run
 * envelope's own top-level `reason` (`baseline_failed` for a plan whose
 * baseline failed, say): the `not_run` entries a stopped plan never
 * reached carry no reason of their own, and the contract requires a
 * reason with every `not_applicable` result; a row's own reason always
 * wins. An envelope with no `plan` value (a run that refused before any
 * mutant existed) reports the empty array. */
export function mutationProbeReportItems(
  plan: { results?: unknown } | undefined,
  replayed: boolean,
  definitions?: readonly (ReportItemDefinition | undefined)[],
  fallbackReason?: string,
): MutationProbeReportItem[] {
  const rows =
    plan !== undefined && Array.isArray(plan.results) ? plan.results : [];
  return rows.map((row) => {
    const index = (row as { index?: unknown }).index;
    const definition =
      typeof index === "number" ? definitions?.[index] : undefined;
    return mutationProbeReportItem(
      row as Record<string, unknown>,
      replayed,
      definition,
      fallbackReason,
    );
  });
}
