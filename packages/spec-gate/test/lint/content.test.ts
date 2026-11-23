import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_QUESTIONS_WARN_ABOVE } from "../../src/formats/config.js";
import { RULES, lintSpecDir, type LintReport } from "../../src/lint/index.js";
import { edited, scratch, specDir } from "./helpers.js";

function lint(
  files: Record<string, string | null>,
  options: Parameters<typeof lintSpecDir>[1] = {},
): LintReport {
  const result = lintSpecDir(specDir(files), options);
  if (!result.ok) throw new Error(result.message);
  return result.report;
}

const findingsOf = (report: LintReport, rule: string) =>
  [...report.errors, ...report.warnings].filter((f) => f.rule === rule);

const ruleIds = (report: LintReport) =>
  [...report.errors, ...report.warnings].map((f) => f.rule);

const skippedReason = (report: LintReport, rule: string) =>
  report.skipped.find((s) => s.rule === rule)?.reason;

/** A `questions.json` text from question and answer objects. */
const questionsFile = (questions: unknown[], answers: unknown[]): string =>
  JSON.stringify({ questions, answers });

const question = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  target: "AC-1",
  class: "blind-spot",
  blocking: false,
  question: `Open point ${id} about the token store?`,
  options: [],
  ...over,
});

const answer = (q: string, over: Record<string, unknown> = {}) => ({
  question: q,
  answer: "revoke",
  channel: "comment",
  author: "alice",
  time: "2000-01-31T12:00:00Z",
  ...over,
});

const N_QUESTION = (n: number) =>
  questionsFile(
    Array.from({ length: n }, (_, i) => question(`QN-${i + 1}`)),
    [],
  );

const DEFAULTS_BLOCK =
  "## Defaults\n\n- DF-1: The idle timeout is 30 seconds.\n  - reason: the request names no timeout\n  - affects_behavior: true\n\n";

const DECISIONS_BLOCK =
  "## Decisions\n\n- DC-1: Old sessions end at once, not at expiry.\n  - question: QN-1\n  - provenance:\n    - channel: comment\n    - author: alice\n    - time: 2000-01-31T12:00:00Z\n\n";

const RESIDUALS_OPEN_BLOCK =
  "## Residuals\n\n- RS-1: The rate limit of the test environment is not the production one.\n  - class: blind-spot\n  - status: open\n\n";

const withSection = (name: string, block: string) =>
  edited("spec.md", `\n## ${name}`, `\n${block}## ${name}`);

describe("df-coverage: DFs with affects_behavior true need a row", () => {
  const spec = { "spec.md": withSection("Non-goals", DEFAULTS_BLOCK) };

  it("passes when a true DF is covered and no DF exists without it", () => {
    expect(ruleIds(lint({}))).toEqual([]);
    expect(
      ruleIds(
        lint({
          ...spec,
          "testplan.yaml": edited(
            "testplan.yaml",
            "covers: [AC-1]",
            "covers: [AC-1, DF-1]",
          ),
        }),
      ),
    ).toEqual([]);
  });

  it("reports a true DF that no row covers", () => {
    const report = lint(spec);
    expect(findingsOf(report, "df-coverage")).toEqual([
      expect.objectContaining({
        level: "error",
        file: "spec.md",
        path: "DF-1",
        id: "DF-1",
        line: 21,
      }),
    ]);
  });

  it("a false DF needs no row", () => {
    const text = spec["spec.md"].replace(
      "  - affects_behavior: true",
      "  - affects_behavior: false",
    );
    expect(ruleIds(lint({ "spec.md": text }))).toEqual([]);
  });
});

describe("tp-covers-unknown: covers names a live AC, DF or NG", () => {
  it("a covers ID that spec.md does not have is an error", () => {
    const report = lint({
      "testplan.yaml": edited(
        "testplan.yaml",
        "covers: [AC-1]",
        "covers: [AC-1, NG-9]",
      ),
    });
    expect(findingsOf(report, "tp-covers-unknown")).toEqual([
      expect.objectContaining({
        level: "error",
        file: "testplan.yaml",
        path: "TP-1.covers",
        id: "TP-1",
        message: expect.stringContaining("NG-9"),
      }),
    ]);
  });

  it("a covers ID of an existing DF and NG is fine", () => {
    const spec = { "spec.md": withSection("Non-goals", DEFAULTS_BLOCK) };
    const report = lint({
      ...spec,
      "testplan.yaml": edited(
        "testplan.yaml",
        "covers: [AC-1]",
        "covers: [AC-1, DF-1, NG-1]",
      ),
    });
    expect(ruleIds(report)).toEqual([]);
  });
});

