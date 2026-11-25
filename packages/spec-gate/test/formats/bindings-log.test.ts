import { describe, expect, it } from "vitest";
import {
  canonicalBinding,
  differingBindings,
  parseBindingsLog,
  replayBindings,
  sameBindings,
  serializeNextBind,
  serializeProposeEntry,
  sha256Tag,
  type BindingsLog,
} from "../../src/formats/index.js";

const COMMIT = "a".repeat(40);
const HASH = sha256Tag("TP-1:\n  status: new\n");

function propose(): string {
  return serializeProposeEntry(COMMIT, HASH);
}

/** A valid log of the propose entry and `binds` bind entries for TP-1. */
function log(binds: number): string {
  const lines = [propose()];
  for (let i = 0; i < binds; i++) {
    const parsed = parseBindingsLog(`${lines.join("\n")}\n`);
    if (!parsed.ok) throw new Error(parsed.problem.message);
    lines.push(
      serializeNextBind(parsed.value, "TP-1", {
        status: "existing",
        selector: `case ${i}`,
        fixtures: [],
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

function ok(text: string): BindingsLog {
  const parsed = parseBindingsLog(text);
  if (!parsed.ok) throw new Error(parsed.problem.message);
  return parsed.value;
}

function problem(text: string): { code: string; line: number } {
  const parsed = parseBindingsLog(text);
  if (parsed.ok) throw new Error("the log was expected not to parse");
  return { code: parsed.problem.code, line: parsed.problem.line };
}

describe("parseBindingsLog", () => {
  it("reads the propose entry alone", () => {
    expect(ok(`${propose()}\n`)).toEqual({
      propose: { seq: 1, kind: "propose", commit: COMMIT, bindings: HASH },
      binds: [],
      lines: [propose()],
    });
  });

  it("reads bind entries chained to the line before", () => {
    const value = ok(log(2));
    expect(value.binds.map((b) => [b.seq, b.tp, b.binding.selector])).toEqual([
      [2, "TP-1", "case 0"],
      [3, "TP-1", "case 1"],
    ]);
    expect(value.binds[0]!.prev).toBe(sha256Tag(value.lines[0]!));
    expect(value.binds[1]!.prev).toBe(sha256Tag(value.lines[1]!));
  });

  it("accepts a 64-digit commit id", () => {
    expect(
      ok(`${serializeProposeEntry("b".repeat(64), HASH)}\n`).propose.commit,
    ).toBe("b".repeat(64));
  });

  it("refuses an empty text, a missing final line feed and a carriage return", () => {
    expect(problem("")).toEqual({ code: "log-empty", line: 0 });
    expect(problem(propose())).toEqual({ code: "log-line-ending", line: 1 });
    expect(problem(`${propose()}\r\n`)).toEqual({
      code: "log-line-ending",
      line: 1,
    });
    const two = log(1).split("\n");
    expect(problem(`${two[0]}\n${two[1]}\r\n`)).toEqual({
      code: "log-line-ending",
      line: 2,
    });
  });

  it("refuses a blank line and a line that is not one strict JSON object", () => {
    expect(problem(`${propose()}\n\n`)).toEqual({
      code: "log-blank-line",
      line: 2,
    });
    expect(problem(`${propose()}\nnot json\n`)).toEqual({
      code: "log-not-json",
      line: 2,
    });
    expect(problem("[1]\n")).toMatchObject({ code: "log-entry-shape" });
    // a duplicate key that JSON.parse would collapse
    expect(
      problem(
        `{"seq":1,"seq":1,"kind":"propose","commit":"${COMMIT}","bindings":"${HASH}"}\n`,
      ),
    ).toEqual({ code: "log-not-json", line: 1 });
  });

  it("refuses a sequence that does not start at 1 or does not grow by exactly 1", () => {
    expect(
      problem(
        `{"seq":0,"kind":"propose","commit":"${COMMIT}","bindings":"${HASH}"}\n`,
      ),
    ).toEqual({ code: "log-seq", line: 1 });
    const lines = log(1).trimEnd().split("\n");
    const skipped = lines[1]!.replace('"seq":2', '"seq":3');
    expect(problem(`${lines[0]}\n${skipped}\n`)).toEqual({
      code: "log-seq",
      line: 2,
    });
  });

  it("refuses a log whose first line is not the propose entry, and a second propose entry", () => {
    const lines = log(1).trimEnd().split("\n");
    const bindFirst = lines[1]!.replace('"seq":2', '"seq":1');
    expect(problem(`${bindFirst}\n`)).toEqual({
      code: "log-propose-not-first",
      line: 1,
    });
    const second = propose().replace('"seq":1', '"seq":2');
    expect(problem(`${propose()}\n${second}\n`)).toEqual({
      code: "log-propose-not-first",
      line: 2,
    });
  });

  it("refuses a propose entry with a missing, extra or malformed field", () => {
    for (const bad of [
      `{"seq":1,"kind":"propose","commit":"${COMMIT}"}`,
      `{"seq":1,"kind":"propose","commit":"${COMMIT}","bindings":"${HASH}","x":1}`,
      `{"seq":1,"kind":"propose","commit":"${COMMIT.slice(1)}","bindings":"${HASH}"}`,
      `{"seq":1,"kind":"propose","commit":"${COMMIT.toUpperCase()}","bindings":"${HASH}"}`,
      `{"seq":1,"kind":"propose","commit":"${COMMIT}","bindings":"md5:abc"}`,
    ]) {
      expect(problem(`${bad}\n`), bad).toEqual({
        code: "log-entry-shape",
        line: 1,
      });
    }
  });

  it("refuses a bind entry with a bad shape, a bad TP ID or a binding the parser refuses or that is not canonical", () => {
    const value = ok(log(0));
    const prev = sha256Tag(value.lines[0]!);
    const entry = (fields: Record<string, unknown>) =>
      `${propose()}\n${JSON.stringify({ seq: 2, kind: "bind", tp: "TP-1", binding: { status: "new", fixtures: [] }, prev, ...fields })}\n`;
    expect(ok(entry({})).binds).toHaveLength(1);
    for (const fields of [
      { kind: "rebind" },
      { tp: "AC-1" },
      { tp: "TP-01" },
      { prev: "sha256:abc" },
      { extra: true },
      { binding: { status: "maybe", fixtures: [] } },
      { binding: { status: "new", selector: "-x", fixtures: [] } },
      { binding: { status: "new", claim: "normative", fixtures: [] } },
      // valid for the parser, but not the canonical spelling
      { binding: { status: "new" } },
      { binding: { fixtures: [], status: "new" } },
    ]) {
      expect(problem(entry(fields)), JSON.stringify(fields)).toEqual({
        code: "log-entry-shape",
        line: 2,
      });
    }
  });

  it("refuses a chain break: a changed, removed or reordered earlier line", () => {
    const lines = log(3).trimEnd().split("\n");
    // line 2 changed: line 3 no longer holds its hash
    const changed = [...lines];
    changed[1] = changed[1]!.replace("case 0", "case X");
    expect(problem(`${changed.join("\n")}\n`)).toEqual({
      code: "log-chain",
      line: 3,
    });
    // the propose line changed: line 2 no longer holds its hash
    const moved = [...lines];
    moved[0] = serializeProposeEntry("c".repeat(40), HASH);
    expect(problem(`${moved.join("\n")}\n`)).toEqual({
      code: "log-chain",
      line: 2,
    });
    // two bind entries swapped, their seq values fixed up
    const swapped = [
      lines[0]!,
      lines[2]!.replace('"seq":3', '"seq":2'),
      lines[1]!.replace('"seq":2', '"seq":3'),
      lines[3]!,
    ];
    expect(problem(`${swapped.join("\n")}\n`)).toEqual({
      code: "log-chain",
      line: 2,
    });
  });
});

describe("replay and comparison", () => {
  it("replays bind entries in order over the bindings at the propose commit", () => {
    const value = ok(log(2));
    const base = {
      "TP-1": { status: "new" as const, fixtures: [] },
      "TP-2": { status: "existing" as const, fixtures: [] },
    };
    const replay = replayBindings(base, value.binds);
    expect(replay["TP-1"]).toEqual({
      status: "existing",
      selector: "case 1",
      fixtures: [],
    });
    expect(replay["TP-2"]).toEqual(base["TP-2"]);
    // the input is not changed
    expect(base["TP-1"]).toEqual({ status: "new", fixtures: [] });
  });

  it("compares bindings as parsed values, whatever the key order", () => {
    const a = {
      "TP-1": { status: "new" as const, fixtures: [], selector: "x" },
    };
    const b = {
      "TP-1": canonicalBinding({ selector: "x", status: "new", fixtures: [] }),
    };
    expect(sameBindings(a, b)).toBe(true);
    expect(differingBindings(a, b)).toEqual([]);
    const c = {
      "TP-1": { status: "new" as const, fixtures: ["f"] },
      "TP-2": { status: "new" as const, fixtures: [] },
    };
    expect(sameBindings(a, c)).toBe(false);
    expect(differingBindings(a, c)).toEqual(["TP-1", "TP-2"]);
  });
});
