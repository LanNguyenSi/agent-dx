/**
 * The conjuncts of the selection and parsing rules of the GitHub adapter,
 * each with the one change to `src/host/github.ts` that removes or inverts
 * exactly that conjunct.
 *
 * A conjunct is one part of a decision: a condition, a filter, an order
 * that is relied on, skipping against stopping in a loop, the first against
 * the last hit of a search, a fallback that fails closed. Every id here has
 * a row in the `CONJUNCTS` table of the test file named in `table`, and that
 * row must fail when the change is made: a rule with a part that no row
 * depends on is a rule whose part can be lost without a test noticing.
 *
 * The suite checks what it can without changing the source
 * (`github-source.test.ts`): the ids of this list and of the tables are the
 * same; every change still applies to exactly one line; every line of the
 * whole file that decides something, and every pattern, has a change; every
 * boolean part of a line lies in a change; and a value that selects what is
 * read, a guard of what follows it and a text compared with a constant are
 * pinned by a change or named there with the reason.
 *
 * That check reads text. It does not see which decision a change removes,
 * a decision that is spread over lines without an operator on any of them
 * (the order of two statements, a default value, what a `catch` turns a
 * failure into), or the single characters a pattern lets in. For the last
 * the test files hold a test for every character of an alphabet; for the
 * others the list was compared with a sweep of generated changes when it
 * was written. What no input can tell from the source is named with its
 * reason beside the check that would otherwise ask for a change.
 *
 * That each row really fails under its change is checked by a mutation
 * run, which applies one change, runs the row whose title starts with the
 * id, and restores the file.
 */

/** The test files that hold a `CONJUNCTS` table, without `.test.ts`. */
export const CONJUNCT_TABLES = [
  "github-options",
  "github-pull",
  "github-reviews",
  "github-enforcement",
  "github-config-commit",
  "github-ci",
  "github-errors",
] as const;
export type ConjunctTable = (typeof CONJUNCT_TABLES)[number];

/** One replacement in `src/host/github.ts`. */
export interface Change {
  /**
   * Text that stands on exactly one line of the source; with `after`, on
   * the first line that has it below the one line that holds `after`.
   */
  match: string;
  /** What `match` is replaced by. */
  with: string;
  after?: string;
}

export interface ConjunctMutant extends Change {
  id: string;
  table: ConjunctTable;
  /** Further replacements of the same change, when one alone does not compile. */
  also?: Change[];
  /**
   * The text of a deciding line this change stands for although it edits
   * another line, because an edit of that line itself would not compile.
   */
  covers?: string;
  /**
   * True when the changed source no longer type-checks, as for a type guard
   * that is taken away. The mutation run applies such a change without the
   * build step; the tests load the source without a type check.
   */
  untyped?: true;
}

const raw = String.raw;

const options: Omit<ConjunctMutant, "table">[] = [
  {
    id: "C-API-01",
    match: "apiRootOf(apiUrl ?? GITHUB_API_URL)",
    with: 'apiRootOf(apiUrl ?? "https://api.github.example")',
  },
  {
    id: "C-API-02",
    match: "apiUrl !== undefined &&",
    with: "(apiUrl !== undefined || true) &&",
  },
  {
    id: "C-API-03",
    match: 'apiUrl !== undefined && typeof apiUrl !== "string"',
    with: '(apiUrl !== undefined && typeof apiUrl !== "string" && false)',
  },
  {
    id: "C-API-04",
    match: 'typeof apiUrl !== "string"',
    with: 'typeof apiUrl === "number"',
  },
  {
    id: "C-API-05",
    match: "apiRootOf(apiUrl ?? GITHUB_API_URL)",
    with: "apiRootOf(apiUrl === undefined ? GITHUB_API_URL : GITHUB_API_URL)",
  },
  {
    id: "C-API-06",
    match: "apiUrl ?? GITHUB_API_URL",
    with: "apiUrl || GITHUB_API_URL",
  },
  {
    id: "C-API-07",
    match: 'throw new Error("github: apiUrl must be a URL");',
    after: "url = new URL(apiUrl);",
    with: "url = new URL(GITHUB_API_URL);",
  },
  {
    id: "C-API-08",
    match: '!(url.protocol === "http:" && loopback)',
    with: '!(url.protocol === "http:" && (loopback || true))',
  },
  {
    id: "C-API-09",
    match: 'url.protocol === "http:" && loopback',
    with: 'url.protocol !== "" && loopback',
  },
  {
    id: "C-API-10",
    match: 'url.protocol !== "https:" &&',
    with: 'url.protocol !== "https+x:" &&',
  },
  { id: "C-API-11", match: '"127.0.0.1", ', with: "" },
  { id: "C-API-12", match: '"[::1]", ', with: "" },
  { id: "C-API-13", match: ', "localhost"]', with: "]" },
  {
    id: "C-API-14",
    match: "LOOPBACK_HOSTS.includes(url.hostname)",
    with: '(LOOPBACK_HOSTS.includes(url.hostname) || url.hostname.startsWith("127."))',
  },
  {
    id: "C-API-15",
    match: 'url.username !== "" ||',
    after: "const loopback = LOOPBACK_HOSTS.includes(url.hostname);",
    with: '(url.username !== "" && false) ||',
  },
  {
    id: "C-API-16",
    match: 'url.password !== "" ||',
    with: '(url.password !== "" && false) ||',
  },
  {
    id: "C-API-17",
    match: 'url.search !== "" ||',
    with: '(url.search !== "" && false) ||',
  },
  {
    id: "C-API-18",
    match: 'url.hash !== ""',
    with: '(url.hash !== "" && false)',
  },
  {
    id: "C-API-19",
    match: raw`api.pathname.replace(/\/+$/, "")`,
    with: raw`api.pathname.replace(/\/+$/, "/")`,
  },
  {
    id: "C-API-20",
    match: "const root = `${api.origin}${prefix}`;",
    with: "const root = `${api.origin}`;",
  },
  // createGitHubHost: the other options.
  {
    id: "C-OPT-01",
    match: "if (!isRecord(options)) {",
    with: "if (options === undefined) {",
  },
  {
    id: "C-OPT-02",
    match: 'typeof repository === "string" ? repository.split("/") : []',
    with: 'String(repository).split("/")',
  },
  {
    id: "C-OPT-03",
    match: "name === undefined ||",
    with: "(name === undefined && false) ||",
    untyped: true,
  },
  { id: "C-OPT-04", match: "rest.length > 0 ||", with: "rest.length > 9 ||" },
  {
    id: "C-OPT-05",
    match: "!OWNER_RE.test(owner) ||",
    with: "(!OWNER_RE.test(owner) && false) ||",
  },
  {
    id: "C-OPT-06",
    match: raw`const OWNER_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,38}$/;`,
    with: raw`const OWNER_RE = /^[A-Za-z0-9_-]{1,39}$/;`,
  },
  {
    id: "C-OPT-07",
    match: raw`[A-Za-z0-9_-]{0,38}$/;`,
    with: raw`[A-Za-z0-9_-]{0,39}$/;`,
  },
  {
    id: "C-OPT-08",
    match: raw`const OWNER_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,38}$/;`,
    with: raw`const OWNER_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,38}$/;`,
  },
  {
    id: "C-OPT-09",
    match: raw`[A-Za-z0-9_-]{0,38}$/;`,
    with: raw`[A-Za-z0-9_-]{0,38}/;`,
  },
  {
    id: "C-OPT-10",
    match: raw`const OWNER_RE = /^[A-Za-z0-9_]`,
    with: raw`const OWNER_RE = /[A-Za-z0-9_]`,
  },
  {
    id: "C-OPT-11",
    match: "!NAME_RE.test(name) ||",
    with: "(!NAME_RE.test(name) && false) ||",
  },
  {
    id: "C-OPT-12",
    match: raw`const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;`,
    with: raw`const NAME_RE = /^[A-Za-z0-9._-]{1,101}$/;`,
  },
  {
    id: "C-OPT-13",
    match: raw`const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;`,
    with: raw`const NAME_RE = /^[A-Za-z0-9._-]{0,100}$/;`,
  },
  {
    id: "C-OPT-14",
    match: raw`const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;`,
    with: raw`const NAME_RE = /^[A-Za-z0-9._%-]{1,100}$/;`,
  },
  {
    id: "C-OPT-15",
    match: raw`const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;`,
    with: raw`const NAME_RE = /[A-Za-z0-9._-]{1,100}$/;`,
  },
  {
    id: "C-OPT-16",
    match: raw`const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;`,
    with: raw`const NAME_RE = /^[A-Za-z0-9._-]{1,100}/;`,
  },
  { id: "C-OPT-17", match: 'name === "." ||', with: 'name === "..." ||' },
  { id: "C-OPT-18", match: '    name === ".."', with: '    name === "..."' },
  {
    id: "C-OPT-19",
    match: "!Number.isSafeInteger(pullNumber) ||",
    with: "(!Number.isSafeInteger(pullNumber) && false) ||",
  },
  {
    id: "C-OPT-20",
    match: "!Number.isSafeInteger(pullNumber) ||",
    with: "!Number.isInteger(pullNumber) ||",
  },
  { id: "C-OPT-21", match: "    pullNumber < 1", with: "    pullNumber < 0" },
  {
    id: "C-OPT-22",
    match: 'typeof token !== "string" ||',
    with: '(typeof token !== "string" && false) ||',
    untyped: true,
  },
  {
    id: "C-OPT-23",
    match: "!TOKEN_RE.test(token)",
    with: "(!TOKEN_RE.test(token) && false)",
  },
  {
    id: "C-OPT-24",
    match: raw`const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;`,
    with: raw`const TOKEN_RE = /^[\x20-\x7e]{1,4096}$/;`,
  },
  {
    id: "C-OPT-25",
    match: raw`const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;`,
    with: raw`const TOKEN_RE = /^[\x21-\xff]{1,4096}$/;`,
  },
  {
    id: "C-OPT-26",
    match: raw`const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;`,
    with: raw`const TOKEN_RE = /^[\x21-\x7e]{1,4097}$/;`,
  },
  {
    id: "C-OPT-27",
    match: raw`const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;`,
    with: raw`const TOKEN_RE = /^[\x21-\x7e]{0,4096}$/;`,
  },
  {
    id: "C-OPT-28",
    match: raw`const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;`,
    with: raw`const TOKEN_RE = /^[\x21-\x7e]{1,4096}/;`,
  },
  {
    id: "C-OPT-29",
    match: raw`const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;`,
    with: raw`const TOKEN_RE = /[\x21-\x7e]{1,4096}$/;`,
  },
  {
    id: "C-OPT-30",
    match: 'typeof send !== "function"',
    with: '(typeof send !== "function" && false)',
  },
  {
    id: "C-OPT-31",
    match: "options.fetch ?? globalThis.fetch",
    with: "globalThis.fetch ?? options.fetch",
    untyped: true,
  },
  {
    id: "C-OPT-32",
    match: "options.fetch ?? globalThis.fetch",
    with: "options.fetch ?? (async () => new Response(null, { status: 599 }))",
  },
  {
    id: "C-OPT-33",
    match: raw`const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;`,
    with: raw`const TOKEN_RE = /^[\x21-\x7f]{1,4096}$/;`,
  },
  {
    id: "C-OPT-34",
    match: raw`const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;`,
    with: raw`const TOKEN_RE = /^[\x22-\x7e]{1,4096}$/;`,
  },
  {
    id: "C-OPT-35",
    match: raw`const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;`,
    with: raw`const TOKEN_RE = /^[\x21-\x7d]{1,4096}$/;`,
  },
];

