/**
 * The bindings-log rule: after `proposed`, `bindings.yaml` is what the log
 * says it is. The log in the spec directory is parsed (sequence, entry shape
 * and hash chain), its propose commit must be an ancestor of HEAD,
 * `bindings.yaml` read from git at that commit (never from the work tree)
 * must hash to the propose entry, every bind entry must name a TP ID that
 * existed there, and replaying the bind entries over that file must give the
 * `bindings.yaml` of the spec directory, compared as parsed bindings. When
 * the diff base already holds a log, the log at HEAD must extend it: an
 * entry that was merged is never rewritten, even with a recomputed chain.
 *
 * The rule needs git and is gated: it runs at `proposed` and under
 * `--final`. Without a log it reports nothing at `draft`, so the final lint
 * that `propose` runs before it writes the log can pass.
 */
import {
  BINDINGS_LOG_FILE,
  differingBindings,
  parseBindings,
  parseBindingsLog,
  replayBindings,
  sha256Tag,
} from "../../formats/index.js";
import {
  decodeUtf8,
  readBlobBytes,
  repoPathOf,
  specPathIn,
} from "../../state/git.js";
import { readSpecFile } from "../files.js";
import { LintGitError, isAncestor, isCommit } from "../git/index.js";
import type { RuleContext, RuleDef, RuleFinding } from "../types.js";

const LOG = BINDINGS_LOG_FILE;
const BINDINGS = "bindings.yaml";

function at(code: string, message: string, line?: number): RuleFinding {
  return {
    file: LOG,
    path: "$",
    code,
    message,
    ...(line !== undefined && line > 0 ? { line } : {}),
  };
}

function checkLog(ctx: RuleContext): RuleFinding[] {
  const git = ctx.git;
  const specDir = ctx.specDir;
  if (git === undefined || specDir === undefined) {
    throw new Error(
      "the bindings-log rule ran without git inputs or a spec directory",
    );
  }
  const specPath = specPathIn(git.repo, specDir);
  if (specPath === null) {
    return [
      at("spec-not-in-repo", "the spec directory is not inside the repository"),
    ];
  }
  // The log at the diff base, for example the one merged with the spec.
  const merged = readBlobBytes(
    git.repo,
    git.diffBase,
    repoPathOf(specPath, LOG),
  );
  const read = readSpecFile(specDir, LOG);
  if (!read.ok) {
    if (read.code === "input-missing" && merged !== null) {
      return [
        at(
          "log-removed",
          `${LOG} exists at the diff base and is gone; a merged log is never removed`,
        ),
      ];
    }
    if (read.code === "input-missing") {
      return ctx.status === "proposed"
        ? [
            at(
              "log-missing",
              `the spec is proposed and has no ${LOG}; after proposed a binding changes only through spec-gate bind, which records it there`,
            ),
          ]
        : [];
    }
    return [at(read.code, read.message)];
  }
  const parsed = parseBindingsLog(read.text);
  if (!parsed.ok) {
    return [
      at(parsed.problem.code, parsed.problem.message, parsed.problem.line),
    ];
  }
  const log = parsed.value;

  const commit = log.propose.commit;
  if (!isCommit(git.repo, commit)) {
    return [
      at(
        "propose-not-a-commit",
        `the propose commit ${commit} is not the full id of a commit in the repository`,
        1,
      ),
    ];
  }
  if (!isAncestor(git.repo, commit, git.head)) {
    return [
      at(
        "propose-not-ancestor",
        `the propose commit ${commit} is not an ancestor of HEAD; a log whose propose commit is not in the history of the change binds nothing`,
        1,
      ),
    ];
  }
  const proposedBytes = readBlobBytes(
    git.repo,
    commit,
    repoPathOf(specPath, BINDINGS),
  );
  if (proposedBytes === null) {
    return [
      at(
        "propose-bindings-missing",
        `${BINDINGS} does not exist in the spec directory at the propose commit`,
        1,
      ),
    ];
  }
  if (sha256Tag(proposedBytes) !== log.propose.bindings) {
    return [
      at(
        "propose-hash-mismatch",
        `the hash of ${BINDINGS} at the propose commit is not the one the propose entry records`,
        1,
      ),
    ];
  }
  const proposedText = decodeUtf8(proposedBytes);
  const proposed = proposedText === null ? null : parseBindings(proposedText);
  if (proposed === null || !proposed.ok) {
    return [
      at(
        "propose-bindings-invalid",
        `${BINDINGS} at the propose commit does not parse`,
        1,
      ),
    ];
  }

  const found: RuleFinding[] = [];
  for (const entry of log.binds) {
    if (!(entry.tp in proposed.value)) {
      found.push(
        at(
          "bind-unknown-id",
          `the bind entry for ${entry.tp} names a TP ID that ${BINDINGS} did not have at the propose commit; bind adds and renames no ID`,
          entry.seq,
        ),
      );
    }
  }

  const replay = replayBindings(proposed.value, log.binds);
  const head =
    ctx.inputs.bindings.state === "ok" ? ctx.inputs.bindings.value : null;
  if (head === null) {
    found.push({
      file: BINDINGS,
      path: "$",
      code: "replay-mismatch",
      message: `${BINDINGS} is missing; the replay of ${LOG} gives a binding set`,
    });
  } else {
    for (const tp of differingBindings(replay, head)) {
      found.push({
        file: BINDINGS,
        path: tp,
        id: tp,
        code: "replay-mismatch",
        message: `the binding of ${tp} in ${BINDINGS} is not the one the replay of ${LOG} from the propose commit gives; change a binding with spec-gate bind only`,
      });
    }
  }

  if (merged !== null) {
    const mergedText = decodeUtf8(merged);
    if (mergedText === null || !read.text.startsWith(mergedText)) {
      found.push(
        at(
          "log-rewritten",
          `${LOG} does not extend the log at the diff base; entries that were merged are never changed, removed or reordered`,
        ),
      );
    }
  }
  return found;
}

/** The bindings-log check; a git read that could not run is a finding of the rule. */
export function checkBindingsLog(ctx: RuleContext): RuleFinding[] {
  try {
    return checkLog(ctx);
  } catch (err) {
    if (!(err instanceof LintGitError)) throw err;
    return [
      at(
        err.code,
        `the check could not read the repository (${err.code}); the bindings log is not verified`,
      ),
    ];
  }
}

export const BINDINGS_LOG_RULES: readonly RuleDef[] = [
  {
    id: "bindings-log",
    level: "error",
    profiles: ["light", "full"],
    gated: true,
    ackable: false,
    needsGit: true,
    summary:
      "At proposed bindings.log exists; it parses (seq from 1 in steps of 1, one propose entry and it is first, entry shapes, hash chain); its propose commit is an ancestor of HEAD; bindings.yaml read from git at that commit hashes to the propose entry; every bind entry names a TP ID it had; the replay of the bind entries over it equals bindings.yaml, compared as parsed bindings; and the log extends the log at the diff base, if one is there.",
    needs: ["spec"],
    uses: ["bindings"],
    check: checkBindingsLog,
  },
];
