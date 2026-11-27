/**
 * A host adapter for GitHub over its REST API (version `2022-11-28`).
 *
 * It supplies the typed facts of `HostAdapter` and nothing else, and fails
 * closed: an answer it does not expect makes the method throw, and the
 * approval check turns that into `host-failed`. It reads; it never writes
 * to the host.
 *
 * The token is sent only in the `Authorization` header, only to the API
 * origin given at construction, and only over TLS (or to a loopback
 * address). It is kept in a closure, so the adapter object does not hold
 * it. An error names the method, the path the adapter built, the status
 * and one fixed phrase: never the token, a response body or a header.
 *
 * `docs/approve.md` ("GitHub adapter") lists the endpoints, the mapping of
 * their fields and the limits.
 */
import type { TimedReview } from "../approve/facts.js";
import { isLogin } from "../approve/logins.js";
import { standingApprovals } from "../approve/reviews.js";
import {
  REVIEW_PATHS,
  REVIEW_STATES,
  type CiRunStatus,
  type Enforcement,
  type HostAdapter,
  type HostConfigCommit,
  type HostPullRequest,
  type HostReview,
  type ReviewPath,
  type ReviewState,
} from "./types.js";

/** The API root used when `apiUrl` is not given. */
export const GITHUB_API_URL = "https://api.github.com";
/** The REST API version every request pins. */
export const GITHUB_API_VERSION = "2022-11-28";
/** The time one request may take, headers and body together. */
export const GITHUB_TIMEOUT_MS = 10_000;
/** The largest response body that is read. */
export const GITHUB_MAX_BODY_BYTES = 4 * 1024 * 1024;
/** The number of entries asked for per page of a list. */
export const GITHUB_PAGE_SIZE = 100;
/** The most pages of one list that are read; a longer list throws. */
export const GITHUB_MAX_PAGES = 30;

export interface GitHubHostOptions {
  /** The repository the pull request targets: `<owner>/<name>`. */
  repository: string;
  /** The number of the pull request. */
  pullRequest: number;
  /** A token that may read the repository. */
  token: string;
  /**
   * The API root. Default `https://api.github.com`. It must be `https:`;
   * `http:` is accepted for a loopback host only.
   */
  apiUrl?: string;
  /** A replacement for the global `fetch`. A seam for tests only. */
  fetch?: typeof globalThis.fetch;
}

const OWNER_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,38}$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
/** Printable ASCII without a space: what a header value can carry safely. */
const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "[::1]", "localhost"];
/** The statuses that send a client to another address. None is followed. */
const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];
const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** A branch name the approval check accepts in `refs/heads/<branch>`. */
const BRANCH_RE = /^[A-Za-z0-9._+/-]+$/;
/** The id of a workflow run: a positive integer in the safe range. */
const RUN_ID_RE = /^[1-9][0-9]{0,15}$/;
const RUN_URL_RE =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9][0-9]{0,15})$/;
const TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** One entry of a `Link` header: a target in angle brackets and its parameters. */
const LINK_ENTRY_RE =
  /\s*<([^<>]*)>((?:\s*;\s*[A-Za-z*]+\s*=\s*(?:"[^"]*"|[^",;\s]+))*)\s*(?:,|$)/y;
/** How a `Link` header names a repository by its numeric id. */
const REPOSITORY_ID_PATH_RE = /^\/repositories\/[1-9][0-9]*$/;
/** One parameter of a `Link` entry: its name and its value, quoted or bare. */
const LINK_PARAM_RE = /;\s*([A-Za-z*]+)\s*=\s*(?:"([^"]*)"|([^",;\s]+))/g;

/** What a request gave: a parsed body for 200, else one of the statuses asked for. */
type Answer =
  | { status: 200; json: unknown; link: string | null }
  | { status: number; json?: undefined; link?: undefined };

/** A list, the mapped status that came instead, or `null` for a list past the page cap. */
type Listing =
  { ok: true; items: unknown[] } | { ok: false; status: number | null };

/** The reviews of a pull request, or the error that says why its list cannot be read as reviews. */
type Reviews =
  { ok: true; reviews: HostReview[] } | { ok: false; error: Error };

/** What one source says about a required review. */
type Evidence = "requires" | "none" | "unreadable";

