/**
 * `.spec-gate/config.yaml`: repo-wide settings, changed only by a person
 * in a pull request of its own.
 *
 * ```yaml
 * questions:
 *   warn_above: 7        # default 7
 * approvers: [alice, bob]
 * agent_identities: [spec-bot]
 * signing_keys: []
 * ```
 *
 * Every key is optional. An absent key takes its default: `warn_above`
 * 7, the three lists empty. An empty file is an error; write `{}` to
 * accept every default. An approver that is also an agent identity is not
 * a parse error; the approval check reports it.
 */
import type { ParseResult } from "./errors.js";
import { ErrorSink, failResult } from "./errors.js";
import { parseYamlText } from "./input.js";
import type { Rec } from "./validate.js";
import {
  describeType,
  hasOwn,
  intValue,
  isRecord,
  rejectUnknownKeys,
  stringList,
} from "./validate.js";

export const DEFAULT_QUESTIONS_WARN_ABOVE = 7;

export interface SpecGateConfig {
  questions: { warn_above: number };
  /** People whose approval counts. */
  approvers: string[];
  /** Accounts an agent works under; never valid approvers. */
  agent_identities: string[];
  /** Signing keys accepted by the file adapter. */
  signing_keys: string[];
}

const TOP_KEYS = [
  "questions",
  "approvers",
  "agent_identities",
  "signing_keys",
] as const;

function identityList(
  sink: ErrorSink,
  value: unknown,
  path: string,
): string[] | undefined {
  const list = stringList(sink, value, path, path);
  if (!list) return undefined;
  let good = true;
  list.forEach((entry, i) => {
    if (/\s/.test(entry)) {
      sink.add(
        "invalid-value",
        `${path}[${i}]`,
        `${path} entries must not contain whitespace or control characters`,
      );
      good = false;
    }
  });
  return good ? list : undefined;
}

/** Validates an already decoded `config.yaml` document. */
export function validateConfig(doc: unknown): ParseResult<SpecGateConfig> {
  const sink = new ErrorSink();
  if (!isRecord(doc)) {
    sink.add(
      "wrong-type",
      "$",
      `config must be a mapping, got ${describeType(doc)}`,
    );
    return failResult(sink.errors);
  }
  const rec: Rec = doc;
  rejectUnknownKeys(sink, rec, TOP_KEYS, "", "config");
  let warnAbove = DEFAULT_QUESTIONS_WARN_ABOVE;
  if (hasOwn(rec, "questions")) {
    const q = rec["questions"];
    if (!isRecord(q)) {
      sink.add(
        "wrong-type",
        "questions",
        `questions must be a mapping, got ${describeType(q)}`,
      );
    } else {
      rejectUnknownKeys(sink, q, ["warn_above"], "questions", "questions");
      if (hasOwn(q, "warn_above")) {
        const v = intValue(
          sink,
          q["warn_above"],
          "questions.warn_above",
          "questions.warn_above",
          1,
        );
        if (v !== undefined) warnAbove = v;
      }
    }
  }
  const lists: Record<string, string[]> = {
    approvers: [],
    agent_identities: [],
    signing_keys: [],
  };
  for (const key of ["approvers", "agent_identities", "signing_keys"]) {
    if (!hasOwn(rec, key)) continue;
    const v =
      key === "signing_keys"
        ? stringList(sink, rec[key], key, key)
        : identityList(sink, rec[key], key);
    if (v) lists[key] = v;
  }
  return sink.finish({
    questions: { warn_above: warnAbove },
    approvers: lists["approvers"]!,
    agent_identities: lists["agent_identities"]!,
    signing_keys: lists["signing_keys"]!,
  });
}

/** Parses the text of a `.spec-gate/config.yaml`. */
export function parseConfig(text: string): ParseResult<SpecGateConfig> {
  const decoded = parseYamlText(text);
  if (!decoded.ok) return decoded;
  return validateConfig(decoded.value);
}
