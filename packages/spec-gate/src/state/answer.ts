/**
 * `spec-gate answer`: the one verb that writes an answer into
 * `questions.json`. Nothing else records an answer: the format has no
 * writer, and a hand-edited answer carries no provenance the tools can
 * trust.
 *
 * Every refusal is a returned message, never a partial write. The file is
 * read through the lint's hardened reader (a link, a non-regular file, a
 * file over the cap or non-UTF-8 text is refused as a named error) and
 * replaced through `replaceFile`, so a reader sees the old or the new file
 * whole and an existing file keeps its permission bits.
 *
 * The answer's `time` comes from a clock the caller supplies (a library
 * seam for tests), never from an argument: there is no flag and no
 * environment override for it. The clock is read once and rendered as a
 * UTC second with a trailing `Z`, which is the only spelling the format's
 * time field accepts.
 *
 * `--accept-recommended` is how a `yes` to a recommendation is recorded:
 * the answer and its `option` both take the question's `recommended`
 * label, never the first option. `--option` says which label a free
 * `--answer` chose and must be one of the question's options.
 */
import fs from "node:fs";
import path from "node:path";
import {
  parseQuestions,
  parseSpec,
  type Answer,
  type Question,
  type Questions,
} from "../formats/index.js";
import { ANSWER_CHANNELS } from "../formats/vocab.js";
import { readSpecFile } from "../lint/files.js";
import { QUESTIONS_FILE, SPEC_FILE } from "../lint/load.js";
import { replaceFile } from "./write.js";

/** A clock: returns the instant an answer was given. Reads no argument. */
export type Clock = () => Date;

/** The real clock, the default every verb uses. */
export const systemClock: Clock = () => new Date();

const QN_RE = /^QN-[1-9][0-9]{0,8}$/;

export interface AnswerRequest {
  /** The question ID being answered (`QN-<n>`). */
  question: string;
  /** `--answer`: the free answer text. */
  answer?: string;
  /** `--option`: the label of the chosen option; only with `--answer`. */
  option?: string;
  /** `--accept-recommended`: take the question's recommended option. */
  acceptRecommended?: boolean;
  /** `--channel`: file, chat or comment. */
  channel: string;
  /** `--author`: the login of the person who answered. */
  author: string;
  /** `--comment-url`: an https URL, only with `--channel comment`. */
  commentUrl?: string;
}

/** The named reason an answer was refused; every one maps to exit 2. */
export type AnswerRefusalCode =
  | "spec-dir-not-a-directory"
  | "spec-dir-not-spec-layout"
  | "channel-invalid"
  | "answer-choice"
  | "empty-answer"
  | "empty-author"
  | "comment-url-channel"
  | "comment-url-https"
  | "questions-missing"
  | "questions-unreadable"
  | "questions-invalid"
  | "spec-unreadable"
  | "spec-not-draft"
  | "unknown-question"
  | "already-answered"
  | "option-not-label"
  | "recommended-not-allowed"
  | "write-failed";

export type AnswerResult =
  | { ok: true; question: string; answers: number }
  | { ok: false; code: AnswerRefusalCode; message: string };

function refuse(code: AnswerRefusalCode, message: string): AnswerResult {
  return { ok: false, code, message: `answer: ${message}` };
}

/** The clock's instant as the format's UTC second: `...T..:..:..Z`. */
export function answerTime(now: Clock): string {
  return now()
    .toISOString()
    .replace(/\.[0-9]{3}Z$/, "Z");
}

/** A question as the file holds it: fixed key order, absent fields left out. */
function serializeQuestion(q: Question): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: q.id,
    target: q.target,
    class: q.class,
    blocking: q.blocking,
    question: q.question,
    options: q.options.map((o) => ({
      label: o.label,
      consequence: o.consequence,
    })),
  };
  if (q.recommended !== undefined) out["recommended"] = q.recommended;
  if (q.evidence !== undefined) out["evidence"] = q.evidence;
  return out;
}

/** An answer as the file holds it: fixed key order, absent fields left out. */
function serializeAnswer(a: Answer): Record<string, unknown> {
  const out: Record<string, unknown> = {
    question: a.question,
    answer: a.answer,
  };
  if (a.option !== undefined) out["option"] = a.option;
  out["channel"] = a.channel;
  out["author"] = a.author;
  out["time"] = a.time;
  if (a.comment_url !== undefined) out["comment_url"] = a.comment_url;
  return out;
}

/**
 * The deterministic text of a whole `questions.json`: fixed key order,
 * two-space JSON and a trailing newline. `parseQuestions` of this text
 * deep-equals the document it came from.
 */
