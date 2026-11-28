/**
 * The per-kind rules over every short envelope sequence. An oracle written
 * here from the per-kind table of docs/closure.md (it does not call the
 * implementation) is compared with `judgeRow` for every sequence of 0 to 4
 * counted envelopes on three commits of one line of history (start, a, b),
 * each envelope a pass, a pass with another exit (a positive one, a negative
 * one or none), a fail, an error or a skip. The sequences are in the order
 * closure hands them over: by commit ancestry, so the commits never go back.
 */
import { describe, expect, it } from "vitest";
import { judgeRow, type CountedEnvelope } from "../../src/closure/index.js";
import { TEST_PLAN_KINDS, type TestPlanKind } from "../../src/formats/index.js";

const START = "1".repeat(40);
const COMMITS = [START, "2".repeat(40), "3".repeat(40)];

type Step = {
  commit: number;
  result: CountedEnvelope["result"];
  exit: number | null;
};

const OUTCOMES: Omit<Step, "commit">[] = [
  { result: "pass", exit: 0 },
  { result: "pass", exit: 3 },
  { result: "pass", exit: -1 },
  { result: "pass", exit: null },
  { result: "fail", exit: 1 },
  { result: "error", exit: null },
  { result: "skip", exit: null },
];

/** Every sequence of up to `max` steps whose commits never go back. */
function sequences(max: number): Step[][] {
  const out: Step[][] = [[]];
  const grow = (seq: Step[]): void => {
    if (seq.length === max) return;
    const from = seq.length === 0 ? 0 : seq[seq.length - 1]!.commit;
    for (let commit = from; commit < COMMITS.length; commit += 1) {
      for (const outcome of OUTCOMES) {
        const next = [...seq, { commit, ...outcome }];
        out.push(next);
        grow(next);
      }
    }
  };
  grow([]);
  return out;
}

type Verdict = { state: string; reason: string };

/** The docs/closure.md table, restated step by step. */
function oracle(kind: TestPlanKind, seq: readonly Step[]): Verdict {
  if (kind === "post-deploy") {
    return { state: "pending-post-deploy", reason: "post-deploy" };
  }
  if (kind === "measurement" || kind === "manual" || kind === "runtime") {
    return { state: "not-decidable", reason: "kind-needs-review" };
  }
  if (seq.length === 0) {
    return { state: "unproven", reason: "no-counted-evidence" };
  }
  const last = seq[seq.length - 1]!;
  const lastIsBad = last.result === "fail" || last.result === "error";
  const anyPass = seq.some((s) => s.result === "pass");

  if (kind === "stays-green" || kind === "static") {
    if (lastIsBad) return { state: "failed", reason: `latest-${last.result}` };
    if (last.result === "skip") {
      return { state: "unproven", reason: "latest-skip" };
    }
    if (kind === "static") {
      return last.exit === 0
        ? { state: "proven", reason: "latest-pass-exit-zero" }
        : { state: "unproven", reason: "pass-exit-not-zero" };
    }
    const passAtStart = seq.some((s) => s.result === "pass" && s.commit === 0);
    return passAtStart
      ? { state: "proven", reason: "pass-at-start-and-latest-pass" }
      : { state: "unproven", reason: "no-pass-at-start" };
  }

  // red-first
  if (lastIsBad && anyPass) {
    return { state: "failed", reason: `latest-${last.result}` };
  }
  const fails = seq
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.result === "fail");
  if (fails.length === 0) return { state: "unproven", reason: "no-red" };
  const red = fails[fails.length - 1]!;
  const greenLater = seq
    .slice(red.i + 1)
    .some((s) => s.result === "pass" && s.commit > red.s.commit);
  if (!greenLater) {
    const greenAtRed = seq.some(
      (s) => s.result === "pass" && s.commit === red.s.commit,
    );
    if (!greenAtRed) return { state: "failed", reason: "no-green-after-red" };
    return last.result === "pass"
      ? { state: "unproven", reason: "red-and-green-at-one-commit" }
      : { state: "unproven", reason: "latest-skip" };
  }
  if (last.result === "skip") {
    return { state: "unproven", reason: "latest-skip" };
  }
  return { state: "proven", reason: "red-then-green" };
}

describe("closure: the per-kind rules over every short sequence", () => {
  const all = sequences(4);

  it("enumerates the sequences it means to", () => {
    // 1 empty; then non-decreasing commit sequences times 7 outcomes each.
    expect(all.length).toBe(1 + 3 * 7 + 6 * 7 ** 2 + 10 * 7 ** 3 + 15 * 7 ** 4);
  });

  for (const kind of TEST_PLAN_KINDS) {
    it(`${kind}: judgeRow agrees with the table of docs/closure.md`, () => {
      const wrong: string[] = [];
      for (const seq of all) {
        const counted: CountedEnvelope[] = seq.map((s) => ({
          commit: COMMITS[s.commit]!,
          result: s.result,
          exit: s.exit,
        }));
        const got = judgeRow(kind, counted, START, true);
        const want = oracle(kind, seq);
        if (got.state !== want.state || got.reason !== want.reason) {
          const text = seq
            .map(
              (s) =>
                `${s.result}${s.result === "pass" && s.exit !== 0 ? `(exit ${String(s.exit)})` : ""}@${s.commit}`,
            )
            .join(",");
          wrong.push(
            `[${text}] got ${got.state}/${got.reason}, want ${want.state}/${want.reason}`,
          );
        }
      }
      expect(wrong.slice(0, 10)).toEqual([]);
    });
  }

  it("is unproven without an evidence file for the kinds decided from envelopes", () => {
    for (const kind of ["stays-green", "red-first", "static"] as const) {
      expect(judgeRow(kind, [], START, false)).toEqual({
        state: "unproven",
        reason: "no-evidence-file",
      });
    }
  });
});