const pull: Omit<ConjunctMutant, "table">[] = [
  // readPullRequest and pullRequest.
  {
    id: "C-PUL-01",
    match: "const path = `${repoPath}/pulls/${pullNumber}`;",
    with: "const path = `${repoPath}/pulls/7`;",
  },
  {
    id: "C-PUL-02",
    match: 'if (!isRecord(json)) throw failure(path, 200, "not an object");',
    after: 'const { json } = await get(path, "");',
    with: 'if (json === null) throw failure(path, 200, "not an object");',
    untyped: true,
  },
  {
    id: "C-PUL-03",
    match: "const author = isRecord(user) ? user.login : undefined;",
    with: "const author = isRecord(user) ? user.login : user;",
  },
  {
    id: "C-PUL-04",
    match: "const headSha = isRecord(head) ? head.sha : undefined;",
    with: "const headSha = isRecord(head) ? head.sha : head;",
  },
  {
    id: "C-PUL-05",
    match: "const baseSha = isRecord(base) ? base.sha : undefined;",
    with: "const baseSha = isRecord(base) ? base.sha : base;",
  },
  {
    id: "C-PUL-06",
    match: "json.number !== pullNumber",
    with: "(json.number !== pullNumber && false)",
  },
  {
    id: "C-PUL-07",
    match: "!isLogin(author)",
    with: 'typeof author !== "string"',
  },
  {
    id: "C-PUL-08",
    match: "!isCommitId(headSha)",
    with: 'typeof headSha !== "string"',
  },
  {
    id: "C-PUL-09",
    match: "!isCommitId(baseSha)",
    with: 'typeof baseSha !== "string"',
  },
  {
    id: "C-PUL-10",
    match: "!isBranch(baseRef)",
    with: 'typeof baseRef !== "string"',
    untyped: true,
  },
  {
    id: "C-PUL-11",
    match: "const baseRepo = isRecord(base) ? base.repo : undefined;",
    after: "const baseSha = isRecord(base) ? base.sha : undefined;",
    with: "const baseRepo = isRecord(base) ? (base.repo ?? { full_name: repoKey }) : undefined;",
    covers: "if (!isRecord(baseRepo) || !sameRepository(baseRepo.full_name)) {",
  },
  {
    id: "C-PUL-12",
    match: "!sameRepository(baseRepo.full_name)",
    with: "(!sameRepository(baseRepo.full_name) && false)",
  },
  {
    id: "C-PUL-13",
    match: 'typeof fullName === "string" &&',
    with: "true &&",
    untyped: true,
  },
  {
    id: "C-PUL-14",
    match: "asciiLower(fullName) === repoKey",
    with: "fullName === repoKey",
  },
  {
    id: "C-PUL-15",
    match: "text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())",
    with: "text.toLowerCase()",
  },
  {
    id: "C-PUL-16",
    match: "asciiLower(`${owner}/${name}`)",
    with: "`${owner}/${name}`",
  },
  {
    id: "C-PUL-17",
    match: "targetRef: `refs/heads/${baseRef}`,",
    with: "targetRef: `${baseRef}`,",
  },
  { id: "C-PUL-18", match: "head: headSha,", with: "head: baseSha," },
  { id: "C-PUL-19", match: "base: baseSha,", with: "base: headSha," },
  {
    id: "C-PUL-20",
    match: "pullOnce ??= readPullRequest()",
    with: "(pullOnce && false) || (pullOnce = readPullRequest())",
  },
  {
    id: "C-PUL-21",
    match: "{ ...(await pullRequestOnce()).pull }",
    with: "(await pullRequestOnce()).pull",
  },
  {
    id: "C-PUL-22",
    match: "const repoPath = `/repos/${owner}/${name}`;",
    with: "const repoPath = `/repos/${owner}/${name}`.toLowerCase();",
  },
  // isRecord.
  {
    id: "C-REC-01",
    match: " && !Array.isArray(value)",
    with: "",
  },
  { id: "C-REC-02", match: " && value !== null", with: "", untyped: true },
  {
    id: "C-REC-03",
    match: 'typeof value === "object" && ',
    with: "",
    untyped: true,
  },
  // isBranch and its pattern.
  {
    id: "C-BRN-01",
    match: "BRANCH_RE.test(value) &&",
    with: "(BRANCH_RE.test(value) || true) &&",
  },
  {
    id: "C-BRN-02",
    match: 'value.split("/").every(',
    with: 'value.split("/").slice(1).every(',
  },
  {
    id: "C-BRN-03",
    match: 'value.split("/").every(',
    with: 'value.split("/").slice(0, -1).every(',
  },
  {
    id: "C-BRN-04",
    match: 'value.split("/").every(',
    with: 'value.split("/").filter((_, i, all) => i === 0 || i === all.length - 1).every(',
  },
  {
    id: "C-BRN-05",
    match: 'value.split("/").every(',
    with: 'value.split("/").some(',
  },
  {
    id: "C-BRN-06",
    match: 'part !== "" &&',
    with: '(part !== "" || true) &&',
  },
  {
    id: "C-BRN-07",
    match: 'part !== "" &&',
    with: '(part !== "" || true) &&',
  },
  {
    id: "C-BRN-08",
    match: 'part !== "" &&',
    with: '(part !== "" || true) &&',
  },
  {
    id: "C-BRN-09",
    match: '!part.startsWith(".")',
    with: '(!part.startsWith(".") || true)',
  },
  {
    id: "C-BRN-10",
    match: '!part.startsWith(".")',
    with: 'part !== ".."',
  },
  {
    id: "C-BRN-11",
    match: '!part.startsWith(".")',
    with: '!part.startsWith("..")',
  },
  {
    id: "C-BRN-12",
    match: raw`const BRANCH_RE = /^[A-Za-z0-9._+/-]+$/;`,
    with: raw`const BRANCH_RE = /^[^\s]+$/;`,
  },
  {
    id: "C-BRN-13",
    match: raw`const BRANCH_RE = /^[A-Za-z0-9._+/-]+$/;`,
    with: raw`const BRANCH_RE = /[A-Za-z0-9._+/-]+$/;`,
  },
  {
    id: "C-BRN-14",
    match: raw`const BRANCH_RE = /^[A-Za-z0-9._+/-]+$/;`,
    with: raw`const BRANCH_RE = /^[A-Za-z0-9._+/-]+/;`,
  },
  {
    id: "C-BRN-15",
    match: 'typeof value === "string" &&',
    after: "function isBranch(value: unknown): value is string {",
    with: "true &&",
    untyped: true,
  },
  // isCommitId and its pattern.
  {
    id: "C-CMT-01",
    match: 'typeof value === "string" && COMMIT_RE.test(value)',
    with: "COMMIT_RE.test(String(value))",
  },
  {
    id: "C-CMT-02",
    match: raw`const COMMIT_RE = /^[0-9a-f]{40}(`,
    with: raw`const COMMIT_RE = /^[0-9a-f]{39,40}(`,
  },
  {
    id: "C-CMT-03",
    match: raw`([0-9a-f]{24})?$/;`,
    with: raw`([0-9a-f]{1,24})?$/;`,
  },
  {
    id: "C-CMT-04",
    match: raw`([0-9a-f]{24})?$/;`,
    with: raw`$/;`,
  },
  {
    id: "C-CMT-05",
    match: raw`([0-9a-f]{24})?$/;`,
    with: raw`([0-9a-f]{24})?$/i;`,
  },
  {
    id: "C-CMT-06",
    match: raw`const COMMIT_RE = /^[0-9a-f]{40}(`,
    with: raw`const COMMIT_RE = /[0-9a-f]{40}(`,
  },
  {
    id: "C-CMT-07",
    match: raw`([0-9a-f]{24})?$/;`,
    with: raw`([0-9a-f]{24})?/;`,
  },
  {
    id: "C-CMT-08",
    match: raw`const COMMIT_RE = /^[0-9a-f]{40}(`,
    with: raw`const COMMIT_RE = /^[0-9a-z]{40}(`,
  },
  {
    id: "C-PUL-23",
    match: "const baseRef = isRecord(base) ? base.ref : undefined;",
    with: "const baseRef = (base as { ref?: unknown }).ref;",
    after: "const baseSha = isRecord(base) ? base.sha : undefined;",
  },
  {
    id: "C-PUL-24",
    match: "!isRecord(baseRepo) || !sameRepository(baseRepo.full_name)",
    with: "!sameRepository((baseRepo as { full_name?: unknown }).full_name)",
  },
  {
    id: "C-PUL-25",
    match: "const author = isRecord(user) ? user.login : undefined;",
    with: "const author = (user as { login?: unknown }).login;",
  },
  {
    id: "C-PUL-26",
    match: "const headSha = isRecord(head) ? head.sha : undefined;",
    with: "const headSha = (head as { sha?: unknown }).sha;",
  },
  {
    id: "C-PUL-27",
    match: "const baseSha = isRecord(base) ? base.sha : undefined;",
    with: "const baseSha = (base as { sha?: unknown }).sha;",
  },
  {
    id: "C-PUL-28",
    match: "const baseRepo = isRecord(base) ? base.repo : undefined;",
    with: "const baseRepo = (base as { repo?: unknown }).repo;",
    after: "const baseSha = isRecord(base) ? base.sha : undefined;",
  },
  {
    id: "C-CMT-09",
    match: 'typeof value === "string" && COMMIT_RE.test(value)',
    with: 'typeof value === "string"',
    untyped: true,
  },
  // The merge facts of readPullRequest.
  {
    id: "C-PUL-29",
    match: 'typeof isMerged !== "boolean"',
    with: '(typeof isMerged !== "boolean" && false)',
    untyped: true,
  },
  {
    id: "C-PUL-30",
    match: 'typeof isMerged !== "boolean"',
    with: "isMerged === undefined",
    untyped: true,
  },
  {
    id: "C-PUL-31",
    match: "if (isMerged) {",
    with: "if (isMerged || true) {",
  },
  {
    id: "C-PUL-32",
    match: "if (isMerged) {",
    with: "if (isMerged && false) {",
  },
  {
    id: "C-PUL-33",
    match: "!isCommitId(mergeSha)",
    with: 'typeof mergeSha !== "string"',
    untyped: true,
  },
  {
    id: "C-PUL-34",
    match: "!isCommitId(mergeSha)",
    with: "mergeSha === undefined",
    untyped: true,
  },
  { id: "C-PUL-35", match: "merged: isMerged,", with: "merged: true," },
  {
    id: "C-PUL-36",
    match: "mergeCommit: landed,",
    with: "mergeCommit: headSha,",
  },
  {
    id: "C-PUL-37",
    match: "const isMerged = json.merged;",
    with: "const isMerged = json.merged_at !== null;",
  },
  {
    id: "C-PUL-38",
    match: "const mergeSha = json.merge_commit_sha;",
    with: "const mergeSha = headSha;",
  },
];

