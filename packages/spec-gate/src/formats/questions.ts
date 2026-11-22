/**
 * `questions.json`: the questions asked of the people behind a request,
 * and their answers.
 *
 * ```json
 * {
 *   "questions": [
 *     {
 *       "id": "QN-1",
 *       "target": "AC-2",
 *       "class": "divergence",
 *       "blocking": true,
 *       "question": "Should old sessions stay valid?",
 *       "options": [
 *         { "label": "revoke", "consequence": "all sessions end at once" },
 *         { "label": "keep", "consequence": "old sessions stay until expiry" }
 *       ],
 *       "recommended": "revoke",
 *       "evidence": "SL-3 says 'log out everywhere'"
 *     }
 *   ],
 *   "answers": [
 *     {
 *       "question": "QN-1",
 *       "answer": "revoke",
 *       "option": "revoke",
 *       "channel": "comment",
 *       "author": "alice",
 *       "time": "2000-01-31T12:00:00Z",
 *       "comment_url": "https://example.com/issues/1#comment-2"
 *     }
 *   ]
 * }
 * ```
 *
 * A question has at most four options; a free answer is always possible,
 * so `answer` is free text and `option` (a label) only says which option
 * it chose. `recommended` exists only for `divergence`. An answer must
 * point at an existing question and may exist at most once per question.
 * `answers` may be absent, which reads as no answers yet.
 */
import type { ParseResult } from "./errors.js";
import { ErrorSink, failResult } from "./errors.js";
import { parseJsonText } from "./input.js";
import { isSourceLineId } from "./source-lines.js";
import { idPrefixOf } from "./ids.js";
import { ANSWER_CHANNELS, OPEN_POINT_CLASSES } from "./vocab.js";
import type { AnswerChannel, OpenPointClass } from "./vocab.js";
import type { Rec } from "./validate.js";
import {
  boolValue,
  describeType,
  enumValue,
  hasOwn,
  isRecord,
  isoTime,
  nonEmptyString,
  rejectUnknownKeys,
  urlValue,
} from "./validate.js";

export const MAX_QUESTION_OPTIONS = 4;

export interface QuestionOption {
  label: string;
  consequence: string;
}

export interface Question {
  id: string;
  /** A spec or test-plan ID, or a source line ID. */
  target: string;
  class: OpenPointClass;
  blocking: boolean;
  question: string;
  options: QuestionOption[];
  /** The label of the recommended option; `divergence` only. */
  recommended?: string;
  evidence?: string;
}

export interface Answer {
  question: string;
  answer: string;
  /** Label of the chosen option, when one was chosen. */
  option?: string;
  channel: AnswerChannel;
  author: string;
  time: string;
  comment_url?: string;
}

export interface Questions {
  questions: Question[];
  answers: Answer[];
}

const QUESTION_KEYS = [
  "id",
  "target",
  "class",
  "blocking",
  "question",
  "options",
  "recommended",
  "evidence",
] as const;

const ANSWER_KEYS = [
  "question",
  "answer",
  "option",
  "channel",
  "author",
  "time",
  "comment_url",
] as const;

const QN_RE = /^QN-[1-9][0-9]{0,8}$/;

function parseOptions(
  sink: ErrorSink,
  raw: unknown,
  path: string,
): QuestionOption[] | undefined {
  if (!Array.isArray(raw)) {
    sink.add(
      "wrong-type",
      path,
      `options must be a list, got ${describeType(raw)}`,
    );
    return undefined;
  }
  if (raw.length > MAX_QUESTION_OPTIONS) {
    sink.add(
      "invalid-value",
      path,
      `a question has at most ${MAX_QUESTION_OPTIONS} options, got ${raw.length}`,
    );
    return undefined;
  }
  const out: QuestionOption[] = [];
  const labels = new Set<string>();
  let good = true;
  raw.forEach((item, i) => {
    const p = `${path}[${i}]`;
    if (!isRecord(item)) {
      sink.add(
        "wrong-type",
        p,
        `an option must be an object, got ${describeType(item)}`,
      );
      good = false;
      return;
    }
    const before = sink.errors.length;
    rejectUnknownKeys(sink, item, ["label", "consequence"], p, "option");
    for (const key of ["label", "consequence"]) {
      if (!hasOwn(item, key)) {
        sink.add("missing-field", `${p}.${key}`, `option is missing ${key}`);
      }
    }
    const label = hasOwn(item, "label")
      ? nonEmptyString(sink, item["label"], `${p}.label`, "option label")
      : undefined;
    const consequence = hasOwn(item, "consequence")
      ? nonEmptyString(
          sink,
          item["consequence"],
          `${p}.consequence`,
          "option consequence",
        )
      : undefined;
    if (label !== undefined) {
      if (labels.has(label)) {
        sink.add(
          "duplicate-value",
          `${p}.label`,
          `option label ${JSON.stringify(label)} is used twice`,
        );
      }
      labels.add(label);
    }
    if (sink.errors.length > before) {
      good = false;
      return;
    }
    out.push({ label: label!, consequence: consequence! });
  });
  return good ? out : undefined;
}

