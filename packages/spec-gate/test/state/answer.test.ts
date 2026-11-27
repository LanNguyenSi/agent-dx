import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseQuestions, type Questions } from "../../src/formats/index.js";
import { lintSpecDir, type LintReport } from "../../src/lint/index.js";
import {
  answerSpecDir,
  serializeQuestions,
  type AnswerResult,
} from "../../src/state/index.js";
import { edited, scratch, validFiles } from "../lint/helpers.js";
import {
  clockAt,
  draftSpecDir,
  proposedRepo,
  question,
  questionsFile,
} from "./helpers.js";

const CLOCK = clockAt("2010-05-06T07:08:09Z");

const readQuestions = (dir: string): Questions => {
  const parsed = parseQuestions(
    fs.readFileSync(path.join(dir, "questions.json"), "utf8"),
  );
  if (!parsed.ok) throw new Error("questions.json did not parse");
  return parsed.value;
};

const lintFinal = (dir: string): LintReport => {
  const result = lintSpecDir(dir, { final: true });
  if (!result.ok) throw new Error(result.message);
  return result.report;
};

const ofRule = (report: LintReport, rule: string) =>
  [...report.errors, ...report.warnings].filter((f) => f.rule === rule);

describe("answer: writing an answer", () => {
  it("appends one answer with the provenance the clock and flags give", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile([question("QN-1")], []),
    });
    const result = answerSpecDir(
      dir,
      { question: "QN-1", answer: "yes", channel: "chat", author: "alice" },
      CLOCK,
    );
    expect(result.ok).toBe(true);
    const answers = readQuestions(dir).answers;
    expect(answers).toHaveLength(1);
    expect(answers[0]).toEqual({
      question: "QN-1",
      answer: "yes",
      channel: "chat",
      author: "alice",
      time: "2010-05-06T07:08:09Z",
    });
  });

  it("takes the time from the clock seam, second precision with a trailing Z", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile([question("QN-1")], []),
    });
    answerSpecDir(
      dir,
      { question: "QN-1", answer: "yes", channel: "chat", author: "alice" },
      clockAt("2019-12-31T23:59:58.4Z"),
    );
    expect(readQuestions(dir).answers[0]!.time).toBe("2019-12-31T23:59:58Z");
  });

  it("records the chosen option label when --option is a label of the question", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile(
        [
          question("QN-1", {
            options: [
              { label: "revoke", consequence: "sessions end" },
              { label: "keep", consequence: "sessions stay" },
            ],
          }),
        ],
        [],
      ),
    });
    const result = answerSpecDir(
      dir,
      {
        question: "QN-1",
        answer: "revoke now",
        option: "revoke",
        channel: "file",
        author: "bob",
      },
      CLOCK,
    );
    expect(result.ok).toBe(true);
    expect(readQuestions(dir).answers[0]).toMatchObject({
      answer: "revoke now",
      option: "revoke",
    });
  });

  it("--accept-recommended records the recommended label, not the first option", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile(
        [
          question("QN-1", {
            class: "divergence",
            options: [
              { label: "revoke", consequence: "sessions end" },
              { label: "keep", consequence: "sessions stay" },
            ],
            recommended: "keep",
          }),
        ],
        [],
      ),
    });
    const result = answerSpecDir(
      dir,
      {
        question: "QN-1",
        acceptRecommended: true,
        channel: "chat",
        author: "alice",
      },
      CLOCK,
    );
    expect(result.ok).toBe(true);
    expect(readQuestions(dir).answers[0]).toMatchObject({
      answer: "keep",
      option: "keep",
    });
  });

  it("records a comment_url only with --channel comment", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile([question("QN-1")], []),
    });
    const result = answerSpecDir(
      dir,
      {
        question: "QN-1",
        answer: "yes",
        channel: "comment",
        author: "alice",
        commentUrl: "https://example.com/c/1",
      },
      CLOCK,
    );
    expect(result.ok).toBe(true);
    expect(readQuestions(dir).answers[0]!.comment_url).toBe(
      "https://example.com/c/1",
    );
  });

  it("keeps the file's permission bits and writes no leftover temporary file", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile([question("QN-1")], []),
    });
    const file = path.join(dir, "questions.json");
    fs.chmodSync(file, 0o600);
    expect(
      answerSpecDir(
        dir,
        { question: "QN-1", answer: "yes", channel: "chat", author: "alice" },
        CLOCK,
      ).ok,
    ).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(
      fs.readdirSync(dir).filter((name) => name.includes(".tmp-")),
    ).toEqual([]);
  });

  it("replaces questions.json through a rename, so the answer lands on a new inode", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile([question("QN-1")], []),
    });
    const file = path.join(dir, "questions.json");
    const before = fs.statSync(file).ino;
    expect(
      answerSpecDir(
        dir,
        { question: "QN-1", answer: "yes", channel: "chat", author: "alice" },
        CLOCK,
      ).ok,
    ).toBe(true);
    expect(fs.statSync(file).ino).not.toBe(before);
  });
});