describe("binding-unknown: every binding key is a test-plan row", () => {
  it("absent bindings.yaml is fine and the rule still runs", () => {
    const report = lint({ "bindings.yaml": null });
    expect(findingsOf(report, "binding-unknown")).toEqual([]);
    expect(skippedReason(report, "binding-unknown")).toBeUndefined();
  });

  it("an empty bindings.yaml is fine", () => {
    expect(ruleIds(lint({ "bindings.yaml": "{}\n" }))).toEqual([]);
  });

  it("a binding for a row that does not exist is an error", () => {
    const report = lint({
      "bindings.yaml": "TP-1:\n  status: new\nTP-7:\n  status: existing\n",
    });
    expect(findingsOf(report, "binding-unknown")).toEqual([
      expect.objectContaining({
        level: "error",
        file: "bindings.yaml",
        path: "TP-7",
        id: "TP-7",
      }),
    ]);
  });
});

describe("binding-status: the binding matches the kind at proposed", () => {
  const measurementOnly =
    '- id: TP-1\n  covers: [AC-1]\n  kind: measurement\n  claim: "the endpoint answers within the stated budget"\n  baseline: 100\n  threshold: 250\n  runs: 20\n';
  const manualRow =
    '- id: TP-2\n  covers: [NG-1]\n  kind: manual\n  claim: "a person checks the logout page"\n  verifier: alice\n  evidence_location: review/logout.md\n';

  it("is skipped for a draft and runs under --final", () => {
    const draft = lint({});
    expect(skippedReason(draft, "binding-status")).toBe("gate");
    const final = lint({}, { final: true });
    expect(skippedReason(final, "binding-status")).toBeUndefined();
    expect(findingsOf(final, "binding-status")).toEqual([]);
  });

  it("runs at status proposed", () => {
    const report = lint({
      "spec.md": edited("spec.md", "status: draft", "status: proposed"),
    });
    expect(skippedReason(report, "binding-status")).toBeUndefined();
    expect(findingsOf(report, "binding-status")).toEqual([]);
  });

  it("a missing binding for a kind that needs one is an error", () => {
    const report = lint({ "bindings.yaml": null }, { final: true });
    expect(findingsOf(report, "binding-status")).toEqual([
      expect.objectContaining({
        level: "error",
        file: "bindings.yaml",
        path: "TP-1",
        id: "TP-1",
        message: expect.stringContaining("new"),
      }),
    ]);
  });

  it("a binding with the wrong status is an error", () => {
    const report = lint(
      { "bindings.yaml": "TP-1:\n  status: existing\n" },
      { final: true },
    );
    expect(findingsOf(report, "binding-status")).toEqual([
      expect.objectContaining({
        file: "bindings.yaml",
        path: "TP-1.status",
        id: "TP-1",
      }),
    ]);
  });

  it("kind stays-green wants the existing binding: new is an error, existing passes", () => {
    const greenRow =
      '- id: TP-2\n  covers: [NG-1]\n  kind: stays-green\n  claim: "the login flow keeps working"\n  probe_hint: "the login smoke test"\n';
    const plan = edited(
      "testplan.yaml",
      'red_reason: "the endpoint does not invalidate tokens today"',
      'red_reason: "the endpoint does not invalidate tokens today"\n' +
        greenRow,
    );
    const wrong = lint(
      {
        "testplan.yaml": plan,
        "bindings.yaml": "TP-1:\n  status: new\nTP-2:\n  status: new\n",
      },
      { final: true },
    );
    expect(findingsOf(wrong, "binding-status")).toEqual([
      expect.objectContaining({
        level: "error",
        file: "bindings.yaml",
        path: "TP-2.status",
        id: "TP-2",
        message: expect.stringContaining("existing"),
      }),
    ]);
    const right = lint(
      {
        "testplan.yaml": plan,
        "bindings.yaml": "TP-1:\n  status: new\nTP-2:\n  status: existing\n",
      },
      { final: true },
    );
    expect(findingsOf(right, "binding-status")).toEqual([]);
  });

  it("kind any accepts either status and even no binding", () => {
    for (const bindings of [
      null,
      "TP-1:\n  status: existing\n",
      "TP-1:\n  status: new\n",
    ]) {
      const report = lint(
        { "testplan.yaml": measurementOnly, "bindings.yaml": bindings },
        { final: true },
      );
      expect(findingsOf(report, "binding-status"), String(bindings)).toEqual(
        [],
      );
    }
  });

  it("kind manual takes no binding: a mapping for it is an error", () => {
    const plan = edited(
      "testplan.yaml",
      'red_reason: "the endpoint does not invalidate tokens today"',
      'red_reason: "the endpoint does not invalidate tokens today"\n' +
        manualRow,
    );
    const bad = lint(
      {
        "testplan.yaml": plan,
        "bindings.yaml": "TP-1:\n  status: new\nTP-2:\n  status: existing\n",
      },
      { final: true },
    );
    expect(findingsOf(bad, "binding-status")).toEqual([
      expect.objectContaining({
        file: "bindings.yaml",
        path: "TP-2",
        id: "TP-2",
        message: expect.stringContaining("manual"),
      }),
    ]);
    const good = lint(
      { "testplan.yaml": plan, "bindings.yaml": "TP-1:\n  status: new\n" },
      { final: true },
    );
    expect(findingsOf(good, "binding-status")).toEqual([]);
  });
});