function validTarget(target: string): boolean {
  return (
    (idPrefixOf(target) !== undefined && idPrefixOf(target) !== "QN") ||
    isSourceLineId(target)
  );
}

function parseQuestion(
  sink: ErrorSink,
  raw: unknown,
  index: number,
  seen: Set<string>,
): Question | undefined {
  const before = sink.errors.length;
  if (!isRecord(raw)) {
    sink.add(
      "wrong-type",
      `questions[${index}]`,
      `question ${index} must be an object, got ${describeType(raw)}`,
    );
    return undefined;
  }
  const rec: Rec = raw;
  const rawId = rec["id"];
  const base =
    typeof rawId === "string" && rawId !== "" ? rawId : `questions[${index}]`;
  rejectUnknownKeys(sink, rec, QUESTION_KEYS, base, `question ${base}`);
  for (const key of [
    "id",
    "target",
    "class",
    "blocking",
    "question",
    "options",
  ]) {
    if (!hasOwn(rec, key)) {
      sink.add(
        "missing-field",
        `${base}.${key}`,
        `question ${base} is missing field ${key}`,
      );
    }
  }
  let id: string | undefined;
  if (hasOwn(rec, "id")) {
    if (typeof rawId !== "string" || !QN_RE.test(rawId)) {
      sink.add(
        "invalid-id",
        `${base}.id`,
        `question id must be a QN-<n> ID, got ${JSON.stringify(rawId)}`,
      );
    } else if (seen.has(rawId)) {
      sink.add("duplicate-id", `${base}.id`, `question ${rawId} is used twice`);
    } else {
      seen.add(rawId);
      id = rawId;
    }
  }
  let target: string | undefined;
  if (hasOwn(rec, "target")) {
    const t = nonEmptyString(sink, rec["target"], `${base}.target`, "target");
    if (t !== undefined) {
      if (validTarget(t)) target = t;
      else {
        sink.add(
          "invalid-id",
          `${base}.target`,
          `target must be a spec or test-plan ID (not a QN ID) or a source line ID, got ${JSON.stringify(t)}`,
        );
      }
    }
  }
  const cls = hasOwn(rec, "class")
    ? enumValue(
        sink,
        rec["class"],
        OPEN_POINT_CLASSES,
        `${base}.class`,
        "class",
      )
    : undefined;
  const blocking = hasOwn(rec, "blocking")
    ? boolValue(sink, rec["blocking"], `${base}.blocking`, "blocking")
    : undefined;
  const text = hasOwn(rec, "question")
    ? nonEmptyString(sink, rec["question"], `${base}.question`, "question")
    : undefined;
  const options = hasOwn(rec, "options")
    ? parseOptions(sink, rec["options"], `${base}.options`)
    : undefined;
  let recommended: string | undefined;
  if (hasOwn(rec, "recommended")) {
    const r = nonEmptyString(
      sink,
      rec["recommended"],
      `${base}.recommended`,
      "recommended",
    );
    if (r !== undefined) {
      if (cls !== undefined && cls !== "divergence") {
        sink.add(
          "recommended-not-allowed",
          `${base}.recommended`,
          `only a divergence question carries a recommendation, ${base} is ${cls}`,
        );
      } else if (options && !options.some((o) => o.label === r)) {
        sink.add(
          "unknown-option",
          `${base}.recommended`,
          `recommended ${JSON.stringify(r)} is not the label of an option`,
        );
      } else recommended = r;
    }
  }
  let evidence: string | undefined;
  if (hasOwn(rec, "evidence")) {
    evidence = nonEmptyString(
      sink,
      rec["evidence"],
      `${base}.evidence`,
      "evidence",
    );
  }
  if (sink.errors.length > before) return undefined;
  const out: Question = {
    id: id!,
    target: target!,
    class: cls!,
    blocking: blocking!,
    question: text!,
    options: options!,
  };
  if (recommended !== undefined) out.recommended = recommended;
  if (evidence !== undefined) out.evidence = evidence;
  return out;
}

