/**
 * The reference-state rules: the revisions a spec names must be the ones the
 * steps may trust. `base_commit` and `commands_ref` are set by the intake
 * step, never by a model role, so a lint that sees one that is not an
 * ancestor of the reference commit (the pull request base, or the fetched
 * default branch) stops the run: a commit that exists only on the head of
 * the pull request, or on a fork, is the spec author's own input.
 *
 * `meta-frontmatter-mismatch` needs no repository. The other four read git
 * through `src/lint/git/` and are skipped without it; none of them fetches
 * or writes, and the test for each reference is "ancestor of the reference
 * commit", never "the commit exists" and never "reachable from HEAD".
 */
import { parseCommandSet } from "../../formats/index.js";
import { META_COMMIT_FIELDS } from "../meta.js";
import {
  LintGitError,
  changedPaths,
  isAncestor,
  isCommit,
  readBlobAtCommit,
} from "../git/index.js";
import { valueOf } from "../inputs.js";
import type { GitInputs, RuleContext, RuleDef, RuleFinding } from "../types.js";

const SPEC = "spec.md";
const TESTPLAN = "testplan.yaml";
const META = "source/meta.json";
const BOTH: RuleDef["profiles"] = ["light", "full"];

/** The directory a spec pull request must not change. */
export const SPEC_GATE_DIR = ".spec-gate";
export const COMMANDS_PATH = `${SPEC_GATE_DIR}/commands.yaml`;

/** The repository of a rule that declared `needsGit`; the engine skips the rule otherwise. */
function gitOf(ctx: RuleContext): GitInputs {
  if (ctx.git === undefined) {
    throw new Error("a rule read git inputs it did not declare in needsGit");
  }
  return ctx.git;
}

/**
 * A git read that could not run (git missing, too slow, too much output) is
 * an error of the rule, not an exception and not a pass: the reference
 * state was not checked, and an unchecked reference is not a trusted one.
 */
function guarded(
  file: string,
  path: string,
  // eslint-disable-next-line no-unused-vars
  check: (ctx: RuleContext, git: GitInputs) => RuleFinding[],
  // eslint-disable-next-line no-unused-vars
): (ctx: RuleContext) => RuleFinding[] {
  return (ctx) => {
    try {
      return check(ctx, gitOf(ctx));
    } catch (err) {
      if (!(err instanceof LintGitError)) throw err;
      return [
        {
          file,
          path,
          code: err.code,
          message: `the check could not read the repository (${err.code}); the reference state is not verified`,
        },
      ];
    }
  };
}

/** `base_commit` and `commands_ref` in `source/meta.json` equal the frontmatter's. */
export function checkMetaFrontmatterMismatch(ctx: RuleContext): RuleFinding[] {
  const frontmatter = valueOf(ctx.inputs.spec).frontmatter;
  const meta = valueOf(ctx.inputs.meta);
  const found: RuleFinding[] = [];
  for (const field of META_COMMIT_FIELDS) {
    if (meta[field] !== frontmatter[field]) {
      found.push({
        file: META,
        path: field,
        message: `${field} in ${META} differs from ${field} in the ${SPEC} frontmatter; the two must name the same commit`,
      });
    }
  }
  return found;
}

type Standing = "trusted" | "not-a-commit" | "not-ancestor";

/**
 * Whether `id` may be trusted as a reference: the full id of a commit object
 * that is an ancestor of the reference commit (the commit itself counts).
 */
function standing(git: GitInputs, id: string): Standing {
  if (!isCommit(git.repo, id)) return "not-a-commit";
  return isAncestor(git.repo, id, git.reference) ? "trusted" : "not-ancestor";
}

function ancestryCheck(
  field: "base_commit" | "commands_ref",
  // eslint-disable-next-line no-unused-vars
): (ctx: RuleContext) => RuleFinding[] {
  return guarded(SPEC, field, (ctx, git) => {
    const id = valueOf(ctx.inputs.spec).frontmatter[field];
    const state = standing(git, id);
    if (state === "trusted") return [];
    return [
      {
        file: SPEC,
        path: field,
        code: state,
        message:
          state === "not-a-commit"
            ? `${field} ${id} is not the full id of a commit in the repository`
            : `${field} ${id} is not an ancestor of the reference commit; a commit that exists only on the head of the pull request or on a fork is not a trusted reference`,
      },
    ];
  });
}

/** The printable form of a path from git: control characters become `?`. */
function printable(p: string): string {
  // eslint-disable-next-line no-control-regex
  return p.replace(/[\u0000-\u001f\u007f]/g, "?");
}

/** No file under `.spec-gate/` differs between the diff base and the head. */
export const checkSpecChangesConfig = guarded(
  `repo:${SPEC_GATE_DIR}`,
  "$",
  (_ctx, git) =>
    changedPaths(git.repo, git.diffBase, git.head, SPEC_GATE_DIR).map((p) => ({
      file: `repo:${printable(p)}`,
      path: "$",
      code: "spec-changes-config",
      message: `the spec change touches ${SPEC_GATE_DIR}/; a change there is a pull request of its own and a spec pull request that makes one is never approved`,
    })),
);

