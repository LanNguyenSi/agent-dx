/**
 * Asks the host adapter for its facts and checks every value before the
 * conditions see it. A method that throws, rejects or returns a value that
 * is not of its type gives `{ ok: false }`: the fact is missing, and the
 * condition that needs it fails. Nothing of what was thrown or returned is
 * kept, so no message can carry a token, a URL or text of the pull request.
 */
import { COMMIT_RE } from "../formats/validate.js";
import {
  ENFORCEMENT_STATES,
  REVIEW_PATHS,
  REVIEW_STATES,
  type Enforcement,
  type HostAdapter,
  type HostConfigCommit,
  type HostPullRequest,
  type HostReview,
  type ReviewPath,
} from "../host/index.js";
import { isLogin } from "./logins.js";

export type Fact<T> = { ok: true; value: T } | { ok: false };

/** A review with its submission time as a number. */
export interface TimedReview extends HostReview {
  /** Milliseconds since the epoch. */
  at: number;
  /** Its position in the list the host gave. */
  index: number;
}

export interface HostFacts {
  pullRequest: Fact<HostPullRequest>;
  reviews: Fact<TimedReview[]>;
  enforcement: Record<ReviewPath, Fact<Enforcement>>;
  configCommit: Fact<HostConfigCommit>;
}

const MISSING = { ok: false } as const;

/** The full name of a branch on the host. */
const TARGET_REF_RE = /^refs\/heads\/[A-Za-z0-9._+/-]+$/;

/** An ISO 8601 date-time with seconds and a zone. */
const TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The instant `text` names, in milliseconds since the epoch, or `null` when
 * it is not a date-time of the form above or names a date or time that does
 * not exist. A parser rolls such a value over (31 February becomes 2 March,
 * 24:00:00 the next day) and would so move a review in the order; here the
 * fields must come back from the calendar as they were written.
 */
export function instantOf(text: string): number | null {
  const m = TIME_RE.exec(text);
  if (m === null) return null;
  const written = m.slice(1, 7).map(Number);
  const [year, month, day, hour, minute, second] = written as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const back = [
    wall.getUTCFullYear(),
    wall.getUTCMonth() + 1,
    wall.getUTCDate(),
    wall.getUTCHours(),
    wall.getUTCMinutes(),
    wall.getUTCSeconds(),
  ];
  if (back.some((value, i) => value !== written[i])) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCommitId(value: unknown): value is string {
  return typeof value === "string" && COMMIT_RE.test(value);
}

function own(rec: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(rec, key) ? rec[key] : undefined;
}

function pullRequestOf(value: unknown): Fact<HostPullRequest> {
  if (!isRecord(value)) return MISSING;
  const number = own(value, "number");
  const author = own(value, "author");
  const head = own(value, "head");
  const base = own(value, "base");
  const targetRef = own(value, "targetRef");
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !isLogin(author) ||
    !isCommitId(head) ||
    !isCommitId(base) ||
    typeof targetRef !== "string" ||
    !TARGET_REF_RE.test(targetRef)
  ) {
    return MISSING;
  }
  return { ok: true, value: { number, author, head, base, targetRef } };
}

function reviewsOf(value: unknown): Fact<TimedReview[]> {
  if (!Array.isArray(value)) return MISSING;
  const out: TimedReview[] = [];
  // One entry that is not a review voids the list: a list with a hole in it
  // cannot say which review of a login is the latest.
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) return MISSING;
    const login = own(entry, "login");
    const state = own(entry, "state");
    const commit = own(entry, "commit");
    const submittedAt = own(entry, "submittedAt");
    if (
      !isLogin(login) ||
      typeof state !== "string" ||
      !(REVIEW_STATES as readonly string[]).includes(state) ||
      !isCommitId(commit) ||
      typeof submittedAt !== "string"
    ) {
      return MISSING;
    }
    const at = instantOf(submittedAt);
    if (at === null) return MISSING;
    out.push({
      login,
      state: state as HostReview["state"],
      commit,
      submittedAt,
      at,
      index,
    });
  }
  return { ok: true, value: out };
}

function enforcementOf(value: unknown): Fact<Enforcement> {
  return typeof value === "string" &&
    (ENFORCEMENT_STATES as readonly string[]).includes(value)
    ? { ok: true, value: value as Enforcement }
    : MISSING;
}

function configCommitOf(value: unknown): Fact<HostConfigCommit> {
  if (!isRecord(value)) return MISSING;
  const commit = own(value, "commit");
  const approver = own(value, "approver");
  if (
    (commit !== null && !isCommitId(commit)) ||
    (approver !== null && !isLogin(approver))
  ) {
    return MISSING;
  }
  return { ok: true, value: { commit, approver } };
}

async function ask<T>(
  call: () => Promise<unknown>,
  // eslint-disable-next-line no-unused-vars
  check: (value: unknown) => Fact<T>,
): Promise<Fact<T>> {
  let value: unknown;
  try {
    value = await call();
  } catch {
    return MISSING;
  }
  try {
    return check(value);
  } catch {
    // A value whose properties throw when read is not a value of the type.
    return MISSING;
  }
}

/**
 * Reads every fact the approval check uses, one call after the other in a
 * fixed order. `ciRunStatus` is not called: no condition reads it.
 */
export async function readHostFacts(host: HostAdapter): Promise<HostFacts> {
  const pullRequest = await ask(() => host.pullRequest(), pullRequestOf);
  const reviews = await ask(() => host.reviews(), reviewsOf);
  const enforcement = {} as Record<ReviewPath, Fact<Enforcement>>;
  for (const path of REVIEW_PATHS) {
    enforcement[path] = await ask(
      () => host.reviewEnforcement(path),
      enforcementOf,
    );
  }
  const configCommit = await ask(() => host.lastConfigCommit(), configCommitOf);
  return { pullRequest, reviews, enforcement, configCommit };
}
