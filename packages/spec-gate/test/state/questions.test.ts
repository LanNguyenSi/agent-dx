import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { questionsSpecDir } from "../../src/state/index.js";
import { draftSpecDir, question, questionsFile } from "./helpers.js";

describe("questions verb", () => {
  it("lists unanswered questions in numeric ID order with their counts", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile(
        [
          question("QN-2", { blocking: true }),
          question("QN-1"),
          question("QN-10"),
          question("QN-3"),
        ],
        [
          {
            question: "QN-3",
            answer: "x",
            channel: "chat",
            author: "a",
            time: "2000-01-31T12:00:00Z",
          },
        ],
      ),
    });
    const result = questionsSpecDir(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.format).toBe("spec-gate-questions/1");
    expect(result.report.spec).toBe("tiny-valid");
    expect(result.report.questions.map((q) => q.id)).toEqual([
      "QN-1",
      "QN-2",
      "QN-10",
    ]);
    expect(result.report.questions[1]).toEqual(
      question("QN-2", { blocking: true }),
    );
    expect(result.report.counts).toEqual({
      total: 4,
      answered: 1,
      unanswered: 3,
      blocking_unanswered: 1,
    });
  });

  it("reports no questions and no unanswered when the file holds none", () => {
    const result = questionsSpecDir(draftSpecDir());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.questions).toEqual([]);
    expect(result.report.counts).toEqual({
      total: 0,
      answered: 0,
      unanswered: 0,
      blocking_unanswered: 0,
    });
  });

  it("treats an absent questions.json as no questions", () => {
    const result = questionsSpecDir(draftSpecDir({ "questions.json": null }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.counts.unanswered).toBe(0);
  });

  it("refuses a questions.json that is a link with a named error", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile([question("QN-1")], []),
    });
    const file = path.join(dir, "questions.json");
    fs.rmSync(file);
    fs.writeFileSync(path.join(dir, "real.json"), "{}");
    fs.symlinkSync("real.json", file);
    const result = questionsSpecDir(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("input-not-regular");
  });

  it("refuses an invalid questions.json and a missing spec.md", () => {
    const bad = questionsSpecDir(draftSpecDir({ "questions.json": "{ nope" }));
    expect(bad.ok).toBe(false);

    const noSpec = questionsSpecDir(draftSpecDir({ "spec.md": null }));
    expect(noSpec.ok).toBe(false);
    if (!noSpec.ok) expect(noSpec.code).toBe("input-missing");
  });

  it("refuses a directory that is not one", () => {
    const result = questionsSpecDir(path.join(draftSpecDir(), "missing"));
    expect(result.ok).toBe(false);
  });
});
