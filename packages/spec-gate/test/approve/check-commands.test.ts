/**
 * The `commands` field of the report: the argv lists a runner may start
 * for the spec, read from git at the `commands_ref` of the spec at the
 * head. It is shown to the reader and is never a condition.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS_GAP, specCommandsAt } from "../../src/approve/index.js";
import {
  COMMANDS_OK,
  Repo,
  SPEC_REL,
  STATIC_PLAN,
  specFiles,
  type Change,
} from "../lint/git-helpers.js";
import { BIND_PLAN } from "../state/helpers.js";
import { build, check, codes, cond, failing, review } from "./helpers.js";

/** A full commit id no test repository holds. */
const NO_COMMIT = "d".repeat(40);

/** A row that names the command `name`. */
const staticRow = (id: string, name: string): string =>
  `- id: ${id}\n  covers: [AC-1]\n  kind: static\n  claim: "the ${name} check passes"\n  check_command_ref: ${name}\n`;

/**
 * A set whose file order is not the order of the names: the selector
 * command first, a command no row names last.
 */
const SET =
  'discovery:\n  argv: ["npx", "vitest", "list"]\n' +
  "commands:\n" +
  '  unit:\n    argv: ["npx", "vitest", "run", "-t", "{selector}"]\n' +
  '  typecheck:\n    argv: ["npm", "run", "typecheck"]\n' +
  '  lint:\n    argv: ["npm", "run", "lint"]\n' +
  '  build:\n    argv: ["npm", "run", "build"]\n';

const PLAN = `${BIND_PLAN}\n${staticRow("TP-4", "typecheck")}${staticRow("TP-5", "lint")}`;

const COLDREAD = { code: "coldread-not-checked", message: expect.any(String) };

describe("the commands of the report", { timeout: 60_000 }, () => {
  it("lists the commands the rows name and the selector command, sorted by name, and no other command of the set", async () => {
    const s = await build({ commands: SET, plan: PLAN });
    const report = await check(s);
    expect(report.commands).toEqual([
      { name: "lint", argv: ["npm", "run", "lint"] },
      { name: "typecheck", argv: ["npm", "run", "typecheck"] },
      { name: "unit", argv: ["npx", "vitest", "run", "-t", "{selector}"] },
    ]);
    expect(report.gaps).toEqual([COLDREAD]);
    expect(codes(report)).toEqual(Array(8).fill("ok"));
    expect(report.approved).toBe(true);
  });

  it("is an empty list for a spec that names no command against a set without a selector command", async () => {
    const report = await check(await build());
    expect(report.commands).toEqual([]);
    expect(report.gaps).toEqual([COLDREAD]);
    expect(report.approved).toBe(true);
  });

  it("reads the set at commands_ref: a set changed on the default branch since, which the head holds too, is not what is listed", async () => {
    const changed =
      'discovery:\n  argv: ["true"]\n' +
      "commands:\n" +
      '  typecheck:\n    argv: ["sh", "-c", "exit 0"]\n' +
      '  unit:\n    argv: ["sh", "-c", "exit 0", "{selector}"]\n';
    const s = await build({
      commands: COMMANDS_OK,
      plan: `${BIND_PLAN}\n${staticRow("TP-4", "typecheck")}`,
      later: { ".spec-gate/commands.yaml": changed },
    });
    // The tip of the default branch and the head both hold the changed set.
    for (const commit of [s.tip!, s.head]) {
      expect(
        await s.repo.sh("show", `${commit}:.spec-gate/commands.yaml`),
      ).toBe(changed.trim());
    }
    const report = await check(s);
    expect(report.default_commit).toBe(s.tip);
    expect(report.commands).toEqual([
      { name: "typecheck", argv: ["npm", "run", "typecheck"] },
    ]);
    expect(report.approved).toBe(true);
  });

  it("no command set at commands_ref: null and a gap with the reason, and no condition changes", async () => {
    const s = await build({ commands: null });
    const report = await check(s);
    expect(report.commands).toBeNull();
    expect(report.gaps).toEqual([
      COLDREAD,
      {
        code: COMMANDS_GAP,
        message:
          "the commands of the spec could not be read from git at its commands_ref (commands-file-missing); the report lists none",
      },
    ]);
    expect(report.conditions).toHaveLength(8);
    expect(codes(report)).toEqual(Array(8).fill("ok"));
    expect(report.approved).toBe(true);
  });

  it("a row that names a command the set lacks: null and a gap; the conditions fail for their own reasons", async () => {
    const s = await build();
    const head = await s.repo.commit(
      {
        [`${SPEC_REL}/testplan.yaml`]: `${BIND_PLAN}\n${staticRow("TP-4", "nope")}`,
      },
      "a row names an unknown command",
    );
    const report = await check(
      { ...s, head },
      { reviews: [review("alice", "APPROVED", head)] },
    );
    expect(report.commands).toBeNull();
    expect(report.gaps.at(-1)).toEqual({
      code: COMMANDS_GAP,
      message: expect.stringContaining("(command-ref-unknown)"),
    });
    expect(report.conditions).toHaveLength(8);
    expect(cond(report, 3).code).toBe("digest-unavailable");
    expect(failing(report)).toEqual([3, 4]);
    expect(report.approved).toBe(false);
  });
});

