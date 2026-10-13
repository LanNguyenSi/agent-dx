import path from "node:path";
import { combinedOutput } from "../exec.js";

/**
 * Compact renderings of a finished probe for `probe --summary` and
 * `probe --print <field,...>`. Both read the same envelope-shaped value
 * the JSON output is built from and change nothing about it: they are a
 * second view, selected by a flag, so a caller does not have to write its
 * own reader of the envelope. The exit code is decided before either runs.
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
  plan?: {
    baseline?: { logPath?: string };
    results: SummaryMutantLike[];
    summary?: Record<string, number>;
  };
}

const FAILURE_LINE =
  /^\s*(FAIL\b|FAILED\b|not ok\b|--- FAIL\b|[✗×✖●]|(?:\w*Error|AssertionError)\b)/;

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
  const marker = (omitted: number): string =>
    `... ${omitted} more mutant line${omitted === 1 ? "" : "s"} omitted (-m ${maxChars}); raise -m or read the result-full log`;
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
