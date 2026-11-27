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
 * The suite checks what it can without changing the source: the ids of this
 * list and of the tables are the same, every change still applies to
 * exactly one line, and every line of the covered functions that decides
 * something has a change (`github-source.test.ts`). That each row really
 * fails under its change is checked by a mutation run, which applies one
 * change, runs the row whose title starts with the id, and restores the
 * file.
 */

/** The test files that hold a `CONJUNCTS` table, without `.test.ts`. */
export const CONJUNCT_TABLES = [
  "github-options",
  "github-reviews",
  "github-config-commit",
  "github-ci",
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
];

export const CONJUNCT_MUTANTS: readonly ConjunctMutant[] = [
  ...options.map((m) => ({ ...m, table: "github-options" as const })),
  ...reviews.map((m) => ({ ...m, table: "github-reviews" as const })),
  ...configCommit.map((m) => ({
    ...m,
    table: "github-config-commit" as const,
  })),
  ...ci.map((m) => ({ ...m, table: "github-ci" as const })),
];

/** The ids of the conjuncts whose rows a test file holds, in order. */
export function conjunctIds(table: ConjunctTable): string[] {
  return CONJUNCT_MUTANTS.filter((m) => m.table === table).map((m) => m.id);
}
