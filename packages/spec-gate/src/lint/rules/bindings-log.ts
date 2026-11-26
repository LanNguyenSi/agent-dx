/**
 * The bindings-log rule: after `proposed`, `bindings.yaml` is what the log
 * says it is. The log in the spec directory is parsed (sequence, entry shape
 * and hash chain), its propose commit must be an ancestor of HEAD,
 * `bindings.yaml` read from git at that commit (never from the work tree)
 * must hash to the propose entry, every bind entry must name a TP ID that
 * existed there, and replaying the bind entries over that file must give the
 * `bindings.yaml` of the spec directory, compared as parsed bindings; at
 * the propose commit the spec was a draft without a log, and every bind
 * entry keeps to the rule of its row's kind. The spec directory must be
 * `specs/<name>`, one level below the top-level `specs/`: with that, the
 * diff base is searched there by the spec's id, not only its path. Every log
 * merged there for this spec must be extended by the log at HEAD (an entry
 * that was merged is never rewritten, even with a recomputed chain, nor
 * removed), and a proposed spec that left its directory is an error.
 *
 * After a squash or rebase merge the propose commit is not in the history
 * of the default branch. When the diff base holds the log of this spec at
 * the same path with the same propose entry, that merged state is the
 * anchor instead: `bindings.yaml` read from git at the diff base, and only
 * the bind entries after the merged log's last line are checked and
 * replayed over it. Without such a log the propose commit must be an
 * ancestor of HEAD.
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
  parseSpec,
  replayBindings,
  sha256Tag,
  type BindEntry,
  type Bindings,
  type BindingsLog,
} from "../../formats/index.js";
import { bindStatusProblem } from "../../state/bind.js";
import {
  SPECS_DIR,
  decodeUtf8,
  isSpecLayoutPath,
  readBlobBytes,
  regularBlobBytes,
  repoPathOf,
  specDirsAt,
  specPathIn,
} from "../../state/git.js";
import { readSpecFile } from "../files.js";
import { LintGitError, isAncestor, isCommit } from "../git/index.js";
import { valueOf } from "../inputs.js";
import type { GitInputs, RuleContext, RuleDef, RuleFinding } from "../types.js";

const LOG = BINDINGS_LOG_FILE;
const BINDINGS = "bindings.yaml";
const SPEC = "spec.md";

function at(code: string, message: string, line?: number): RuleFinding {
  return {
    file: LOG,
    path: "$",
    code,
    message,
    ...(line !== undefined && line > 0 ? { line } : {}),
  };
}

/** A spec directory at the diff base that carries the same spec id. */
interface Kin {
  /** Its repository path, `specs/<name>`. */
  path: string;
  /** Its frontmatter status at the diff base. */
  status: string;
  /** Its `bindings.log` at the diff base, or `null`. */
  log: Buffer | null;
}

/** The id and status of a `spec.md` given as bytes; `null` when it is absent or does not parse. */
function statusOf(bytes: Buffer | null): { id: string; status: string } | null {
  const text = bytes === null ? null : decodeUtf8(bytes);
  const parsed = text === null ? null : parseSpec(text);
  if (parsed === null || !parsed.ok) return null;
  return {
    id: parsed.value.frontmatter.id,
    status: parsed.value.frontmatter.status,
  };
}

/** The id and status of the spec at `specPath` in `commit`; its `spec.md` must be a regular file. */
function statusAt(
  repo: string,
  commit: string,
  specPath: string,
): { id: string; status: string } | null {
  return statusOf(readBlobBytes(repo, commit, repoPathOf(specPath, SPEC)));
}

/**
 * Every spec directory at the diff base whose `spec.md` carries the id `id`,
 * the current path included when it holds one: the log of a spec is found by
 * the spec's identity, so a directory that was renamed (or copied) after its
 * log was merged does not start a fresh history. The search is the layout,
 * the directories directly inside `specs/`: the rule passes no spec directory
 * anywhere else, so no merged log can live anywhere else. Only a regular
 * `spec.md` that parses counts.
 */
function kinAtDiffBase(repo: string, diffBase: string, id: string): Kin[] {
  const kin: Kin[] = [];
  for (const dir of specDirsAt(repo, diffBase)) {
    const at = statusOf(
      regularBlobBytes(repo, diffBase, repoPathOf(dir, SPEC)),
    );
    if (at === null || at.id !== id) continue;
    kin.push({
      path: dir,
      status: at.status,
      log: readBlobBytes(repo, diffBase, repoPathOf(dir, LOG)),
    });
  }
  return kin;
}

/** The findings of the diff-base search, and the log merged at the spec's own path. */
interface History {
  found: RuleFinding[];
  /** The `bindings.log` the diff base holds for this spec at its own path, or `null`. */
  merged: Buffer | null;
}