describe("answer: refusals", () => {
  const ok = (r: AnswerResult, code: string) => {
    expect(r.ok, JSON.stringify(r)).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  };

  it("refuses an unknown question", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile([question("QN-1")], []),
    });
    ok(
      answerSpecDir(
        dir,
        { question: "QN-9", answer: "x", channel: "chat", author: "alice" },
        CLOCK,
      ),
      "unknown-question",
    );
  });

  it("refuses an already-answered question", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile([question("QN-1")], []),
    });
    expect(
      answerSpecDir(
        dir,
        { question: "QN-1", answer: "x", channel: "chat", author: "alice" },
        CLOCK,
      ).ok,
    ).toBe(true);
    ok(
      answerSpecDir(
        dir,
        { question: "QN-1", answer: "y", channel: "chat", author: "alice" },
        CLOCK,
      ),
      "already-answered",
    );
  });

  it("refuses an --option that is not a label of the question", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile(
        [question("QN-1", { options: [{ label: "a", consequence: "c" }] })],
        [],
      ),
    });
    ok(
      answerSpecDir(
        dir,
        {
          question: "QN-1",
          answer: "x",
          option: "z",
          channel: "chat",
          author: "alice",
        },
        CLOCK,
      ),
      "option-not-label",
    );
  });

  it("refuses --accept-recommended on a question without a recommendation", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile([question("QN-1")], []),
    });
    ok(
      answerSpecDir(
        dir,
        {
          question: "QN-1",
          acceptRecommended: true,
          channel: "chat",
          author: "alice",
        },
        CLOCK,
      ),
      "recommended-not-allowed",
    );
  });

  it("refuses both or neither of --answer and --accept-recommended", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile([question("QN-1")], []),
    });
    ok(
      answerSpecDir(
        dir,
        { question: "QN-1", channel: "chat", author: "alice" },
        CLOCK,
      ),
      "answer-choice",
    );
    ok(
      answerSpecDir(
        dir,
        {
          question: "QN-1",
          answer: "x",
          acceptRecommended: true,
          channel: "chat",
          author: "alice",
        },
        CLOCK,
      ),
      "answer-choice",
    );
  });

  it("refuses an empty answer or author", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile([question("QN-1")], []),
    });
    ok(
      answerSpecDir(
        dir,
        { question: "QN-1", answer: "  ", channel: "chat", author: "alice" },
        CLOCK,
      ),
      "empty-answer",
    );
    ok(
      answerSpecDir(
        dir,
        { question: "QN-1", answer: "x", channel: "chat", author: "  " },
        CLOCK,
      ),
      "empty-author",
    );
  });

  it("refuses a --comment-url without --channel comment or not https", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile([question("QN-1")], []),
    });
    ok(
      answerSpecDir(
        dir,
        {
          question: "QN-1",
          answer: "x",
          channel: "chat",
          author: "alice",
          commentUrl: "https://example.com/c/1",
        },
        CLOCK,
      ),
      "comment-url-channel",
    );
    ok(
      answerSpecDir(
        dir,
        {
          question: "QN-1",
          answer: "x",
          channel: "comment",
          author: "alice",
          commentUrl: "http://example.com/c/1",
        },
        CLOCK,
      ),
      "comment-url-https",
    );
  });

  it("refuses a missing, a non-regular, or an invalid questions.json", () => {
    ok(
      answerSpecDir(
        draftSpecDir({ "questions.json": null }),
        { question: "QN-1", answer: "x", channel: "chat", author: "alice" },
        CLOCK,
      ),
      "questions-missing",
    );
    ok(
      answerSpecDir(
        draftSpecDir({ "questions.json": "{ nope" }),
        { question: "QN-1", answer: "x", channel: "chat", author: "alice" },
        CLOCK,
      ),
      "questions-invalid",
    );
    const dir = draftSpecDir({
      "questions.json": questionsFile([question("QN-1")], []),
    });
    const file = path.join(dir, "questions.json");
    fs.rmSync(file);
    fs.writeFileSync(path.join(dir, "real.json"), "{}");
    fs.symlinkSync("real.json", file);
    ok(
      answerSpecDir(
        dir,
        { question: "QN-1", answer: "x", channel: "chat", author: "alice" },
        CLOCK,
      ),
      "questions-unreadable",
    );
  });

  it("refuses a directory that is not specs/<name>", () => {
    const dir = draftSpecDir();
    const outside = path.join(path.dirname(path.dirname(dir)), "loose");
    fs.mkdirSync(outside, { recursive: true });
    fs.copyFileSync(path.join(dir, "spec.md"), path.join(outside, "spec.md"));
    fs.copyFileSync(
      path.join(dir, "questions.json"),
      path.join(outside, "questions.json"),
    );
    ok(
      answerSpecDir(
        outside,
        { question: "QN-1", answer: "x", channel: "chat", author: "alice" },
        CLOCK,
      ),
      "spec-dir-not-spec-layout",
    );
  });

  it("refuses --accept-recommended given together with --option and leaves the file byte-identical", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile(
        [
          question("QN-1", {
            class: "divergence",
            options: [{ label: "keep", consequence: "sessions stay" }],
            recommended: "keep",
          }),
        ],
        [],
      ),
    });
    const file = path.join(dir, "questions.json");
    const before = fs.readFileSync(file);
    ok(
      answerSpecDir(
        dir,
        {
          question: "QN-1",
          acceptRecommended: true,
          option: "keep",
          channel: "chat",
          author: "alice",
        },
        CLOCK,
      ),
      "answer-choice",
    );
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("refuses a channel outside file, chat and comment and leaves the file byte-identical", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile([question("QN-1")], []),
    });
    const file = path.join(dir, "questions.json");
    const before = fs.readFileSync(file);
    ok(
      answerSpecDir(
        dir,
        { question: "QN-1", answer: "x", channel: "email", author: "alice" },
        CLOCK,
      ),
      "channel-invalid",
    );
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("refuses a spec directory that is a symlink to a real spec directory and writes nothing", () => {
    const root = scratch();
    const real = path.join(root, "real");
    const files = {
      ...validFiles(),
      "questions.json": questionsFile([question("QN-1")], []),
    };
    for (const [rel, text] of Object.entries(files)) {
      const file = path.join(real, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    const specs = path.join(root, "specs");
    fs.mkdirSync(specs, { recursive: true });
    const link = path.join(specs, "s1");
    fs.symlinkSync(real, link);
    const file = path.join(real, "questions.json");
    const before = fs.readFileSync(file);
    const result = answerSpecDir(
      link,
      { question: "QN-1", answer: "x", channel: "chat", author: "alice" },
      CLOCK,
    );
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("spec-dir-not-a-directory");
      expect(result.message).toContain("symlink");
    }
    expect(fs.readFileSync(file)).toEqual(before);
  });
});