describe("ledger-complete: ledger lines equal meta lines", () => {
  it("passes when both name the one source line", () => {
    expect(ruleIds(lint({}))).toEqual([]);
  });

  it("a meta line with no ledger entry is an error", () => {
    const report = lint({
      "source/meta.json":
        '{ "lines": [ { "id": "L1-0123456789ab", "kind": "text" }, { "id": "L2-000000000000", "kind": "text" } ] }',
    });
    expect(findingsOf(report, "ledger-complete")).toEqual([
      expect.objectContaining({
        level: "error",
        file: "source/meta.json",
        path: "lines[1]",
        id: "L2-000000000000",
      }),
    ]);
  });

  it("a ledger entry whose source line meta does not list is an error", () => {
    const report = lint({
      "source/meta.json": '{ "lines": [] }',
    });
    expect(findingsOf(report, "ledger-complete")).toEqual([
      expect.objectContaining({
        file: "spec.md",
        path: "SL-1",
        id: "SL-1",
        line: 25,
      }),
    ]);
  });

  it("an out entry still maps its source line", () => {
    const text = edited(
      "spec.md",
      "- SL-1: L1-0123456789ab -> AC-1, NG-1",
      "- SL-1: L1-0123456789ab -> out\n  - reason: pure prose of the request",
    );
    const report = lint({ "spec.md": text });
    expect(findingsOf(report, "ledger-complete")).toEqual([]);
  });

  it("absent source/meta.json is one error on the file, not a skip", () => {
    const report = lint({ "source/meta.json": null });
    expect(findingsOf(report, "ledger-complete")).toEqual([
      expect.objectContaining({
        level: "error",
        file: "source/meta.json",
        path: "$",
        code: "input-missing",
        message: expect.stringContaining("cannot"),
      }),
    ]);
    expect(
      report.skipped.find((s) => s.rule === "ledger-complete"),
    ).toBeUndefined();
  });

  it("a source/meta.json that failed to parse keeps the skip with input-failed", () => {
    const report = lint({ "source/meta.json": "{ nope" });
    expect(skippedReason(report, "ledger-complete")).toBe("input-failed");
    expect(findingsOf(report, "ledger-complete")).toEqual([]);
  });
});

describe("ledger-target-unknown: ledger targets are live IDs", () => {
  it("passes when every target exists", () => {
    expect(ruleIds(lint({}))).toEqual([]);
  });

  it("a target that is no ID of spec.md is an error", () => {
    const report = lint({
      "spec.md": edited("spec.md", "-> AC-1, NG-1", "-> AC-1, NG-1, DF-8"),
    });
    expect(findingsOf(report, "ledger-target-unknown")).toEqual([
      expect.objectContaining({
        level: "error",
        file: "spec.md",
        path: "SL-1",
        id: "SL-1",
        line: 25,
        message: expect.stringContaining("DF-8"),
      }),
    ]);
  });

  it("an out entry has no target to check", () => {
    const text = edited(
      "spec.md",
      "- SL-1: L1-0123456789ab -> AC-1, NG-1",
      "- SL-1: L1-0123456789ab -> out\n  - reason: pure prose of the request",
    );
    const plan = edited("testplan.yaml", "covers: [AC-1]", "covers: [NG-1]");
    const report = lint({ "spec.md": text, "testplan.yaml": plan });
    expect(findingsOf(report, "ledger-target-unknown")).toEqual([]);
  });
});

