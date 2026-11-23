/**
 * Loads the files of a spec directory into `LintInputs`. Git is never
 * involved. Every problem becomes a finding (`file` for a file that cannot
 * be read, `format` for text that does not parse); nothing here throws.
 */
import path from "node:path";
import {
  isId,
  parseBindings,
  parseConfig,
  parseQuestions,
  parseSpec,
  parseTestPlan,
  parseTriage,
  type FormatError,
  type ParseResult,
  type SpecGateConfig,
} from "../formats/index.js";
import { ACKS_FILE, parseAcks, type Ack } from "./acks.js";
import { readSpecFile } from "./files.js";
import { parseSourceMeta } from "./meta.js";
import { TRIAGE_FILE } from "./profile.js";
import type { LintInputs, Loaded, RuleFinding } from "./types.js";

export const SPEC_FILE = "spec.md";
export const TESTPLAN_FILE = "testplan.yaml";
export const BINDINGS_FILE = "bindings.yaml";
export const QUESTIONS_FILE = "questions.json";
export const META_FILE = "source/meta.json";

/** Where the loader reports its findings; the engine stamps the level. */
export interface FindingSink {
  // The base no-unused-vars rule reads the names in a signature as variables.
  // eslint-disable-next-line no-unused-vars
  add(rule: string, finding: RuleFinding): void;
}

/** The ID a format error's dotted path starts with (`TP-1.kind`), if any. */
function idOfPath(path: string): string | undefined {
  const head = path.split(/[.[]/)[0] ?? "";
  return isId(head) ? head : undefined;
}

function formatFindings(
  sink: FindingSink,
  file: string,
  errors: readonly FormatError[],
): void {
  for (const error of errors) {
    const finding: RuleFinding = {
      file,
      path: error.path,
      code: error.code,
      message: error.message,
    };
    const id = idOfPath(error.path);
    if (id !== undefined) finding.id = id;
    if (error.line !== undefined) finding.line = error.line;
    sink.add("format", finding);
  }
}

function load<T>(
  dir: string,
  sink: FindingSink,
  file: string,
  required: boolean,
  // eslint-disable-next-line no-unused-vars
  parse: (text: string) => ParseResult<T>,
): Loaded<T> {
  const read = readSpecFile(dir, file);
  if (!read.ok) {
    if (read.code === "input-missing" && !required) return { state: "absent" };
    sink.add("file", {
      file,
      path: "$",
      code: read.code,
      message: read.message,
    });
    return { state: "failed" };
  }
  const parsed = parse(read.text);
  if (!parsed.ok) {
    formatFindings(sink, file, parsed.errors);
    return { state: "failed" };
  }
  return { state: "ok", value: parsed.value };
}

export function loadInputs(dir: string, sink: FindingSink): LintInputs {
  return {
    spec: load(dir, sink, SPEC_FILE, true, parseSpec),
    testplan: load(dir, sink, TESTPLAN_FILE, true, parseTestPlan),
    bindings: load(dir, sink, BINDINGS_FILE, false, parseBindings),
    questions: load(dir, sink, QUESTIONS_FILE, false, parseQuestions),
    triage: load(dir, sink, TRIAGE_FILE, false, parseTriage),
    meta: load(dir, sink, META_FILE, false, parseSourceMeta),
  };
}

/** The acks of a spec directory; an invalid file yields none and one error per problem. */
export function loadAcks(dir: string, sink: FindingSink): Ack[] {
  const loaded = load(dir, sink, ACKS_FILE, false, parseAcks);
  return loaded.state === "ok" ? loaded.value : [];
}

/**
 * The `.spec-gate/config.yaml` given to `--config`. It is not part of the
 * spec directory, so the findings about it name `configPath`, the path as
 * it was given: there is no directory the path is relative to. A file that
 * cannot be read is a `file` finding and one that does not parse is a
 * `format` finding; in both cases the rules fall back to the format
 * defaults instead of skipping.
 */
export function loadConfig(
  configPath: string,
  sink: FindingSink,
): Loaded<SpecGateConfig> {
  const read = readSpecFile(
    path.dirname(configPath),
    path.basename(configPath),
  );
  if (!read.ok) {
    sink.add("file", {
      file: configPath,
      path: "$",
      code: read.code,
      message: read.message,
    });
    return { state: "failed" };
  }
  const parsed = parseConfig(read.text);
  if (!parsed.ok) {
    formatFindings(sink, configPath, parsed.errors);
    return { state: "failed" };
  }
  return { state: "ok", value: parsed.value };
}
