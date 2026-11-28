/**
 * The per-kind rules of the closing check. They see only the counted
 * envelopes of one row, already in order (earliest first), and decide
 * nothing from an envelope that does not count; git is never read here.
 *
 * - `stays-green`: proven when a counted `pass` is at the start commit
 *   itself and the latest counted envelope is a `pass`.
 * - `red-first`: proven when the last counted `fail` (never `error` or
 *   `skip`) is followed by a counted `pass` at a strict descendant of its
 *   commit and the latest counted envelope is a `pass`; a `fail` and a
 *   `pass` at one commit prove nothing.
 * - `static`: proven when the latest counted envelope is a `pass` with
 *   `exit: 0`.
 * - `measurement`, `manual`, `runtime`: not decidable from envelopes.
 * - `post-deploy`: always pending.
 */
import type { EvidenceResult, TestPlanKind } from "../formats/index.js";
import type { RowState } from "./types.js";

export interface CountedEnvelope {
  commit: string;
  result: EvidenceResult;
  exit: number | null;
}

export interface Verdict {
  state: RowState;
  reason: string;
}

/** Whether a kind is decided from envelopes at all. */
export function kindNeedsEnvelopes(kind: TestPlanKind): boolean {
  return kind === "stays-green" || kind === "red-first" || kind === "static";
}

function latestNotPass(latest: CountedEnvelope): Verdict {
  if (latest.result === "fail" || latest.result === "error") {
    return { state: "failed", reason: `latest-${latest.result}` };
  }
  return { state: "unproven", reason: "latest-skip" };
}

function staysGreen(
  counted: readonly CountedEnvelope[],
  start: string,
): Verdict {
  const latest = counted[counted.length - 1]!;
  if (latest.result !== "pass") return latestNotPass(latest);
  if (!counted.some((env) => env.result === "pass" && env.commit === start)) {
    return { state: "unproven", reason: "no-pass-at-start" };
  }
  return { state: "proven", reason: "pass-at-start-and-latest-pass" };
}

function redFirst(counted: readonly CountedEnvelope[]): Verdict {
  let lastFail = -1;
  counted.forEach((env, index) => {
    if (env.result === "fail") lastFail = index;
  });
  if (lastFail < 0) return { state: "unproven", reason: "no-red" };
  const red = counted[lastFail]!.commit;
  // The counted envelopes are in ancestry order, so a later one at another
  // commit lies at a strict descendant of the red's commit.
  if (
    !counted
      .slice(lastFail + 1)
      .some((env) => env.result === "pass" && env.commit !== red)
  ) {
    if (counted.some((env) => env.result === "pass" && env.commit === red)) {
      return { state: "unproven", reason: "red-and-green-at-one-commit" };
    }
    return { state: "failed", reason: "no-green-after-red" };
  }
  const latest = counted[counted.length - 1]!;
  if (latest.result !== "pass") return latestNotPass(latest);
  return { state: "proven", reason: "red-then-green" };
}

function staticCheck(counted: readonly CountedEnvelope[]): Verdict {
  const latest = counted[counted.length - 1]!;
  if (latest.result !== "pass") return latestNotPass(latest);
  if (latest.exit !== 0) {
    return { state: "unproven", reason: "pass-exit-not-zero" };
  }
  return { state: "proven", reason: "latest-pass-exit-zero" };
}

/**
 * The verdict of one row. `hasFile` says whether the row has an evidence
 * file; `counted` is in order, earliest first.
 */
export function judgeRow(
  kind: TestPlanKind,
  counted: readonly CountedEnvelope[],
  start: string,
  hasFile: boolean,
): Verdict {
  if (kind === "post-deploy") {
    return { state: "pending-post-deploy", reason: "post-deploy" };
  }
  if (!kindNeedsEnvelopes(kind)) {
    return { state: "not-decidable", reason: "kind-needs-review" };
  }
  if (!hasFile) return { state: "unproven", reason: "no-evidence-file" };
  if (counted.length === 0) {
    return { state: "unproven", reason: "no-counted-evidence" };
  }
  if (kind === "stays-green") return staysGreen(counted, start);
  if (kind === "red-first") return redFirst(counted);
  return staticCheck(counted);
}