describe("ac-source-unknown: an AC cites a ledger entry", () => {
  it("passes when the cited SL exists", () => {
    expect(ruleIds(lint({}))).toEqual([]);
  });

  it("a cited SL that is no ledger entry is an error", () => {
    const report = lint({
      "spec.md": edited("spec.md", "- source: SL-1", "- source: SL-1, SL-5"),
    });
    expect(findingsOf(report, "ac-source-unknown")).toEqual([
      expect.objectContaining({
        level: "error",
        file: "spec.md",
        path: "AC-1.source",
        id: "AC-1",
        line: 15,
        message: expect.stringContaining("SL-5"),
      }),
    ]);
  });
});

describe("owner-none: nobody stands behind an AC", () => {
  it("passes with a real owner", () => {
    expect(ruleIds(lint({}))).toEqual([]);
  });

  it("owner none is an error", () => {
    const report = lint({
      "spec.md": edited("spec.md", "owner: alice", "owner: none"),
    });
    expect(findingsOf(report, "owner-none")).toEqual([
      expect.objectContaining({
        level: "error",
        file: "spec.md",
        path: "AC-1.owner",
        id: "AC-1",
        line: 15,
      }),
    ]);
  });

  it("owner None and owner NONE are the same error", () => {
    for (const owner of ["None", "NONE"]) {
      const report = lint({
        "spec.md": edited("spec.md", "owner: alice", `owner: ${owner}`),
      });
      expect(findingsOf(report, "owner-none"), owner).toEqual([
        expect.objectContaining({
          level: "error",
          file: "spec.md",
          path: "AC-1.owner",
          id: "AC-1",
          line: 15,
          message: expect.stringContaining("written none"),
        }),
      ]);
      expect(findingsOf(report, "owner-none")[0]!.message, owner).toContain(
        `has owner "${owner}"`,
      );
    }
  });
});

describe("residual-open: nothing open at proposed", () => {
  const spec = {
    "spec.md": withSection("Source ledger", RESIDUALS_OPEN_BLOCK),
  };

  it("is skipped for a draft and runs under --final", () => {
    const draft = lint(spec);
    expect(skippedReason(draft, "residual-open")).toBe("gate");
    const final = lint(spec, { final: true });
    expect(findingsOf(final, "residual-open")).toEqual([
      expect.objectContaining({
        level: "error",
        file: "spec.md",
        path: "RS-1",
        id: "RS-1",
        line: 25,
      }),
    ]);
  });

  it("a resolved residual passes", () => {
    const resolved = spec["spec.md"].replace(
      "status: open",
      "status: resolved",
    );
    const report = lint({ "spec.md": resolved }, { final: true });
    expect(findingsOf(report, "residual-open")).toEqual([]);
  });

  it("an unanswered blocking question of any open-point class is an error", () => {
    for (const cls of ["divergence", "blind-spot", "untestable"]) {
      const report = lint(
        {
          "questions.json": questionsFile(
            [question("QN-1", { class: cls, blocking: true })],
            [],
          ),
        },
        { final: true },
      );
      expect(findingsOf(report, "residual-open"), cls).toEqual([
        expect.objectContaining({
          file: "questions.json",
          path: "QN-1",
          id: "QN-1",
          message: expect.stringContaining(cls),
        }),
      ]);
    }
  });

  it("an unanswered but not blocking, and an answered question pass", () => {
    const report = lint(
      {
        "questions.json": questionsFile(
          [
            question("QN-1", { class: "untestable", blocking: false }),
            question("QN-2", { class: "divergence", blocking: false }),
            question("QN-3", { class: "blind-spot", blocking: true }),
          ],
          [answer("QN-3")],
        ),
      },
      { final: true },
    );
    expect(findingsOf(report, "residual-open")).toEqual([]);
  });

  it("absent questions.json does not skip the spec part of the rule", () => {
    const report = lint({ ...spec, "questions.json": null }, { final: true });
    expect(findingsOf(report, "residual-open")).toHaveLength(1);
    expect(
      report.skipped.find((s) => s.rule === "residual-open"),
    ).toBeUndefined();
  });
});

