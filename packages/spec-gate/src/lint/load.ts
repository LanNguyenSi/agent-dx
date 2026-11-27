/**
 * Loads the files of a spec directory into `LintInputs`. Git is never
 * involved here (the config at the reference commit is read in
 * `git/config.ts`). Every problem becomes a finding (`file` for a file
 * that cannot be read, `format` for text that does not parse); nothing
 * here throws.
 */
import fs from "node:fs";
import path from "node:path";
import {
  EVIDENCE_DIR,
  EVIDENCE_FILE_RE,
  evidenceFileTpId,
  isId,
  parseBindings,
  parseConfig,
  parseEvidenceLines,
  parseQuestions,
  parseSpec,
  parseTestPlan,
  parseTriage,
  type EvidenceEnvelope,
  type FormatError,
  type ParseResult,
  type SpecGateConfig,
} from "../formats/index.js";
import { ACKS_FILE, parseAcks, type Ack } from "./acks.js";
import { readSpecFile } from "./files.js";
import { parseSourceMeta } from "./meta.js";
import { TRIAGE_FILE } from "./profile.js";
import type {
  EvidenceFiles,
  LintInputs,
  Loaded,
  RuleFinding,
} from "./types.js";

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

export function formatFindings(
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

/**
 * Reads the `evidence/` directory (layout in `formats/evidence.ts`): its
 * only entries may be regular files named `TP-<n>.jsonl`, each JSON Lines
 * of the envelopes of that test-plan row. Everything else is a finding:
 * a link, a subdirectory or any other non-regular entry is a `file`
 * finding (`input-not-regular`), an entry with another name is a `format`
 * finding (`evidence-layout`), a file that cannot be read is the reader's
 * `file` finding and one that does not parse its `format` findings; all
 * of them name `evidence/<name>`. One such finding makes the whole input
 * `failed`: the evidence rules then skip (their findings would be about
 * half-read evidence) while the error fails the run.
 */
export function loadEvidence(
  dir: string,
  sink: FindingSink,
): Loaded<EvidenceFiles> {
  let entries: fs.Dirent[];
  try {
    if (!fs.lstatSync(path.join(dir, EVIDENCE_DIR)).isDirectory()) {
      sink.add("file", {
        file: EVIDENCE_DIR,
        path: "$",
        code: "input-not-regular",
        message: `${EVIDENCE_DIR} must be a directory of TP-<n>.jsonl evidence files`,
      });
      return { state: "failed" };
    }
    entries = fs.readdirSync(path.join(dir, EVIDENCE_DIR), {
      withFileTypes: true,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "absent" };
    sink.add("file", {
      file: EVIDENCE_DIR,
      path: "$",
      code: "input-unreadable",
      message: `${EVIDENCE_DIR} cannot be listed`,
    });
    return { state: "failed" };
  }
  const files: EvidenceFiles = {};
  let broken = 0;
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = `${EVIDENCE_DIR}/${entry.name}`;
    if (!EVIDENCE_FILE_RE.test(entry.name)) {
      if (entry.isFile()) {
        sink.add("format", {
          file: rel,
          path: "$",
          code: "evidence-layout",
          message: `${rel} is not named TP-<n>.jsonl: the only files of ${EVIDENCE_DIR}/ are one per test-plan row, JSON Lines, both phases in the row's file`,
        });
      } else {
        sink.add("file", {
          file: rel,
          path: "$",
          code: "input-not-regular",
          message: `${rel} is not a regular file: the only entries of ${EVIDENCE_DIR}/ are regular TP-<n>.jsonl files`,
        });
      }
      broken += 1;
      continue;
    }
    if (!entry.isFile()) {
      sink.add("file", {
        file: rel,
        path: "$",
        code: "input-not-regular",
        message: `${rel} is not a regular file: the only entries of ${EVIDENCE_DIR}/ are regular TP-<n>.jsonl files`,
      });
      broken += 1;
      continue;
    }
    const read = readSpecFile(dir, rel);
    if (!read.ok) {
      sink.add("file", {
        file: rel,
        path: "$",
        code: read.code,
        message: read.message,
      });
      broken += 1;
      continue;
    }
    const parsed = parseEvidenceLines(read.text);
    if (!parsed.ok) {
      formatFindings(sink, rel, parsed.errors);
      broken += 1;
      continue;
    }
    const tpId = evidenceFileTpId(entry.name);
    const envelopes: EvidenceEnvelope[] = parsed.value;
    if (tpId !== undefined) files[tpId] = envelopes;
  }
  return broken > 0 ? { state: "failed" } : { state: "ok", value: files };
}

export function loadInputs(dir: string, sink: FindingSink): LintInputs {
  return {
    spec: load(dir, sink, SPEC_FILE, true, parseSpec),
    testplan: load(dir, sink, TESTPLAN_FILE, true, parseTestPlan),
    bindings: load(dir, sink, BINDINGS_FILE, false, parseBindings),
    questions: load(dir, sink, QUESTIONS_FILE, false, parseQuestions),
    triage: load(dir, sink, TRIAGE_FILE, false, parseTriage),
    meta: load(dir, sink, META_FILE, false, parseSourceMeta),
    evidence: loadEvidence(dir, sink),
  };
}

/** The acks of a spec directory; an invalid file yields none and one error per problem. */
export function loadAcks(dir: string, sink: FindingSink): Ack[] {
  const loaded = load(dir, sink, ACKS_FILE, false, parseAcks);
  return loaded.state === "ok" ? loaded.value : [];
}

/**
 * The `.spec-gate/config.yaml` given to `--config`. It is not part of the
 * spec directory, so the findings about it never name the path as given
 * (an absolute path would leak into the report): `file` is
 * `config:<basename of the path>` and the message names the basename only.
 * A file that cannot be read is a `file` finding and one that does not
 * parse is a `format` finding; in both cases the rules fall back to the
 * format defaults instead of skipping. An empty path is refused by the CLI
 * as a usage error before this runs.
 */
export function loadConfig(
  configPath: string,
  sink: FindingSink,
): Loaded<SpecGateConfig> {
  const name = path.basename(configPath);
  const file = `config:${name}`;
  const read = readSpecFile(path.dirname(configPath), name);
  if (!read.ok) {
    sink.add("file", {
      file,
      path: "$",
      code: read.code,
      message: read.message,
    });
    return { state: "failed" };
  }
  const parsed = parseConfig(read.text);
  if (!parsed.ok) {
    formatFindings(sink, file, parsed.errors);
    return { state: "failed" };
  }
  return { state: "ok", value: parsed.value };
}
