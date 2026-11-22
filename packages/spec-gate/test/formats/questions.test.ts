import { describe, expect, it } from "vitest";
import {
  MAX_QUESTION_OPTIONS,
  parseQuestions,
  validateQuestions,
} from "../../src/formats/index.js";

const question = (over: Record<string, unknown> = {}) => ({
  id: "QN-1",
  target: "AC-1",
  class: "divergence",
  blocking: true,
  question: "q?",
  options: [
    { label: "a", consequence: "ca" },
    { label: "b", consequence: "cb" },
  ],
  ...over,
});

const answer = (over: Record<string, unknown> = {}) => ({
  question: "QN-1",
  answer: "a",
  channel: "file",
  author: "alice",
  time: "2000-01-31T12:00:00Z",
  ...over,
});

function codes(doc: unknown): string[] {
  const r = validateQuestions(doc);
  return r.ok ? [] : r.errors.map((e) => `${e.code} @ ${e.path}`);
}

describe("questions.json", () => {
  it("allows at most four options", () => {
    expect(MAX_QUESTION_OPTIONS).toBe(4);
    const opts = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        label: `o${i}`,
        consequence: "c",
      }));
    for (const n of [0, 1, 4]) {
      expect(
        codes({ questions: [question({ options: opts(n) })] }),
        String(n),
      ).toEqual([]);
    }
    expect(codes({ questions: [question({ options: opts(5) })] })).toEqual([
      "invalid-value @ QN-1.options",
    ]);
  });

  it("rejects options that are not a list", () => {
    for (const options of ["a", {}, null, 3]) {
      expect(
        codes({ questions: [question({ options })] }),
        String(options),
      ).toEqual(["wrong-type @ QN-1.options"]);
    }
  });

  it("accepts every target kind except a question", () => {
    for (const target of [
      "GOAL",
      "AC-1",
      "NG-2",
      "DF-3",
      "DC-4",
      "RS-5",
      "SL-6",
      "TP-7",
      "L12-0123456789ab",
    ]) {
      expect(codes({ questions: [question({ target })] }), target).toEqual([]);
    }
    for (const target of ["QN-2", "x", "", "AC-0"]) {
      expect(codes({ questions: [question({ target })] }).length, target).toBe(
        1,
      );
    }
  });

  it("lets only a divergence question recommend, and only one of its labels", () => {
    expect(codes({ questions: [question({ recommended: "a" })] })).toEqual([]);
    expect(codes({ questions: [question({ recommended: "z" })] })).toEqual([
      "unknown-option @ QN-1.recommended",
    ]);
    for (const cls of ["blind-spot", "untestable"]) {
      expect(
        codes({ questions: [question({ class: cls, recommended: "a" })] }),
        cls,
      ).toEqual(["recommended-not-allowed @ QN-1.recommended"]);
      expect(codes({ questions: [question({ class: cls })] }), cls).toEqual([]);
    }
    expect(
      codes({ questions: [question({ recommended: "a", options: [] })] }),
    ).toEqual(["unknown-option @ QN-1.recommended"]);
  });

  it("defaults answers to an empty list; an explicit empty list means the same", () => {
    const absent = validateQuestions({ questions: [question()] });
    const empty = validateQuestions({ questions: [question()], answers: [] });
    expect(absent).toEqual(empty);
    expect(absent.ok && absent.value.answers).toEqual([]);
  });

  it("accepts an answer with every optional field and without", () => {
    const full = validateQuestions({
      questions: [question()],
      answers: [answer({ option: "a", comment_url: "https://example.com/x" })],
    });
    expect(full.ok && full.value.answers[0]).toMatchObject({
      question: "QN-1",
      option: "a",
      comment_url: "https://example.com/x",
      channel: "file",
    });
    const bare = validateQuestions({
      questions: [question()],
      answers: [answer()],
    });
    expect(bare.ok && bare.value.answers[0]).not.toHaveProperty("option");
    expect(bare.ok && bare.value.answers[0]).not.toHaveProperty("comment_url");
  });

  it("accepts a free answer that names no option", () => {
    expect(
      codes({
        questions: [question()],
        answers: [answer({ answer: "something else entirely" })],
      }),
    ).toEqual([]);
  });

  it("checks that an answer points at a question and that each question is answered at most once", () => {
    expect(
      codes({
        questions: [question()],
        answers: [answer({ question: "QN-2" })],
      }),
    ).toEqual(["unknown-question @ answers.QN-2.question"]);
    expect(
      codes({ questions: [question()], answers: [answer(), answer()] }),
    ).toEqual(["duplicate-answer @ answers.QN-1.question"]);
    expect(
      codes({
        questions: [question(), question({ id: "QN-2" })],
        answers: [answer(), answer({ question: "QN-2" })],
      }),
    ).toEqual([]);
  });

  it("checks the chosen option against the question's options", () => {
    expect(
      codes({ questions: [question()], answers: [answer({ option: "z" })] }),
    ).toEqual(["unknown-option @ answers.QN-1.option"]);
  });

  it("accepts the URL schemes http and https only", () => {
    for (const url of ["http://example.com/a", "https://example.com/a?b=1#c"]) {
      expect(
        codes({
          questions: [question()],
          answers: [answer({ comment_url: url })],
        }),
        url,
      ).toEqual([]);
    }
    for (const url of [
      "ftp://example.com",
      "javascript:alert(1)",
      "example.com",
      "https://a b",
      "https://example.com/a b",
      "",
    ]) {
      expect(
        codes({
          questions: [question()],
          answers: [answer({ comment_url: url })],
        }).length,
        url,
      ).toBe(1);
    }
  });

  it("accepts the three channels and nothing else", () => {
    for (const channel of ["file", "chat", "comment"]) {
      expect(
        codes({ questions: [question()], answers: [answer({ channel })] }),
        channel,
      ).toEqual([]);
    }
    for (const channel of ["phone", "email", "File", "", 1]) {
      expect(
        codes({ questions: [question()], answers: [answer({ channel })] })
          .length,
        String(channel),
      ).toBe(1);
    }
  });

  it("accepts the ISO UTC time form only", () => {
    for (const time of ["2000-01-31T12:00:00Z", "2000-01-31T12:00:00.123Z"]) {
      expect(
        codes({ questions: [question()], answers: [answer({ time })] }),
        time,
      ).toEqual([]);
    }
    for (const time of [
      "2000-01-31T12:00:00+01:00",
      "2000-01-31T12:00:00",
      "2000-01-31",
      5,
    ]) {
      expect(
        codes({ questions: [question()], answers: [answer({ time })] }).length,
        String(time),
      ).toBe(1);
    }
  });

  it("parses text", () => {
    expect(parseQuestions('{"questions": []}').ok).toBe(true);
    expect(parseQuestions("[").ok).toBe(false);
  });
});