describe("dc-unanswered: every DC rests on an answered question", () => {
  const spec = { "spec.md": withSection("Source ledger", DECISIONS_BLOCK) };
  const asked = questionsFile(
    [question("QN-1")],
    [answer("QN-1", { comment_url: "https://example.com/c/1" })],
  );

  it("passes when the question has an answer", () => {
    expect(ruleIds(lint({ ...spec, "questions.json": asked }))).toEqual([]);
  });

  it("an unanswered question is an error, and so is an unknown question ID", () => {
    for (const [name, file] of [
      ["no answer", questionsFile([question("QN-1")], [])],
      ["unknown ID", questionsFile([question("QN-2")], [])],
      ["empty file", questionsFile([], [])],
    ] as const) {
      const report = lint({ ...spec, "questions.json": file });
      expect(findingsOf(report, "dc-unanswered"), name).toEqual([
        expect.objectContaining({
          level: "error",
          file: "spec.md",
          path: "DC-1.question",
          id: "DC-1",
          line: 25,
        }),
      ]);
    }
  });

  it("absent questions.json makes every DC an error, not a skip", () => {
    const report = lint({ ...spec, "questions.json": null });
    expect(findingsOf(report, "dc-unanswered")).toEqual([
      expect.objectContaining({
        level: "error",
        file: "spec.md",
        path: "DC-1.question",
        id: "DC-1",
        line: 25,
      }),
    ]);
    expect(
      report.skipped.find((s) => s.rule === "dc-unanswered"),
    ).toBeUndefined();
  });

  it("a failed questions.json keeps the skip with input-failed", () => {
    const report = lint({ ...spec, "questions.json": "{ nope" });
    expect(skippedReason(report, "dc-unanswered")).toBe("input-failed");
  });
});

describe("dc-self-reported: an answer needs a checkable source", () => {
  const spec = { "spec.md": withSection("Source ledger", DECISIONS_BLOCK) };

  it("an answer with a comment_url passes", () => {
    const report = lint({
      ...spec,
      "questions.json": questionsFile(
        [question("QN-1")],
        [answer("QN-1", { comment_url: "https://example.com/c/1" })],
      ),
    });
    expect(findingsOf(report, "dc-self-reported")).toEqual([]);
  });

  it("an answer without a comment_url is an ackable warning", () => {
    const report = lint({
      ...spec,
      "questions.json": questionsFile([question("QN-1")], [answer("QN-1")]),
    });
    expect(findingsOf(report, "dc-self-reported")).toEqual([
      expect.objectContaining({
        level: "warning",
        file: "spec.md",
        path: "DC-1.question",
        id: "DC-1",
        line: 25,
      }),
    ]);
    const acked = lint({
      ...spec,
      "questions.json": questionsFile([question("QN-1")], [answer("QN-1")]),
      "acks.yaml":
        '- rule: "dc-self-reported"\n  id: "DC-1"\n  reason: "the chat log is archived"\n',
    });
    expect(acked.acked.map((f) => f.id)).toEqual(["DC-1"]);
  });

  it("an unanswered DC is not also self-reported", () => {
    const report = lint({
      ...spec,
      "questions.json": questionsFile([question("QN-1")], []),
    });
    expect(findingsOf(report, "dc-self-reported")).toEqual([]);
    expect(ruleIds(report)).toEqual(["dc-unanswered"]);
  });
});

describe("retired-id-live: a retired ID has no use again", () => {
  const retire = (ids: string) =>
    edited("spec.md", "status: draft", `status: draft\nretired_ids: [${ids}]`);

  it("a retired ID that is live nowhere passes", () => {
    expect(ruleIds(lint({ "spec.md": retire('"AC-9"') }))).toEqual([]);
  });

  it("a retired TP ID that is a test-plan row is an error", () => {
    const report = lint({ "spec.md": retire('"TP-1"') });
    expect(findingsOf(report, "retired-id-live")).toEqual([
      expect.objectContaining({
        level: "error",
        file: "testplan.yaml",
        path: "TP-1",
        id: "TP-1",
      }),
    ]);
  });

  it("a retired QN ID that is a question is an error, unknown files run the rule anyway", () => {
    const report = lint({
      "spec.md": retire('"QN-1", "QN-5"'),
      "questions.json": questionsFile([question("QN-1")], []),
    });
    expect(findingsOf(report, "retired-id-live")).toEqual([
      expect.objectContaining({
        file: "questions.json",
        path: "QN-1",
        id: "QN-1",
      }),
    ]);
  });

  it("a retired TP ID is still flagged when questions.json is absent, and the rule is not skipped", () => {
    const report = lint({
      "spec.md": retire('"TP-1"'),
      "questions.json": null,
    });
    expect(findingsOf(report, "retired-id-live")).toEqual([
      expect.objectContaining({
        level: "error",
        file: "testplan.yaml",
        path: "TP-1",
        id: "TP-1",
      }),
    ]);
    expect(
      report.skipped.find((s) => s.rule === "retired-id-live"),
    ).toBeUndefined();
  });
});

