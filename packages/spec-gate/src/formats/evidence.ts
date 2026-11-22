/**
 * Evidence intake.
 *
 * Evidence arrives as envelopes written by a runner: one JSON object per
 * line (JSON Lines), or one object per file. The envelope schema ships in
 * `schemas/evidence-envelope.json`, a copy of the reference runner's
 * schema; a test pins the two byte for byte. This module validates in
 * code, field for field as the schema reads, and adds no dependency.
 *
 * Two phases (`phase` in the envelope):
 * - `baseline`: gathered at the spec's `base_commit` while the spec is
 *   written. Informative. Can go stale.
 * - `closure`: gathered at the start commit or later, against the
 *   finished work. Decides the closing check.
 *
 * The code here only reads and validates. Whether an envelope matches the
 * commit, the command set or the selector it should is a check for the
 * lint and closure steps, which read git; those steps call
 * `staleEvidenceApplies` and `evidenceSurvivesSquash` for the rules.
 */
import type { ParseResult } from "./errors.js";
import { ErrorSink, failResult, okResult } from "./errors.js";
import { parseJsonText } from "./input.js";
import { MAX_INPUT_LENGTH } from "./input.js";
import type { Rec } from "./validate.js";
import {
  commitValue,
  describeType,
  enumValue,
  hasOwn,
  isRecord,
  isoTime,
  rejectUnknownKeys,
} from "./validate.js";

export const EVIDENCE_SCHEMA_VERSION = 1;
export const EVIDENCE_PHASES = ["baseline", "closure"] as const;
export type EvidencePhase = (typeof EVIDENCE_PHASES)[number];
export const EVIDENCE_PRODUCERS = ["ci", "host", "local"] as const;
export type EvidenceProducer = (typeof EVIDENCE_PRODUCERS)[number];
export const EVIDENCE_RESULTS = ["pass", "fail", "skip", "error"] as const;
export type EvidenceResult = (typeof EVIDENCE_RESULTS)[number];

export const MAX_CI_RUN_LENGTH = 2048;

export interface EvidenceEnvelope {
  schema_version: 1;
  phase: EvidencePhase;
  producer: EvidenceProducer;
  /** Present exactly when `producer` is `ci`. */
  ci_run?: string;
  time: string;
  commit: string;
  dirty: boolean;
  commands_digest: string;
  selector: string | null;
  command: string[];
  exit: number | null;
  result: EvidenceResult;
}

const REQUIRED = [
  "schema_version",
  "phase",
  "producer",
  "time",
  "commit",
  "dirty",
  "commands_digest",
  "selector",
  "command",
  "exit",
  "result",
] as const;

/** Every property of the envelope schema. */
export const EVIDENCE_FIELDS: readonly string[] = [...REQUIRED, "ci_run"];

const DIGEST_RE = /^[0-9a-f]{64}$/;

function joinPath(base: string, key: string): string {
  return base === "$" ? key : `${base}.${key}`;
}