const reviews: Omit<ConjunctMutant, "table">[] = [
  // readReviews, seen through reviews().
  {
    id: "C-REV-01",
    match: 'if (!isRecord(entry)) return unreadable("a review is no object");',
    with: "if (!isRecord(entry)) continue;",
  },
  {
    id: "C-REV-02",
    match: 'return unreadable("a review has no state");',
    with: "continue;",
  },
  {
    id: "C-REV-03",
    match: 'if (state === "PENDING") continue;',
    with: 'if (state === "PENDING_") continue;',
  },
  {
    id: "C-REV-04",
    match: 'if (state === "PENDING") continue;',
    with: 'if (state === "PENDING") break;',
  },
  {
    id: "C-REV-05",
    match: 'if (state === "PENDING") continue;',
    with: 'if (state === "PENDING") break;',
  },
  {
    id: "C-REV-06",
    match: 'if (state === "PENDING") continue;',
    with: 'if (state === "PENDING" && isRecord(entry.user)) continue;',
  },
  {
    id: "C-REV-07",
    match: "!(REVIEW_STATES as readonly string[]).includes(state)",
    with: '(!(REVIEW_STATES as readonly string[]).includes(state) && state === "never")',
  },
  {
    id: "C-REV-08",
    match: "const login = isRecord(user) ? user.login : undefined;",
    with: "const login = isRecord(user) ? user.login : user;",
  },
  {
    id: "C-REV-09",
    match: "!isLogin(login)",
    with: 'typeof login !== "string"',
  },
  {
    id: "C-REV-10",
    match: "if (!isCommitId(commit)) {",
    with: 'if (typeof commit !== "string") {',
  },
  {
    id: "C-REV-11",
    match: "const submittedAt = entry.submitted_at;",
    with: 'const submittedAt = typeof entry.submitted_at === "number" ? "2024-05-01T10:00:00Z" : entry.submitted_at;',
  },
  {
    id: "C-REV-12",
    match: "instantOf(submittedAt) === null",
    with: "(instantOf(submittedAt) === null && false)",
  },
  { id: "C-REV-13", match: "reviews.push({", with: "reviews.unshift({" },
  {
    id: "C-REV-14",
    match: 'return unreadable("a review has an unknown state");',
    with: "continue;",
  },
  {
    id: "C-REV-15",
    match: "      if (!read.ok) throw read.error;",
    with: "      if (!read.ok) return [];",
  },
  {
    id: "C-REV-16",
    match:
      'if (!listing.ok) return unreadable("more pages than the page cap");',
    with: "if (!listing.ok) return { ok: true, reviews: [] };",
  },
  {
    id: "C-REV-17",
    match: "for (const entry of listing.items) {",
    after: "const reviews: HostReview[] = [];",
    with: "for (const entry of listing.items.slice(0, 1)) {",
  },
  {
    id: "C-REV-18",
    match: "for (const entry of listing.items) {",
    after: "const reviews: HostReview[] = [];",
    with: "for (const entry of listing.items.slice(-1)) {",
  },
  {
    id: "C-REV-19",
    match: "for (const entry of listing.items) {",
    after: "const reviews: HostReview[] = [];",
    with: "for (const entry of [listing.items[0], listing.items.at(-1)]) {",
  },
  // list.
  {
    id: "C-LST-01",
    match: '        throw failure(path, 200, "not a list");',
    with: "        return { ok: true, items };",
  },
  {
    id: "C-LST-02",
    match: "for (const item of answer.json) items.push(item);",
    with: "for (const item of answer.json) items.unshift(item);",
  },
  {
    id: "C-LST-03",
    match: "hasNext(answer.link ?? null, path, page) ||",
    with: "(hasNext(answer.link ?? null, path, page) && false) ||",
  },
  {
    id: "C-LST-04",
    match: "answer.json.length >= GITHUB_PAGE_SIZE;",
    with: "answer.json.length > GITHUB_PAGE_SIZE;",
  },
  {
    id: "C-LST-05",
    match: "answer.json.length >= GITHUB_PAGE_SIZE;",
    with: "answer.json.length >= GITHUB_PAGE_SIZE - 1;",
  },
  {
    id: "C-LST-06",
    match: "if (!more) return { ok: true, items };",
    with: "if (!more && page > 1) return { ok: true, items };",
  },
  {
    id: "C-LST-07",
    match: "page >= GITHUB_MAX_PAGES",
    with: "page >= GITHUB_MAX_PAGES - 1",
  },
  {
    id: "C-LST-08",
    match: "page >= GITHUB_MAX_PAGES",
    with: "page >= Infinity",
  },
  {
    id: "C-LST-09",
    match: "for (let page = 1; ; page += 1) {",
    with: "for (let page = 1; ; page += 2) {",
  },
  {
    id: "C-LST-10",
    match: "for (const item of answer.json) items.push(item);",
    with: "for (const item of answer.json.slice(0, 1)) items.push(item);",
  },
  {
    id: "C-LST-11",
    match: "for (const item of answer.json) items.push(item);",
    with: "for (const item of answer.json.slice(-1)) items.push(item);",
  },
  // nextTarget: the entries of a Link header and their parameters.
  {
    id: "C-LNK-01",
    match: "if (header === null) return null;",
    with: "if (header === null) return undefined;",
  },
  {
    id: "C-LNK-02",
    match: "if (m === null) return undefined;",
    with: "if (m === null) return null;",
  },
  {
    id: "C-LNK-03",
    match: "if (m === null) return undefined;",
    with: "if (m === null) break;",
  },
  {
    id: "C-LNK-04",
    match: "while (entry.lastIndex < header.length) {",
    with: "while (entry.lastIndex === 0) {",
  },
  {
    id: "C-LNK-05",
    match: 'if (!names.includes("next")) continue;',
    with: 'if (!names.includes("next")) { next = null; continue; }',
  },
  {
    id: "C-LNK-06",
    match: 'if (!names.includes("next")) continue;',
    with: 'if (!names.includes("next")) break;',
  },
  {
    id: "C-LNK-07",
    match: "if (next !== null) return undefined;",
    with: "if (next !== null) continue;",
  },
  {
    id: "C-LNK-08",
    match: "if (next !== null) return undefined;",
    with: "if (next !== null) next = null;",
  },
  { id: "C-LNK-09", match: "].find(", with: "].reverse().find(" },
  { id: "C-LNK-10", match: "].find(", with: "].reverse().find(" },
  {
    id: "C-LNK-11",
    match: 'param[1]!.toLowerCase() === "rel"',
    with: 'param[1]! === "rel"',
  },
  {
    id: "C-LNK-12",
    match: 'param[1]!.toLowerCase() === "rel"',
    with: 'param[1]!.toLowerCase().startsWith("re")',
  },
  {
    id: "C-LNK-13",
    match: 'param[1]!.toLowerCase() === "rel"',
    with: '(param[1]!.toLowerCase() === "rel" || true)',
  },
  {
    id: "C-LNK-14",
    match: '(rel?.[2] ?? rel?.[3] ?? "")',
    with: '(rel?.[3] ?? "")',
  },
  {
    id: "C-LNK-15",
    match: '(rel?.[2] ?? rel?.[3] ?? "")',
    with: '(rel?.[2] ?? "")',
  },
  { id: "C-LNK-16", match: raw`"([^"]*)"|`, with: "" },
  {
    id: "C-LNK-17",
    match: raw`.toLowerCase().split(/\s+/)`,
    with: raw`.split(/\s+/)`,
  },
  {
    id: "C-LNK-18",
    match: '!names.includes("next")',
    with: 'names[0] !== "next"',
  },
  {
    id: "C-LNK-19",
    match: '!names.includes("next")',
    with: 'names.at(-1) !== "next"',
  },
  { id: "C-LNK-20", match: raw`.split(/\s+/)`, with: ".split(/,/)" },
  {
    id: "C-LNK-21",
    match: raw`/\s*<([^<>]*)>(`,
    with: raw`/\s*<?([^<>]*)>?(`,
  },
  {
    id: "C-LNK-22",
    match: raw`[A-Za-z*]+\s*=\s*(?:"[^"]*"|[^",;\s]+))*)`,
    with: raw`[A-Za-z*]+(?:\s*=\s*(?:"[^"]*"|[^",;\s]+))?)*)`,
  },
  {
    id: "C-LNK-23",
    match: raw`\s*(?:,|$)/y;`,
    with: raw`\s*(?:,|$)?/y;`,
  },
  {
    id: "C-LNK-24",
    match: '(rel?.[2] ?? rel?.[3] ?? "")',
    with: '(rel?.[2] ?? rel?.[3] ?? "next")',
  },
  // hasNext: what a next link must be before a further page is asked for.
  {
    id: "C-NXT-01",
    match: "if (target === null) return false;",
    with: "if (target === null) return true;",
  },
  {
    id: "C-NXT-02",
    match: "url = new URL(target)",
    with: "url = new URL(target, root)",
  },
  {
    id: "C-NXT-03",
    match: "if (target === null) return false;",
    with: "if (target === null || target === undefined) return false;",
  },
  {
    id: "C-NXT-04",
    match: "url.origin !== api.origin ||",
    with: "(url.origin !== api.origin && false) ||",
  },
  {
    id: "C-NXT-05",
    match: '      url.username !== "" ||',
    with: '      (url.username !== "" && false) ||',
  },
  {
    id: "C-NXT-06",
    match: '      url.password !== ""',
    with: '      (url.password !== "" && false)',
  },
  {
    id: "C-NXT-07",
    match: "url.pathname.startsWith(`${prefix}/`) && ",
    with: "",
  },
  { id: "C-NXT-08", match: " && url.pathname.endsWith(tail)", with: "" },
  {
    id: "C-NXT-09",
    match: "(asciiLower(below) === asciiLower(repoPath) ||",
    with: '(below.startsWith("/repos/") ||',
  },
  {
    id: "C-NXT-10",
    match: "asciiLower(below) === asciiLower(repoPath)",
    with: "below === repoPath",
  },
  {
    id: "C-NXT-11",
    match: "REPOSITORY_ID_PATH_RE.test(below)",
    with: "(REPOSITORY_ID_PATH_RE.test(below) && false)",
  },
  {
    id: "C-NXT-12",
    match: raw`/^\/repositories\/[1-9][0-9]*$/`,
    with: raw`/^\/repositories\//`,
  },
  { id: "C-NXT-13", match: "pages.length !== 1 ||", with: "false ||" },
  {
    id: "C-NXT-14",
    match: "pages[0] !== String(page + 1)",
    with: "(pages[0] !== String(page + 1) && false)",
  },
  {
    id: "C-NXT-15",
    match: "pages[0] !== String(page + 1)",
    with: "Number(pages[0]) > page + 1",
  },
  {
    id: "C-NXT-16",
    match: "url.origin !== api.origin ||",
    with: "(page === 1 && url.origin !== api.origin) ||",
  },
  // Conjuncts a look at single lines does not show: the order of two
  // operands, the case of a constant.
  {
    id: "C-LST-12",
    match: "hasNext(answer.link ?? null, path, page) ||",
    with: "(answer.json.length < GITHUB_PAGE_SIZE && hasNext(answer.link ?? null, path, page)) ||",
  },
  {
    id: "C-REV-20",
    match: 'if (state === "PENDING") continue;',
    with: 'if (state.toUpperCase() === "PENDING") continue;',
  },
  {
    id: "C-REV-21",
    match: ".includes(state)) {",
    with: ".includes(state.toUpperCase())) {",
  },
  // instantOf: which text names an instant.
  {
    id: "C-TIM-01",
    match: "if (m === null) return null;",
    after: "const m = TIME_RE.exec(text);",
    with: "if (m === null) return Date.parse(text);",
  },
  {
    id: "C-TIM-02",
    match: "if (back.some((value, i) => value !== written[i])) return null;",
    with: "if (back.some((value, i) => value !== written[i]) && false) return null;",
  },
  {
    id: "C-TIM-03",
    match: "return Number.isFinite(at) ? at : null;",
    with: "return at;",
  },
  {
    id: "C-TIM-04",
    match: raw`(Z|[+-]\d{2}:\d{2})$/;`,
    with: raw`(Z|[+-]\d{2}:\d{2})?$/;`,
  },
  {
    id: "C-TIM-05",
    match: raw`(\.\d{1,9})?(Z|`,
    with: raw`(Z|`,
  },
  {
    id: "C-TIM-06",
    match: raw`/^(\d{4})-(\d{2})-(\d{2})T`,
    with: raw`/^(\d{4})-(\d{2})-(\d{2})[T ]`,
  },
  {
    id: "C-TIM-07",
    match: raw`(Z|[+-]\d{2}:\d{2})$/;`,
    with: raw`(Z|[+-]\d{2}:\d{2})$/i;`,
  },
  {
    id: "C-TIM-08",
    match: "back.some((value, i) => value !== written[i])",
    with: "back.slice(3).some((value, i) => value !== written[i + 3])",
  },
  {
    id: "C-TIM-09",
    match: raw`(\.\d{1,9})?(Z|`,
    with: raw`(\.\d{1,10})?(Z|`,
  },
  {
    id: "C-TIM-10",
    match: "if (back.some((value, i) => value !== written[i])) return null;",
    with: "if (back.some((value, i) => value !== written[i]) && false) return null;",
  },
  {
    id: "C-NXT-17",
    match: "below !== null &&",
    with: "true &&",
    untyped: true,
  },
  {
    id: "C-NXT-18",
    match: "const target = nextTarget(link);",
    with: "const target = nextTarget(null);",
    untyped: true,
  },
  {
    id: "C-LST-13",
    match: "hasNext(answer.link ?? null, path, page) ||",
    with: "hasNext(answer.link ?? null, repoPath, page) ||",
  },
  {
    id: "C-LST-14",
    match: "hasNext(answer.link ?? null, path, page) ||",
    with: "hasNext(answer.link ?? null, path, 1) ||",
  },
  {
    id: "C-REV-22",
    match: 'typeof submittedAt !== "string" || instantOf(submittedAt) === null',
    with: "instantOf(submittedAt as string) === null",
    untyped: true,
  },
  {
    id: "C-REV-23",
    match: "const login = isRecord(user) ? user.login : undefined;",
    with: "const login = (user as { login?: unknown }).login;",
  },
  {
    id: "C-REV-24",
    match: "const read = await readReviews(pullNumber);",
    with: "const read = await readReviews(7);",
  },
  {
    id: "C-LNK-25",
    match: raw`/\s*<([^<>]*)>(`,
    with: raw`/\s*<([^>]*)>(`,
  },
  {
    id: "C-LNK-26",
    match: raw`/\s*<([^<>]*)>(`,
    with: raw`/\s*<([^<]*)>(`,
  },
  {
    id: "C-LNK-27",
    match: raw`[A-Za-z*]+\s*=\s*(?:"[^"]*"|`,
    with: raw`[A-Za-z*]*\s*=\s*(?:"[^"]*"|`,
  },
  {
    id: "C-LNK-28",
    match: raw`[^",;\s]+))*)`,
    with: raw`[^",;\s]*))*)`,
  },
  {
    id: "C-LNK-29",
    match: raw`[^",;\s]+))*)`,
    with: raw`[^,;\s]+))*)`,
  },
  {
    id: "C-LNK-30",
    match: raw`[^",;\s]+))*)`,
    with: raw`[^";\s]+))*)`,
  },
  {
    id: "C-LNK-31",
    match: raw`[^",;\s]+))*)`,
    with: raw`[^",\s]+))*)`,
  },
  {
    id: "C-LNK-32",
    match: raw`[^",;\s]+))*)`,
    with: raw`[^",;]+))*)`,
  },
  {
    id: "C-LNK-33",
    match: raw`([^",;\s]+))/g;`,
    with: raw`([^",\s]+))/g;`,
  },
  {
    id: "C-LNK-34",
    match: raw`;\s*([A-Za-z*]+)\s*=`,
    with: raw`;\s*([A-Za-z* ]+)\s*=`,
  },
  {
    id: "C-LNK-35",
    match: raw`\s*;\s*[A-Za-z*]+\s*=`,
    with: raw`\s*;\s*[A-Za-z*%]+\s*=`,
  },
  {
    id: "C-NXT-19",
    match: raw`[1-9][0-9]*$/;`,
    with: raw`[1-9][0-9]*$/i;`,
  },
  {
    id: "C-NXT-20",
    match: raw`/^\/repositories\/[1-9]`,
    with: raw`/\/repositories\/[1-9]`,
  },
  {
    id: "C-NXT-21",
    match: "url.pathname.startsWith(`${prefix}/`)",
    with: "url.pathname.includes(`${prefix}/`)",
  },
  {
    id: "C-NXT-22",
    match: raw`url.pathname.endsWith(tail)`,
    with: raw`url.pathname.includes(tail)`,
  },
  {
    id: "C-NXT-23",
    match: raw`[1-9][0-9]*$/;`,
    with: raw`[1-9][0-9%]*$/;`,
  },
  {
    id: "C-LST-15",
    match: "        path,",
    after: "for (let page = 1; ; page += 1) {",
    with: '        "/x",',
  },
];