describe("prose: the fixed word list", () => {
  it("clean normative text passes", () => {
    expect(ruleIds(lint({}))).toEqual([]);
  });

  it("an AC with a listed word is an ackable warning naming the word", () => {
    const report = lint({
      "spec.md": edited(
        "spec.md",
        "is rejected with HTTP 401",
        "should be rejected with HTTP 401",
      ),
    });
    expect(findingsOf(report, "prose")).toEqual([
      expect.objectContaining({
        level: "warning",
        file: "spec.md",
        path: "AC-1.text",
        id: "AC-1",
        line: 15,
        message: expect.stringContaining('"should"'),
      }),
    ]);
    const acked = lint({
      "spec.md": edited(
        "spec.md",
        "is rejected with HTTP 401",
        "should be rejected with HTTP 401",
      ),
      "acks.yaml":
        '- rule: "prose"\n  id: "AC-1"\n  reason: "kept for the diff"\n',
    });
    expect(acked.acked.map((f) => f.id)).toEqual(["AC-1"]);
  });

  it("the claim and expected of a row are checked too", () => {
    const report = lint({
      "testplan.yaml": edited(
        "testplan.yaml",
        'claim: "an old token is rejected after a password change"',
        'claim: "an old token should be rejected after a password change"',
      ).replace('expected: "HTTP 401"', 'expected: "HTTP 401 quickly"'),
    });
    expect(
      findingsOf(report, "prose").map((f) => [f.file, f.path, f.id]),
    ).toEqual([
      ["testplan.yaml", "TP-1.claim", "TP-1"],
      ["testplan.yaml", "TP-1.expected", "TP-1"],
    ]);
  });

  it("a row without an expected is checked only on its claim", () => {
    const report = lint({
      "testplan.yaml":
        '- id: TP-1\n  covers: [AC-1]\n  kind: measurement\n  claim: "the endpoint answers fast within the stated budget"\n  baseline: 100\n  threshold: 250\n  runs: 20\n',
    });
    expect(
      findingsOf(report, "prose").map((f) => [f.file, f.path, f.id]),
    ).toEqual([["testplan.yaml", "TP-1.claim", "TP-1"]]);
  });

  it("matching is case-insensitive, whole-word and covers both spellings and phrases", () => {
    const cases: [string, string][] = [
      ["Should", "should"],
      ["SHOULD", "should"],
      ["as needed", "as needed"],
      ["if possible", "if possible"],
      ["user-friendly", "user-friendly"],
      ["etc.", "etc"],
      ["koennte", "koennte"],
      ["könnte", "könnte"],
      ["moeglichst", "moeglichst"],
      ["möglichst", "möglichst"],
      ["bei Bedarf", "bei Bedarf"],
      ["ggf.", "ggf"],
      ["usw.", "usw"],
      ["sollten", "sollten"],
    ];
    for (const [text, word] of cases) {
      const report = lint({
        "spec.md": edited(
          "spec.md",
          "is rejected with HTTP 401.",
          `is rejected with HTTP 401, ${text}.`,
        ),
      });
      const found = findingsOf(report, "prose");
      expect(found.length, text).toBeGreaterThanOrEqual(1);
      expect(found[0]!.message, text).toContain(`"${word}"`);
    }
  });

  it("a listed word inside a longer word is no hit", () => {
    const report = lint({
      "spec.md": edited(
        "spec.md",
        "is rejected with HTTP 401.",
        "is rejected with HTTP 401 fastest and maybe simply.",
      ),
    });
    expect(findingsOf(report, "prose")).toEqual([]);
  });

  it("a listed word as the tail of a longer word is no hit", () => {
    const report = lint({
      "spec.md": edited(
        "spec.md",
        "is rejected with HTTP 401.",
        "is rejected with HTTP 401 after breakfast and dismay.",
      ),
    });
    expect(findingsOf(report, "prose")).toEqual([]);
  });

  it("a listed word followed by a digit or an underscore is no hit", () => {
    const report = lint({
      "spec.md": edited(
        "spec.md",
        "is rejected with HTTP 401.",
        "is rejected with HTTP 401, deadline may1 and should_not apply.",
      ),
    });
    expect(findingsOf(report, "prose")).toEqual([]);
  });

  it("a decomposed word hits after NFC normalisation", () => {
    const report = lint({
      "spec.md": edited(
        "spec.md",
        "is rejected with HTTP 401.",
        "is rejected with HTTP 401, m\u006F\u0308glichst bald.",
      ),
    });
    expect(findingsOf(report, "prose").map((f) => f.message)).toEqual([
      expect.stringContaining('"möglichst"'),
    ]);
  });

  it("a phrase split by a run of spaces and a no-break space hits after collapsing", () => {
    const report = lint({
      "spec.md": edited(
        "spec.md",
        "is rejected with HTTP 401.",
        "is rejected with HTTP 401, bei \u00A0 Bedarf.",
      ),
    });
    expect(findingsOf(report, "prose").map((f) => f.message)).toEqual([
      expect.stringContaining('"bei Bedarf"'),
    ]);
  });

  it("two listed words in one text give two findings", () => {
    const report = lint({
      "spec.md": edited(
        "spec.md",
        "is rejected with HTTP 401.",
        "is rejected fast, and the check is easy: HTTP 401.",
      ),
    });
    expect(findingsOf(report, "prose").map((f) => f.message)).toEqual([
      expect.stringContaining('"easy"'),
      expect.stringContaining('"fast"'),
    ]);
  });
});