function failure(path: string, status: number | null, reason?: string): Error {
  const head =
    status === null
      ? `github: GET ${path} failed`
      : `github: GET ${path} answered ${status}`;
  return new Error(reason === undefined ? head : `${head} (${reason})`);
}

/**
 * `text` with its ASCII letters in lower case. Names of owners and
 * repositories are compared this way: a letter outside ASCII that merely
 * folds to an ASCII letter is another name.
 */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `needle` occurs in a text or a key anywhere in a parsed JSON value. */
function holdsText(value: unknown, needle: string): boolean {
  const open: unknown[] = [value];
  while (open.length > 0) {
    const item = open.pop();
    if (typeof item === "string") {
      if (item.includes(needle)) return true;
    } else if (Array.isArray(item)) {
      for (const entry of item) open.push(entry);
    } else if (isRecord(item)) {
      for (const [key, entry] of Object.entries(item)) {
        if (key.includes(needle)) return true;
        open.push(entry);
      }
    }
  }
  return false;
}

function isCommitId(value: unknown): value is string {
  return typeof value === "string" && COMMIT_RE.test(value);
}

function isBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    BRANCH_RE.test(value) &&
    value.split("/").every((part) => part !== "" && !part.startsWith("."))
  );
}

/**
 * The instant an ISO 8601 date-time with seconds and a zone names, or
 * `null`. The rule of the approval check (`instantOf` there): a date or
 * time that does not exist is not rolled over.
 */
function instantOf(text: string): number | null {
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

/**
 * The target of the `rel="next"` entry of a `Link` header: `null` without
 * such an entry, `undefined` when the header cannot be read as a list of
 * links or names two next pages.
 */
function nextTarget(header: string | null): string | null | undefined {
  if (header === null) return null;
  const entry = new RegExp(LINK_ENTRY_RE.source, LINK_ENTRY_RE.flags);
  let next: string | null = null;
  while (entry.lastIndex < header.length) {
    const m = entry.exec(header);
    if (m === null) return undefined;
    // The relation is the value of the first parameter named `rel`. Text
    // inside the quoted value of another parameter is not a parameter.
    const rel = [...m[2]!.matchAll(LINK_PARAM_RE)].find(
      (param) => param[1]!.toLowerCase() === "rel",
    );
    const names = (rel?.[2] ?? rel?.[3] ?? "").toLowerCase().split(/\s+/);
    if (!names.includes("next")) continue;
    if (next !== null) return undefined;
    next = m[1]!;
  }
  return next;
}

/**
 * The run id `run` names for `repository` (lower case), or `null`. The
 * address form is read only when `addresses` is true: an address on
 * github.com names a run of that host, not of another API root.
 */
function runIdOf(
  run: unknown,
  repository: string,
  addresses: boolean,
): string | null {
  if (typeof run !== "string") return null;
  let id: string;
  if (RUN_ID_RE.test(run)) {
    id = run;
  } else {
    const m = addresses ? RUN_URL_RE.exec(run) : null;
    if (m === null) return null;
    if (asciiLower(`${m[1]}/${m[2]}`) !== repository) return null;
    id = m[3]!;
  }
  return Number.isSafeInteger(Number(id)) ? id : null;
}

/** The API root as a parsed address, or a refusal that does not repeat it. */
function apiRootOf(apiUrl: string): URL {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error("github: apiUrl must be a URL");
  }
  const loopback = LOOPBACK_HOSTS.includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "github: apiUrl must be https (http only for a loopback host)",
    );
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "github: apiUrl must not carry credentials, a query or a fragment",
    );
  }
  return url;
}

/**
 * A `HostAdapter` for one pull request of one GitHub repository.
 *
 * One adapter is one view: it asks for the pull request and for the review
 * enforcement of its target branch once and keeps the answer (a failure
 * too), so the branch whose enforcement it reports is the branch it reports
 * as the target. Make a new adapter for a new check.
 */
