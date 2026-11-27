import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APPROVE_FORMAT,
  APPROVER_PROBLEMS,
  COMMANDS_GAP,
  CONDITIONS,
  FAILURE_CODES,
  GAPS,
  MAX_LISTED_FINDINGS,
  MAX_MERGED_COMMITS,
  MERGED_SUMMARIES,
  MERGE_SHAPES,
  SPEC_STANDINGS,
  TOKEN_VARIABLE,
} from "../../src/approve/index.js";
import {
  CI_RUN_STATES,
  ENFORCEMENT_STATES,
  REVIEW_PATHS,
  REVIEW_STATES,
} from "../../src/host/index.js";

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const doc = fs.readFileSync(at("../../docs/approve.md"), "utf8");

/** The section of the doc for one condition: from its heading to the next one. */
function section(condition: number): string {
  const from = doc.indexOf(`\n### ${condition}. `);
  expect(from, `section ${condition}`).toBeGreaterThan(-1);
  const to = doc.indexOf("\n## ", from + 1);
  const next = doc.indexOf("\n### ", from + 1);
  const end = next > -1 && next < to ? next : to;
  return doc.slice(from, end);
}

describe("docs/approve.md", () => {
  it("has one table row and one section per condition", () => {
    for (const c of CONDITIONS) {
      expect(doc).toContain(`| ${c.condition} | \`${c.name}\` |`);
      expect(section(c.condition)).toContain("Codes:");
    }
    expect(CONDITIONS.map((c) => c.condition)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it("says that conditions 4, 7 and 8 measure from one base, which is never the base commit", () => {
    const from = doc.indexOf("\n### The measuring base\n");
    expect(from).toBeGreaterThan(-1);
    const measuring = doc.slice(from, doc.indexOf("\n### 1. ", from));
    for (const phrase of [
      "the one merge base of `HEAD` and the default commit",
      "`git merge-base --all`",
      "It is not taken from `base`",
      "The lint is given `repo` and `defaultRef`",
      "- more than one merge base: `ambiguous-merge-base`",
      "The check does not pick and does not run the lint",
      "- no merge base, or a read that fails: `git-failed`",
    ]) {
      expect(measuring, phrase).toContain(phrase);
    }
    for (const condition of [4, 7, 8]) {
      expect(section(condition)).toContain('"The measuring base"');
    }
    expect(section(4)).toContain("never\n  with `--base`");
    expect(section(8)).toContain("whether `base` is given\nor not");
    // What the earlier texts said, and no text may say again.
    for (const gone of [
      "handed to the final lint unchanged",
      "merge-base(HEAD, reference commit)",
      "with the git inputs as given",
      "the reference commit of the final lint",
      "keeps the base it was",
    ]) {
      expect(doc, gone).not.toContain(gone);
    }
    expect(doc).toContain(
      "The final lint is given\n`repo` and `defaultRef` only, never `base`",
    );
    expect(doc).toContain(
      "| `reference` | the base commit that is compared with the base the host reports",
    );
  });

  it("gives the number of findings a message of condition 8 lists", () => {
    expect(section(8)).toContain(
      `for the first ${MAX_LISTED_FINDINGS} in the order of the repository check`,
    );
  });

  it("names every failure code in the section of each condition that uses it, and only there", () => {
    for (const [code, conditions] of Object.entries(FAILURE_CODES)) {
      for (const c of CONDITIONS) {
        const codes = section(c.condition).split("Codes:")[1]!;
        expect(
          codes.includes(`\`${code}\``),
          `${code} in the codes of condition ${c.condition}`,
        ).toBe((conditions as readonly number[]).includes(c.condition));
      }
    }
  });

  it("names the format, the approver problems, the gaps and the host vocabulary", () => {
    expect(doc).toContain(APPROVE_FORMAT);
    for (const word of [
      ...APPROVER_PROBLEMS,
      ...GAPS.map((gap) => gap.code),
      ...REVIEW_STATES,
      ...ENFORCEMENT_STATES,
      ...CI_RUN_STATES,
      ...REVIEW_PATHS,
      "approve_reported",
      "last_config_commit",
      "pull_request",
      "commands",
      COMMANDS_GAP,
    ]) {
      expect(doc, word).toContain(`\`${word}\``);
    }
  });

  it("states the boundary and the gaps", () => {
    for (const phrase of [
      "It cannot say that a person approved",
      "Admin bypass and every other bypass actor",
      "who may bypass a ruleset or a\n  branch protection is not read",
      "Squash merges",
      "no cold-read format exists yet",
      "never from text of the\n  pull request",
    ]) {
      expect(doc).toContain(phrase);
    }
  });
});

describe('docs/approve.md, "After the merge"', () => {
  const from = doc.indexOf("\n## After the merge\n");
  const after = doc.slice(from, doc.indexOf("\n## Report\n", from));
  // Line breaks of the prose are not part of what it says.
  const said = after.replace(/\s+/g, " ");
  const gaps = doc.slice(doc.indexOf("\n## Known gaps\n")).replace(/\s+/g, " ");

  it("stands between the conditions and the report, and has a row per condition with the summary of the source", () => {
    expect(from).toBeGreaterThan(doc.indexOf("\n### 8. "));
    expect(after.length).toBeGreaterThan(1000);
    for (const c of CONDITIONS) {
      expect(after).toContain(
        `| ${c.condition} | ${MERGED_SUMMARIES[c.condition]} |`,
      );
    }
    expect(Object.keys(MERGED_SUMMARIES)).toHaveLength(CONDITIONS.length);
    // Conditions 5 and 6 ask the same in both modes.
    for (const c of CONDITIONS.filter((c) => [5, 6].includes(c.condition))) {
      expect(MERGED_SUMMARIES[c.condition]).toBe(c.summary);
    }
  });

  it("names every code and every shape of the check after the merge", () => {
    for (const word of [
      "not-merged",
      "merge-not-on-default",
      "head-unavailable",
      "merge-shape-unknown",
      "ambiguous-merge-base",
      "config-in-merge",
      "spec-not-in-merge",
      "review-not-proposed",
      "shallow-repository",
      "digest-mismatch-after-merge",
      "checkout-not-default-tip",
      "review-commit-unavailable",
      "worktree-not-head",
      ...MERGE_SHAPES,
    ]) {
      expect(after, word).toContain(`\`${word}\``);
      if (!(MERGE_SHAPES as readonly string[]).includes(word)) {
        expect(Object.keys(FAILURE_CODES), word).toContain(word);
      }
    }
  });

  it("says where the spec is judged, what the ranges are and that none starts at a base commit", () => {
    for (const phrase of [
      "The tip of the default branch is the commit `defaultRef` names when the check runs",
      "The approval must stand on the head commit the host reports for the pull request",
      "the message names both digests and both commits",
      "`HEAD` must be the commit `defaultRef` names",
      "an approver taken off the list on the default branch after the merge does not count",
      "The first range runs from the first parent of the merge commit to the merge commit",
      "each of the last N first-parent steps below the merge commit, N being the number of commits between the reviewed base and the head commit",
      "The reviewed base is the one merge base of the head commit with the first parent of the merge commit",
      "Git does not say which of the two happened, and no comparison of the trees at both ends does",
      "So every step is measured on its own",
      "A replay makes at most one commit per commit of the pull request",
      "a squash that follows a commit of the default branch that changed `.spec-gate/` or removed a proposed spec, within N - 1 commits, is not approved",
      "a pull request of more than 50 commits is not measured",
      "No merge is computed to say what the landed tree should be",
      "the spec is `proposed` with the digest judged at the tip at the approved head commit, and is not so at the one merge base of that head with the first parent of the merge commit",
      "some measured first-parent step of the default branch goes from another state to that state",
      "The state judged at the tip arrives over a range when the spec is `proposed-tip` at its end and is not at its start: three of the sixteen pairs",
      "A range whose end is in another state never counts, whatever its start is",
      "For `merge-commit` the merge base of the head with the first parent is read for this condition alone",
      "no merge base is `git-failed` and several are `ambiguous-merge-base`, for condition 3 only",
      "The second part asks each measured step on its own, not the two ends of all steps",
      "a merge commit the host names where the spec is at neither end of a measured step, or is `proposed-tip` at both",
      "The claim does not say that the approver was shown the change",
      "Condition 3 asks that the spec is `proposed` at the commit of every approving review considered (`review-not-proposed`, which names the commit)",
      "A rebase merge can reach commits of the default branch as well",
      "N counts every commit of the pull request, its merge commits included",
      "a later pull request that only edits another file",
      "This takes the place of `head-in-reference`",
      "the default branch was moved to it by fast-forward, or the branch was pushed there",
      "No range starts at `base`, and none at the base commit the host reports",
      "The measuring base of the open mode, the merge base of `HEAD` and the default commit, is not used after the merge",
      "The final lint of condition 4 is given `repo` and `defaultRef`",
      "compare the tip with itself",
    ]) {
      expect(said, phrase).toContain(phrase);
    }
  });

  it("names the four states of a spec at a commit, in the section about the pull request that brought the spec", () => {
    const from = after.indexOf(
      "\n### The pull request that brought the spec\n",
    );
    expect(from).toBeGreaterThan(
      after.indexOf("\n### The ranges of the merge\n"),
    );
    const binding = after.slice(from, after.indexOf("\n### ", from + 1));
    for (const standing of SPEC_STANDINGS) {
      expect(binding, standing).toContain(`| \`${standing}\` |`);
    }
    expect(binding).toContain("`arrives` in\n`src/approve/binding.ts`");
  });

  it("says that a shallow repository is refused in both modes, and why", () => {
    const flat = doc.replace(/\s+/g, " ");
    for (const phrase of [
      "A shallow repository is refused before anything is measured, in both modes: conditions 2, 4, 7 and 8 are `shallow-repository`",
      "`git-failed` when git cannot say whether it is shallow",
      "A shallow repository is refused: conditions 2, 4, 7 and 8 are `shallow-repository` and the exit code is 1",
      "When `HEAD` and the default ref share no history the checkout can see (a clone of depth 1, for one), the check refuses before that test",
      "exit 2, no report and no word about a shallow repository",
    ]) {
      expect(flat, phrase).toContain(phrase);
    }
    expect(MAX_MERGED_COMMITS).toBe(50);
  });

  it("says what a job after the merge must do: the tip checked out, no shallow history, the head brought in", () => {
    const job = after
      .slice(after.indexOf("\n### In a job after the merge\n"))
      .replace(/\s+/g, " ");
    for (const phrase of [
      "never for a number taken from text",
      "Check out the commit `--default-ref` names, with the complete history of the default branch",
      "A shallow repository is refused (`shallow-repository`, exit 1)",
      "at a shallow boundary a commit shows no parents",
      "Bring the head commit of the pull request into the repository before the check",
      "The check never fetches",
      "`--base` is optional and nothing is measured from it",
      "An open pull request with `--merged` exits 1 (`not-merged`)",
    ]) {
      expect(job, phrase).toContain(phrase);
    }
  });

  it("names the boundaries of the check after the merge under the known gaps", () => {
    for (const phrase of [
      "the check after the merge compares the digest at the tip of the default branch with the digest at the commit of the approving review",
      "reports `merge-shape-unknown` and never approves",
      "Bindings after the merge: `bindings.yaml` and `bindings.log` are not part of the digest",
      "Which pull request, in the open mode: an approval of a commit counts for every spec in the tree of that commit",
      "The check after the merge asks that the pull request brought the spec to the state judged at the tip (`spec-not-in-merge`); the open mode does not",
      "An approval given before the default branch moved, after the merge",
      "Telling the two apart needs a fact of the host about the order of the review and the move of the base",
      "A second pull request with the same commits",
      "The merge commit and the head are the host's word",
      "Named later by fewer commits than the pull request has, the steps can leave out the first commits of a rebase merge",
      "A squash merge is measured like a rebase merge",
      "The same holds for a rebase merge of a pull request that holds merge commits or commits the replay drops",
      "After the merge the bindings are therefore compared neither with their log as it was merged before nor with the bindings of the approved head",
      "neither is a later commit of the default branch that changes `bindings.yaml` without a log entry",
    ]) {
      expect(gaps, phrase).toContain(phrase);
    }
    // What the earlier text said about a later check.
    expect(doc).not.toContain("is a separate, later check");
  });

  it("describes the merge facts of the adapter and the fields of the report", () => {
    const flat = doc.replace(/\s+/g, " ");
    for (const phrase of [
      "report `merged: true` only when the host itself says the pull request was merged",
      "a trial merge the host computed for an open pull request is never reported",
      "`mergeCommit` is `merge_commit_sha` for a merged pull request",
      "| `mode` | `open`, or `merged` for the check after the merge |",
      "| `merge` | after the merge, the merge as it was measured",
      "| `merged` | `true` for the check after the merge",
    ]) {
      expect(flat, phrase).toContain(phrase);
    }
  });
});

describe('docs/approve.md, "Commands" and "CLI"', () => {
  /** The section under a heading of any level, up to the next heading of that level or above. */
  function under(heading: string): string {
    const from = doc.indexOf(`\n${heading}\n`);
    expect(from, heading).toBeGreaterThan(-1);
    const level = heading.split(" ")[0]!.length;
    const rest = doc.slice(from + 1 + heading.length);
    const next = rest.search(new RegExp(`\\n#{1,${level}} `));
    return next < 0 ? rest : rest.slice(0, next);
  }

  it("describes the commands field, its gap and every reason the tests produce", () => {
    const commands = under("### Commands");
    for (const word of [
      COMMANDS_GAP,
      "commands_ref",
      "check_command_ref",
      "{selector}",
      // The reasons `test/approve/check-commands.test.ts` produces.
      "spec-unreadable",
      "testplan-unreadable",
      "commands-ref-unresolvable",
      "commands-file-missing",
      "commands-file-invalid",
      "command-ref-unknown",
      "git-failed",
    ]) {
      expect(commands, word).toContain(`\`${word}\``);
    }
    expect(commands).toContain("never read at\nthe tip of the default branch");
    expect(commands).toContain("not a condition");
    expect(doc).toContain("| `commands` |");
  });

  it("names every option the command registers, and the command has none for the token", () => {
    const source = fs.readFileSync(at("../../src/cli.ts"), "utf8");
    const from = source.indexOf('.command("approve-check")');
    expect(from).toBeGreaterThan(-1);
    const block = source.slice(from, source.indexOf("\ntry {", from));
    const flags = [...block.matchAll(/ption\(\s*"(--[a-z-]+) </g)].map(
      (m) => m[1]!,
    );
    expect(flags).toEqual([
      "--repo",
      "--default-ref",
      "--base",
      "--github-repo",
      "--pr",
      "--api-url",
    ]);
    // The options that take no value: the one for the check after the merge.
    const switches = [...block.matchAll(/ption\(\s*"(--[a-z-]+)",/g)].map(
      (m) => m[1]!,
    );
    expect(switches).toEqual(["--merged"]);
    const cli = under("## CLI");
    const readme = fs.readFileSync(at("../../README.md"), "utf8");
    for (const flag of flags) {
      expect(cli, flag).toContain(`\`${flag}\``);
      expect(readme, flag).toContain(`${flag} <`);
    }
    expect(cli).toContain("[--api-url <url>] [--merged]");
    expect(cli).toContain("| `--merged` | `merged: true`");
    expect(readme).toContain("`spec-gate approve-check --merged`");
    expect(fs.readFileSync(at("../../CHANGELOG.md"), "utf8")).toContain(
      "`spec-gate approve-check --merged`",
    );
    expect(readme).toContain("spec-gate approve-check <spec-dir>");
    expect(fs.readFileSync(at("../../CHANGELOG.md"), "utf8")).toContain(
      "spec-gate approve-check <spec-dir>",
    );
  });

  it("states the exit codes and where the token comes from", () => {
    const cli = under("## CLI");
    for (const phrase of [
      "| 0 | a report whose `approved` is `true` |",
      "| 1 | a report whose `approved` is not `true`",
      "| 2 | no report:",
      "Only exit 0 means approved",
      "- `--version` and `-V` anywhere on the command line",
      "a job must also require the JSON line with `approved: true` on stdout",
      "`--help` and `-h` among the arguments of the\nverb are no help request",
      "Arguments before the verb name are\nhandled by the program",
      "the exit code is 1 with an\nempty stdout",
      `environment variable \`${TOKEN_VARIABLE}\``,
      "There is no option for it",
      "Check out the head commit of the pull request, not a merge of it",
      "The check\n  never fetches",
    ]) {
      expect(cli, phrase).toContain(phrase);
    }
  });
});

describe("the approval sources", () => {
  const list = (rel: string): string[] =>
    fs
      .readdirSync(at(rel))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => path.join(at(rel), name));
  const approve = list("../../src/approve");
  const host = list("../../src/host");
  const sources = [...approve, ...host];
  const named = (file: string) => path.basename(file);
  const read = (file: string) => fs.readFileSync(file, "utf8");
  /** The module of `src/approve/` behind the CLI verb: the one that makes an adapter. */
  const VERB = "verb.ts";
  /** The module of `src/host/` that talks to a host. */
  const ADAPTER = "github.ts";

  it("start no process and load nothing but their own modules and node's fs, path and crypto", () => {
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      const text = read(file);
      const imports = [...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec, `${named(file)} imports ${spec}`).toMatch(
          /^(\.{1,2}\/|node:(fs|path|crypto)$)/,
        );
      }
      expect(text, named(file)).not.toMatch(
        /\b(fetch|require|XMLHttpRequest|WebSocket)\s*\(/,
      );
      expect(text, named(file)).not.toMatch(/\bimport\s*\(/);
    }
  });

  it("the library opens no connection: no module but the verb makes an adapter, and none but the adapter names fetch", () => {
    const library = approve.filter((file) => named(file) !== VERB);
    expect(library.map(named)).toContain("check.ts");
    expect(library.length).toBe(approve.length - 1);
    for (const file of library) {
      const text = read(file);
      // `checkApproval` and what it calls ask the adapter they are handed.
      expect(text, named(file)).not.toMatch(/createGitHubHost|github\.js/);
      expect(text, named(file)).not.toMatch(/\bfetch\b|globalThis/);
    }
    for (const file of host.filter((f) => named(f) !== ADAPTER)) {
      expect(read(file), named(file)).not.toMatch(/\bfetch\b|globalThis/);
    }
    // The adapter is where a connection is opened, through the one fetch it
    // was given or the global one; `test/host/github-source.test.ts` pins
    // that place.
    expect(host.map(named)).toContain(ADAPTER);
  });

  it("the verb opens a connection only through the adapter it makes, and reads the token from the environment it is handed", () => {
    const text = read(approve.find((file) => named(file) === VERB)!);
    expect(text).toMatch(/createHost: createGitHubHost,/);
    expect(text).not.toMatch(/\bfetch\b|globalThis|node:/);
    // No environment of its own: the caller hands one in, and one name is
    // read from it.
    expect(text).not.toMatch(/\bprocess\b/);
    expect([...text.matchAll(/\benv\[[^\]]*\]/g)].map((m) => m[0])).toEqual([
      "env[TOKEN_VARIABLE]",
    ]);
    expect(TOKEN_VARIABLE).toBe("GITHUB_TOKEN");
    // The token goes to the adapter and to the search of the outputs, and
    // into no text.
    expect(text).not.toMatch(/\$\{token\}/);
  });

  it("the only git arguments they write are reads: a tree, merge bases, parents, first parents, a count of commits and whether the repository is shallow", () => {
    const calls = sources.flatMap((file) =>
      [
        ...fs
          .readFileSync(file, "utf8")
          .matchAll(/runGit\(\s*\w+,\s*\[([^\]]*)\]/g),
      ].map((m) => m[1]!.replace(/\s+/g, " ").trim()),
    );
    expect(calls).toHaveLength(6);
    expect(calls[0]).toMatch(
      /^"merge-base", "--all", "--end-of-options", a, b,?$/,
    );
    expect(calls[1]).toMatch(
      /^"rev-list", "--parents", "--max-count=1", "--end-of-options", commit,?$/,
    );
    expect(calls[2]).toBe(
      '"rev-list", "--first-parent", `--max-count=${count}`, "--end-of-options", commit,',
    );
    expect(calls[3]).toBe(
      '"rev-list", "--count", `--max-count=${cap}`, "--end-of-options", `${from}..${to}`,',
    );
    expect(calls[4]).toBe('"rev-parse", "--is-shallow-repository"');
    expect(calls[5]).toMatch(
      /^"ls-tree", "-r", "-z", "--full-tree", "--end-of-options", commit, "--", prefix,?$/,
    );
    // No call merges, writes a tree or starts a merge driver.
    for (const call of calls) expect(call).not.toMatch(/merge-tree|write/);
    // Every runGit call of these sources is one of the six above: none is
    // written in a form the pattern does not see.
    const written = sources.reduce(
      (n, file) =>
        n + (fs.readFileSync(file, "utf8").match(/\brunGit\(/g) ?? []).length,
      0,
    );
    expect(written).toBe(6);
  });
});