describe("question-budget: the unanswered questions fit the budget", () => {
  it("the default budget of 7 lets 7 pass and 8 warn", () => {
    expect(DEFAULT_QUESTIONS_WARN_ABOVE).toBe(7);
    expect(
      findingsOf(lint({ "questions.json": N_QUESTION(7) }), "question-budget"),
    ).toEqual([]);
    expect(
      findingsOf(lint({ "questions.json": N_QUESTION(8) }), "question-budget"),
    ).toEqual([
      expect.objectContaining({
        level: "warning",
        file: "questions.json",
        path: "questions",
        id: "questions",
      }),
    ]);
  });

  it("answered questions do not count", () => {
    const report = lint({
      "questions.json": questionsFile(
        Array.from({ length: 12 }, (_, i) => question(`QN-${i + 1}`)),
        Array.from({ length: 5 }, (_, i) => answer(`QN-${i + 1}`)),
      ),
    });
    expect(findingsOf(report, "question-budget")).toEqual([]);
  });

  it("absent questions.json skips the rule with input-absent", () => {
    const report = lint({ "questions.json": null });
    expect(skippedReason(report, "question-budget")).toBe("input-absent");
  });

  it("--config raises or lowers the budget", () => {
    const dir = scratch();
    fs.writeFileSync(
      path.join(dir, "warn-2.yaml"),
      "questions:\n  warn_above: 2\n",
    );
    const lower = lint({ "questions.json": N_QUESTION(3) });
    expect(findingsOf(lower, "question-budget")).toEqual([]);
    const report = lint(
      { "questions.json": N_QUESTION(3) },
      { configPath: path.join(dir, "warn-2.yaml") },
    );
    expect(findingsOf(report, "question-budget")).toHaveLength(1);
    const raised = lint(
      { "questions.json": N_QUESTION(3) },
      {
        configPath: writeConfig(
          "questions:\n  warn_above: 10\napprovers: [bob]\n",
        ),
      },
    );
    expect(findingsOf(raised, "question-budget")).toEqual([]);
  });

  it("a config without a questions key keeps the default budget", () => {
    const report = lint(
      { "questions.json": N_QUESTION(8) },
      { configPath: writeConfig("approvers: [bob]\n") },
    );
    expect(findingsOf(report, "question-budget")).toHaveLength(1);
    expect(report.errors).toEqual([]);
  });

  it("a bad config file is a format finding on that file and the default budget stays", () => {
    const report = lint(
      { "questions.json": N_QUESTION(3) },
      { configPath: writeConfig("questions:\n  warn_above: zero\n") },
    );
    expect(report.errors.map((f) => f.rule)).toEqual(["format"]);
    expect(report.errors[0]!.file).toContain("config.yaml");
    expect(findingsOf(report, "question-budget")).toEqual([]);
  });

  it("a missing config file is a file finding and the default budget stays", () => {
    const report = lint(
      { "questions.json": N_QUESTION(3) },
      { configPath: path.join(scratch(), "gone.yaml") },
    );
    expect(report.errors).toEqual([
      expect.objectContaining({ rule: "file", code: "input-missing" }),
    ]);
    expect(findingsOf(report, "question-budget")).toEqual([]);
  });

  it("the summary names the default from the format layer, not a literal", () => {
    const def = RULES.find((r) => r.id === "question-budget");
    expect(def?.summary).toContain(
      `default ${String(DEFAULT_QUESTIONS_WARN_ABOVE)}`,
    );
  });

  it("the warning is ackable", () => {
    const report = lint({
      "questions.json": N_QUESTION(8),
      "acks.yaml":
        '- rule: "question-budget"\n  id: "questions"\n  reason: "the batch is worked off this week"\n',
    });
    expect(report.acked.map((f) => [f.rule, f.id])).toEqual([
      ["question-budget", "questions"],
    ]);
  });
});