describe("specCommandsAt", { timeout: 60_000 }, () => {
  /** A repository with `SET` at one commit and a spec with `PLAN` at the next. */
  async function repoWithSpec(): Promise<{
    repo: Repo;
    c1: string;
    head: string;
  }> {
    const repo = await Repo.create();
    const c1 = await repo.commit({ ".spec-gate/commands.yaml": SET }, "set");
    const head = await repo.commit(
      specFiles({ base: c1, ref: c1, plan: PLAN }),
      "spec",
    );
    return { repo, c1, head };
  }

  const LISTED = {
    ok: true,
    commands: [
      { name: "lint", argv: ["npm", "run", "lint"] },
      { name: "typecheck", argv: ["npm", "run", "typecheck"] },
      { name: "unit", argv: ["npx", "vitest", "run", "-t", "{selector}"] },
    ],
  };

  it("reads the commit it is given, not the work tree", async () => {
    const { repo, head } = await repoWithSpec();
    expect(specCommandsAt(repo.dir, head, SPEC_REL)).toEqual(LISTED);
    fs.writeFileSync(path.join(repo.spec, "testplan.yaml"), STATIC_PLAN);
    fs.writeFileSync(
      path.join(repo.dir, ".spec-gate", "commands.yaml"),
      'commands:\n  typecheck:\n    argv: ["true"]\n',
    );
    expect(specCommandsAt(repo.dir, head, SPEC_REL)).toEqual(LISTED);
  });

  it("gives a fresh list each time", async () => {
    const { repo, head } = await repoWithSpec();
    const one = specCommandsAt(repo.dir, head, SPEC_REL);
    if (!one.ok) throw new Error(one.problem);
    one.commands[0]!.argv.push("--fix");
    expect(specCommandsAt(repo.dir, head, SPEC_REL)).toEqual(LISTED);
  });

  it("names the problem where the commands cannot be listed, and never gives an empty list there", async () => {
    const { repo, c1, head } = await repoWithSpec();
    const good = specFiles({ base: c1, ref: c1, plan: PLAN });
    /** The result at a commit that holds the good spec, `change` applied. */
    const at = async (
      what: string,
      change: Record<string, Change>,
    ): Promise<unknown> => {
      const commit = await repo.commit({ ...good, ...change }, what);
      return specCommandsAt(repo.dir, commit, SPEC_REL);
    };
    const problem = (code: string) => ({ ok: false, problem: code });
    const spec = good[`${SPEC_REL}/spec.md`]!;

    expect(specCommandsAt(repo.dir, c1, SPEC_REL)).toEqual(
      problem("spec-unreadable"),
    );
    expect(specCommandsAt(repo.dir, head, "specs/other")).toEqual(
      problem("spec-unreadable"),
    );
    expect(
      await at("a spec that does not parse", {
        [`${SPEC_REL}/spec.md`]: "no frontmatter\n",
      }),
    ).toEqual(problem("spec-unreadable"));
    expect(
      await at("a spec that is a link", {
        [`${SPEC_REL}/real.md`]: spec,
        [`${SPEC_REL}/spec.md`]: { linkTo: "real.md" },
      }),
    ).toEqual(problem("git-failed"));
    expect(
      await at("no plan", {
        [`${SPEC_REL}/real.md`]: null,
        [`${SPEC_REL}/testplan.yaml`]: null,
      }),
    ).toEqual(problem("testplan-unreadable"));
    expect(
      await at("a plan that does not parse", {
        [`${SPEC_REL}/testplan.yaml`]: "- id: [\n",
      }),
    ).toEqual(problem("testplan-unreadable"));
    expect(
      await at("a row that names a command the set lacks", {
        [`${SPEC_REL}/testplan.yaml`]: `${PLAN}${staticRow("TP-6", "nope")}`,
      }),
    ).toEqual(problem("command-ref-unknown"));
    expect(
      await at("a commands_ref that is no commit of the repository", {
        [`${SPEC_REL}/spec.md`]: spec.replace(
          `commands_ref: ${c1}`,
          `commands_ref: ${NO_COMMIT}`,
        ),
      }),
    ).toEqual(problem("commands-ref-unresolvable"));

    // A commands_ref whose commit holds no set, a set that is a link, a set
    // that does not parse.
    const refAt = async (what: string, set: Change): Promise<unknown> => {
      const ref = await repo.commit(
        { ".spec-gate/real.yaml": SET, ".spec-gate/commands.yaml": set },
        what,
      );
      return at(`a spec with ${what}`, {
        [`${SPEC_REL}/spec.md`]: spec.replace(
          `commands_ref: ${c1}`,
          `commands_ref: ${ref}`,
        ),
      });
    };
    expect(await refAt("no set", null)).toEqual(
      problem("commands-file-missing"),
    );
    expect(
      await refAt("a set that is a link", { linkTo: "real.yaml" }),
    ).toEqual(problem("commands-file-missing"));
    expect(
      await refAt("a shell string", 'commands:\n  x: "sh -c x"\n'),
    ).toEqual(problem("commands-file-invalid"));
    // The good files again: the problems above were the changes, nothing else.
    expect(await at("the good spec", {})).toEqual(LISTED);
  });

  it("with no row that names a command, a set that cannot be read is still a problem", async () => {
    const repo = await Repo.create();
    const c1 = await repo.commit({ "README.md": "one\n" }, "no set");
    const head = await repo.commit(
      specFiles({ base: c1, ref: c1, plan: BIND_PLAN }),
      "spec",
    );
    expect(specCommandsAt(repo.dir, head, SPEC_REL)).toEqual({
      ok: false,
      problem: "commands-file-missing",
    });
  });
});
