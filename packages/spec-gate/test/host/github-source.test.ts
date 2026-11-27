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

/**
 * What these checks see, and what they do not.
 *
 * They read the whole of `src/host/github.ts`: every function, and the
 * patterns and lists at module level. No function is left out. They check
 * the conjunct list against the text of the source; they never run a
 * change. That the row of an id fails under its change is the job of the
 * mutation run.
 *
 * Seen by an operator or a keyword on a line: a condition, a comparison, a
 * loop, a choice, a filter, a search, a pattern. Three kinds of decision
 * have no operator of their own and get a check each: a value that is
 * handed on and selects what is read, the order of two operands where the
 * left one does work or guards the right one, and the case of a text a
 * constant is compared with.
 *
 * Not seen: what a change does to the part it edits (every part of a line
 * must lie in the text some change replaces, and a line with n parts needs
 * n changes that differ, but a change that only rewrites a part looks like
 * one that removes it); a decision that is spread over lines without an
 * operator on any of them (the order of two statements, a default value of
 * a parameter, what a `catch` turns a failure into); and the single
 * characters a pattern lets in, which the test files check one by one.
 * Those are found by reading and by a sweep of generated changes, not here.
 */
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

  /** Per line index: the changes that edit the line or stand for it. */
  const changesAt = new Map<number, { id: string; change: Change }[]>();
  const put = (line: number, id: string, change: Change): void => {
    changesAt.set(line, [...(changesAt.get(line) ?? []), { id, change }]);
  };
  for (const mutant of CONJUNCT_MUTANTS) {
    for (const change of changesOf(mutant)) {
      const line = lineOf(change);
      if (typeof line === "number") put(line, mutant.id, change);
    }
    if (mutant.covers !== undefined) {
      for (const line of linesWith(mutant.covers)) put(line, mutant.id, mutant);
    }
  }
  const onLine = (i: number) => changesAt.get(i) ?? [];
  const known = new Set(CONJUNCT_MUTANTS.map((mutant) => mutant.id));

  /**
   * The code lines of the whole file: every function and everything at
   * module level. Only comments and imports are left out.
   */
  const code: number[] = [];
  {
    let inComment = false;
    lines.forEach((line, i) => {
      const text = line.trim();
      if (inComment) {
        if (text.includes("*/")) inComment = false;
        return;
      }
      if (text.startsWith("/*")) {
        if (!text.includes("*/")) inComment = true;
        return;
      }
      if (text === "" || text.startsWith("//")) return;
      if (text.startsWith("import ") || text.startsWith("} from ")) return;
      code.push(i);
    });
  }

  /** A line that decides something: a condition, a comparison, a loop, a choice, a filter, a search. */
  const DECIDES =
    /\bif \(\S|\bwhile \(|\bfor \(|&&|\|\||\?\?|\s\?\s|^\?\s|[!=]==|<=|>=|\s[<>]\s|\.filter\(|\.find\(|\.reduce\(|\.every\(|\.some\(|\.includes\(/;
  /** A line that holds a pattern: what the pattern admits is a decision too. */
  const HAS_PATTERN = /(?:^|[=(,]\s*)\/(?![/*\s])(?:\\.|[^/\\])+\/[dgimsuy]*/;

  /**
   * Deciding lines without a change of their own, each with the reason. A
   * line belongs here only when it adds no decision to the one a listed
   * conjunct already pins, or when its two outcomes cannot be told apart
   * from outside. The test fails for a line that is missing here and for an
   * entry that is no longer needed.
   */
  const NOT_A_CONJUNCT: Record<string, string> = {
    "if (url === undefined) {":
      "narrows the type; whether the target can be read is decided on the lines above (C-NXT-02, C-NXT-03)",
    "? url.pathname.slice(prefix.length, url.pathname.length - tail.length)":
      "the value of the condition on the line above (C-NXT-07, C-NXT-08)",
    "if (!sameList) {":
      "applies the value the lines above decide (C-NXT-09 to C-NXT-12, C-NXT-17)",
    "if (answer.status !== 200) return { ok: false, status: answer.status };":
      "the mapped status of a list; its two outcomes are C-RUL-01 to C-RUL-05",
    "if (!Array.isArray(answer.json)) {":
      "the condition of C-LST-01, whose change edits the line it guards",
    'if (typeof state !== "string") {':
      "the condition of C-REV-02, whose change edits the line it guards",
    "if (!listing.ok) throw failure(path, listing.status);":
      "narrows the type; the list of pull requests passes no mapped status and throws past the cap (C-MRG-10)",
    "if (!isRecord(entry)) {":
      "the condition of C-MRG-09, whose change edits the line it guards",
    "for (;;) {":
      "a loop without a condition; where it ends is decided by the line that reads the end of the body (C-BOD-13)",
    "owner === undefined ||":
      "narrows the type; an owner is missing only when the repository is no text, and then the name is missing too (C-OPT-02)",
    'typeof pullNumber !== "number" ||':
      "narrows the type; the line below refuses everything that is no number (C-OPT-19)",
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

  it("every deciding line and every pattern of the whole file has a conjunct", () => {
    const deciding = code.filter(
      (i) =>
        DECIDES.test(lines[i]!.trim()) || HAS_PATTERN.test(lines[i]!.trim()),
    );
    expect(deciding.length).toBeGreaterThan(150);
    const uncovered = deciding
      .filter((i) => onLine(i).length === 0)
      .map((i) => lines[i]!.trim());
    expect(uncovered.sort()).toEqual(Object.keys(NOT_A_CONJUNCT).sort());
  });

  /**
   * The parts of a line: what stands between its `&&` and `||`. Every part
   * must lie in the text some change of that line replaces, and a line with
   * n parts needs n changes that differ. A part named here has no change of
   * its own because no input tells it apart from the rest of its line.
   */
  const PARTS_AS_ONE: Record<string, string> = {
    "if (step.done || step.value === undefined) break;":
      "a body gives a value with every step that is not its last, so the two parts are one end of the body (C-BOD-13); the second part narrows the type",
    'if (typeof count !== "number" || !Number.isSafeInteger(count)) {':
      "what is no number is no safe integer either, so the first part refuses nothing the second lets through (C-RUL-18, C-PRT-13); it narrows the type",
  };

  it("every boolean part of a line lies in a change, and a line with n parts has n changes that differ", () => {
    const short = new Set<string>();
    let counted = 0;
    for (const i of code) {
      const line = lines[i]!;
      const parts: { from: number; to: number }[] = [];
      let from = 0;
      for (const operator of [...line.matchAll(/&&|\|\|/g), null]) {
        const to = operator === null ? line.length : operator.index;
        const text = line.slice(from, to);
        if (/\w/.test(text.replace(/\b(if|return|const)\b/g, ""))) {
          const lead = text.length - text.trimStart().length;
          parts.push({ from: from + lead, to: from + text.trimEnd().length });
        }
        from = to + 2;
      }
      if (parts.length < 2) continue;
      counted += 1;
      const spans = onLine(i).map(({ change }) => {
        const start = line.indexOf(change.match);
        // A change that stands for the line from another one covers all of it.
        return start < 0
          ? { from: 0, to: line.length }
          : { from: start, to: start + change.match.length };
      });
      const inAChange = parts.every((part) =>
        spans.some((span) => span.from < part.to && part.from < span.to),
      );
      const distinct = new Set(
        onLine(i).map(({ change }) => `${change.match}\n${change.with}`),
      ).size;
      if (!inAChange || distinct < parts.length) short.add(line.trim());
    }
    expect(counted).toBeGreaterThan(20);
    expect([...short].sort()).toEqual(Object.keys(PARTS_AS_ONE).sort());
  });

  it("pins skipping against stopping, the first against the last hit, and every position of a loop", () => {
    const having = (i: number, text: string): boolean =>
      onLine(i).some((entry) => entry.change.with.includes(text));
    const skips = code.filter((i) => /\bcontinue;/.test(lines[i]!));
    const searches = code.filter((i) => lines[i]!.includes(".find("));
    const loops = code.filter((i) =>
      /\bfor \(const [\w[\], ]+ of /.test(lines[i]!),
    );
    expect(skips.length).toBeGreaterThanOrEqual(5);
    expect(searches.length).toBeGreaterThanOrEqual(1);
    expect(loops.length).toBeGreaterThanOrEqual(8);
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

  /**
   * A selecting argument: a name handed to one of the adapter's own
   * functions that read from the host or choose what is read. A row that
   * only ever uses one value would pass with a constant in its place.
   *
   * Every such site is pinned in one of three ways, tried in this order:
   * a change on its line puts something else in its place; or the name is a
   * path built by a template in the same function and a change edits that
   * template; or the site is named below with the conjunct whose row fails
   * for another value, and with the reason no change of its own is listed.
   */
  const SELECTORS = [
    "get",
    "list",
    "hasNext",
    "bodyOf",
    "nextTarget",
    "rulesetEvidence",
    "protectionEvidence",
    "mergedPullOf",
    "readReviews",
    "latestApprover",
    "runIdOf",
    "apiRootOf",
    "holdsText",
    "standingApprovals",
  ];
  /** `<function>(<argument>)` and its line: the conjunct that pins it, and why it has no change of its own. */
  const SELECTING_ARGUMENTS: Record<string, { id: string; why: string }> = {
    "bodyOf(response) in: json: await bodyOf(response, path),": {
      id: "C-BOD-06",
      why: "there is one answer in reach and no constant that could stand for it; its body is what every row reads",
    },
    "holdsText(json) in: if (holdsText(json, token)) {": {
      id: "C-TXT-14",
      why: "the parsed body is the one value in reach; the rows of holdsText search bodies of every shape",
    },
  };

  /** The arguments of the call that opens at `open` (the index of its parenthesis in the source), each with its line. */
  function argumentsAt(open: number): { text: string; line: number }[] {
    const found: { text: string; line: number }[] = [];
    let depth = 0;
    let start = open + 1;
    const lineAt = (index: number) =>
      source.slice(0, index).split("\n").length - 1;
    const push = (end: number) => {
      const text = source.slice(start, end);
      const lead = text.length - text.trimStart().length;
      if (text.trim() !== "")
        found.push({ text: text.trim(), line: lineAt(start + lead) });
    };
    for (let i = open; i < source.length; i += 1) {
      const char = source[i]!;
      if (char === "`") {
        // A template is one argument; its text is not looked into.
        i = source.indexOf("`", i + 1);
      } else if ("([{".includes(char)) depth += 1;
      else if (")]}".includes(char)) {
        depth -= 1;
        if (depth === 0) {
          push(i);
          return found;
        }
      } else if (char === "," && depth === 1) {
        push(i);
        start = i + 1;
      }
    }
    return found;
  }

  it("every selecting argument is pinned by a change, by the template that builds it, or by name", () => {
    const sites: string[] = [];
    const unpinned: string[] = [];
    const used = new Set<string>();
    const calls = new RegExp(`(?<![\\w.])(${SELECTORS.join("|")})\\(`, "g");
    for (const call of source.matchAll(calls)) {
      const callLine = source.slice(0, call.index).split("\n").length - 1;
      if (!code.includes(callLine)) continue;
      if (/^(async )?function /.test(lines[callLine]!.trim())) continue;
      const name = call[1]!;
      for (const argument of argumentsAt(call.index + call[0].length - 1)) {
        if (!/^[A-Za-z_$][\w$]*(\.[\w$]+)*$/.test(argument.text)) continue;
        const site = `${name}(${argument.text}) in: ${lines[argument.line]!.trim()}`;
        sites.push(site);
        const word = new RegExp(
          `(?<![\\w.])${argument.text.replace(/[.$]/g, "\\$&")}(?![\\w])`,
        );
        const replaced = onLine(argument.line).some(
          ({ change }) => word.test(change.match) && !word.test(change.with),
        );
        if (replaced) continue;
        // A path that a template builds in the same function: the nearest one above.
        const lastAbove = (pattern: RegExp): number => {
          for (let k = argument.line - 1; k >= 0; k -= 1) {
            if (pattern.test(lines[k]!)) return k;
          }
          return -1;
        };
        const built = /^\w+$/.test(argument.text)
          ? lastAbove(new RegExp(`^\\s*const ${argument.text} = \``))
          : -1;
        const opens = lastAbove(/^ {0,4}(async )?function /);
        if (built > opens && onLine(built).length > 0) continue;
        if (site in SELECTING_ARGUMENTS) used.add(site);
        else unpinned.push(site);
      }
    }
    expect(sites.length).toBeGreaterThan(25);
    expect(unpinned).toEqual([]);
    expect([...used].sort()).toEqual(Object.keys(SELECTING_ARGUMENTS).sort());
  });

  /**
   * The order of two operands. It matters in two cases, and each is found
   * by its own pattern.
   *
   * The left operand does work that must happen whatever the right one
   * says: a call of a function that reads or checks and can throw. Its
   * conjunct is a change that lets the right operand decide alone.
   *
   * The left operand guards the right one: it tests a value for null, for
   * its type or for being an object, and the right one reads a property of
   * that value or hands it to a function that would fail on it. The same
   * holds for a guard before `?`. Its conjunct is a change that takes the
   * guard away, with a row whose input the guard is for: without the guard
   * the row ends in a failure of another kind. Taking the guard away is the
   * stronger change: a row that notices it notices the two operands in the
   * other order too.
   */
  const WORKING = ["hasNext", "get", "list", "readReviews", "bodyOf", "send"];
  /**
   * The line of the operand or of the guard: the conjunct whose change
   * lets the other operand decide alone or takes the guard away. One id
   * for every line with that text, from the top of the file down.
   */
  const OPERAND_ORDER: Record<string, string[]> = {
    "hasNext(answer.link ?? null, path, page) ||": ["C-LST-12"],
    'typeof value === "string" &&': ["C-BRN-15"],
    'typeof repository === "string" ? repository.split("/") : [];': [
      "C-OPT-02",
    ],
    'typeof fullName === "string" && asciiLower(fullName) === repoKey;': [
      "C-PUL-13",
    ],
    "below !== null &&": ["C-NXT-17"],
    "const login = isRecord(user) ? user.login : undefined;": ["C-REV-23"],
    "const author = isRecord(user) ? user.login : undefined;": ["C-PUL-25"],
    "const headSha = isRecord(head) ? head.sha : undefined;": ["C-PUL-26"],
    "const baseSha = isRecord(base) ? base.sha : undefined;": ["C-PUL-27"],
    "const baseRef = isRecord(base) ? base.ref : undefined;": [
      "C-PUL-23",
      "C-MRG-25",
    ],
    "const baseRepo = isRecord(base) ? base.repo : undefined;": [
      "C-PUL-28",
      "C-MRG-26",
    ],
    "if (!isRecord(baseRepo) || !sameRepository(baseRepo.full_name)) {": [
      "C-PUL-24",
    ],
    "const count = isRecord(parameters)": ["C-RUL-25"],
    "if (best === null || at > best.at) best = { login: approval.login, at };":
      ["C-APP-26"],
    "!isRecord(baseRepo) ||": ["C-MRG-23"],
    "head: isRecord(head) ? head.sha : undefined,": ["C-CFG-29"],
    "const commit = isRecord(first) ? first.sha : undefined;": ["C-CFG-30"],
    "const fullName = isRecord(repo) ? repo.full_name : undefined;": [
      "C-CI-21",
    ],
    'typeof error === "object" &&': ["C-TMO-01"],
    "error !== null &&": ["C-TMO-02"],
  };

  /** Whether the statement of line `k` goes on in the next line. */
  const goesOn = (k: number): boolean =>
    /(\|\||&&|[(=[])$/.test(lines[k]!.trim()) ||
    /^(\?|:|\.|&&|\|\||\))/.test((lines[k + 1] ?? "").trim());

  it("every operand that does work, and every guard of what follows it, is named with its conjunct", () => {
    /** Per line text: the guards found on the lines with that text, top down. */
    const found = new Map<string, { line: number; guard: string | null }[]>();
    const note = (line: number, guard: string | null): void => {
      const text = lines[line]!.trim();
      const sites = found.get(text) ?? [];
      if (!sites.some((site) => site.line === line)) {
        found.set(text, [...sites, { line, guard }]);
      }
    };
    for (const i of code) {
      const text = lines[i]!.trim();
      if (
        WORKING.some((name) =>
          new RegExp(`(?<![\\w.])${name}\\(.*\\)\\s*(\\|\\||&&)`).test(text),
        )
      ) {
        note(i, null);
      }
      // The line and what follows it, to the end of its statement.
      let statement = text;
      for (let k = i; goesOn(k); k += 1) {
        statement += ` ${lines[k + 1]!.trim()}`;
      }
      const guards = statement.matchAll(
        /(typeof (\w+) [!=]== "\w+"|(?<![\w.])(\w+) [!=]== null|!?isRecord\((\w+)\))\s*(?:\|\||&&|\?(?!\?))/g,
      );
      for (const guard of guards) {
        if (guard.index >= text.length) break;
        const name = guard[2] ?? guard[3] ?? guard[4]!;
        const rest = statement.slice(guard.index + guard[0].length);
        const reads = new RegExp(
          `(?<![\\w.])${name}(\\.|\\[)|\\(${name} as |asciiLower\\(${name}\\)`,
        );
        if (reads.test(rest)) note(i, guard[1]!);
      }
    }
    expect([...found.keys()].sort()).toEqual(Object.keys(OPERAND_ORDER).sort());
    for (const [text, ids] of Object.entries(OPERAND_ORDER)) {
      const sites = found.get(text)!;
      expect(ids, text).toHaveLength(sites.length);
      sites.forEach(({ line, guard }, k) => {
        const mine = onLine(line).filter((entry) => entry.id === ids[k]);
        expect(mine, `${text}: ${ids[k]}`).toHaveLength(1);
        if (guard === null) return;
        // The change takes the guard away: it edits the guard and leaves none.
        expect(mine[0]!.change.match, ids[k]).toContain(guard);
        expect(mine[0]!.change.with, ids[k]).not.toContain(guard);
      });
    }
  });

  /**
   * The case of a compared constant: a text of the host that is compared
   * with a constant must be compared as it is written. Found as `===` or
   * `!==` with a constant that has a letter, outside `typeof`, and as a
   * search in a list of constants. Its conjunct is a change that folds the
   * case before the comparison.
   */
  const CASE_NOT_AT_STAKE: Record<string, string> = {
    'if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {':
      "the scheme of a parsed address is in lower case whatever was written",
    'if (!names.includes("next")) continue;':
      "the names were put in lower case on the line above, on purpose: a relation is read without its case, and C-LNK-17 pins that",
    'if (pastCap === "report") return { ok: false, status: null };':
      "a value of the adapter itself, not a text of the host",
    'if (rulesets === "requires") return "enforced";':
      "a value of the adapter itself, not a text of the host",
    'if (protection === "requires") return "enforced";':
      "a value of the adapter itself, not a text of the host",
    'return rulesets === "none" && protection === "none"':
      "values of the adapter itself, not texts of the host",
    '.filter((r) => r.state === "APPROVED" && r.login === approval.login)':
      "a state arrives here only as one of the known states, which C-REV-21 pins with its case",
  };

  it("every comparison with a constant text has a change that folds its case, or is named", () => {
    const open: string[] = [];
    let compared = 0;
    for (const i of code) {
      const text = lines[i]!.trim();
      const constants = [
        ...text.matchAll(/(typeof [\w.]+ )?[!=]== "([^"]*[A-Za-z][^"]*)"/g),
      ].filter((m) => m[1] === undefined);
      const lists = /\.includes\((state|"next")\)/.test(text);
      if (constants.length === 0 && !lists) continue;
      compared += 1;
      const folded = onLine(i).some(({ change }) =>
        /toLowerCase|toUpperCase/.test(`${change.match} ${change.with}`),
      );
      if (!folded) open.push(text);
    }
    expect(compared).toBeGreaterThan(10);
    expect(open.sort()).toEqual(Object.keys(CASE_NOT_AT_STAKE).sort());
  });

  it("every conjunct a reason names is in the list", () => {
    const reasons = [
      ...Object.values(NOT_A_CONJUNCT),
      ...Object.values(PARTS_AS_ONE),
      ...Object.values(CASE_NOT_AT_STAKE),
      ...Object.values(SELECTING_ARGUMENTS).map(
        ({ id, why }) => `${id} ${why}`,
      ),
    ];
    const named = reasons.flatMap(
      (reason) => reason.match(/C-[A-Z]+-\d+/g) ?? [],
    );
    expect(named.length).toBeGreaterThan(20);
    for (const id of named) expect(known.has(id), id).toBe(true);
  });

  it("every phrase of an error stands in a row that expects it", () => {
    const tests = fs
      .readdirSync(at("."))
      .filter(
        (name) => name.endsWith(".test.ts") && name !== "github-source.test.ts",
      )
      .map((name) => fs.readFileSync(at(name), "utf8"))
      .join("\n");
    const phrases = new Set<string>();
    for (const call of source.matchAll(/\b(failure|unreadable|new Error)\(/g)) {
      let depth = 1;
      let end = call.index + call[0].length;
      while (depth > 0 && end < source.length) {
        if (source[end] === "(") depth += 1;
        else if (source[end] === ")") depth -= 1;
        end += 1;
      }
      const inside = source.slice(call.index, end);
      for (const text of inside.matchAll(/"([^"]+)"/g)) phrases.add(text[1]!);
    }
    expect(phrases.size).toBeGreaterThan(40);
    for (const phrase of phrases) {
      expect(tests.includes(phrase), phrase).toBe(true);
    }
  });
});