/** A config file in a scratch holder; returns its path. */
function writeConfig(text: string): string {
  const holder = scratch();
  const file = path.join(holder, "config.yaml");
  fs.writeFileSync(file, text);
  return file;
}

describe("triage-stale: the stored class still matches its fields", () => {
  const triage = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      single_goal: { value: "yes", evidence: "one goal" },
      code_related: { value: "yes", evidence: "the auth module" },
      core_is_decision: { value: "no", evidence: "behaviour is stated" },
      scope_within_request: { value: "yes", evidence: "the request asks" },
      multiple_repos: { value: "no", evidence: "one repository" },
      trivial: { value: "no", evidence: "the auth flow" },
      blocking_unknowns: [],
      class: "actionable",
      rule_version: 1,
      ...over,
    });

  it("a current file passes", () => {
    expect(ruleIds(lint({ "triage.json": triage() }))).toEqual([]);
  });

  it("a stored class that differs from the derivation is an error", () => {
    const report = lint({ "triage.json": triage({ class: "no-spec-needed" }) });
    expect(findingsOf(report, "triage-stale")).toEqual([
      expect.objectContaining({
        level: "error",
        file: "triage.json",
        path: "class",
        id: "triage",
      }),
    ]);
  });

  it("a stored rule_version that is not the current one is an error", () => {
    const report = lint({ "triage.json": triage({ rule_version: 2 }) });
    expect(findingsOf(report, "triage-stale")).toEqual([
      expect.objectContaining({
        file: "triage.json",
        path: "rule_version",
        id: "triage",
      }),
    ]);
  });

  /** The same file, but with fields that derive `no-spec-needed`, i.e. light. */
  const light = (over: Record<string, unknown> = {}) =>
    triage({
      trivial: { value: "yes", evidence: "a one-line copy change" },
      class: "no-spec-needed",
      ...over,
    });

  it("in the light profile, a stored class that differs from the derivation is an error", () => {
    const report = lint({ "triage.json": light({ class: "actionable" }) });
    expect(report.profile).toBe("light");
    expect(skippedReason(report, "triage-stale")).toBeUndefined();
    expect(findingsOf(report, "triage-stale")).toEqual([
      expect.objectContaining({
        level: "error",
        file: "triage.json",
        path: "class",
        id: "triage",
      }),
    ]);
  });

  it("in the light profile, a stored rule_version that is not current is an error", () => {
    const report = lint({ "triage.json": light({ rule_version: 2 }) });
    expect(report.profile).toBe("light");
    expect(findingsOf(report, "triage-stale")).toEqual([
      expect.objectContaining({
        file: "triage.json",
        path: "rule_version",
        id: "triage",
      }),
    ]);
  });

  it("both problems give two findings, in path order", () => {
    const report = lint({
      "triage.json": triage({ class: "split", rule_version: 99 }),
    });
    expect(findingsOf(report, "triage-stale").map((f) => f.path)).toEqual([
      "class",
      "rule_version",
    ]);
  });

  it("a file with no stored class is not stale", () => {
    const doc = JSON.parse(triage()) as Record<string, unknown>;
    delete doc["class"];
    delete doc["rule_version"];
    const report = lint({ "triage.json": JSON.stringify(doc) });
    expect(findingsOf(report, "triage-stale")).toEqual([]);
  });

  it("absent triage.json skips the rule with input-absent", () => {
    const report = lint({ "triage.json": null });
    expect(skippedReason(report, "triage-stale")).toBe("input-absent");
  });
});
