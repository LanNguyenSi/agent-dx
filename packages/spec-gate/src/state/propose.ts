/**
 * `spec-gate propose`: the step from `draft` to `proposed`.
 *
 * It refuses, writing nothing, unless all of this holds: git inputs are
 * given (`--repo` and `--default-ref`, `--base` optional, resolved as for
 * the lint), the spec directory is `specs/<name>`, one level below the top-level
 * `specs/` of the repository, the frontmatter status is `draft`, no
 * `bindings.log` exists, and
 * `spec.md` and `bindings.yaml` in the work tree are byte for byte the files
 * at `HEAD` (the propose entry hashes the committed `bindings.yaml`, so the
 * work tree must not hold another one). Then it runs the lint as
 * `lint --final` with the same git inputs, in process: a report with an
 * error finding (a `rule-skipped` one included) is the result and nothing is
 * written. On a clean final lint it sets the frontmatter `status` to
 * `proposed`, changing that one line and no other byte, and creates
 * `bindings.log` with the propose entry for the commit at `HEAD`.
 *
 * Write order: `spec.md` first, then `bindings.log`. A run stopped between
 * the two leaves a spec that is `proposed` without a log, which the
 * bindings-log rule reports in every lint run; the other order would leave
 * a `draft` spec with a log, which a lint without `--final` does not look at.
 */
import fs from "node:fs";
import path from "node:path";
import {
  BINDINGS_LOG_FILE,
  parseSpec,
  serializeProposeEntry,
  sha256Tag,
  type Spec,
} from "../formats/index.js";
import { LintGitError } from "../lint/git/exec.js";
import { resolveHead } from "../lint/git/index.js";
import {
  hasGitInputs,
  resolveGitInputs,
  type GitRequest,
} from "../lint/git/resolve.js";
import { BINDINGS_FILE, SPEC_FILE } from "../lint/load.js";
import { lintSpecDir } from "../lint/run.js";
import { RULES } from "../lint/registry.js";
import type { LintReport, RuleDef } from "../lint/types.js";
import {
  SPECS_DIR,
  isRepoPath,
  isSpecLayoutPath,
  readBlobBytes,
  repoPathOf,
  specPathIn,
} from "./git.js";
import { createFile, replaceFile } from "./write.js";

export type ProposeResult =
  | { kind: "written"; spec: string; commit: string }
  | { kind: "findings"; report: LintReport }
  | { kind: "refused"; message: string };

function refuse(message: string): ProposeResult {
  return { kind: "refused", message: `propose: ${message}` };
}

/** The bytes of a regular file of the spec directory; `null` when it is absent. */
function workBytes(dir: string, name: string): Buffer | null | "not-regular" {
  const file = path.join(dir, name);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) return "not-regular";
  return fs.readFileSync(file);
}

const KEEP_BOM = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * `text` with the frontmatter `status` line replaced by `status: proposed`,
 * its line ending kept; every other byte stays. `null` when the frontmatter
 * does not hold exactly one `status:` line at column 0.
 */
export function withStatusProposed(text: string): string | null {
  const lines = text.split(/(?<=\n)/);
  // A byte order mark may open the first line, as the parser allows.
  const bare = (i: number) =>
    (i === 0 ? lines[i]!.replace(/^\uFEFF/, "") : lines[i]!).replace(
      /\r?\n$/,
      "",
    );
  if (lines.length === 0 || bare(0) !== "---") return null;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (bare(i) === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) return null;
  const at: number[] = [];
  for (let i = 1; i < close; i++) {
    if (lines[i]!.startsWith("status:")) at.push(i);
  }
  if (at.length !== 1) return null;
  const i = at[0]!;
  const ending = /\r?\n$/.exec(lines[i]!)?.[0] ?? "";
  const out = [...lines];
  out[i] = `status: proposed${ending}`;
  return out.join("");
}

/** Whether `after` is `before` with only the status changed to `proposed`. */
function onlyStatusChanged(before: Spec, after: Spec): boolean {
  const expected: Spec = {
    ...before,
    frontmatter: { ...before.frontmatter, status: "proposed" },
  };
  return JSON.stringify(expected) === JSON.stringify(after);
}

/**
 * Proposes one spec directory. `rules` is the rule list of the final lint;
 * it defaults to the registry, and a test passes its own.
 */
