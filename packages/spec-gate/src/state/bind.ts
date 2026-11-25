/**
 * `spec-gate bind`: the one way a binding changes after `proposed`.
 *
 * It refuses, writing nothing, unless the frontmatter status is `proposed`,
 * the TP ID is a row of `testplan.yaml` and a key of `bindings.yaml` (bind
 * neither adds nor renames an ID), `bindings.log` parses, the new binding
 * passes the bindings parser, and its status suits the row's kind (see
 * `bindStatusProblem`). Then it appends one bind entry, holding the full new
 * binding, to `bindings.log` and rewrites `bindings.yaml` with it, each file
 * through a temporary file and a rename in the spec directory.
 *
 * Write order: `bindings.log` first, then `bindings.yaml`. A run stopped
 * between the two leaves a log one entry ahead of the file, which the
 * bindings-log rule reports as a replay that differs from `bindings.yaml`;
 * running the same bind again appends the entry once more and writes the
 * file, and the replay matches again. The other order would leave a changed
 * `bindings.yaml` without its entry, indistinguishable from a hand edit.
 *
 * `bindings.yaml` is written as a block mapping in its existing key order;
 * comments in it are dropped. Git is not read: whether the log replays to
 * `bindings.yaml` from the propose commit is the lint's question.
 */
import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import {
  BINDINGS_LOG_FILE,
  KIND_SPECS,
  canonicalBinding,
  parseBindings,
  parseBindingsLog,
  parseSpec,
  parseTestPlan,
  sameBindings,
  serializeNextBind,
  validateBindings,
  type Binding,
  type BindingStatus,
  type Bindings,
  type TestPlanKind,
} from "../formats/index.js";
import { readSpecFile } from "../lint/files.js";
import { BINDINGS_FILE, SPEC_FILE, TESTPLAN_FILE } from "../lint/load.js";
import { replaceFile } from "./write.js";

export interface BindRequest {
  status: string;
  selector?: string;
  file?: string;
  fixtures?: string[];
  notes?: string;
}

export type BindResult =
  { ok: true; tp: string; seq: number } | { ok: false; message: string };

function refuse(message: string): BindResult {
  return { ok: false, message: `bind: ${message}` };
}

/**
 * Why a binding with status `next` may not replace one with status
 * `current` for a row of `kind`, or `null` when it may. The kind's binding
 * status at `proposed` decides: `none` takes no binding, `existing` stays
 * `existing`, `any` takes either, and `new` (red-first) may move on to
 * `existing` once its test exists but never back from `existing` to `new`.
 */
export function bindStatusProblem(
  kind: TestPlanKind,
  current: BindingStatus,
  next: BindingStatus,
): string | null {
  const want = KIND_SPECS[kind].bindingStatusAtProposed;
  if (want === "none") return `kind ${kind} takes no binding`;
  if (want === "existing" && next !== "existing") {
    return `kind ${kind} needs binding status existing`;
  }
  if (want === "new" && current === "existing" && next === "new") {
    return `kind ${kind} moves from new to existing, never back`;
  }
  return null;
}

/** The text of a `bindings.yaml` holding `bindings` in their key order. */
export function serializeBindings(bindings: Bindings): string {
  const doc: Record<string, Record<string, unknown>> = {};
  for (const [tp, binding] of Object.entries(bindings)) {
    const canon: Record<string, unknown> = { ...canonicalBinding(binding) };
    // An empty list is the default; the file leaves it out.
    if (binding.fixtures.length === 0) delete canon["fixtures"];
    doc[tp] = canon;
  }
  return stringify(doc, { version: "1.2", lineWidth: 0 });
}

function readParsed<T>(
  dir: string,
  name: string,
  parse: (
    // eslint-disable-next-line no-unused-vars
    text: string,
  ) =>
    | { ok: true; value: T }
    | { ok: false; errors: { code: string; path: string }[] },
): { ok: true; value: T; text: string } | { ok: false; message: string } {
  const read = readSpecFile(dir, name);
  if (!read.ok) return { ok: false, message: read.message };
  const parsed = parse(read.text);
  if (!parsed.ok) {
    const first = parsed.errors[0]!;
    return {
      ok: false,
      message: `${name} does not parse (${first.code} at ${first.path}); run spec-gate lint`,
    };
  }
  return { ok: true, value: parsed.value, text: read.text };
}