describe("answer: the serializer", () => {
  const doc: Questions = {
    questions: [
      {
        id: "QN-1",
        target: "AC-1",
        class: "divergence",
        blocking: true,
        question: "q?",
        options: [
          { label: "a", consequence: "ca" },
          { label: "b", consequence: "cb" },
        ],
        recommended: "b",
        evidence: "e",
      },
    ],
    answers: [
      {
        question: "QN-1",
        answer: "b",
        option: "b",
        channel: "comment",
        author: "alice",
        time: "2000-01-31T12:00:00Z",
        comment_url: "https://x/1",
      },
    ],
  };

  it("emits a fixed key order, two-space JSON and a trailing newline", () => {
    const text = serializeQuestions(doc);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "questions": [\n');
    expect(text).toContain('\n  "answers": [\n');
    const answersBlock = text.slice(text.indexOf('"answers"'));
    expect(
      [...answersBlock.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]),
    ).toEqual([
      "answers",
      "question",
      "answer",
      "option",
      "channel",
      "author",
      "time",
      "comment_url",
    ]);
    const questionsBlock = text.slice(
      text.indexOf('"questions"'),
      text.indexOf('"answers"'),
    );
    expect(
      [...questionsBlock.matchAll(/"([a-z_]+)":/g)]
        .map((m) => m[1])
        .filter((k) => k !== "label" && k !== "consequence"),
    ).toEqual([
      "questions",
      "id",
      "target",
      "class",
      "blocking",
      "question",
      "options",
      "recommended",
      "evidence",
    ]);
  });

  it("round-trips: parseQuestions of the text deep-equals the document", () => {
    const back = parseQuestions(serializeQuestions(doc));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value).toEqual(doc);
  });
});