const enforcement: Omit<ConjunctMutant, "table">[] = [
  // rulesetEvidence.
  {
    id: "C-RUL-01",
    match: "const listing = await list(path, [403, 404]);",
    with: "const listing = await list(path, [404]);",
  },
  {
    id: "C-RUL-02",
    match: "const listing = await list(path, [403, 404]);",
    with: "const listing = await list(path, [403]);",
  },
  {
    id: "C-RUL-03",
    match: "const listing = await list(path, [403, 404]);",
    with: "const listing = await list(path, [403, 404, 401]);",
  },
  {
    id: "C-RUL-04",
    match: 'if (!listing.ok) return "unreadable";',
    with: 'if (!listing.ok) return "none";',
  },
  {
    id: "C-RUL-05",
    match: 'if (!listing.ok) return "unreadable";',
    with: 'if (!listing.ok) return "requires";',
  },
  {
    id: "C-RUL-06",
    match: "let requires = false;",
    with: "let requires = true;",
  },
  {
    id: "C-RUL-07",
    match: "for (const rule of listing.items) {",
    with: "for (const rule of listing.items.slice(0, 1)) {",
  },
  {
    id: "C-RUL-08",
    match: "for (const rule of listing.items) {",
    with: "for (const rule of listing.items.slice(-1)) {",
  },
  {
    id: "C-RUL-09",
    match: "for (const rule of listing.items) {",
    with: "for (const rule of [listing.items[0], listing.items.at(-1)]) {",
  },
  {
    id: "C-RUL-10",
    match:
      'if (!isRecord(rule)) throw failure(path, 200, "a rule is no object");',
    with: "if (!isRecord(rule)) continue;",
  },
  {
    id: "C-RUL-11",
    match: 'throw failure(path, 200, "a rule has no type");',
    with: "continue;",
    covers: 'if (typeof type !== "string") {',
  },
  {
    id: "C-RUL-12",
    match: 'if (type !== "pull_request") continue;',
    with: 'if (type !== "pull_request" && false) continue;',
  },
  {
    id: "C-RUL-13",
    match: 'if (type !== "pull_request") continue;',
    with: 'if (type !== "pull_request") break;',
  },
  {
    id: "C-RUL-14",
    match: 'type !== "pull_request"',
    with: 'type.toLowerCase() !== "pull_request"',
  },
  {
    id: "C-RUL-15",
    match: "if (parameters === undefined) continue;",
    with: "if (parameters === null) continue;",
  },
  {
    id: "C-RUL-16",
    match: "if (parameters === undefined) continue;",
    with: "if (parameters === undefined) break;",
  },
  {
    id: "C-RUL-17",
    match: "        : undefined;",
    with: "        : 0;",
    covers: "const count = isRecord(parameters)",
  },
  {
    id: "C-RUL-18",
    match: "!Number.isSafeInteger(count)",
    after: "? parameters.required_approving_review_count",
    with: "(!Number.isSafeInteger(count) && false)",
  },
  {
    id: "C-RUL-19",
    match: "if (count >= 1) requires = true;",
    with: "if (count >= 0) requires = true;",
  },
  {
    id: "C-RUL-20",
    match: "if (count >= 1) requires = true;",
    with: "if (count > 1) requires = true;",
  },
  {
    id: "C-RUL-21",
    match: "if (count >= 1) requires = true;",
    with: "requires = count >= 1;",
  },
  {
    id: "C-RUL-22",
    match: "if (count >= 1) requires = true;",
    with: 'if (count >= 1) return "requires";',
  },
  {
    id: "C-RUL-23",
    match: 'return requires ? "requires" : "none";',
    with: 'return requires ? "none" : "requires";',
  },
  {
    id: "C-RUL-24",
    match: "const path = `${repoPath}/rules/branches/${branch}`;",
    with: "const path = `${repoPath}/rules/branches/main`;",
    untyped: true,
  },
  // protectionEvidence.
  {
    id: "C-PRT-01",
    match: 'const answer = await get(path, "", [403, 404]);',
    with: 'const answer = await get(path, "", [404]);',
  },
  {
    id: "C-PRT-02",
    match: 'const answer = await get(path, "", [403, 404]);',
    with: 'const answer = await get(path, "", [403]);',
  },
  {
    id: "C-PRT-03",
    match: 'const answer = await get(path, "", [403, 404]);',
    with: 'const answer = await get(path, "", [403, 404, 401]);',
  },
  {
    id: "C-PRT-04",
    match: 'if (answer.status !== 200) return "unreadable";',
    with: 'if (answer.status !== 200) return "none";',
  },
  {
    id: "C-PRT-05",
    match: 'if (answer.status !== 200) return "unreadable";',
    with: 'if (answer.status !== 200) return "requires";',
  },
  {
    id: "C-PRT-06",
    match:
      'if (!isRecord(answer.json)) throw failure(path, 200, "not an object");',
    with: 'if (!isRecord(answer.json)) return "none";',
  },
  {
    id: "C-PRT-07",
    match: "reviews === undefined ||",
    with: "false ||",
  },
  { id: "C-PRT-08", match: " || reviews === null", with: "" },
  {
    id: "C-PRT-09",
    match: 'if (reviews === undefined || reviews === null) return "none";',
    with: 'if (reviews === undefined || reviews === null) return "requires";',
  },
  {
    id: "C-PRT-10",
    match: 'throw failure(path, 200, "the review settings are no object");',
    with: 'return "none";',
    covers: "if (!isRecord(reviews)) {",
  },
  {
    id: "C-PRT-11",
    match: 'if (count === undefined) return "none";',
    with: 'if (count === null) return "none";',
  },
  {
    id: "C-PRT-12",
    match: 'if (count === undefined) return "none";',
    with: 'if (count === undefined) return "requires";',
  },
  {
    id: "C-PRT-13",
    match: "!Number.isSafeInteger(count)",
    after: "const count = reviews.required_approving_review_count;",
    with: "(!Number.isSafeInteger(count) && false)",
  },
  {
    id: "C-PRT-14",
    match: 'return count >= 1 ? "requires" : "none";',
    with: 'return count >= 0 ? "requires" : "none";',
  },
  {
    id: "C-PRT-15",
    match: 'return count >= 1 ? "requires" : "none";',
    with: 'return count > 1 ? "requires" : "none";',
  },
  {
    id: "C-PRT-16",
    match: "const path = `${repoPath}/branches/${branch}/protection`;",
    with: "const path = `${repoPath}/branches/main/protection`;",
    untyped: true,
  },
  // readEnforcement and reviewEnforcement.
  {
    id: "C-ENF-01",
    match: "await rulesetEvidence(branch)",
    with: 'await rulesetEvidence("main")',
  },
  {
    id: "C-ENF-02",
    match: "await protectionEvidence(branch)",
    with: 'await protectionEvidence("main")',
  },
  {
    id: "C-ENF-03",
    match: 'if (rulesets === "requires") return "enforced";',
    with: 'if (rulesets === "requires" && false) return "enforced";',
  },
  {
    id: "C-ENF-04",
    match: "const rulesets = await rulesetEvidence(branch);",
    with: "const [rulesets] = [await rulesetEvidence(branch), await protectionEvidence(branch)];",
  },
  {
    id: "C-ENF-05",
    match: 'if (protection === "requires") return "enforced";',
    with: 'if (protection === "requires" && false) return "enforced";',
  },
  {
    id: "C-ENF-06",
    match: 'rulesets === "none" &&',
    with: "true &&",
  },
  {
    id: "C-ENF-07",
    match: '&& protection === "none"',
    with: "&& true",
  },
  {
    id: "C-ENF-08",
    match: 'rulesets === "none" && protection === "none"',
    with: 'rulesets === "none" || protection === "none"',
  },
  {
    id: "C-ENF-09",
    match: '? "not-enforced"',
    with: '? "unknown"',
  },
  {
    id: "C-ENF-10",
    match: ': "unknown";',
    after: '? "not-enforced"',
    with: ': "not-enforced";',
  },
  {
    id: "C-ENF-11",
    match: "!(REVIEW_PATHS as readonly unknown[]).includes(path)",
    with: "(!(REVIEW_PATHS as readonly unknown[]).includes(path) && false)",
  },
  {
    id: "C-ENF-12",
    match: "!(REVIEW_PATHS as readonly unknown[]).includes(path)",
    with: 'path !== "specs/"',
    untyped: true,
  },
  {
    id: "C-ENF-13",
    match: "enforcementOnce ??= readEnforcement()",
    with: "(enforcementOnce && false) || (enforcementOnce = readEnforcement())",
  },
  {
    id: "C-ENF-14",
    match: 'if (rulesets === "requires") return "enforced";',
    with: 'if (rulesets === "requires") return "not-enforced";',
  },
  {
    id: "C-ENF-15",
    match: 'if (protection === "requires") return "enforced";',
    with: 'if (protection === "requires") return "unknown";',
  },
  {
    id: "C-RUL-25",
    match: "const count = isRecord(parameters)",
    with: "const count = parameters !== undefined",
    covers: "? parameters.required_approving_review_count",
    untyped: true,
  },
  {
    id: "C-RUL-26",
    match: "        mapped,",
    with: "        [],",
    untyped: true,
  },
];

