/**
 * `spec-gate status`: a read-only snapshot of where a spec directory stands.
 * It reads only, never writes, and reads no git: every value comes from the
 * files themselves.
 *
 * Each file is read through the lint's hardened reader and its parser. A
 * file that does not load is reported as `null` and names its problem in an
 * `errors` list of codes; an optional file that is simply absent (a draft
 * with no `triage.json`, a spec not yet proposed with no `bindings.log`) is
 * not an error and reads as empty.
 *
 * The triage class is reported both as the file stored it and as
 * `src/triage/` derives it from the fields, so a stale stored class shows
 * without running the lint.
 */
import fs from "node:fs";
import path from "node:path";
import {
  parseBindings,
  parseBindingsLog,
  parseQuestions,
  parseSpec,
  parseTestPlan,
  parseTriage,
  type Binding,
  type BindingStatus,
  type BindingsLog,
  type ParseResult,
  type Questions,
  type Spec,
  type SpecStatus,
  type TestPlan,
  type Triage,
  type TriageClass,
} from "../formats/index.js";
import { readSpecFile, type FileErrorCode } from "../lint/files.js";
import { parseAcks, type Ack } from "../lint/acks.js";
import { deriveTriageClass, profileForClass } from "../triage/index.js";
import { unansweredQuestions, type QuestionCounts } from "./questions.js";

export const STATUS_REPORT_FORMAT = "spec-gate-status/1";

export interface TriageState {
  stored: TriageClass | null;
  derived: TriageClass | null;
  profile: "light" | "full" | null;
}

export interface ResidualState {
  total: number;
  open: number;
  open_ids: string[];
}

export interface StatusReport {
  format: typeof STATUS_REPORT_FORMAT;
  spec: string | null;
  status: SpecStatus | null;
  path: string;
  triage: TriageState | null;
  questions: QuestionCounts | null;
  residuals: ResidualState | null;
  bindings: { by_status: Record<BindingStatus, number> } | null;
  rows_without_binding: string[] | null;
  bindings_log: { entries: number; propose_commit: string | null } | null;
  acks: number | null;
  errors: string[];
}

export type StatusResult =
  { ok: true; report: StatusReport } | { ok: false; message: string };

/** A file read as text: parsed, absent, or present and unusable. */
type FileState<T> =
  | { state: "ok"; value: T }
  | { state: "absent" }
  | { state: "error"; code: string };

/** Reads one file with its parser; `required` turns an absent file into an error. */
function load1<T>(
  dir: string,
  name: string,
  parse: (
    // eslint-disable-next-line no-unused-vars
    text: string,
  ) => ParseResult<T>,
  required: boolean,
): FileState<T> {
  const read = readSpecFile(dir, name);
  if (!read.ok) {
    if (read.code === "input-missing" && !required) return { state: "absent" };
    return { state: "error", code: read.code as FileErrorCode };
  }
  const parsed = parse(read.text);
  if (!parsed.ok) return { state: "error", code: parsed.errors[0]!.code };
  return { state: "ok", value: parsed.value };
}

/** Reads and parses `bindings.log`, whose parser reports a single problem. */
function loadBindingsLog(dir: string, name: string): FileState<BindingsLog> {
  const read = readSpecFile(dir, name);
  if (!read.ok) {
    if (read.code === "input-missing") return { state: "absent" };
    return { state: "error", code: read.code as FileErrorCode };
  }
  const parsed = parseBindingsLog(read.text);
  if (!parsed.ok) return { state: "error", code: parsed.problem.code };
  return { state: "ok", value: parsed.value };
}

function isDirectory(specDir: string): boolean {
  try {
    const stat = fs.lstatSync(path.resolve(specDir));
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function residualState(spec: Spec): ResidualState {
  const open = spec.residuals.filter((r) => r.status === "open");
  return {
    total: spec.residuals.length,
    open: open.length,
    open_ids: open.map((r) => r.id),
  };
}

function byStatus(
  bindings: Record<string, Binding>,
): Record<BindingStatus, number> {
  const counts: Record<BindingStatus, number> = { new: 0, existing: 0 };
  for (const binding of Object.values(bindings)) counts[binding.status] += 1;
  return counts;
}

/** The snapshot of one spec directory. `specDir` is echoed in `path` as given. */
export function statusSpecDir(specDir: string): StatusResult {
  if (!isDirectory(specDir)) {
    return { ok: false, message: `status: ${specDir} is not a directory` };
  }
  const dir = path.resolve(specDir);
  const errors: string[] = [];

  const spec = load1(dir, "spec.md", parseSpec, true);
  if (spec.state === "error") errors.push(spec.code);
  const specValue: Spec | null = spec.state === "ok" ? spec.value : null;

  const plan = load1<TestPlan>(dir, "testplan.yaml", parseTestPlan, true);
  if (plan.state === "error") errors.push(plan.code);

  const questions = load1<Questions>(
    dir,
    "questions.json",
    parseQuestions,
    false,
  );
  if (questions.state === "error") errors.push(questions.code);

  const triage = load1<Triage>(dir, "triage.json", parseTriage, false);
  if (triage.state === "error") errors.push(triage.code);

  const bindings = load1(dir, "bindings.yaml", parseBindings, false);
  if (bindings.state === "error") errors.push(bindings.code);

  const log = loadBindingsLog(dir, "bindings.log");
  if (log.state === "error") errors.push(log.code);

  const acks = load1<Ack[]>(dir, "acks.yaml", parseAcks, false);
  if (acks.state === "error") errors.push(acks.code);

  const questionsValue: Questions | null =
    questions.state === "ok"
      ? questions.value
      : questions.state === "absent"
        ? { questions: [], answers: [] }
        : null;
  const questionCounts: QuestionCounts | null =
    questionsValue === null ? null : unansweredQuestions(questionsValue).counts;

  let triageState: TriageState | null;
  if (triage.state === "error") {
    triageState = null;
  } else if (triage.state === "ok") {
    const derived = deriveTriageClass(triage.value);
    triageState = {
      stored: triage.value.class ?? null,
      derived: derived.class,
      profile: profileForClass(derived.class),
    };
  } else {
    triageState = { stored: null, derived: null, profile: null };
  }

  let bindingsState: { by_status: Record<BindingStatus, number> } | null;
  let rowsWithoutBinding: string[] | null = null;
  if (bindings.state === "error") {
    bindingsState = null;
  } else {
    const map = bindings.state === "ok" ? bindings.value : {};
    bindingsState = { by_status: byStatus(map) };
    if (plan.state === "ok") {
      rowsWithoutBinding = plan.value
        .filter((row) => map[row.id] === undefined)
        .map((row) => row.id);
    }
  }

  let bindingsLog: { entries: number; propose_commit: string | null } | null;
  if (log.state === "error") {
    bindingsLog = null;
  } else if (log.state === "ok") {
    bindingsLog = {
      entries: log.value.lines.length,
      propose_commit: log.value.propose.commit,
    };
  } else {
    bindingsLog = { entries: 0, propose_commit: null };
  }

  return {
    ok: true,
    report: {
      format: STATUS_REPORT_FORMAT,
      spec: specValue?.frontmatter.id ?? null,
      status: specValue?.frontmatter.status ?? null,
      path: specDir,
      triage: triageState,
      questions: questionCounts,
      residuals: specValue === null ? null : residualState(specValue),
      bindings: bindingsState,
      rows_without_binding: rowsWithoutBinding,
      bindings_log: bindingsLog,
      acks:
        acks.state === "error"
          ? null
          : acks.state === "ok"
            ? acks.value.length
            : 0,
      errors,
    },
  };
}