function parseAnswer(
  sink: ErrorSink,
  raw: unknown,
  index: number,
  questions: Map<string, Question>,
  answered: Set<string>,
): Answer | undefined {
  const before = sink.errors.length;
  if (!isRecord(raw)) {
    sink.add(
      "wrong-type",
      `answers[${index}]`,
      `answer ${index} must be an object, got ${describeType(raw)}`,
    );
    return undefined;
  }
  const rec: Rec = raw;
  const ref = rec["question"];
  const base =
    typeof ref === "string" && ref !== ""
      ? `answers.${ref}`
      : `answers[${index}]`;
  rejectUnknownKeys(sink, rec, ANSWER_KEYS, base, `answer ${base}`);
  for (const key of ["question", "answer", "channel", "author", "time"]) {
    if (!hasOwn(rec, key)) {
      sink.add(
        "missing-field",
        `${base}.${key}`,
        `answer ${base} is missing field ${key}`,
      );
    }
  }
  let question: Question | undefined;
  let qid: string | undefined;
  if (hasOwn(rec, "question")) {
    const q = nonEmptyString(sink, ref, `${base}.question`, "question");
    if (q !== undefined) {
      question = questions.get(q);
      if (!question) {
        sink.add(
          "unknown-question",
          `${base}.question`,
          `answer refers to ${q}, which is not a question in this file`,
        );
      } else if (answered.has(q)) {
        sink.add(
          "duplicate-answer",
          `${base}.question`,
          `question ${q} is answered twice`,
        );
      } else {
        answered.add(q);
        qid = q;
      }
    }
  }
  const answer = hasOwn(rec, "answer")
    ? nonEmptyString(sink, rec["answer"], `${base}.answer`, "answer")
    : undefined;
  let option: string | undefined;
  if (hasOwn(rec, "option")) {
    const o = nonEmptyString(sink, rec["option"], `${base}.option`, "option");
    if (o !== undefined) {
      if (question && !question.options.some((x) => x.label === o)) {
        sink.add(
          "unknown-option",
          `${base}.option`,
          `option ${JSON.stringify(o)} is not the label of an option of ${question.id}`,
        );
      } else option = o;
    }
  }
  const channel = hasOwn(rec, "channel")
    ? enumValue(
        sink,
        rec["channel"],
        ANSWER_CHANNELS,
        `${base}.channel`,
        "channel",
      )
    : undefined;
  const author = hasOwn(rec, "author")
    ? nonEmptyString(sink, rec["author"], `${base}.author`, "author")
    : undefined;
  const time = hasOwn(rec, "time")
    ? isoTime(sink, rec["time"], `${base}.time`, "time")
    : undefined;
  let commentUrl: string | undefined;
  if (hasOwn(rec, "comment_url")) {
    commentUrl = urlValue(
      sink,
      rec["comment_url"],
      `${base}.comment_url`,
      "comment_url",
    );
  }
  if (sink.errors.length > before) return undefined;
  const out: Answer = {
    question: qid!,
    answer: answer!,
    channel: channel!,
    author: author!,
    time: time!,
  };
  if (option !== undefined) out.option = option;
  if (commentUrl !== undefined) out.comment_url = commentUrl;
  return out;
}

/** Validates an already decoded `questions.json` document. */
export function validateQuestions(doc: unknown): ParseResult<Questions> {
  const sink = new ErrorSink();
  if (!isRecord(doc)) {
    sink.add(
      "wrong-type",
      "$",
      `questions file must be an object, got ${describeType(doc)}`,
    );
    return failResult(sink.errors);
  }
  const rec: Rec = doc;
  rejectUnknownKeys(sink, rec, ["questions", "answers"], "", "questions file");
  const questions: Question[] = [];
  const byId = new Map<string, Question>();
  if (!hasOwn(rec, "questions")) {
    sink.add("missing-field", "questions", "file is missing field questions");
  } else if (!Array.isArray(rec["questions"])) {
    sink.add(
      "wrong-type",
      "questions",
      `questions must be a list, got ${describeType(rec["questions"])}`,
    );
  } else {
    const seen = new Set<string>();
    rec["questions"].forEach((raw, i) => {
      const q = parseQuestion(sink, raw, i, seen);
      if (q) {
        questions.push(q);
        byId.set(q.id, q);
      }
    });
  }
  const answers: Answer[] = [];
  if (hasOwn(rec, "answers")) {
    if (!Array.isArray(rec["answers"])) {
      sink.add(
        "wrong-type",
        "answers",
        `answers must be a list, got ${describeType(rec["answers"])}`,
      );
    } else {
      const answered = new Set<string>();
      rec["answers"].forEach((raw, i) => {
        const a = parseAnswer(sink, raw, i, byId, answered);
        if (a) answers.push(a);
      });
    }
  }
  return sink.finish({ questions, answers });
}

/** Parses the text of a `questions.json`. */
export function parseQuestions(text: string): ParseResult<Questions> {
  const decoded = parseJsonText(text);
  if (!decoded.ok) return decoded;
  return validateQuestions(decoded.value);
}