export function proposeSpecDir(
  specDir: string,
  request: GitRequest | undefined,
  rules: readonly RuleDef[] = RULES,
): ProposeResult {
  const dir = path.resolve(specDir);
  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(dir);
  } catch {
    return refuse(`${specDir} is not a directory`);
  }
  if (dirStat.isSymbolicLink()) {
    return refuse(`${specDir} is a symlink, refusing to write into it`);
  }
  if (!dirStat.isDirectory()) return refuse(`${specDir} is not a directory`);

  if (!hasGitInputs(request)) {
    return refuse(
      "needs git inputs: --repo <dir> and --default-ref <ref>; the final lint it runs does not pass without them",
    );
  }
  const resolved = resolveGitInputs(dir, request);
  if (!resolved.ok) return refuse(resolved.message);
  const git = resolved.git!;
  const specPath = specPathIn(git.repo, dir);
  if (specPath === null) {
    return refuse("the spec directory is not inside the repository");
  }
  if (!isSpecLayoutPath(specPath)) {
    return refuse(
      `the spec directory must be ${SPECS_DIR}/<name>, one level below ${SPECS_DIR}/ at the top level of the repository`,
    );
  }
  if (
    !isRepoPath(repoPathOf(specPath, SPEC_FILE)) ||
    !isRepoPath(repoPathOf(specPath, BINDINGS_LOG_FILE))
  ) {
    return refuse(
      "the path of the spec directory holds a character the git reads do not accept",
    );
  }

  try {
    fs.lstatSync(path.join(dir, BINDINGS_LOG_FILE));
    return refuse(
      `${BINDINGS_LOG_FILE} already exists; a spec is proposed once`,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return refuse(`${BINDINGS_LOG_FILE} cannot be checked`);
    }
  }

  const committed: Record<string, Buffer> = {};
  for (const name of [SPEC_FILE, BINDINGS_FILE]) {
    const work = workBytes(dir, name);
    if (work === null) return refuse(`${name} does not exist`);
    if (work === "not-regular") {
      return refuse(
        `${name} must be a regular file, not a link or a directory`,
      );
    }
    let head: Buffer | null;
    try {
      head = readBlobBytes(git.repo, git.head, repoPathOf(specPath, name));
    } catch (err) {
      if (!(err instanceof LintGitError)) throw err;
      return refuse(`${name} at HEAD could not be read (${err.code})`);
    }
    if (head === null) return refuse(`${name} is not committed at HEAD`);
    if (!head.equals(work)) {
      return refuse(
        `${name} in the work tree differs from HEAD; commit it first, propose hashes the committed file`,
      );
    }
    committed[name] = head;
  }

  let specText: string;
  try {
    specText = KEEP_BOM.decode(committed[SPEC_FILE]!);
  } catch {
    return refuse(`${SPEC_FILE} is not valid UTF-8`);
  }
  const before = parseSpec(specText);
  if (!before.ok) {
    const first = before.errors[0]!;
    return refuse(
      `${SPEC_FILE} does not parse (${first.code} at ${first.path}); run spec-gate lint`,
    );
  }
  if (before.value.frontmatter.status !== "draft") {
    return refuse(
      `the status is ${before.value.frontmatter.status}; only a draft can be proposed`,
    );
  }

  const lint = lintSpecDir(dir, { final: true, git: request }, rules);
  if (!lint.ok) return refuse(lint.message);
  if (!lint.report.ok) return { kind: "findings", report: lint.report };

  let headNow: string;
  try {
    headNow = resolveHead(git.repo);
  } catch {
    return refuse("HEAD could not be read again after the lint");
  }
  if (headNow !== git.head) {
    return refuse("HEAD moved while the lint ran; nothing was written");
  }

  const next = withStatusProposed(specText);
  const after = next === null ? null : parseSpec(next);
  if (
    next === null ||
    after === null ||
    !after.ok ||
    !onlyStatusChanged(before.value, after.value)
  ) {
    return refuse(
      `the status line of ${SPEC_FILE} could not be changed alone; nothing was written`,
    );
  }

  const wroteSpec = replaceFile(dir, SPEC_FILE, next);
  if (!wroteSpec.ok) return refuse(`${wroteSpec.message}; nothing was written`);
  const line = serializeProposeEntry(
    git.head,
    sha256Tag(committed[BINDINGS_FILE]!),
  );
  const wroteLog = createFile(dir, BINDINGS_LOG_FILE, `${line}\n`);
  if (!wroteLog.ok) {
    return refuse(
      `${wroteLog.message}; ${SPEC_FILE} is already proposed, and the lint reports the missing ${BINDINGS_LOG_FILE}`,
    );
  }
  return {
    kind: "written",
    spec: before.value.frontmatter.id,
    commit: git.head,
  };
}