/** Validates one decoded envelope. `path` prefixes every error path. */
function validateEnvelope(
  sink: ErrorSink,
  raw: unknown,
  path: string,
): EvidenceEnvelope | undefined {
  const before = sink.errors.length;
  if (!isRecord(raw)) {
    sink.add(
      "wrong-type",
      path,
      `an envelope must be an object, got ${describeType(raw)}`,
    );
    return undefined;
  }
  const rec: Rec = raw;
  const at = (key: string) => joinPath(path, key);
  rejectUnknownKeys(
    sink,
    rec,
    EVIDENCE_FIELDS,
    path === "$" ? "" : path,
    "envelope",
  );
  for (const key of REQUIRED) {
    if (!hasOwn(rec, key)) {
      sink.add(
        "missing-field",
        at(key),
        `envelope is missing required field ${key}`,
      );
    }
  }
  if (hasOwn(rec, "schema_version") && rec["schema_version"] !== 1) {
    sink.add("invalid-value", at("schema_version"), "schema_version must be 1");
  }
  const phase = hasOwn(rec, "phase")
    ? enumValue(sink, rec["phase"], EVIDENCE_PHASES, at("phase"), "phase")
    : undefined;
  const producer = hasOwn(rec, "producer")
    ? enumValue(
        sink,
        rec["producer"],
        EVIDENCE_PRODUCERS,
        at("producer"),
        "producer",
      )
    : undefined;
  const result = hasOwn(rec, "result")
    ? enumValue(sink, rec["result"], EVIDENCE_RESULTS, at("result"), "result")
    : undefined;
  const time = hasOwn(rec, "time")
    ? isoTime(sink, rec["time"], at("time"), "time")
    : undefined;
  const commit = hasOwn(rec, "commit")
    ? commitValue(sink, rec["commit"], at("commit"), "commit")
    : undefined;
  let dirty: boolean | undefined;
  if (hasOwn(rec, "dirty")) {
    if (typeof rec["dirty"] === "boolean") dirty = rec["dirty"];
    else sink.add("wrong-type", at("dirty"), "dirty must be a boolean");
  }
  let digest: string | undefined;
  if (hasOwn(rec, "commands_digest")) {
    const v = rec["commands_digest"];
    if (typeof v === "string" && DIGEST_RE.test(v)) digest = v;
    else {
      sink.add(
        "invalid-value",
        at("commands_digest"),
        "commands_digest must be 64 lower-case hex characters",
      );
    }
  }
  let selector: string | null | undefined;
  if (hasOwn(rec, "selector")) {
    const v = rec["selector"];
    if (v === null || typeof v === "string") selector = v;
    else {
      sink.add(
        "wrong-type",
        at("selector"),
        "selector must be a string or null",
      );
    }
  }
  let command: string[] | undefined;
  if (hasOwn(rec, "command")) {
    const v = rec["command"];
    if (Array.isArray(v) && v.every((e) => typeof e === "string")) {
      command = v as string[];
    } else {
      sink.add(
        "wrong-type",
        at("command"),
        "command must be a list of strings",
      );
    }
  }
  let exit: number | null | undefined;
  if (hasOwn(rec, "exit")) {
    const v = rec["exit"];
    if (v === null || (typeof v === "number" && Number.isInteger(v))) exit = v;
    else sink.add("wrong-type", at("exit"), "exit must be an integer or null");
  }

  // ci_run: required for producer ci, not allowed otherwise
  let ciRun: string | undefined;
  if (hasOwn(rec, "ci_run")) {
    const v = rec["ci_run"];
    if (typeof v !== "string") {
      sink.add("wrong-type", at("ci_run"), "ci_run must be a string");
    } else if (v.length < 1 || v.length > MAX_CI_RUN_LENGTH) {
      sink.add(
        "invalid-value",
        at("ci_run"),
        `ci_run must be 1 to ${MAX_CI_RUN_LENGTH} characters`,
      );
    } else ciRun = v;
  }
  if (producer === "ci" && !hasOwn(rec, "ci_run")) {
    sink.add(
      "ci-run-required",
      at("ci_run"),
      "producer ci needs a ci_run id or URL",
    );
  }
  if (producer !== undefined && producer !== "ci" && hasOwn(rec, "ci_run")) {
    sink.add(
      "ci-run-not-allowed",
      at("ci_run"),
      `ci_run is only allowed for producer ci, not ${producer}`,
    );
  }
  // command may be empty only for a skipped check
  if (
    command !== undefined &&
    command.length === 0 &&
    result !== undefined &&
    result !== "skip"
  ) {
    sink.add(
      "command-required",
      at("command"),
      "command may be empty only when result is skip",
    );
  }

  if (sink.errors.length > before) return undefined;
  const out: EvidenceEnvelope = {
    schema_version: 1,
    phase: phase!,
    producer: producer!,
    time: time!,
    commit: commit!,
    dirty: dirty!,
    commands_digest: digest!,
    selector: selector!,
    command: command!,
    exit: exit!,
    result: result!,
  };
  if (ciRun !== undefined) out.ci_run = ciRun;
  return out;
}

/** Validates one already decoded envelope. */
export function validateEvidenceEnvelope(
  raw: unknown,
): ParseResult<EvidenceEnvelope> {
  const sink = new ErrorSink();
  const env = validateEnvelope(sink, raw, "$");
  if (!sink.empty || !env) return failResult(sink.errors);
  return okResult(env);
}

