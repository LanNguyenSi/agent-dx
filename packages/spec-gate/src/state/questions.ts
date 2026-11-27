/**
 * `spec-gate questions`: a read-only view of the questions still open in a
 * spec directory. It never writes.
 *
 * The files are read through the lint's hardened reader and parsers, so a
 * link, a non-regular file, a file over the size cap or non-UTF-8 text is
 * refused as a named error, and `questions.json` is optional: with none the
 * report holds no questions and no unanswered ones. `spec.md` is required,
 * because the report names the spec it is about.
 *
 * The frontier of a spec is every unanswered question: the format has no
 * field by which one question depends on another, so an unanswered question
 * is open whatever else is open. `unanswered` lists them in numeric ID
 * order, each with the fields exactly as the file holds them.
 */
import fs from "node:fs";
import path from "node:path";
import {
  parseQuestions,
  parseSpec,
  type Question,
  type Questions,
} from "../formats/index.js";
import { readSpecFile } from "../lint/files.js";
import { QUESTIONS_FILE, SPEC_FILE } from "../lint/load.js";

export const QUESTIONS_REPORT_FORMAT = "spec-gate-questions/1";

export interface QuestionCounts {
  total: number;
  answered: number;
  unanswered: number;
  blocking_unanswered: number;
}

export interface QuestionsReport {
  format: typeof QUESTIONS_REPORT_FORMAT;
  spec: string;
  questions: Question[];
  counts: QuestionCounts;
}

export type QuestionsResult =
  | { ok: true; report: QuestionsReport }
  | { ok: false; code: string; message: string };

/** The numeric tail of a `QN-<n>` ID; used to order unanswered questions. */
function qnNumber(id: string): number {
  return Number(id.slice(3));
}

/**
 * The unanswered questions of a parsed document, in numeric ID order, and
 * the four counts. Shared by `questions` and `status`.
 */
export function unansweredQuestions(doc: Questions): {
  unanswered: Question[];
  counts: QuestionCounts;
} {
  const answered = new Set(doc.answers.map((a) => a.question));
  const unanswered = doc.questions
    .filter((q) => !answered.has(q.id))
    .sort((a, b) => qnNumber(a.id) - qnNumber(b.id));
  const answeredCount = doc.questions.filter((q) => answered.has(q.id)).length;
  return {
    unanswered,
    counts: {
      total: doc.questions.length,
      answered: answeredCount,
      unanswered: unanswered.length,
      blocking_unanswered: unanswered.filter((q) => q.blocking).length,
    },
  };
}

function isDirectory(specDir: string): boolean {
  try {
    const stat = fs.lstatSync(path.resolve(specDir));
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Reads `<specDir>` and reports its questions. A directory that is not one,
 * a `spec.md` that cannot be read or parsed, or a `questions.json` that is
 * present but cannot be read or parsed is a named refusal; an absent
 * `questions.json` is no questions.
 */
export function questionsSpecDir(specDir: string): QuestionsResult {
  if (!isDirectory(specDir)) {
    return {
      ok: false,
      code: "input-missing",
      message: `questions: ${specDir} is not a directory`,
    };
  }
  const dir = path.resolve(specDir);

  const specRead = readSpecFile(dir, SPEC_FILE);
  if (!specRead.ok) {
    return {
      ok: false,
      code: specRead.code,
      message: `questions: ${specRead.message}`,
    };
  }
  const spec = parseSpec(specRead.text);
  if (!spec.ok) {
    const first = spec.errors[0]!;
    return {
      ok: false,
      code: first.code,
      message: `questions: ${SPEC_FILE} does not parse (${first.code} at ${first.path})`,
    };
  }

  const questionsRead = readSpecFile(dir, QUESTIONS_FILE);
  let doc: Questions = { questions: [], answers: [] };
  if (questionsRead.ok) {
    const parsed = parseQuestions(questionsRead.text);
    if (!parsed.ok) {
      const first = parsed.errors[0]!;
      return {
        ok: false,
        code: first.code,
        message: `questions: ${QUESTIONS_FILE} does not parse (${first.code} at ${first.path})`,
      };
    }
    doc = parsed.value;
  } else if (questionsRead.code !== "input-missing") {
    return {
      ok: false,
      code: questionsRead.code,
      message: `questions: ${questionsRead.message}`,
    };
  }

  const { unanswered, counts } = unansweredQuestions(doc);
  return {
    ok: true,
    report: {
      format: QUESTIONS_REPORT_FORMAT,
      spec: spec.value.frontmatter.id,
      questions: unanswered,
      counts,
    },
  };
}