/** What the diff base says about this spec: moved directories and merged logs. */
function checkHistory(
  git: GitInputs,
  specPath: string,
  id: string,
  headLog: string | null,
): History {
  const found: RuleFinding[] = [];
  let merged: Buffer | null = null;
  for (const kin of kinAtDiffBase(git.repo, git.diffBase, id)) {
    if (kin.path === specPath) merged = kin.log;
    if (
      kin.path !== specPath &&
      (kin.log !== null || kin.status !== "draft") &&
      readBlobBytes(git.repo, git.head, repoPathOf(kin.path, SPEC)) === null
    ) {
      found.push(
        at(
          "spec-moved",
          `the spec ${id} was at ${kin.path} at the diff base, with a ${LOG} or a status other than draft, and is gone from there; a proposed spec keeps its directory`,
        ),
      );
    }
    if (kin.log === null) continue;
    const where =
      kin.path === specPath ? "" : ` (the spec ${id} at ${kin.path})`;
    if (headLog === null) {
      found.push(
        at(
          "log-removed",
          `${LOG} exists at the diff base${where} and is gone; a merged log is never removed`,
        ),
      );
      continue;
    }
    const text = decodeUtf8(kin.log);
    if (text === null || !headLog.startsWith(text)) {
      found.push(
        at(
          "log-rewritten",
          `${LOG} does not extend the log at the diff base${where}; entries that were merged are never changed, removed or reordered`,
        ),
      );
    }
  }
  return { found, merged };
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
  if (!isSpecLayoutPath(specPath)) {
    return [
      at(
        "spec-off-layout",
        `the spec directory is not ${SPECS_DIR}/<name>, one level below ${SPECS_DIR}/ at the top level of the repository; a spec is proposed and checked there only`,
      ),
    ];
  }
  const id = valueOf(ctx.inputs.spec).frontmatter.id;
  const read = readSpecFile(specDir, LOG);
  if (!read.ok && read.code !== "input-missing") {
    return [at(read.code, read.message)];
  }
  const { found: history, merged } = checkHistory(
    git,
    specPath,
    id,
    read.ok ? read.text : null,
  );
  if (!read.ok) {
    if (history.length > 0) return history;
    return ctx.status === "proposed"
      ? [
          at(
            "log-missing",
            `the spec is proposed and has no ${LOG}; after proposed a binding changes only through spec-gate bind, which records it there`,
          ),
        ]
      : [];
  }
  const parsed = parseBindingsLog(read.text);
  if (!parsed.ok) {
    return [
      ...history,
      at(parsed.problem.code, parsed.problem.message, parsed.problem.line),
    ];
  }
  return [...history, ...checkReplay(ctx, git, specPath, parsed.value, merged)];
}

/** The anchor of a log merged at the diff base: its bindings and the bind entries after it. */
interface MergedAnchor {
  bindings: Bindings;
  binds: BindEntry[];
}

/** A merged log the diff base holds, refused because `bindings.yaml` there no longer matches it. */
interface MergedMismatch {
  /** The TP IDs whose binding differs from their last merged bind entry. */
  mismatch: string[];
}

/**
 * The merged state as the anchor of `log`, or `null` when the diff base
 * holds no usable log for it: the log merged at the spec's own path must
 * parse and carry the propose entry of `log`, and `bindings.yaml` read from
 * git at the diff base must exist, parse and hold, for every TP ID the merged
 * log binds, the binding of its last bind entry (otherwise the TP IDs that
 * differ are returned, for the message). The bind entries to check are
 * those after the merged log's last line; that the log at HEAD extends the
 * merged one byte for byte is `log-rewritten`'s check.
 */
function mergedAnchor(
  git: GitInputs,
  specPath: string,
  log: BindingsLog,
  merged: Buffer | null,
): MergedAnchor | MergedMismatch | null {
  const text = merged === null ? null : decodeUtf8(merged);
  const parsed = text === null ? null : parseBindingsLog(text);
  if (parsed === null || !parsed.ok) return null;
  const base = parsed.value;
  if (
    base.propose.commit !== log.propose.commit ||
    base.propose.bindings !== log.propose.bindings
  ) {
    return null;
  }
  const bytes = readBlobBytes(
    git.repo,
    git.diffBase,
    repoPathOf(specPath, BINDINGS),
  );
  const yaml = bytes === null ? null : decodeUtf8(bytes);
  const bindings = yaml === null ? null : parseBindings(yaml);
  if (bindings === null || !bindings.ok) return null;
  // Every TP ID the merged log binds still holds its last bound value: a
  // bindings.yaml changed on the default branch without a bind entry (a
  // write that skipped the lint) anchors nothing.
  const mismatch = differingBindings(
    replayBindings(bindings.value, base.binds),
    bindings.value,
  );
  if (mismatch.length > 0) return { mismatch };
  const last = base.lines.length;
  return {
    bindings: bindings.value,
    binds: log.binds.filter((entry) => entry.seq > last),
  };
}