const configCommit: Omit<ConjunctMutant, "table">[] = [
  // lastConfigCommit: the commit and the facts an approval is tied to.
  {
    id: "C-CFG-01",
    match: 'if (!Array.isArray(json)) throw failure(path, 200, "not a list");',
    with: "if (!Array.isArray(json)) return { commit: null, approver: null };",
  },
  { id: "C-CFG-02", match: "json.length === 0", with: "json.length < 0" },
  {
    id: "C-CFG-03",
    match: "const first: unknown = json[0];",
    with: "const first: unknown = json.at(-1);",
  },
  {
    id: "C-CFG-04",
    match: 'if (!isCommitId(commit)) throw failure(path, 200, "no commit id");',
    with: 'if (typeof commit !== "string") throw failure(path, 200, "no commit id");',
  },
  {
    id: "C-CFG-05",
    match: "isRecord(first) ? first.sha : undefined",
    with: "isRecord(first) ? first.sha : first",
  },
  {
    id: "C-CFG-06",
    match: "if (merged === null) return { commit, approver: null };",
    with: 'if (merged === null) return { commit, approver: "nobody" };',
  },
  {
    id: "C-CFG-07",
    match: "if (merged === null) return { commit, approver: null };",
    with: "if (merged === null) return { commit: null, approver: null };",
  },
  {
    id: "C-CFG-08",
    match: "!isCommitId(merged.head)",
    with: 'typeof merged.head !== "string"',
  },
  {
    id: "C-CFG-09",
    match: "head: isRecord(head) ? head.sha : undefined,",
    with: "head: isRecord(head) ? head.sha : commit,",
  },
  {
    id: "C-CFG-10",
    match: "instantOf(merged.mergedAt)",
    with: "(instantOf(merged.mergedAt) ?? Infinity)",
  },
  {
    id: "C-CFG-11",
    match: "if (!read.ok) return { commit, approver: null };",
    with: "if (!read.ok) throw read.error;",
  },
  {
    id: "C-CFG-12",
    match: "if (!read.ok) return { commit, approver: null };",
    with: "if (!read.ok) return { commit: null, approver: null };",
  },
  {
    id: "C-CFG-13",
    match: 'const listing = await list(path, [], "report");',
    with: 'const listing = await list(path, [500], "report");',
  },
  {
    id: "C-CFG-14",
    match: 'pastCap === "report"',
    with: '(pastCap === "report" && false)',
  },
  // mergedPullOf: which pull request brought the commit in.
  {
    id: "C-MRG-01",
    match: "        mergedAt !== null &&",
    with: "        (mergedAt !== null || true) &&",
    also: [
      {
        match: "          mergedAt,",
        with: '          mergedAt: mergedAt ?? "2024-05-01T11:00:00Z",',
      },
    ],
  },
  {
    id: "C-MRG-02",
    match: "mergeCommit === commit &&",
    with: "(mergeCommit === commit || true) &&",
  },
  {
    id: "C-MRG-03",
    match: "baseRef === branch &&",
    with: "(baseRef === branch || true) &&",
  },
  {
    id: "C-MRG-04",
    match: "        sameRepository(baseRepo.full_name)",
    with: "        (sameRepository(baseRepo.full_name) || true)",
  },
  {
    id: "C-MRG-05",
    match: "merged.length === 1",
    with: "merged.length >= 1",
  },
  {
    id: "C-MRG-06",
    match: "for (const entry of listing.items) {",
    after:
      "const merged: { number: number; head: unknown; mergedAt: string }[] = [];",
    with: "for (const entry of listing.items.slice(-1)) {",
  },
  {
    id: "C-MRG-07",
    match: "for (const entry of listing.items) {",
    after:
      "const merged: { number: number; head: unknown; mergedAt: string }[] = [];",
    with: "for (const entry of listing.items.slice(0, 1)) {",
  },
  {
    id: "C-MRG-08",
    match: "for (const entry of listing.items) {",
    after:
      "const merged: { number: number; head: unknown; mergedAt: string }[] = [];",
    with: "for (const entry of [listing.items[0], listing.items.at(-1)]) {",
  },
  {
    id: "C-MRG-09",
    match: 'throw failure(path, 200, "a pull request is no object");',
    with: "continue;",
  },
  {
    id: "C-MRG-10",
    match: 'pastCap === "report"',
    with: '(pastCap === "report" || true)',
  },
  {
    id: "C-MRG-11",
    match: "const number = entry.number;",
    with: 'const number = typeof entry.number === "string" ? Number(entry.number) : entry.number;',
    covers: 'typeof number !== "number" ||',
  },
  {
    id: "C-MRG-12",
    match: "!Number.isSafeInteger(number) ||",
    with: "(!Number.isSafeInteger(number) && false) ||",
  },
  { id: "C-MRG-13", match: "number < 1 ||", with: "number < 0 ||" },
  {
    id: "C-MRG-14",
    match: "const mergedAt = entry.merged_at;",
    with: "const mergedAt = entry.merged_at === true ? null : entry.merged_at;",
  },
  {
    id: "C-MRG-15",
    match: 'typeof mergeCommit !== "string"',
    with: '(typeof mergeCommit !== "string" && false)',
  },
  {
    id: "C-MRG-16",
    match: 'typeof baseRef !== "string" ||',
    with: '(typeof baseRef !== "string" && false) ||',
  },
  {
    id: "C-MRG-17",
    match: "const baseRepo = isRecord(base) ? base.repo : undefined;",
    after: "const mergeCommit = entry.merge_commit_sha;",
    with: 'const baseRepo = isRecord(base) ? (base.repo ?? { full_name: "" }) : undefined;',
    covers: "        !isRecord(baseRepo) ||",
  },
  {
    id: "C-MRG-18",
    match: 'typeof baseRepo.full_name !== "string"',
    with: '(typeof baseRepo.full_name !== "string" && false)',
  },
  {
    id: "C-MRG-19",
    match: "const baseRef = isRecord(base) ? base.ref : undefined;",
    after: "const mergeCommit = entry.merge_commit_sha;",
    with: 'const baseRef = isRecord(base) ? base.ref : "";',
    also: [
      {
        match: "const baseRepo = isRecord(base) ? base.repo : undefined;",
        after: "const mergeCommit = entry.merge_commit_sha;",
        with: 'const baseRepo = isRecord(base) ? base.repo : { full_name: "" };',
      },
    ],
  },
  {
    id: "C-MRG-20",
    match: '(mergedAt !== null && typeof mergedAt !== "string") ||',
    with: 'typeof mergedAt !== "string" ||',
  },
  {
    id: "C-MRG-21",
    match: '(mergeCommit !== null && typeof mergeCommit !== "string") ||',
    with: 'typeof mergeCommit !== "string" ||',
  },
  {
    id: "C-MRG-22",
    match: "merged.length === 1",
    with: "merged.length <= 1",
  },
  // latestApprover: which approval of the merged pull request counts.
  {
    id: "C-APP-01",
    match: "review.at <= mergedAt",
    with: "(review.at <= mergedAt || true)",
  },
  {
    id: "C-APP-02",
    match: "review.at <= mergedAt",
    with: "review.at < mergedAt",
  },
  {
    id: "C-APP-03",
    match: "review.at <= mergedAt",
    with: '(review.at <= mergedAt || review.state !== "APPROVED")',
  },
  {
    id: "C-APP-04",
    match: ".filter((review) => review.at <= mergedAt);",
    with: ".filter((review, i, all) => i < all.length - 1 || review.at <= mergedAt);",
  },
  {
    id: "C-APP-05",
    match: ".filter((review) => review.at <= mergedAt);",
    with: ".filter((review, i, all) => i === all.length - 1 || review.at <= mergedAt);",
  },
  {
    id: "C-APP-06",
    match: ".filter((review) => review.at <= mergedAt);",
    with: ".filter((review, i, all) => (i > 0 && i < all.length - 1) || review.at <= mergedAt);",
  },
  {
    id: "C-APP-07",
    match: "for (const approval of standingApprovals(timed)) {",
    with: 'for (const approval of [...standingApprovals(timed).slice(0, 0), ...timed.filter((r) => r.state === "APPROVED")]) {',
  },
  {
    id: "C-APP-08",
    match: "if (approval.commit !== head) continue;",
    with: "if (approval.commit !== head && false) continue;",
  },
  {
    id: "C-APP-09",
    match: "if (approval.commit !== head) continue;",
    with: "if (approval.commit !== head) break;",
  },
  {
    id: "C-APP-10",
    match: "if (approval.commit !== head) continue;",
    with: "if (approval.commit !== head) break;",
  },
  {
    id: "C-APP-11",
    match: "if (approval.commit !== head) continue;",
    with: "if (approval.commit !== head && false) continue;",
  },
  {
    id: "C-APP-12",
    match: "approval.commit !== head",
    with: '!timed.some((r) => r.login === approval.login && r.state === "APPROVED" && r.commit === head)',
  },
  {
    id: "C-APP-13",
    match: " && r.login === approval.login",
    with: " && true",
  },
  { id: "C-APP-14", match: "at > best.at", with: "at < best.at" },
  { id: "C-APP-15", match: "at > best.at", with: "at < best.at" },
  { id: "C-APP-16", match: "at > best.at", with: "at < best.at" },
  {
    id: "C-APP-17",
    match: 'r.state === "APPROVED" &&',
    with: "true &&",
  },
  {
    id: "C-APP-18",
    match: "Math.max(max, r.at), -Infinity",
    with: "Math.min(max, r.at), Infinity",
  },
  { id: "C-APP-19", match: "at > best.at", with: "at >= best.at" },
  {
    id: "C-APP-20",
    match: "standingApprovals(timed)) {",
    with: "standingApprovals(timed).reverse()) {",
  },
  {
    id: "C-APP-21",
    match: "return best?.login ?? null;",
    with: 'return best?.login ?? "nobody";',
  },
  {
    id: "C-APP-22",
    match: "best === null || at > best.at",
    with: "best !== null && at > best.at",
  },
  {
    id: "C-APP-23",
    match: "standingApprovals(timed)) {",
    with: "standingApprovals(timed).slice(0, 1)) {",
  },
  {
    id: "C-APP-24",
    match: "standingApprovals(timed)) {",
    with: "standingApprovals(timed).slice(-1)) {",
  },
  // lastConfigCommit: the values it hands on select what is read.
  {
    id: "C-CFG-15",
    match: "mergedPullOf(commit, branch)",
    with: 'mergedPullOf(commit, "main")',
  },
  {
    id: "C-CFG-16",
    match: "mergedPullOf(commit, branch)",
    with: 'mergedPullOf(commit, "main")',
  },
  {
    id: "C-CFG-17",
    match: "mergedPullOf(commit, branch)",
    with: 'mergedPullOf("c".repeat(40), branch)',
  },
  {
    id: "C-CFG-18",
    match: "readReviews(merged.number)",
    with: "readReviews(3)",
  },
  {
    id: "C-CFG-19",
    match: "latestApprover(read.reviews, merged.head, mergedAt)",
    with: 'latestApprover(read.reviews, "d".repeat(40), mergedAt)',
  },
  {
    id: "C-CFG-20",
    match: "latestApprover(read.reviews, merged.head, mergedAt)",
    with: "latestApprover(read.reviews, merged.head, Infinity)",
  },
  {
    id: "C-CFG-21",
    match: "`?sha=${encodeURIComponent(branch)}&path=.spec-gate&per_page=1`,",
    with: "`?sha=${branch}&path=.spec-gate&per_page=1`,",
  },
  {
    id: "C-CFG-22",
    match: "`?sha=${encodeURIComponent(branch)}&path=.spec-gate&per_page=1`,",
    with: "`?sha=main&path=.spec-gate&per_page=1`,",
  },
  {
    id: "C-CFG-23",
    match: "`?sha=${encodeURIComponent(branch)}&path=.spec-gate&per_page=1`,",
    with: "`?sha=${encodeURIComponent(branch)}&per_page=1`,",
  },
  {
    id: "C-CFG-24",
    match: "const path = `${repoPath}/commits/${commit}/pulls`;",
    with: 'const path = `${repoPath}/commits/${"c".repeat(40)}/pulls`;',
  },
  {
    id: "C-CFG-25",
    match: "const path = `${repoPath}/pulls/${number}/reviews`;",
    with: "const path = `${repoPath}/pulls/3/reviews`;",
    untyped: true,
  },
  {
    id: "C-APP-25",
    match: "review.at <= mergedAt",
    with: "review.at <= mergedAt + 999",
  },
  {
    id: "C-MRG-23",
    match: "        !isRecord(baseRepo) ||",
    with: "        false ||",
    untyped: true,
  },
  {
    id: "C-MRG-24",
    match: '(mergedAt !== null && typeof mergedAt !== "string") ||',
    with: "false ||",
    untyped: true,
  },
  {
    id: "C-MRG-25",
    match: "const baseRef = isRecord(base) ? base.ref : undefined;",
    with: "const baseRef = (base as { ref?: unknown }).ref;",
    after: "const mergeCommit = entry.merge_commit_sha;",
  },
  {
    id: "C-MRG-26",
    match: "const baseRepo = isRecord(base) ? base.repo : undefined;",
    with: "const baseRepo = (base as { repo?: unknown }).repo;",
    after: "const mergeCommit = entry.merge_commit_sha;",
  },
  {
    id: "C-CFG-26",
    match: "latestApprover(read.reviews, merged.head, mergedAt)",
    with: "latestApprover([], merged.head, mergedAt)",
  },
  {
    id: "C-CFG-27",
    match: "const path = `${repoPath}/commits`;",
    with: "const path = `${repoPath}/commit`;",
  },
  {
    id: "C-CFG-28",
    match: "!isCommitId(merged.head) || mergedAt === null",
    with: "!isCommitId(merged.head)",
    untyped: true,
  },
  {
    id: "C-CFG-29",
    match: "head: isRecord(head) ? head.sha : undefined,",
    with: "head: (head as { sha?: unknown }).sha,",
  },
  {
    id: "C-CFG-30",
    match: "isRecord(first) ? first.sha : undefined",
    with: "(first as { sha?: unknown }).sha",
  },
  {
    id: "C-APP-26",
    match: "best === null || at > best.at",
    with: "at > best!.at",
  },
  {
    id: "C-MRG-27",
    match: raw`number < 1 ||`,
    with: raw`number <= 1 ||`,
  },
  {
    id: "C-MRG-28",
    match: raw`        mergedAt !== null &&`,
    with: raw`        true &&`,
    untyped: true,
  },
  {
    id: "C-MRG-29",
    match: "mergeCommit === commit &&",
    with: "String(mergeCommit).toLowerCase() === commit &&",
  },
  {
    id: "C-MRG-30",
    match: "baseRef === branch &&",
    with: "baseRef.toLowerCase() === branch.toLowerCase() &&",
  },
  {
    id: "C-APP-27",
    match: "standingApprovals(timed)",
    with: "standingApprovals([])",
  },
];

