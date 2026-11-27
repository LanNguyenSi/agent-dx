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
    const cli = under("## CLI");
    const readme = fs.readFileSync(at("../../README.md"), "utf8");
    for (const flag of flags) {
      expect(cli, flag).toContain(`\`${flag}\``);
      expect(readme, flag).toContain(`${flag} <`);
    }
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

  it("the only git arguments they write are a read of a tree", () => {
    const calls = sources.flatMap((file) =>
      [
        ...fs
          .readFileSync(file, "utf8")
          .matchAll(/runGit\(\s*\w+,\s*\[([^\]]*)\]/g),
      ].map((m) => m[1]!.replace(/\s+/g, " ").trim()),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(
      /^"ls-tree", "-r", "-z", "--full-tree", "--end-of-options", commit, "--", prefix,?$/,
    );
  });
});