function checkReplay(
  ctx: RuleContext,
  git: GitInputs,
  specPath: string,
  log: BindingsLog,
  merged: Buffer | null,
): RuleFinding[] {
  const commit = log.propose.commit;
  const unreachable = !isCommit(git.repo, commit)
    ? at(
        "propose-not-a-commit",
        `the propose commit ${commit} is not the full id of a commit in the repository`,
        1,
      )
    : !isAncestor(git.repo, commit, git.head)
      ? at(
          "propose-not-ancestor",
          `the propose commit ${commit} is not an ancestor of HEAD; a log whose propose commit is not in the history of the change binds nothing`,
          1,
        )
      : null;
  if (unreachable !== null) {
    // After a squash or rebase merge the log the default branch holds is
    // the anchor; without one the log binds nothing.
    const anchor = mergedAnchor(git, specPath, log, merged);
    if (anchor === null) return [unreachable];
    if ("mismatch" in anchor) {
      return [
        {
          ...unreachable,
          message: `${unreachable.message}; ${BINDINGS} at the diff base does not match the merged ${LOG} for ${anchor.mismatch.join(", ")}`,
        },
      ];
    }
    return checkBinds(
      ctx,
      anchor.bindings,
      anchor.binds,
      "at the diff base",
      "from the diff base",
    );
  }
  const found: RuleFinding[] = [];
  // At the propose commit the spec was a draft and had no log yet: a log that
  // names a later commit would re-anchor the bindings there.
  if (statusAt(git.repo, commit, specPath)?.status !== "draft") {
    found.push(
      at(
        "propose-not-draft",
        `${SPEC} at the propose commit is not a draft; propose runs on a draft`,
        1,
      ),
    );
  }
  if (readBlobBytes(git.repo, commit, repoPathOf(specPath, LOG)) !== null) {
    found.push(
      at(
        "propose-log-present",
        `${LOG} already exists at the propose commit; propose creates it`,
        1,
      ),
    );
  }
  const proposedBytes = readBlobBytes(
    git.repo,
    commit,
    repoPathOf(specPath, BINDINGS),
  );
  if (proposedBytes === null) {
    return [
      ...found,
      at(
        "propose-bindings-missing",
        `${BINDINGS} does not exist in the spec directory at the propose commit`,
        1,
      ),
    ];
  }
  if (sha256Tag(proposedBytes) !== log.propose.bindings) {
    return [
      ...found,
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
      ...found,
      at(
        "propose-bindings-invalid",
        `${BINDINGS} at the propose commit does not parse`,
        1,
      ),
    ];
  }

  return [
    ...found,
    ...checkBinds(
      ctx,
      proposed.value,
      log.binds,
      "at the propose commit",
      "from the propose commit",
    ),
  ];
}

/**
 * The bind entries `binds` over the anchor `anchor`: each names a TP ID the
 * anchor had and keeps to its row's kind, and their replay over the anchor
 * equals `bindings.yaml` of the spec directory. `atAnchor` and `fromAnchor`
 * name the anchor in the messages.
 */
function checkBinds(
  ctx: RuleContext,
  anchor: Bindings,
  binds: readonly BindEntry[],
  atAnchor: string,
  fromAnchor: string,
): RuleFinding[] {
  const found: RuleFinding[] = [];
  const kinds = new Map(
    (ctx.inputs.testplan.state === "ok" ? ctx.inputs.testplan.value : []).map(
      (row) => [row.id, row.kind] as const,
    ),
  );
  const statuses = new Map(
    Object.entries(anchor).map(([tp, b]) => [tp, b.status] as const),
  );
  for (const entry of binds) {
    const previous = statuses.get(entry.tp);
    if (previous === undefined) {
      found.push(
        at(
          "bind-unknown-id",
          `the bind entry for ${entry.tp} names a TP ID that ${BINDINGS} did not have ${atAnchor}; bind adds and renames no ID`,
          entry.seq,
        ),
      );
      continue;
    }
    const kind = kinds.get(entry.tp);
    const problem =
      kind === undefined
        ? null
        : bindStatusProblem(kind, previous, entry.binding.status);
    if (problem !== null) {
      found.push(
        at(
          "bind-kind",
          `the bind entry for ${entry.tp} sets status ${entry.binding.status} after ${previous}: ${problem}`,
          entry.seq,
        ),
      );
    }
    statuses.set(entry.tp, entry.binding.status);
  }

  const replay = replayBindings(anchor, binds);
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
        message: `the binding of ${tp} in ${BINDINGS} is not the one the replay of ${LOG} ${fromAnchor} gives; change a binding with spec-gate bind only`,
      });
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
      "At proposed bindings.log exists; it parses (seq from 1 in steps of 1, one propose entry and it is first, entry shapes, hash chain); its propose commit is an ancestor of HEAD where spec.md was a draft without a log; bindings.yaml read from git at that commit hashes to the propose entry; every bind entry names a TP ID it had and keeps to its row's kind; the replay of the bind entries over it equals bindings.yaml, compared as parsed bindings; when the propose commit is not a commit or not an ancestor of HEAD (after a squash or rebase merge) and the diff base holds the log of this spec at the same path with the same propose entry, bindings.yaml read from git at the diff base is the anchor instead and only the bind entries after that log are checked and replayed over it; the spec directory is specs/<name>, one level below the top-level specs/; every log the diff base holds there for a spec of the same id is extended, not rewritten or removed; and a proposed spec has not left its directory.",
    needs: ["spec"],
    uses: ["bindings", "testplan"],
    check: checkBindingsLog,
  },
];