/** Every `static` row's `check_command_ref` names a command of the set at `commands_ref`. */
export const checkStaticCommandUnknown = guarded(
  `repo:${COMMANDS_PATH}`,
  "$",
  (ctx, git) => {
    const rows = valueOf(ctx.inputs.testplan).filter(
      (row) => row.kind === "static",
    );
    if (rows.length === 0) return [];
    const ref = valueOf(ctx.inputs.spec).frontmatter.commands_ref;
    // The command set at a commit the ancestry check refused is never read:
    // what a fork or a pull request head says is not what the runner runs.
    if (standing(git, ref) !== "trusted") {
      return [
        {
          file: SPEC,
          path: "commands_ref",
          code: "commands-ref-untrusted",
          message: `${rows.length === 1 ? "a static row needs" : "static rows need"} the command set at commands_ref, which is not read because commands_ref is not a trusted reference (see commands-ref-not-ancestor)`,
        },
      ];
    }
    const file = `repo:${COMMANDS_PATH}`;
    let text: string;
    try {
      text = readBlobAtCommit(git.repo, ref, COMMANDS_PATH);
    } catch (err) {
      if (
        !(err instanceof LintGitError) ||
        err.code === "git-failed" ||
        err.code === "output-too-large" ||
        err.code === "object-unreadable"
      ) {
        throw err;
      }
      const missing =
        err.code === "path-missing" || err.code === "path-not-regular";
      return [
        {
          file,
          path: "$",
          code: missing ? "commands-file-missing" : "commands-file-invalid",
          message: missing
            ? `a static row needs ${COMMANDS_PATH} at commands_ref, which is missing there or is not a regular file`
            : `${COMMANDS_PATH} at commands_ref is not valid UTF-8`,
        },
      ];
    }
    const parsed = parseCommandSet(text);
    if (!parsed.ok) {
      const first = parsed.errors[0]!;
      return [
        {
          file,
          path: "$",
          code: "commands-file-invalid",
          message: `${COMMANDS_PATH} at commands_ref does not parse (${parsed.errors.length} error${parsed.errors.length === 1 ? "" : "s"}, the first ${first.code} at ${first.path})`,
        },
      ];
    }
    const names = new Set(parsed.value.commands.map((c) => c.name));
    return rows
      .filter((row) => !names.has(row.check_command_ref ?? ""))
      .map((row) => ({
        file: TESTPLAN,
        path: `${row.id}.check_command_ref`,
        id: row.id,
        message: `${row.id}: check_command_ref ${row.check_command_ref ?? ""} is not a command of ${COMMANDS_PATH} at commands_ref`,
      }));
  },
);

export const REF_RULES: readonly RuleDef[] = [
  {
    id: "meta-frontmatter-mismatch",
    level: "error",
    profiles: BOTH,
    gated: false,
    ackable: false,
    summary:
      "base_commit and commands_ref in source/meta.json equal those in the spec.md frontmatter; it needs no repository and runs in both profiles.",
    needs: ["spec", "meta"],
    check: checkMetaFrontmatterMismatch,
  },
  {
    id: "base-commit-not-ancestor",
    level: "error",
    profiles: BOTH,
    gated: false,
    ackable: false,
    needsGit: true,
    summary:
      "The frontmatter base_commit is the full id of a commit in the repository and an ancestor of the reference commit (the --base commit, else the --default-ref commit); a commit that exists only on the pull request head or a fork is an error.",
    needs: ["spec"],
    check: ancestryCheck("base_commit"),
  },
  {
    id: "commands-ref-not-ancestor",
    level: "error",
    profiles: BOTH,
    gated: false,
    ackable: false,
    needsGit: true,
    summary:
      "The frontmatter commands_ref is the full id of a commit in the repository and an ancestor of the reference commit, checked like base_commit.",
    needs: ["spec"],
    check: ancestryCheck("commands_ref"),
  },
  {
    id: "spec-changes-config",
    level: "error",
    profiles: BOTH,
    gated: false,
    ackable: false,
    needsGit: true,
    summary:
      "No path under .spec-gate/ differs between merge-base(HEAD, reference commit) and HEAD, renames not detected; changes made only on the base side do not count.",
    needs: [],
    check: checkSpecChangesConfig,
  },
  {
    id: "static-command-unknown",
    level: "error",
    profiles: BOTH,
    gated: false,
    ackable: false,
    needsGit: true,
    summary:
      "Every static test-plan row's check_command_ref names a command of .spec-gate/commands.yaml at commands_ref; a missing or invalid command set there is an error, and the set is not read at a commands_ref that failed its ancestry check.",
    needs: ["spec", "testplan"],
    check: checkStaticCommandUnknown,
  },
];
