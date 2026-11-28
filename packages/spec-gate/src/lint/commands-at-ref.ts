/**
 * The command a test-plan row runs, read from `.spec-gate/commands.yaml`
 * at the spec's `commands_ref`. Shared by the `stale-evidence` lint rule
 * and the closing check, which both compare an envelope's
 * `commands_digest` with `expectedCommandsDigest` of that one command.
 */
import {
  parseCommandSet,
  type Binding,
  type TestPlanRow,
} from "../formats/index.js";
import {
  LintGitError,
  isAncestor,
  isCommit,
  readBlobAtCommit,
} from "./git/index.js";

export const COMMANDS_PATH = ".spec-gate/commands.yaml";

/**
 * The argv template of the one command a row's check runs, or `undefined`
 * when the row has no determinable command: a `static` row whose
 * `check_command_ref` names no command of the set, a row that is not
 * `static` and whose binding has no selector, or a selector-bound row
 * while no command of the set carries the placeholder.
 */
export function rowTemplate(
  row: TestPlanRow,
  binding: Binding | undefined,
  selectorArgv: readonly string[] | undefined,
  byName: ReadonlyMap<string, readonly string[]>,
): readonly string[] | undefined {
  if (row.kind === "static") {
    return byName.get(row.check_command_ref ?? "") ?? undefined;
  }
  if (binding?.selector !== undefined) return selectorArgv;
  return undefined;
}

export type Templates =
  | { ok: true; selectorArgv?: string[]; byName: Map<string, string[]> }
  | { ok: false; code: string; message: string };

/**
 * The command set at `commandsRef`, read only at that commit and never at
 * a `commandsRef` that is not a commit of `repo` or not an ancestor of (or
 * equal to) `reference`, the trusted reference commit. A git read that
 * could not run is thrown to the caller.
 */
export function templatesAtCommandsRef(
  repo: string,
  commandsRef: string,
  reference: string,
): Templates {
  if (
    !isCommit(repo, commandsRef) ||
    !isAncestor(repo, commandsRef, reference)
  ) {
    return {
      ok: false,
      code: "commands-ref-untrusted",
      message: `the expected digest needs ${COMMANDS_PATH} at commands_ref, which is not read because commands_ref is not a trusted reference (see commands-ref-not-ancestor)`,
    };
  }
  let text: string;
  try {
    text = readBlobAtCommit(repo, commandsRef, COMMANDS_PATH);
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
    return {
      ok: false,
      code: missing ? "commands-file-missing" : "commands-file-invalid",
      message: missing
        ? `the expected digest needs ${COMMANDS_PATH} at commands_ref, which is missing there or is not a regular file`
        : `the expected digest needs ${COMMANDS_PATH} at commands_ref, which is not valid UTF-8 there`,
    };
  }
  const parsed = parseCommandSet(text);
  if (!parsed.ok) {
    return {
      ok: false,
      code: "commands-file-invalid",
      message: `the expected digest needs ${COMMANDS_PATH} at commands_ref, which does not parse there`,
    };
  }
  const byName = new Map<string, string[]>();
  let selectorArgv: string[] | undefined;
  for (const command of parsed.value.commands) {
    byName.set(command.name, command.argv);
    if (command.usesSelector) selectorArgv = command.argv;
  }
  return selectorArgv
    ? { ok: true, selectorArgv, byName }
    : { ok: true, byName };
}