export function serializeQuestions(doc: Questions): string {
  const out = {
    questions: doc.questions.map(serializeQuestion),
    answers: doc.answers.map(serializeAnswer),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Whether `dir` is laid out as `specs/<name>`: its parent is `specs`. */
function isSpecLayout(dir: string): boolean {
  const parts = dir.split(path.sep).filter((p) => p !== "");
  return (
    parts.length >= 2 &&
    parts[parts.length - 2] === "specs" &&
    parts[parts.length - 1] !== ""
  );
}

function readText(
  dir: string,
  name: string,
): { ok: true; text: string } | { ok: false; code: AnswerRefusalCode } {
  const read = readSpecFile(dir, name);
  if (read.ok) return { ok: true, text: read.text };
  if (read.code === "input-missing") {
    return { ok: false, code: "questions-missing" };
  }
  return { ok: false, code: "questions-unreadable" };
}

/**
 * Appends one answer to `<specDir>/questions.json`. `now` is the clock seam
 * (tests pass a fixed clock); the real verb leaves it out and reads the
 * system clock. Any refusal writes nothing.
 */
export function answerSpecDir(
  specDir: string,
  request: AnswerRequest,
  now: Clock = systemClock,
): AnswerResult {
  const dir = path.resolve(specDir);

  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(dir);
  } catch {
    return refuse("spec-dir-not-a-directory", `${specDir} is not a directory`);
  }
  if (dirStat.isSymbolicLink()) {
    return refuse(
      "spec-dir-not-a-directory",
      `${specDir} is a symlink, refusing to write into it`,
    );
  }
  if (!dirStat.isDirectory()) {
    return refuse("spec-dir-not-a-directory", `${specDir} is not a directory`);
  }
  if (!isSpecLayout(dir)) {
    return refuse(
      "spec-dir-not-spec-layout",
      `${specDir} must be a spec directory specs/<name>`,
    );
  }

  if (
    !ANSWER_CHANNELS.includes(
      request.channel as (typeof ANSWER_CHANNELS)[number],
    )
  ) {
    return refuse(
      "channel-invalid",
      `--channel must be one of ${ANSWER_CHANNELS.join(", ")}, got ${JSON.stringify(request.channel)}`,
    );
  }
  if (request.author.trim() === "") {
    return refuse("empty-author", "--author must not be empty");
  }

  const hasAnswer = request.answer !== undefined;
  const hasAccept = request.acceptRecommended === true;
  if (hasAnswer === hasAccept) {
    return refuse(
      "answer-choice",
      "give exactly one of --answer <text> or --accept-recommended",
    );
  }
  if (hasAnswer && request.answer!.trim() === "") {
    return refuse("empty-answer", "--answer must not be empty");
  }
  if (hasAccept && request.option !== undefined) {
    return refuse(
      "answer-choice",
      "--option is given with --answer only; --accept-recommended takes the recommended option",
    );
  }
  if (request.commentUrl !== undefined) {
    if (request.channel !== "comment") {
      return refuse(
        "comment-url-channel",
        "--comment-url needs --channel comment",
      );
    }
    if (!isHttps(request.commentUrl)) {
      return refuse(
        "comment-url-https",
        `--comment-url must be an https URL, got ${JSON.stringify(request.commentUrl)}`,
      );
    }
  }

  const questionsRead = readText(dir, QUESTIONS_FILE);
  if (!questionsRead.ok) {
    if (questionsRead.code === "questions-missing") {
      return refuse("questions-missing", `${QUESTIONS_FILE} does not exist`);
    }
    return refuse(
      "questions-unreadable",
      `${QUESTIONS_FILE} cannot be read (it must be a regular UTF-8 file)`,
    );
  }
  const parsed = parseQuestions(questionsRead.text);
  if (!parsed.ok) {
    const first = parsed.errors[0]!;
    return refuse(
      "questions-invalid",
      `${QUESTIONS_FILE} is not valid (${first.code} at ${first.path}); fix it first`,
    );
  }

  const specRead = readText(dir, SPEC_FILE);
  if (!specRead.ok) {
    return refuse("spec-unreadable", `${SPEC_FILE} cannot be read`);
  }
  const spec = parseSpec(specRead.text);
  if (!spec.ok) {
    return refuse("spec-unreadable", `${SPEC_FILE} does not parse`);
  }
  if (spec.value.frontmatter.status !== "draft") {
    return refuse(
      "spec-not-draft",
      `the status is ${spec.value.frontmatter.status}; answer writes answers of a draft spec only`,
    );
  }

  const doc = parsed.value;
  const question = doc.questions.find((q) => q.id === request.question);
  if (question === undefined || !QN_RE.test(request.question)) {
    return refuse(
      "unknown-question",
      `${JSON.stringify(request.question)} is not a question in ${QUESTIONS_FILE}`,
    );
  }
  if (doc.answers.some((a) => a.question === question.id)) {
    return refuse(
      "already-answered",
      `question ${question.id} is already answered; a question has at most one answer`,
    );
  }

  let answerText: string;
  let option: string | undefined;
  if (hasAccept) {
    const recommended = question.recommended;
    if (recommended === undefined) {
      return refuse(
        "recommended-not-allowed",
        `question ${question.id} has no recommended option to accept`,
      );
    }
    answerText = recommended;
    option = recommended;
  } else {
    answerText = request.answer!;
    if (request.option !== undefined) {
      if (!question.options.some((o) => o.label === request.option)) {
        return refuse(
          "option-not-label",
          `${JSON.stringify(request.option)} is not the label of an option of ${question.id}`,
        );
      }
      option = request.option;
    }
  }

  const answer: Answer = {
    question: question.id,
    answer: answerText,
    ...(option !== undefined ? { option } : {}),
    channel: request.channel as Answer["channel"],
    author: request.author,
    time: answerTime(now),
    ...(request.commentUrl !== undefined
      ? { comment_url: request.commentUrl }
      : {}),
  };

  const next: Questions = {
    questions: doc.questions,
    answers: [...doc.answers, answer],
  };
  const serialized = serializeQuestions(next);
  const reparsed = parseQuestions(serialized);
  if (!reparsed.ok) {
    return refuse(
      "write-failed",
      `could not produce a valid ${QUESTIONS_FILE}; nothing was written`,
    );
  }
  const wrote = replaceFile(dir, QUESTIONS_FILE, serialized);
  if (!wrote.ok) {
    return refuse("write-failed", wrote.message);
  }
  return { ok: true, question: question.id, answers: next.answers.length };
}

/** Whether `url` parses as an absolute `https:` URL. */
function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
