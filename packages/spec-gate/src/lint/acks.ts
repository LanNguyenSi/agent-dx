/**
 * `acks.yaml`: acknowledged warnings.
 *
 * A YAML list of `{ rule, id, reason }`, all strings, each one a single
 * line and not empty. The file sits next to `spec.md` and stays out of the
 * digest. An entry acknowledges the warnings of one rule that are about one
 * ID: it matches a warning by `(rule, id)`.
 */
import {
  ErrorSink,
  findForbiddenCharacter,
  parseYamlText,
  type FormatError,
  type ParseResult,
} from "../formats/index.js";
import {
  describeType,
  hasOwn,
  isRecord,
  rejectUnknownKeys,
} from "../formats/validate.js";
import type { AckedFinding, Finding, RuleDef, RuleFinding } from "./types.js";

export const ACKS_FILE = "acks.yaml";

export interface Ack {
  rule: string;
  id: string;
  reason: string;
}

const ACK_KEYS = ["rule", "id", "reason"] as const;

export interface AckTextProblem {
  code: "wrong-type" | "forbidden-character" | "empty-value";
  text: string;
}

/**
 * Why a value is not a usable ack text, or `null` when it is one: a string
 * that is not blank and has no control, format or separator character, a
 * tab included, so it is one line by construction.
 */
export function ackTextProblem(value: unknown): AckTextProblem | null {
  if (typeof value !== "string") {
    return {
      code: "wrong-type",
      text: `must be a string, got ${describeType(value)}`,
    };
  }
  const bad = findForbiddenCharacter(value, { allowTab: false });
  if (bad) {
    return {
      code: "forbidden-character",
      text: `must be a single line without control characters, found ${bad.label}`,
    };
  }
  if (value.trim() === "") {
    return { code: "empty-value", text: "must not be empty" };
  }
  return null;
}

/** Parses the text of an `acks.yaml`. */
export function parseAcks(text: string): ParseResult<Ack[]> {
  const decoded = parseYamlText(text);
  if (!decoded.ok) return decoded;
  const doc = decoded.value;
  const sink = new ErrorSink();
  if (!Array.isArray(doc)) {
    sink.add(
      "wrong-type",
      "$",
      `acks must be a list of { rule, id, reason }, got ${describeType(doc)}`,
    );
    return { ok: false, errors: sink.errors };
  }
  const acks: Ack[] = [];
  doc.forEach((entry: unknown, i) => {
    const at = `[${i}]`;
    if (!isRecord(entry)) {
      sink.add(
        "wrong-type",
        at,
        `an ack must be an object with rule, id and reason, got ${describeType(entry)}`,
      );
      return;
    }
    rejectUnknownKeys(sink, entry, ACK_KEYS, at, `ack ${at}`);
    let good = true;
    for (const key of ACK_KEYS) {
      if (!hasOwn(entry, key)) {
        sink.add(
          "missing-field",
          `${at}.${key}`,
          `ack ${at} is missing ${key}`,
        );
        good = false;
        continue;
      }
      const problem = ackTextProblem(entry[key]);
      if (problem !== null) {
        sink.add(
          problem.code,
          `${at}.${key}`,
          `ack ${at} ${key} ${problem.text}`,
        );
        good = false;
      }
    }
    if (good) {
      acks.push({
        rule: entry["rule"] as string,
        id: entry["id"] as string,
        reason: entry["reason"] as string,
      });
    }
  });
  if (sink.errors.length > 0) {
    return { ok: false, errors: sink.errors as FormatError[] };
  }
  return { ok: true, value: acks };
}

/** One entry as the writer appends it: a block-style list item, strings quoted. */
export function serializeAck(ack: Ack): string {
  return (
    `- rule: ${JSON.stringify(ack.rule)}\n` +
    `  id: ${JSON.stringify(ack.id)}\n` +
    `  reason: ${JSON.stringify(ack.reason)}\n`
  );
}

export interface AckOutcome {
  /** Findings raised about the acks themselves (`ack-invalid`, `ack-unused`). */
  findings: { rule: string; finding: RuleFinding }[];
  /** The warnings that stay, in input order. */
  warnings: Finding[];
  acked: AckedFinding[];
}

/**
 * Applies the acks to the warnings of a run.
 *
 * An ack is invalid when its rule is unknown, when the rule is an error, or
 * is a warning that cannot be acknowledged, and when an earlier entry has
 * the same `(rule, id)`; an invalid ack acknowledges nothing and is not
 * reported as unused. A valid ack that matches no warning is `ack-unused`.
 */
export function applyAcks(
  acks: readonly Ack[],
  warnings: readonly Finding[],
  rules: readonly RuleDef[],
): AckOutcome {
  const findings: AckOutcome["findings"] = [];
  const byId = new Map(rules.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const valid: { ack: Ack; index: number }[] = [];
  acks.forEach((ack, index) => {
    const at = `[${index}]`;
    const rule = byId.get(ack.rule);
    let problem: string | null = null;
    if (rule === undefined) {
      problem = `rule ${JSON.stringify(ack.rule)} is not a known rule`;
    } else if (rule.level !== "warning") {
      problem = `rule ${ack.rule} is an error and cannot be acknowledged`;
    } else if (!rule.ackable) {
      problem = `rule ${ack.rule} cannot be acknowledged`;
    } else if (seen.has(JSON.stringify([ack.rule, ack.id]))) {
      problem = `${ack.rule} for ${JSON.stringify(ack.id)} is acknowledged twice`;
    }
    if (problem !== null) {
      findings.push({
        rule: "ack-invalid",
        finding: {
          file: ACKS_FILE,
          path: at,
          message: `ack ${at}: ${problem}`,
        },
      });
      return;
    }
    seen.add(JSON.stringify([ack.rule, ack.id]));
    valid.push({ ack, index });
  });

  const used = new Set<number>();
  const kept: Finding[] = [];
  const acked: AckedFinding[] = [];
  for (const warning of warnings) {
    const hit = valid.find(
      ({ ack }) => ack.rule === warning.rule && ack.id === warning.id,
    );
    if (hit === undefined) {
      kept.push(warning);
      continue;
    }
    used.add(hit.index);
    acked.push({ ...warning, reason: hit.ack.reason });
  }
  for (const { ack, index } of valid) {
    if (used.has(index)) continue;
    findings.push({
      rule: "ack-unused",
      finding: {
        file: ACKS_FILE,
        path: `[${index}]`,
        id: ack.id,
        message: `ack [${index}] for ${ack.rule} on ${JSON.stringify(ack.id)} matches no warning`,
      },
    });
  }
  return { findings, warnings: kept, acked };
}