export function bindSpecDir(
  specDir: string,
  tp: string,
  request: BindRequest,
): BindResult {
  const dir = path.resolve(specDir);
  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(dir);
  } catch {
    return refuse(`${specDir} is not a directory`);
  }
  if (dirStat.isSymbolicLink()) {
    return refuse(`${specDir} is a symlink, refusing to write into it`);
  }
  if (!dirStat.isDirectory()) return refuse(`${specDir} is not a directory`);

  const spec = readParsed(dir, SPEC_FILE, parseSpec);
  if (!spec.ok) return refuse(spec.message);
  const status = spec.value.frontmatter.status;
  if (status !== "proposed") {
    return refuse(
      `the status is ${status}; bind changes a binding of a proposed spec only, before that bindings.yaml is edited directly`,
    );
  }
  const plan = readParsed(dir, TESTPLAN_FILE, parseTestPlan);
  if (!plan.ok) return refuse(plan.message);
  const row = plan.value.find((r) => r.id === tp);
  if (row === undefined) {
    return refuse(`${JSON.stringify(tp)} is not a row of ${TESTPLAN_FILE}`);
  }
  const current = readParsed(dir, BINDINGS_FILE, parseBindings);
  if (!current.ok) return refuse(current.message);
  const old = current.value[tp];
  if (old === undefined) {
    return refuse(
      `${tp} has no binding in ${BINDINGS_FILE}; bind changes an existing binding and adds no ID`,
    );
  }
  const log = readParsed(dir, BINDINGS_LOG_FILE, (text) => {
    const parsed = parseBindingsLog(text);
    return parsed.ok
      ? parsed
      : {
          ok: false as const,
          errors: [
            { code: parsed.problem.code, path: `line ${parsed.problem.line}` },
          ],
        };
  });
  if (!log.ok) return refuse(log.message);

  const raw: Record<string, unknown> = { status: request.status };
  if (request.selector !== undefined) raw["selector"] = request.selector;
  if (request.file !== undefined) raw["file"] = request.file;
  if (request.fixtures !== undefined && request.fixtures.length > 0) {
    raw["fixtures"] = request.fixtures;
  }
  if (request.notes !== undefined) raw["notes"] = request.notes;
  const checked = validateBindings({ [tp]: raw });
  if (!checked.ok) {
    const first = checked.errors[0]!;
    return refuse(
      `the new binding is not valid (${first.code} at ${first.path}): ${first.message}`,
    );
  }
  const binding: Binding = checked.value[tp]!;
  const kindProblem = bindStatusProblem(row.kind, old.status, binding.status);
  if (kindProblem !== null) {
    return refuse(`${tp}: ${kindProblem}; ${binding.status} is refused`);
  }

  const next: Bindings = { ...current.value, [tp]: canonicalBinding(binding) };
  const yamlText = serializeBindings(next);
  const reparsed = parseBindings(yamlText);
  if (!reparsed.ok || !sameBindings(reparsed.value, next)) {
    return refuse(
      `could not produce a valid ${BINDINGS_FILE}; nothing was written`,
    );
  }
  const entry = serializeNextBind(log.value, tp, binding);
  const logText = `${log.text}${entry}\n`;
  const relog = parseBindingsLog(logText);
  if (!relog.ok) {
    return refuse(
      `could not produce a valid ${BINDINGS_LOG_FILE}; nothing was written`,
    );
  }

  const wroteLog = replaceFile(dir, BINDINGS_LOG_FILE, logText);
  if (!wroteLog.ok) return refuse(`${wroteLog.message}; nothing was written`);
  const wroteYaml = replaceFile(dir, BINDINGS_FILE, yamlText);
  if (!wroteYaml.ok) {
    return refuse(
      `${wroteYaml.message}; ${BINDINGS_LOG_FILE} already holds the entry, run the same bind again`,
    );
  }
  return { ok: true, tp, seq: relog.value.lines.length };
}