const ci: Omit<ConjunctMutant, "table">[] = [
  // runIdOf: which text names a run, and on which API root.
  {
    id: "C-RUN-01",
    match: 'if (typeof run !== "string") return null;',
    with: 'if (typeof run !== "string") return String(run);',
  },
  {
    id: "C-RUN-02",
    match: "if (RUN_ID_RE.test(run)) {",
    with: 'if (RUN_ID_RE.test(run) && run === "") {',
  },
  {
    id: "C-RUN-03",
    match: "if (RUN_ID_RE.test(run)) {",
    with: "if (addresses && RUN_ID_RE.test(run)) {",
  },
  {
    id: "C-RUN-04",
    match: raw`const RUN_ID_RE = /^[1-9][0-9]{0,15}$/;`,
    with: raw`const RUN_ID_RE = /^[0-9]{1,16}$/;`,
  },
  {
    id: "C-RUN-05",
    match: raw`const RUN_ID_RE = /^[1-9][0-9]{0,15}$/;`,
    with: raw`const RUN_ID_RE = /^[1-9][0-9a-z]{0,15}$/;`,
  },
  {
    id: "C-RUN-06",
    match: "Number.isSafeInteger(Number(id))",
    with: "(Number.isSafeInteger(Number(id)) || true)",
  },
  { id: "C-RUN-07", match: raw`{0,15}$/;`, with: raw`{0,15}/;` },
  {
    id: "C-RUN-08",
    match: raw`const RUN_ID_RE = /^[1-9]`,
    with: raw`const RUN_ID_RE = /[1-9]`,
  },
  {
    id: "C-RUN-09",
    match: "api.origin === GITHUB_API_URL",
    with: "(api.origin === GITHUB_API_URL && false)",
  },
  {
    id: "C-RUN-10",
    match: "addresses ? RUN_URL_RE.exec(run) : null",
    with: "(addresses || true) ? RUN_URL_RE.exec(run) : null",
  },
  {
    id: "C-RUN-11",
    match: "api.origin === GITHUB_API_URL",
    with: 'api.protocol === "https:"',
  },
  {
    id: "C-RUN-12",
    match: "api.origin === GITHUB_API_URL",
    with: "api.origin.startsWith(GITHUB_API_URL)",
  },
  {
    id: "C-RUN-13",
    match: "api.origin === GITHUB_API_URL",
    with: '(api.origin === GITHUB_API_URL || api.protocol === "http:")',
  },
  {
    id: "C-RUN-14",
    match: raw`/^https:\/\/github`,
    with: raw`/https:\/\/github`,
  },
  {
    id: "C-RUN-15",
    match: raw`([1-9][0-9]{0,15})$/;`,
    with: raw`([1-9][0-9]{0,15})/;`,
  },
  {
    id: "C-RUN-16",
    match: raw`/^https:\/\/github`,
    with: raw`/^https?:\/\/github`,
  },
  { id: "C-RUN-17", match: raw`github\.com`, with: "github.com" },
  {
    id: "C-RUN-18",
    match: "if (m === null) return null;",
    after: "const m = addresses ? RUN_URL_RE.exec(run) : null;",
    with: 'if (m === null) return "1";',
  },
  {
    id: "C-RUN-19",
    match: "!== repository) return null;",
    with: '!== repository && run === "") return null;',
  },
  {
    id: "C-RUN-20",
    match: "asciiLower(`${m[1]}/${m[2]}`) !== repository",
    with: "!repository.endsWith(`/${asciiLower(m[2]!)}`)",
  },
  {
    id: "C-RUN-21",
    match: "asciiLower(`${m[1]}/${m[2]}`) !== repository",
    with: "!repository.startsWith(`${asciiLower(m[1]!)}/`)",
  },
  {
    id: "C-RUN-22",
    match: "asciiLower(`${m[1]}/${m[2]}`)",
    with: "`${m[1]}/${m[2]}`",
  },
  // ciRunStatus: what makes a run verified.
  {
    id: "C-CI-01",
    match: 'if (!isCommitId(commit)) return "unverified";',
    with: 'if (!isCommitId(commit) && false) return "unverified";',
  },
  {
    id: "C-CI-02",
    match: 'if (id === null) return "unverified";',
    with: 'if (id === null && false) return "unverified";',
  },
  { id: "C-CI-03", match: 'get(path, "", [404])', with: 'get(path, "", [])' },
  {
    id: "C-CI-04",
    match: 'if (answer.status !== 200) return "unverified";',
    with: 'if (answer.status !== 200) return "unknown";',
  },
  {
    id: "C-CI-05",
    match: 'get(path, "", [404])',
    with: 'get(path, "", [404, 403])',
  },
  {
    id: "C-CI-06",
    match: 'if (!isRecord(json)) throw failure(path, 200, "not an object");',
    after: "const json = answer.json;",
    with: 'if (!isRecord(json)) return "unverified";',
  },
  {
    id: "C-CI-07",
    match: 'typeof runId !== "number" ||',
    with: '(typeof runId !== "number" && false) ||',
  },
  {
    id: "C-CI-08",
    match: 'typeof headSha !== "string" ||',
    with: '(typeof headSha !== "string" && false) ||',
  },
  {
    id: "C-CI-09",
    match: 'typeof status !== "string"',
    with: '(typeof status !== "string" && false)',
  },
  {
    id: "C-CI-10",
    match: 'typeof fullName !== "string"',
    with: '(typeof fullName !== "string" && false)',
  },
  {
    id: "C-CI-11",
    match: "isRecord(repo) ? repo.full_name : undefined",
    with: "isRecord(repo) ? repo.full_name : repo",
  },
  {
    id: "C-CI-12",
    match: '(status !== null && typeof status !== "string") ||',
    with: 'typeof status !== "string" ||',
  },
  {
    id: "C-CI-13",
    match: "String(runId) === id &&",
    with: "(String(runId) === id || true) &&",
  },
  {
    id: "C-CI-14",
    match: "sameRepository(fullName) &&",
    with: "(sameRepository(fullName) || true) &&",
  },
  {
    id: "C-CI-15",
    match: "headSha === commit &&",
    with: "(headSha === commit || true) &&",
  },
  {
    id: "C-CI-16",
    match: 'status === "completed"',
    with: '(status === "completed" || true)',
  },
  { id: "C-CI-17", match: '? "verified"', with: '? "unknown"' },
  { id: "C-CI-18", match: ': "unverified";', with: ': "unknown";' },
  {
    id: "C-RUN-23",
    match: "runIdOf(run, repoKey, api.origin === GITHUB_API_URL)",
    with: 'runIdOf(run, "acme/widgets", api.origin === GITHUB_API_URL)',
  },
  {
    id: "C-RUN-24",
    match: "const path = `${repoPath}/actions/runs/${id}`;",
    with: "const path = `${repoPath}/actions/runs/8123456789`;",
  },
  {
    id: "C-CI-19",
    match: 'status === "completed"',
    with: 'String(status).toLowerCase() === "completed"',
  },
  {
    id: "C-CI-20",
    match: "asciiLower(fullName) === repoKey",
    with: "asciiLower(fullName).startsWith(repoKey)",
  },
  {
    id: "C-CI-21",
    match: "isRecord(repo) ? repo.full_name : undefined",
    with: "(repo as { full_name?: unknown }).full_name",
  },
  {
    id: "C-RUN-25",
    match: "runIdOf(run, repoKey, api.origin === GITHUB_API_URL)",
    with: 'runIdOf("8123456789", repoKey, api.origin === GITHUB_API_URL)',
    untyped: true,
  },
  {
    id: "C-RUN-26",
    match: raw`([1-9][0-9]{0,15})$/;`,
    with: raw`([1-9][0-9]{0,15})$/i;`,
  },
];

