import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { statusSpecDir } from "../../src/state/index.js";
import {
  bindOk,
  draftSpecDir,
  proposedRepo,
  question,
  questionsFile,
} from "./helpers.js";

const read = (dir: string) => {
  const result = statusSpecDir(dir);
  if (!result.ok) throw new Error(result.message);
  return result.report;
};

describe("status verb", () => {
  it("reports the draft snapshot of the valid fixture", () => {
    const report = read(draftSpecDir());
    expect(report.format).toBe("spec-gate-status/1");
    expect(report.spec).toBe("tiny-valid");
    expect(report.status).toBe("draft");
    expect(report.triage).toEqual({
      stored: "actionable",
      derived: "actionable",
      profile: "full",
    });
    expect(report.questions).toEqual({
      total: 0,
      answered: 0,
      unanswered: 0,
      blocking_unanswered: 0,
    });
    expect(report.residuals).toEqual({ total: 0, open: 0, open_ids: [] });
    expect(report.bindings).toEqual({ by_status: { new: 1, existing: 0 } });
    expect(report.rows_without_binding).toEqual([]);
    expect(report.bindings_log).toEqual({
      entries: 0,
      propose_commit: null,
    });
    expect(report.acks).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it("counts open residuals and questions", () => {
    const residuals =
      "## Residuals\n\n- RS-1: A blind spot.\n  - class: blind-spot\n  - status: open\n\n- RS-2: A resolved one.\n  - class: untestable\n  - status: resolved\n\n";
    const specMd = fs
      .readFileSync(path.join(draftSpecDir(), "spec.md"), "utf8")
      .replace("\n## Source ledger", `\n${residuals}## Source ledger`);
    const dir = draftSpecDir({
      "spec.md": specMd,
      "questions.json": questionsFile(
        [question("QN-1", { blocking: true })],
        [],
      ),
    });
    const report = read(dir);
    expect(report.residuals).toEqual({ total: 2, open: 1, open_ids: ["RS-1"] });
    expect(report.questions).toMatchObject({
      total: 1,
      blocking_unanswered: 1,
    });
  });

  it("shows the bindings.log entry count and propose commit after propose and bind", async () => {
    const base = await proposedRepo();
    bindOk(base.repo, "TP-1", {
      status: "existing",
      selector: "rejects old token",
    });
    const report = read(base.repo.spec);
    expect(report.status).toBe("proposed");
    expect(report.bindings_log?.entries).toBe(2);
    expect(report.bindings_log?.propose_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(report.rows_without_binding).toEqual(["TP-3"]);
    expect(report.acks).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it("reports a file that does not load as null and names its code", () => {
    const dir = draftSpecDir({
      "questions.json": questionsFile([question("QN-1")], []),
    });
    const file = path.join(dir, "questions.json");
    fs.rmSync(file);
    fs.writeFileSync(path.join(dir, "real.json"), "{}");
    fs.symlinkSync("real.json", file);
    const report = read(dir);
    expect(report.questions).toBeNull();
    expect(report.errors).toContain("input-not-regular");
  });

  it("refuses a directory that is not one", () => {
    const result = statusSpecDir(path.join(draftSpecDir(), "missing"));
    expect(result.ok).toBe(false);
  });
});