describe("answer: interaction with lint", () => {
  it("answering a blocking question clears residual-open for it", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile(
        [question("QN-1", { blocking: true })],
        [],
      ),
    });
    expect(ofRule(lintFinal(dir), "residual-open").map((f) => f.id)).toEqual([
      "QN-1",
    ]);
    expect(
      answerSpecDir(
        dir,
        { question: "QN-1", answer: "yes", channel: "chat", author: "alice" },
        CLOCK,
      ).ok,
    ).toBe(true);
    expect(ofRule(lintFinal(dir), "residual-open")).toEqual([]);
  });

  it("an answer without a comment_url keeps dc-self-reported", () => {
    const decisions =
      "## Decisions\n\n- DC-1: Old sessions end at once, not at expiry.\n  - question: QN-1\n  - provenance:\n    - channel: comment\n    - author: alice\n    - time: 2000-01-31T12:00:00Z\n\n";
    const dir = draftSpecDir({
      "spec.md": edited(
        "spec.md",
        "\n## Source ledger",
        `\n${decisions}## Source ledger`,
      ),
      "questions.json": questionsFile([question("QN-1")], []),
    });
    expect(
      answerSpecDir(
        dir,
        { question: "QN-1", answer: "yes", channel: "chat", author: "alice" },
        CLOCK,
      ).ok,
    ).toBe(true);
    expect(ofRule(lintFinal(dir), "dc-self-reported").map((f) => f.id)).toEqual(
      ["DC-1"],
    );
  });

  it("answering one question drops the question-budget finding by one", () => {
    const many = questionsFile(
      Array.from({ length: 8 }, (_, i) => question(`QN-${i + 1}`)),
      [],
    );
    const dir = draftSpecDir({ "questions.json": many });
    const result = lintSpecDir(dir, {});
    if (!result.ok) throw new Error(result.message);
    expect(ofRule(result.report, "question-budget")).toHaveLength(1);
    expect(
      answerSpecDir(
        dir,
        { question: "QN-1", answer: "yes", channel: "chat", author: "alice" },
        CLOCK,
      ).ok,
    ).toBe(true);
    const after = lintSpecDir(dir, {});
    if (!after.ok) throw new Error(after.message);
    expect(ofRule(after.report, "question-budget")).toEqual([]);
  });

  it("refuses to answer a proposed spec and leaves the file byte-identical", async () => {
    const base = await proposedRepo({
      "questions.json": questionsFile([question("QN-1")], []),
    });
    const file = path.join(base.repo.spec, "questions.json");
    const before = fs.readFileSync(file);
    const result = answerSpecDir(
      base.repo.spec,
      { question: "QN-1", answer: "yes", channel: "chat", author: "alice" },
      CLOCK,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("spec-not-draft");
    expect(fs.readFileSync(file)).toEqual(before);
  });
});
