import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONJUNCT_MUTANTS,
  CONJUNCT_TABLES,
  type Change,
  type ConjunctMutant,
} from "./conjunct-mutants.js";
import {
  ENFORCEMENT_STATES,
  GITHUB_API_URL,
  GITHUB_API_VERSION,
  GITHUB_MAX_BODY_BYTES,
  GITHUB_MAX_PAGES,
  GITHUB_PAGE_SIZE,
  GITHUB_TIMEOUT_MS,
  REVIEW_STATES,
} from "../../src/host/index.js";

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const source = fs.readFileSync(at("../../src/host/github.ts"), "utf8");
const doc = fs.readFileSync(at("../../docs/approve.md"), "utf8");

/** The section of the doc about the adapter: from its heading to the next of its level. */
function adapterSection(): string {
  const from = doc.indexOf("\n## GitHub adapter\n");
  expect(from).toBeGreaterThan(-1);
  const to = doc.indexOf("\n## ", from + 1);
  expect(to).toBeGreaterThan(from);
  return doc.slice(from, to);
}

describe("src/host/github.ts", () => {
  it("reaches the network at one place only, through the fetch it was given or the global one", () => {
    expect(source.match(/\bsend\(/g)).toHaveLength(1);
    expect(source).toContain("const send = options.fetch ?? globalThis.fetch;");
    // The type of the option and the default: no other use of the global.
    expect(source.match(/globalThis\.fetch/g)).toHaveLength(2);
    expect(source).not.toMatch(/\b(XMLHttpRequest|WebSocket|EventSource)\b/);
  });

  it("imports nothing but its own package, starts no process and writes nowhere", () => {
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec).toMatch(/^\.{1,2}\//);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\b(console|process|child_process|eval)\b/);
    expect(source).not.toMatch(/\bnode:/);
  });

  it("sends GET only", () => {
    const methods = [...source.matchAll(/method: "([A-Z]+)"/g)].map(
      (m) => m[1],
    );
    expect(methods).toEqual(["GET"]);
    expect(source).not.toMatch(/"(POST|PUT|PATCH|DELETE)"/);
  });
});

describe('docs/approve.md, "GitHub adapter"', () => {
  // Line breaks of the prose are not part of what it says.
  const section = adapterSection().replace(/\s+/g, " ");

  it("names every request the adapter makes", () => {
    for (const request of [
      "`/pulls/{number}`",
      "`/pulls/{number}/reviews`",
      "`/rules/branches/{branch}`",
      "`/branches/{branch}/protection`",
      "`/commits?sha={branch}&path=.spec-gate&per_page=1`",
      "`/commits/{sha}/pulls`",
      "`/actions/runs/{id}`",
    ]) {
      expect(section, request).toContain(request);
    }
    // And the source asks for nothing the doc does not name.
    const asked = [...source.matchAll(/\$\{repoPath\}(\/[a-z/]+)/g)].map(
      (m) => m[1]!,
    );
    expect([...new Set(asked)].sort()).toEqual([
      "/actions/runs/",
      "/branches/",
      "/commits",
      "/commits/",
      "/pulls/",
      "/rules/branches/",
    ]);
  });

  it("names the limits with the values of the source", () => {
    expect(section).toContain(`\`${GITHUB_API_URL}\``);
    // The doc names the constant, not its value: the version is a date.
    expect(section).toContain("`X-GitHub-Api-Version` header that pins");
    expect(section).toContain("`GITHUB_API_VERSION` in `src/host/github.ts`");
    expect(GITHUB_API_VERSION).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    expect(section).toContain(`${GITHUB_TIMEOUT_MS / 1000} seconds`);
    expect(section).toContain(`${GITHUB_MAX_BODY_BYTES / (1024 * 1024)} MiB`);
    expect(section).toContain(`${GITHUB_PAGE_SIZE} entries at a time`);
    expect(section).toContain(`At most ${GITHUB_MAX_PAGES} pages`);
  });

  it("names the states, the enforcement rule and its limits", () => {
    for (const word of [...REVIEW_STATES, ...ENFORCEMENT_STATES, "PENDING"]) {
      expect(section, word).toContain(`\`${word}\``);
    }
    for (const phrase of [
      "required_approving_review_count",
      "`evaluate` or `disabled`",
      "A source is not readable when it answers 403 or 404",
      "does not tell the two apart",
      "A required code-owner review",
      "the answer is the same for `specs/` and `.spec-gate/`",
      "such as `.Spec-Gate`, is not seen here",
      "submitted on the head commit of the merged pull request (`head.sha`) and not after the merge (`merged_at`)",
      "cannot be read as reviews",
      "read only when the API root is `https://api.github.com`",
      "(a role, a team, an app, not only an administrator) can merge without the review while the adapter reports `enforced`",
      "`null` included, is refused",
      "Redirects are not followed",
      "`rate limited`",
      "With one of these headers a rate limit is never read as a missing permission",
      "It never holds the token, a response body or a header",
      "the token is never sent to an address taken from a header",
    ]) {
      expect(section, phrase).toContain(phrase);
    }
  });

  it("names the permissions and what a workflow token cannot read", () => {
    for (const phrase of [
      "`pull-requests: read`",
      "`contents: read`",
      "`actions: read`",
      "Administration: read",
      "The token of a workflow run cannot be given the administration permission",
      "gets `unknown`",
    ]) {
      expect(section, phrase).toContain(phrase);
    }
  });

  it("cites the sections of the GitHub REST documentation the mapping rests on", () => {
    for (const title of [
      "Get a pull request",
      "List reviews for a pull request",
      "Get rules for a branch",
      "Get branch protection",
      "List commits",
      "List pull requests associated with a commit",
      "Get a workflow run",
      "Using pagination in the REST API",
      "Rate limits for the REST API",
      "Troubleshooting the REST API",
      "Permissions required for fine-grained personal access tokens",
    ]) {
      expect(section, title).toContain(`"${title}"`);
    }
  });

  it("describes ciRunStatus with its two arguments and says the approval check does not call it", () => {
    expect(doc).toContain("`ciRunStatus(commit, run)`");
    expect(doc).not.toContain("ciRunStatus(ref)");
    expect(doc).toContain("the approval check does not call it");
  });
});

describe("the conjunct list (conjunct-mutants.ts)", () => {
  const lines = source.split("\n");
  const linesWith = (text: string): number[] =>
    lines.flatMap((line, i) => (line.includes(text) ? [i] : []));

  /** The index of the one line a change edits, or the reason there is none. */
  function lineOf(change: Change): number | string {
    let from = 0;
    if (change.after !== undefined) {
      const anchors = linesWith(change.after);
      if (anchors.length !== 1) {
        return `the anchor stands on ${anchors.length} lines`;
      }
      from = anchors[0]! + 1;
    }
    const hits = linesWith(change.match).filter((i) => i >= from);
    if (hits.length === 0) return "the text is not in the source";
    if (change.after === undefined && hits.length !== 1) {
      return `the text stands on ${hits.length} lines`;
    }
    const line = lines[hits[0]!]!;
    if (line.split(change.match).length !== 2) {
      return "the text stands twice on its line";
    }
    return hits[0]!;
  }

  const changesOf = (mutant: ConjunctMutant): Change[] => [
    mutant,
    ...(mutant.also ?? []),
  ];

  /** The line indices of the body of the function whose first line holds `opening`. */
  function bodyOf(opening: string): number[] {
    const starts = linesWith(opening);
    expect(starts, opening).toHaveLength(1);
    const body: number[] = [];
    let depth = 0;
    let opened = false;
    for (let i = starts[0]!; i < lines.length; i += 1) {
      body.push(i);
      for (const char of lines[i]!) {
        if (char === "{") {
          depth += 1;
          opened = true;
        } else if (char === "}") {
          depth -= 1;
        }
      }
      if (opened && depth === 0) return body;
    }
    throw new Error(`the body of ${opening} does not end`);
  }

  /** The functions whose every deciding line must have a conjunct. */
  const COVERED = [
    "function nextTarget(",
    "function runIdOf(",
    "function apiRootOf(",
    "function hasNext(",
    "async function list(",
    "async function readReviews(",
    "function latestApprover(",
    "async function mergedPullOf(",
    "async reviews(): Promise<HostReview[]> {",
    "async lastConfigCommit(): Promise<HostConfigCommit> {",
    "async ciRunStatus(commit: string, run: string): Promise<CiRunStatus> {",
  ];
  /** The check of the apiUrl option, which stands in the body of the factory. */
  const COVERED_LINES = [
    'if (apiUrl !== undefined && typeof apiUrl !== "string") {',
    "const api = apiRootOf(apiUrl ?? GITHUB_API_URL);",
  ];

  /** A line that decides something: a condition, a comparison, a loop, a choice, a filter, a search. */
  const DECIDES =
    /\bif \(\S|\bwhile \(|\bfor \(|&&|\|\||\?\?|\s\?\s|^\?\s|[!=]==|<=|>=|\s[<>]\s|\.filter\(|\.find\(|\.reduce\(/;
  const isCode = (line: string): boolean =>
    !/^(\/\/|\/\*|\*)/.test(line.trim());

  /**
   * Deciding lines without a change of their own, each with the reason. A
   * line belongs here only when it adds no decision to the one a listed
   * conjunct already pins; the test below fails for a line that is missing
   * here and for an entry that is no longer needed.
   */
  const NOT_A_CONJUNCT: Record<string, string> = {
    "if (url === undefined) {":
      "narrows the type; whether the target can be read is decided on the lines above (C-NXT-02, C-NXT-03)",
    "? url.pathname.slice(prefix.length, url.pathname.length - tail.length)":
      "the value of the condition on the line above (C-NXT-07, C-NXT-08)",
    "below !== null &&":
      "narrows the type; null is the outcome of the line pair above (C-NXT-07, C-NXT-08)",
    "if (!sameList) {":
      "applies the value the lines above decide (C-NXT-09 to C-NXT-12)",
    "if (answer.status !== 200) return { ok: false, status: answer.status };":
      "only reached with a mapped status, which none of the covered callers passes; pinned in github-enforcement.test.ts (rules that answer 403 or 404)",
    "if (!Array.isArray(answer.json)) {":
      "the condition of C-LST-01, whose change edits the line it guards",
    'if (typeof state !== "string") {':
      "the condition of C-REV-02, whose change edits the line it guards",
    "if (!listing.ok) throw failure(path, listing.status);":
      "narrows the type; the list of pull requests passes no mapped status and throws past the cap (C-MRG-10)",
    "if (!isRecord(entry)) {":
      "the condition of C-MRG-09, whose change edits the line it guards",
  };

  it("has unique ids of one form, each in a known table", () => {
    const ids = CONJUNCT_MUTANTS.map((mutant) => mutant.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const mutant of CONJUNCT_MUTANTS) {
      expect(mutant.id).toMatch(/^C-[A-Z]{2,3}-[0-9]{2}$/);
      expect(CONJUNCT_TABLES).toContain(mutant.table);
    }
    // No id is the end of another one, so a title filter on `<id>:` picks one row.
    for (const id of ids) {
      expect(ids.filter((other) => other.endsWith(id))).toEqual([id]);
    }
  });

  it("every change applies to exactly one line of the source and changes it", () => {
    for (const mutant of CONJUNCT_MUTANTS) {
      const edited = new Set<number>();
      for (const change of changesOf(mutant)) {
        const line = lineOf(change);
        expect(typeof line, `${mutant.id}: ${String(line)}`).toBe("number");
        expect(change.with, mutant.id).not.toBe(change.match);
        edited.add(line as number);
      }
      expect(edited.size, mutant.id).toBe(changesOf(mutant).length);
      if (mutant.covers !== undefined) {
        expect(linesWith(mutant.covers), mutant.id).toHaveLength(1);
      }
    }
  });

  it("every deciding line of the covered functions has a conjunct", () => {
    const covered = new Set<number>();
    for (const mutant of CONJUNCT_MUTANTS) {
      for (const change of changesOf(mutant)) {
        const line = lineOf(change);
        if (typeof line === "number") covered.add(line);
      }
      if (mutant.covers !== undefined) {
        for (const line of linesWith(mutant.covers)) covered.add(line);
      }
    }
    const scope = new Set<number>(COVERED.flatMap(bodyOf));
    for (const text of COVERED_LINES) {
      const at = linesWith(text);
      expect(at, text).toHaveLength(1);
      scope.add(at[0]!);
    }
    const deciding = [...scope]
      .sort((a, b) => a - b)
      .filter((i) => isCode(lines[i]!) && DECIDES.test(lines[i]!.trim()));
    expect(deciding.length).toBeGreaterThan(80);
    const uncovered = deciding
      .filter((i) => !covered.has(i))
      .map((i) => lines[i]!.trim());
    expect(uncovered.sort()).toEqual(Object.keys(NOT_A_CONJUNCT).sort());
  });

  it("pins skipping against stopping, the first against the last hit, and every position of a loop", () => {
    const scope = COVERED.flatMap(bodyOf);
    const onLine = (i: number): ConjunctMutant[] =>
      CONJUNCT_MUTANTS.filter((mutant) =>
        changesOf(mutant).some((change) => lineOf(change) === i),
      );
    const having = (i: number, text: string): boolean =>
      onLine(i).some((mutant) => mutant.with.includes(text));
    const skips = scope.filter((i) => /\bcontinue;/.test(lines[i]!));
    const searches = scope.filter((i) => lines[i]!.includes(".find("));
    const loops = scope.filter((i) => /\bfor \(const \w+ of /.test(lines[i]!));
    expect(skips.length).toBeGreaterThanOrEqual(3);
    expect(searches.length).toBeGreaterThanOrEqual(1);
    expect(loops.length).toBeGreaterThanOrEqual(4);
    for (const i of skips) {
      // A loop that skips an element must have a row that fails when it stops instead.
      expect(having(i, "break;"), lines[i]!.trim()).toBe(true);
    }
    for (const i of searches) {
      // A search for the first hit must have a row that fails when the last hit is taken.
      expect(having(i, ".reverse().find("), lines[i]!.trim()).toBe(true);
    }
    for (const i of loops) {
      // Rows must fail when only the first, and when only the last, element is looked at.
      expect(having(i, ".slice(0, 1)"), lines[i]!.trim()).toBe(true);
      expect(having(i, ".slice(-1)"), lines[i]!.trim()).toBe(true);
    }
  });
});