const errors: Omit<ConjunctMutant, "table">[] = [
  // get: the request and what an answer becomes.
  {
    id: "C-GET-01",
    match: 'Accept: "application/vnd.github+json",',
    with: 'Accept: "application/json",',
  },
  {
    id: "C-GET-02",
    match: "Authorization: `Bearer ${token}`,",
    with: "Authorization: `token ${token}`,",
  },
  {
    id: "C-GET-03",
    match: '"User-Agent": "spec-gate",',
    with: "",
  },
  {
    id: "C-GET-04",
    match: '"X-GitHub-Api-Version": GITHUB_API_VERSION,',
    with: "",
  },
  { id: "C-GET-05", match: 'redirect: "manual",', with: 'redirect: "follow",' },
  {
    id: "C-GET-06",
    match: "signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),",
    with: "",
  },
  {
    id: "C-GET-07",
    match: "send(`${root}${path}${query}`, {",
    with: "send(`${root}${path}`, {",
    untyped: true,
  },
  {
    id: "C-GET-08",
    match: 'isTimeout(error) ? "timed out" : "no answer"',
    with: 'isTimeout(error) ? "no answer" : "timed out"',
  },
  {
    id: "C-GET-09",
    match: 'isTimeout(error) ? "timed out" : "no answer"',
    with: '"no answer"',
  },
  {
    id: "C-GET-10",
    match: "if (status === 200) {",
    with: "if (status < 300) {",
    untyped: true,
  },
  {
    id: "C-GET-11",
    match: 'link: response.headers.get("link"),',
    with: 'link: response.headers.get("x-link"),',
  },
  {
    id: "C-GET-12",
    match: "[301, 302, 303, 307, 308]",
    with: "[302, 303, 307, 308]",
  },
  {
    id: "C-GET-13",
    match: "[301, 302, 303, 307, 308]",
    with: "[301, 303, 307, 308]",
  },
  {
    id: "C-GET-14",
    match: "[301, 302, 303, 307, 308]",
    with: "[301, 302, 307, 308]",
  },
  {
    id: "C-GET-15",
    match: "[301, 302, 303, 307, 308]",
    with: "[301, 302, 303, 308]",
  },
  {
    id: "C-GET-16",
    match: "[301, 302, 303, 307, 308]",
    with: "[301, 302, 303, 307]",
  },
  {
    id: "C-GET-17",
    match: "REDIRECT_STATUSES.includes(status)",
    with: "(status >= 300 && status < 400)",
    untyped: true,
  },
  {
    id: "C-GET-18",
    match: "(status === 403 || status === 429) &&",
    with: "(status === 429) &&",
  },
  {
    id: "C-GET-19",
    match: "(status === 403 || status === 429) &&",
    with: "(status === 403) &&",
  },
  {
    id: "C-GET-20",
    match: "(status === 403 || status === 429) &&",
    with: "true &&",
  },
  {
    id: "C-GET-21",
    match: 'response.headers.get("x-ratelimit-remaining") === "0" ||',
    with: "false ||",
  },
  {
    id: "C-GET-22",
    match: 'response.headers.get("x-ratelimit-remaining") === "0" ||',
    with: 'response.headers.get("x-ratelimit-remaining") !== null ||',
  },
  {
    id: "C-GET-23",
    match: 'response.headers.has("retry-after"))',
    with: "false)",
  },
  {
    id: "C-GET-24",
    match: "(status === 403 || status === 429) &&",
    with: "(status === 403 || status === 429) && !mapped.includes(status) &&",
  },
  {
    id: "C-GET-25",
    match: "if (mapped.includes(status)) return { status };",
    with: "if (mapped.includes(status) && false) return { status };",
  },
  {
    id: "C-GET-26",
    match: "    throw failure(path, status);",
    with: '    throw failure(path, status, "refused");',
  },
  {
    id: "C-GET-27",
    match: "if (mapped.includes(status)) return { status };",
    with: "if (mapped.length > 0) return { status };",
  },
  // failure: what an error says.
  {
    id: "C-FAL-01",
    match: "status === null",
    after:
      "function failure(path: string, status: number | null, reason?: string): Error {",
    with: "status !== null",
  },
  {
    id: "C-FAL-02",
    match: "reason === undefined ? head : `${head} (${reason})`",
    with: "`${head} (${reason})`",
  },
  {
    id: "C-FAL-03",
    match: "? `github: GET ${path} failed`",
    with: "? `github: GET failed`",
  },
  {
    id: "C-FAL-04",
    match: ": `github: GET ${path} answered ${status}`;",
    with: ": `github: GET ${path} answered`;",
  },
  // bodyOf: reading the body of a 200 answer.
  {
    id: "C-BOD-01",
    match: "if (response.body !== null) {",
    with: "if (response.body !== undefined) {",
    untyped: true,
  },
  {
    id: "C-BOD-02",
    match: 'isTimeout(error) ? "timed out" : "body not readable",',
    with: '"timed out",',
  },
  {
    id: "C-BOD-03",
    match: 'isTimeout(error) ? "timed out" : "body not readable",',
    with: '"body not readable",',
  },
  {
    id: "C-BOD-04",
    match: "size > GITHUB_MAX_BODY_BYTES",
    with: "size >= GITHUB_MAX_BODY_BYTES",
  },
  {
    id: "C-BOD-05",
    match: "size > GITHUB_MAX_BODY_BYTES",
    with: "size > Infinity",
  },
  {
    id: "C-BOD-06",
    match: "for (const chunk of chunks) {",
    with: "for (const chunk of chunks.slice(0, 1)) {",
  },
  {
    id: "C-BOD-07",
    match: "for (const chunk of chunks) {",
    with: "for (const chunk of chunks.slice(-1)) {",
  },
  {
    id: "C-BOD-08",
    match: "for (const chunk of chunks) {",
    with: "for (const chunk of [chunks[0]!, chunks.at(-1)!]) {",
  },
  {
    id: "C-BOD-09",
    match: "offset += chunk.byteLength;",
    with: "offset += 0;",
  },
  { id: "C-BOD-10", match: "fatal: true", with: "fatal: false" },
  {
    id: "C-BOD-11",
    match: "if (holdsText(json, token)) {",
    with: "if (holdsText(json, token) && false) {",
  },
  {
    id: "C-BOD-12",
    match: "size += step.value.byteLength;",
    with: "size += 1;",
  },
  {
    id: "C-BOD-13",
    match: "if (step.done || step.value === undefined) break;",
    with: "if (step.done || step.value === undefined || size > 0) break;",
  },
  // holdsText: where the token is looked for.
  {
    id: "C-TXT-01",
    match: "if (item.includes(needle)) return true;",
    with: "if (item === needle) return true;",
  },
  {
    id: "C-TXT-02",
    match: "for (const entry of item) open.push(entry);",
    with: "for (const entry of item.slice(0, 1)) open.push(entry);",
  },
  {
    id: "C-TXT-03",
    match: "for (const entry of item) open.push(entry);",
    with: "for (const entry of item.slice(-1)) open.push(entry);",
  },
  {
    id: "C-TXT-04",
    match: "for (const entry of item) open.push(entry);",
    with: "for (const entry of [item[0], item.at(-1)]) open.push(entry);",
  },
  {
    id: "C-TXT-05",
    match: "Object.entries(item)) {",
    with: "Object.entries(item).slice(0, 1)) {",
  },
  {
    id: "C-TXT-06",
    match: "Object.entries(item)) {",
    with: "Object.entries(item).slice(-1)) {",
  },
  {
    id: "C-TXT-07",
    match: "Object.entries(item)) {",
    with: "Object.entries(item).filter((_, i, all) => i === 0 || i === all.length - 1)) {",
  },
  {
    id: "C-TXT-08",
    match: "if (key.includes(needle)) return true;",
    with: "if (key.includes(needle) && false) return true;",
  },
  {
    id: "C-TXT-09",
    match: "        open.push(entry);",
    with: '        if (typeof entry === "string") open.push(entry);',
  },
  {
    id: "C-TXT-10",
    match: "  return false;",
    after: "function holdsText(value: unknown, needle: string): boolean {",
    with: "  return true;",
  },
  {
    id: "C-TXT-11",
    match: 'if (typeof item === "string") {',
    with: 'if (typeof item === "string" && item.length < 40) {',
  },
  {
    id: "C-TXT-12",
    match: "} else if (Array.isArray(item)) {",
    with: "} else if (Array.isArray(item) && item.length < 2) {",
  },
  {
    id: "C-TXT-13",
    match: "} else if (isRecord(item)) {",
    with: "} else if (isRecord(item) && Object.keys(item).length < 2) {",
  },
  {
    id: "C-TXT-14",
    match: "while (open.length > 0) {",
    with: "while (open.length > 1) {",
  },
  // isTimeout: which failure is a time limit.
  {
    id: "C-TMO-01",
    match: 'typeof error === "object" &&',
    with: "true &&",
  },
  { id: "C-TMO-02", match: "    error !== null &&", with: "    true &&" },
  {
    id: "C-TMO-03",
    match: '(error as { name?: unknown }).name === "TimeoutError"',
    with: "(error as { name?: unknown }).name !== undefined",
  },
  {
    id: "C-TMO-04",
    match: '(error as { name?: unknown }).name === "TimeoutError"',
    with: 'String((error as { name?: unknown }).name).toLowerCase() === "timeouterror"',
  },
  {
    id: "C-BOD-14",
    match: "json: await bodyOf(response, path),",
    with: 'json: await bodyOf(response, ""),',
  },
  {
    id: "C-BOD-15",
    match: "if (holdsText(json, token)) {",
    with: 'if (holdsText(json, "t")) {',
  },
  {
    id: "C-GET-28",
    match: "mapped: readonly number[] = [],",
    after: "async function get(",
    with: "mapped: readonly number[] = [404],",
  },
];

export const CONJUNCT_MUTANTS: readonly ConjunctMutant[] = [
  ...options.map((m) => ({ ...m, table: "github-options" as const })),
  ...pull.map((m) => ({ ...m, table: "github-pull" as const })),
  ...reviews.map((m) => ({ ...m, table: "github-reviews" as const })),
  ...enforcement.map((m) => ({
    ...m,
    table: "github-enforcement" as const,
  })),
  ...configCommit.map((m) => ({
    ...m,
    table: "github-config-commit" as const,
  })),
  ...ci.map((m) => ({ ...m, table: "github-ci" as const })),
  ...errors.map((m) => ({ ...m, table: "github-errors" as const })),
];

/** The ids of the conjuncts whose rows a test file holds, in order. */
export function conjunctIds(table: ConjunctTable): string[] {
  return CONJUNCT_MUTANTS.filter((m) => m.table === table).map((m) => m.id);
}