export function createGitHubHost(options: GitHubHostOptions): HostAdapter {
  if (!isRecord(options)) {
    throw new Error("github: options must be an object");
  }
  const { repository, pullRequest: pullNumber, token } = options;
  const [owner, name, ...rest] =
    typeof repository === "string" ? repository.split("/") : [];
  if (
    owner === undefined ||
    name === undefined ||
    rest.length > 0 ||
    !OWNER_RE.test(owner) ||
    !NAME_RE.test(name) ||
    name === "." ||
    name === ".."
  ) {
    throw new Error("github: repository must be <owner>/<name>");
  }
  if (
    typeof pullNumber !== "number" ||
    !Number.isSafeInteger(pullNumber) ||
    pullNumber < 1
  ) {
    throw new Error("github: pullRequest must be a positive integer");
  }
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    throw new Error("github: token must be printable ASCII without a space");
  }
  const { apiUrl } = options;
  // Only a missing option means the default: a value of another type, null
  // included, is a configuration that went wrong, not a wish for github.com.
  if (apiUrl !== undefined && typeof apiUrl !== "string") {
    throw new Error("github: apiUrl must be a URL");
  }
  const api = apiRootOf(apiUrl ?? GITHUB_API_URL);
  const send = options.fetch ?? globalThis.fetch;
  if (typeof send !== "function") {
    throw new Error("github: no fetch is available");
  }

  const prefix = api.pathname.replace(/\/+$/, "");
  const root = `${api.origin}${prefix}`;
  const repoKey = asciiLower(`${owner}/${name}`);
  const repoPath = `/repos/${owner}/${name}`;
  const sameRepository = (fullName: unknown): boolean =>
    typeof fullName === "string" && asciiLower(fullName) === repoKey;

  /** The body of a 200 answer as JSON, read up to the cap. */
  async function bodyOf(response: Response, path: string): Promise<unknown> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body !== null) {
      const reader = response.body.getReader();
      for (;;) {
        let step: { done: boolean; value?: Uint8Array };
        try {
          step = await reader.read();
        } catch (error) {
          throw failure(
            path,
            response.status,
            isTimeout(error) ? "timed out" : "body not readable",
          );
        }
        if (step.done || step.value === undefined) break;
        size += step.value.byteLength;
        if (size > GITHUB_MAX_BODY_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw failure(path, response.status, "body over the size cap");
        }
        chunks.push(step.value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let json: unknown;
    try {
      json = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw failure(path, response.status, "invalid JSON");
    }
    // A body that repeats the token is not turned into values: a login or a
    // branch name read from it would carry the token into a report. The
    // parsed texts are searched, so an escape in the body hides nothing.
    if (holdsText(json, token)) {
      throw failure(path, response.status, "body repeats the token");
    }
    return json;
  }

  /**
   * One GET of `path` (below the API root, with `query`). 200 gives the
   * parsed body, a status in `mapped` gives that status, anything else
   * throws.
   */
  async function get(
    path: string,
    query: string,
    mapped: readonly number[] = [],
  ): Promise<Answer> {
    let response: Response;
    try {
      response = await send(`${root}${path}${query}`, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "spec-gate",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch (error) {
      throw failure(path, null, isTimeout(error) ? "timed out" : "no answer");
    }
    const status = response.status;
    if (status === 200) {
      return {
        status,
        json: await bodyOf(response, path),
        link: response.headers.get("link"),
      };
    }
    void response.body?.cancel().catch(() => undefined);
    if (REDIRECT_STATUSES.includes(status)) {
      throw failure(path, status, "redirect refused");
    }
    if (
      (status === 403 || status === 429) &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after"))
    ) {
      throw failure(path, status, "rate limited");
    }
    if (mapped.includes(status)) return { status };
    throw failure(path, status);
  }

  /**
   * Whether the `Link` header of page `page` of `path` names a next page.
   * The link must stay on the API origin, name the same list (by the
   * repository's name or by its numeric id) and name page `page + 1`.
   */
  function hasNext(link: string | null, path: string, page: number): boolean {
    const target = nextTarget(link);
    if (target === null) return false;
    let url: URL | undefined;
    try {
      if (target !== undefined) url = new URL(target);
    } catch {
      url = undefined;
    }
    if (url === undefined) {
      throw failure(path, 200, "next link not readable");
    }
    if (
      url.origin !== api.origin ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw failure(path, 200, "next link leaves the API origin");
    }
    // The list below the repository, and the repository as the link names it.
    const tail = path.slice(repoPath.length);
    const below =
      url.pathname.startsWith(`${prefix}/`) && url.pathname.endsWith(tail)
        ? url.pathname.slice(prefix.length, url.pathname.length - tail.length)
        : null;
    const sameList =
      below !== null &&
      (asciiLower(below) === asciiLower(repoPath) ||
        REPOSITORY_ID_PATH_RE.test(below));
    if (!sameList) {
      throw failure(path, 200, "next link names another path");
    }
    const pages = url.searchParams.getAll("page");
    if (pages.length !== 1 || pages[0] !== String(page + 1)) {
      throw failure(path, 200, "next link names another page");
    }
    return true;
  }

  /**
   * Every entry of the list at `path`, all pages. A page is the last one
   * when it has no next link and is not full. The next page is asked for at
   * the adapter's own path, never at the address a header names.
   */
  async function list(
    path: string,
    mapped: readonly number[] = [],
    pastCap: "throw" | "report" = "throw",
  ): Promise<Listing> {
    const items: unknown[] = [];
    for (let page = 1; ; page += 1) {
      const answer = await get(
        path,
        `?per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
        mapped,
      );
      if (answer.status !== 200) return { ok: false, status: answer.status };
      if (!Array.isArray(answer.json)) {
        throw failure(path, 200, "not a list");
      }
      for (const item of answer.json) items.push(item);
      const more =
        hasNext(answer.link ?? null, path, page) ||
        answer.json.length >= GITHUB_PAGE_SIZE;
      if (!more) return { ok: true, items };
      if (page >= GITHUB_MAX_PAGES) {
        if (pastCap === "report") return { ok: false, status: null };
        throw failure(path, 200, "more pages than the page cap");
      }
    }
  }

  /**
   * The submitted reviews of pull request `number`, all pages. A list that
   * arrives but cannot be read as reviews (an entry of another shape, more
   * pages than the cap) is reported, not thrown: the caller decides what an
   * unreadable list means. A request that fails throws.
   */
  async function readReviews(number: number): Promise<Reviews> {
    const path = `${repoPath}/pulls/${number}/reviews`;
    const unreadable = (reason: string): Reviews => ({
      ok: false,
      error: failure(path, 200, reason),
    });
    const listing = await list(path, [], "report");
    if (!listing.ok) return unreadable("more pages than the page cap");
    const reviews: HostReview[] = [];
    for (const entry of listing.items) {
      if (!isRecord(entry)) return unreadable("a review is no object");
      const state = entry.state;
      if (typeof state !== "string") {
        return unreadable("a review has no state");
      }
      // A pending review was never submitted: it is not a review.
      if (state === "PENDING") continue;
      if (!(REVIEW_STATES as readonly string[]).includes(state)) {
        return unreadable("a review has an unknown state");
      }
      const user = entry.user;
      const login = isRecord(user) ? user.login : undefined;
      const commit = entry.commit_id;
      const submittedAt = entry.submitted_at;
      if (!isLogin(login)) return unreadable("a review has no login");
      if (!isCommitId(commit)) {
        return unreadable("a review has no commit");
      }
      if (typeof submittedAt !== "string" || instantOf(submittedAt) === null) {
        return unreadable("a review has no submission time");
      }
      reviews.push({
        login,
        state: state as ReviewState,
        commit,
        submittedAt,
      });
    }
    return { ok: true, reviews };
  }

  async function readPullRequest(): Promise<{
    pull: HostPullRequest;
    branch: string;
  }> {
    const path = `${repoPath}/pulls/${pullNumber}`;
    const { json } = await get(path, "");
    if (!isRecord(json)) throw failure(path, 200, "not an object");
    const user = json.user;
    const head = json.head;
    const base = json.base;
    const author = isRecord(user) ? user.login : undefined;
    const headSha = isRecord(head) ? head.sha : undefined;
    const baseSha = isRecord(base) ? base.sha : undefined;
    const baseRef = isRecord(base) ? base.ref : undefined;
    const baseRepo = isRecord(base) ? base.repo : undefined;
    if (json.number !== pullNumber) {
      throw failure(path, 200, "another pull request number");
    }
    if (!isLogin(author)) throw failure(path, 200, "no author login");
    if (!isCommitId(headSha)) throw failure(path, 200, "no head commit");
    if (!isCommitId(baseSha)) throw failure(path, 200, "no base commit");
    if (!isBranch(baseRef)) throw failure(path, 200, "no base branch");
    if (!isRecord(baseRepo) || !sameRepository(baseRepo.full_name)) {
      throw failure(path, 200, "the base is in another repository");
    }
    return {
      pull: {
        number: pullNumber,
        author,
        head: headSha,
        base: baseSha,
        targetRef: `refs/heads/${baseRef}`,
      },
      branch: baseRef,
    };
  }

  let pullOnce: ReturnType<typeof readPullRequest> | undefined;
  const pullRequestOnce = () => (pullOnce ??= readPullRequest());

  /** What the active rules of rulesets say for `branch`. */
  async function rulesetEvidence(branch: string): Promise<Evidence> {
    const path = `${repoPath}/rules/branches/${branch}`;
    const listing = await list(path, [403, 404]);
    if (!listing.ok) return "unreadable";
    let requires = false;
    for (const rule of listing.items) {
      if (!isRecord(rule)) throw failure(path, 200, "a rule is no object");
      const type = rule.type;
      if (typeof type !== "string") {
        throw failure(path, 200, "a rule has no type");
      }
      if (type !== "pull_request") continue;
      const parameters = rule.parameters;
      if (parameters === undefined) continue;
      const count = isRecord(parameters)
        ? parameters.required_approving_review_count
        : undefined;
      if (typeof count !== "number" || !Number.isSafeInteger(count)) {
        throw failure(path, 200, "a pull request rule has no review count");
      }
      if (count >= 1) requires = true;
    }
    return requires ? "requires" : "none";
  }

  /** What the classic branch protection of `branch` says. */
  async function protectionEvidence(branch: string): Promise<Evidence> {
    const path = `${repoPath}/branches/${branch}/protection`;
    const answer = await get(path, "", [403, 404]);
    // 404 is the answer for a branch without protection and for a token
    // that may not see it; the two are not told apart.
    if (answer.status !== 200) return "unreadable";
    if (!isRecord(answer.json)) throw failure(path, 200, "not an object");
    const reviews = answer.json.required_pull_request_reviews;
    if (reviews === undefined || reviews === null) return "none";
    if (!isRecord(reviews)) {
      throw failure(path, 200, "the review settings are no object");
    }
    const count = reviews.required_approving_review_count;
    if (count === undefined) return "none";
    if (typeof count !== "number" || !Number.isSafeInteger(count)) {
      throw failure(path, 200, "the review count is no integer");
    }
    return count >= 1 ? "requires" : "none";
  }

  async function readEnforcement(): Promise<Enforcement> {
    const { branch } = await pullRequestOnce();
    const rulesets = await rulesetEvidence(branch);
    if (rulesets === "requires") return "enforced";
    const protection = await protectionEvidence(branch);
    if (protection === "requires") return "enforced";
    return rulesets === "none" && protection === "none"
      ? "not-enforced"
      : "unknown";
  }

  let enforcementOnce: Promise<Enforcement> | undefined;

  /**
   * The login of the latest approval of commit `head` that stood when the
   * pull request was merged at `mergedAt`, by the rule of the approval
   * check; `null` without one. A review after the merge did not let the
   * change in, and an approval of another commit is not an approval of what
   * was merged.
   */
  function latestApprover(
    reviews: readonly HostReview[],
    head: string,
    mergedAt: number,
  ): string | null {
    const timed: TimedReview[] = reviews
      .map((review, index) => ({
        ...review,
        at: instantOf(review.submittedAt)!,
        index,
      }))
      .filter((review) => review.at <= mergedAt);
    let best: { login: string; at: number } | null = null;
    for (const approval of standingApprovals(timed)) {
      if (approval.commit !== head) continue;
      // The login is the one of the account's latest approval, so the
      // latest approval under that login is the one that stands.
      const at = timed
        .filter((r) => r.state === "APPROVED" && r.login === approval.login)
        .reduce((max, r) => Math.max(max, r.at), -Infinity);
      if (best === null || at > best.at) best = { login: approval.login, at };
    }
    return best?.login ?? null;
  }

  /**
   * The merged pull request into `branch` whose merge commit is `commit`:
   * its number, its head commit and its merge time as the host gave them;
   * `null` when there is none or more than one.
   */
  async function mergedPullOf(
    commit: string,
    branch: string,
  ): Promise<{ number: number; head: unknown; mergedAt: string } | null> {
    const path = `${repoPath}/commits/${commit}/pulls`;
    const listing = await list(path);
    if (!listing.ok) throw failure(path, listing.status);
    const merged: { number: number; head: unknown; mergedAt: string }[] = [];
    for (const entry of listing.items) {
      if (!isRecord(entry)) {
        throw failure(path, 200, "a pull request is no object");
      }
      const number = entry.number;
      const head = entry.head;
      const mergedAt = entry.merged_at;
      const mergeCommit = entry.merge_commit_sha;
      const base = entry.base;
      const baseRef = isRecord(base) ? base.ref : undefined;
      const baseRepo = isRecord(base) ? base.repo : undefined;
      if (
        typeof number !== "number" ||
        !Number.isSafeInteger(number) ||
        number < 1 ||
        (mergedAt !== null && typeof mergedAt !== "string") ||
        (mergeCommit !== null && typeof mergeCommit !== "string") ||
        typeof baseRef !== "string" ||
        !isRecord(baseRepo) ||
        typeof baseRepo.full_name !== "string"
      ) {
        throw failure(path, 200, "a pull request has an unexpected shape");
      }
      if (
        mergedAt !== null &&
        mergeCommit === commit &&
        baseRef === branch &&
        sameRepository(baseRepo.full_name)
      ) {
        merged.push({
          number,
          head: isRecord(head) ? head.sha : undefined,
          mergedAt,
        });
      }
    }
    return merged.length === 1 ? merged[0]! : null;
  }

  return {
    async pullRequest(): Promise<HostPullRequest> {
      return { ...(await pullRequestOnce()).pull };
    },

    async reviews(): Promise<HostReview[]> {
      // A review that cannot be read is never dropped: the reviews that
      // remain would tell another story.
      const read = await readReviews(pullNumber);
      if (!read.ok) throw read.error;
      return read.reviews;
    },

    async reviewEnforcement(path: ReviewPath): Promise<Enforcement> {
      if (!(REVIEW_PATHS as readonly unknown[]).includes(path)) {
        throw new Error("github: reviewEnforcement was asked for another path");
      }
      // Rulesets and branch protection hold for the whole branch, so the
      // answer is the same for every path.
      return (enforcementOnce ??= readEnforcement());
    },

    async lastConfigCommit(): Promise<HostConfigCommit> {
      const { branch } = await pullRequestOnce();
      const path = `${repoPath}/commits`;
      const { json } = await get(
        path,
        `?sha=${encodeURIComponent(branch)}&path=.spec-gate&per_page=1`,
      );
      if (!Array.isArray(json)) throw failure(path, 200, "not a list");
      if (json.length === 0) return { commit: null, approver: null };
      const first: unknown = json[0];
      const commit = isRecord(first) ? first.sha : undefined;
      if (!isCommitId(commit)) throw failure(path, 200, "no commit id");
      const merged = await mergedPullOf(commit, branch);
      if (merged === null) return { commit, approver: null };
      // Without the commit that was merged and the time of the merge no
      // approval can be tied to the change: the approver is unknown.
      const mergedAt = instantOf(merged.mergedAt);
      if (!isCommitId(merged.head) || mergedAt === null) {
        return { commit, approver: null };
      }
      // Unknown is an answer here, so reviews that cannot be read do not
      // fail the fact for every pull request of the repository.
      const read = await readReviews(merged.number);
      if (!read.ok) return { commit, approver: null };
      return {
        commit,
        approver: latestApprover(read.reviews, merged.head, mergedAt),
      };
    },

    async ciRunStatus(commit: string, run: string): Promise<CiRunStatus> {
      if (!isCommitId(commit)) return "unverified";
      const id = runIdOf(run, repoKey, api.origin === GITHUB_API_URL);
      if (id === null) return "unverified";
      const path = `${repoPath}/actions/runs/${id}`;
      const answer = await get(path, "", [404]);
      if (answer.status !== 200) return "unverified";
      const json = answer.json;
      if (!isRecord(json)) throw failure(path, 200, "not an object");
      const runId = json.id;
      const headSha = json.head_sha;
      const status = json.status;
      const repo = json.repository;
      const fullName = isRecord(repo) ? repo.full_name : undefined;
      if (
        typeof runId !== "number" ||
        typeof headSha !== "string" ||
        (status !== null && typeof status !== "string") ||
        typeof fullName !== "string"
      ) {
        throw failure(path, 200, "a run has an unexpected shape");
      }
      return String(runId) === id &&
        sameRepository(fullName) &&
        headSha === commit &&
        status === "completed"
        ? "verified"
        : "unverified";
    },
  };
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "TimeoutError"
  );
}