/** Parses a file holding one JSON envelope. */
export function parseEvidenceEnvelope(
  text: string,
): ParseResult<EvidenceEnvelope> {
  const decoded = parseJsonText(text);
  if (!decoded.ok) return decoded;
  return validateEvidenceEnvelope(decoded.value);
}

/**
 * Parses JSON Lines: one envelope per line. The only blank line allowed
 * is the one a final line break leaves behind; an empty file is an error.
 */
export function parseEvidenceLines(
  text: string,
): ParseResult<EvidenceEnvelope[]> {
  if (text.length > MAX_INPUT_LENGTH) {
    return failResult([
      {
        code: "input-too-large",
        path: "$",
        message: `input is ${text.length} characters, the limit is ${MAX_INPUT_LENGTH}`,
      },
    ]);
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const sink = new ErrorSink();
  if (lines.length === 0) {
    sink.add("empty-document", "$", "the evidence file holds no envelope");
    return failResult(sink.errors);
  }
  const out: EvidenceEnvelope[] = [];
  lines.forEach((lineText, index) => {
    const lineNo = index + 1;
    const path = `[${index}]`;
    if (lineText.trim() === "") {
      sink.add("blank-line", path, "blank line between envelopes", lineNo);
      return;
    }
    const decoded = parseJsonText(lineText);
    if (!decoded.ok) {
      for (const e of decoded.errors) {
        sink.add(e.code, path, e.message, lineNo);
      }
      return;
    }
    sink.lineHint = lineNo;
    const env = validateEnvelope(sink, decoded.value, path);
    sink.lineHint = undefined;
    if (env) out.push(env);
  });
  return sink.finish(out);
}

// ------------------------------------------------------------ validity rules

/**
 * `stale-evidence` is a finding about `baseline` evidence only: it means
 * the envelope's commit, cleanliness, command-set digest or selector no
 * longer match what the spec was written against. `closure` evidence is
 * compared at the start commit by the closing check, never marked stale.
 */
export function staleEvidenceApplies(phase: EvidencePhase): boolean {
  return phase === "baseline";
}

/**
 * Validity of evidence after the pull request was squash-merged.
 *
 * A squash merge replaces the PR branch's commits by one new commit, so
 * evidence that names a branch commit names a commit no longer reachable
 * from the default branch. Rule:
 * - `closure` evidence is gathered on the default branch after the merge
 *   and is not affected.
 * - Other evidence (red evidence per slice) stays valid only if the
 *   commit it names was on the PR branch before the squash AND is
 *   referenced in the CI run of the pull request.
 * - In every other case the evidence does not count, and only `closure`
 *   evidence does.
 *
 * The two facts are git and host questions. The closing check (a later
 * step that reads git) answers them and passes them in; nothing here
 * invokes git.
 */
export const SQUASH_EVIDENCE_RULE = {
  summary:
    "Per-slice evidence survives a squash merge only if it names a commit that was on the PR branch before the squash and that the PR's CI run references; otherwise only closure evidence counts.",
  closureUnaffected: true,
  requiredFacts: ["onPrBranchBeforeSquash", "referencedInPrCiRun"],
} as const;

export interface SquashFacts {
  /** The merge was a squash merge. */
  squashed: boolean;
  /** The envelope's commit was on the PR branch before the squash. */
  onPrBranchBeforeSquash: boolean;
  /** The PR's CI run references the envelope's commit. */
  referencedInPrCiRun: boolean;
}

export function evidenceSurvivesSquash(
  phase: EvidencePhase,
  facts: SquashFacts,
): { valid: boolean; reason: string } {
  if (!facts.squashed) {
    return { valid: true, reason: "the merge was not a squash merge" };
  }
  if (phase === "closure") {
    return {
      valid: true,
      reason: "closure evidence is gathered after the merge",
    };
  }
  if (facts.onPrBranchBeforeSquash && facts.referencedInPrCiRun) {
    return {
      valid: true,
      reason:
        "the commit was on the PR branch before the squash and the PR's CI run references it",
    };
  }
  return {
    valid: false,
    reason: facts.onPrBranchBeforeSquash
      ? "the PR's CI run does not reference the commit; only closure evidence counts"
      : "the commit was not on the PR branch before the squash; only closure evidence counts",
  };
}
