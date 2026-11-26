/**
 * The merged check of `spec-gate export --format ow`: the three files of
 * the spec directory must be byte-equal in the work tree and in the tree
 * of the `--default-ref` commit, the status must be `proposed`, and what
 * remains is parsed once for the exporter.
 *
 * The git reads go through the hardened read-only primitives the lint
 * git layer provides (argument list, no shell, scrubbed environment, a
 * full ref resolved to one full commit id, regular file entries only),
 * and the work tree entries are regular files at their own names: a
 * symbolic link is refused on both sides, so no name can stand in for
 * content the reference commit does not hold under that name. The
 * comparison is of raw bytes, taken before any decoding, so a byte order
 * mark or a line ending that appears only on one side is a difference.
 */
import fs from "node:fs";
import path from "node:path";
import {
  type Bindings,
  type ParseResult,
  type Spec,
  type TestPlan,
  parseBindings,
  parseSpec,
  parseTestPlan,
} from "../formats/index.js";
import {
  SPEC_FILE,
  TESTPLAN_FILE,
  DigestError,
  repoToplevel,
} from "../canonical/index.js";
import { isInside } from "../canonical/git-hardening.js";
import {
  LintGitError,
  readBlobAtCommit,
  resolveRef,
} from "../lint/git/index.js";
import { runGit } from "../lint/git/exec.js";
import { ExportError } from "./errors.js";
import type { ExportErrorCode } from "./errors.js";
import { assertCanonicalBindingPaths } from "./paths.js";
import { decodeWorktreeText, readWorktreeBytes } from "./worktree.js";

export const BINDINGS_FILE = "bindings.yaml";

/** The files the merged check compares and the exporter reads. */
const SPEC_FILES = [SPEC_FILE, TESTPLAN_FILE, BINDINGS_FILE] as const;

export interface MergedInputs {
  spec: Spec;
  testPlan: TestPlan;
  bindings: Bindings;
  /** The repository top level, as git reports it. */
  toplevel: string;
  /** The full commit id `--default-ref` resolved to. */
  commit: string;
  /** The spec directory relative to the top level, `/` separated. */
  specRel: string;
}

export interface MergedRequest {
  repo?: string;
  defaultRef?: string;
}

function parseInput<T>(
  result: ParseResult<T>,
  code: ExportErrorCode,
  name: string,
): T {
  if (result.ok) return result.value;
  const first = result.errors[0];
  throw new ExportError(
    code,
    `${name} is not valid (${result.errors.length} error(s)): ${first?.message ?? "no detail"}`,
  );
}

/**
 * Resolve `--repo` and `--default-ref`, refuse anything that is not a
 * proposed spec of the repository, and require every spec file to be equal
 * in the work tree and at the reference commit.
 */
export function loadMergedSpecDir(
  specDir: string,
  request: MergedRequest,
): MergedInputs {
  if (request.repo === undefined || request.repo.trim() === "") {
    throw new ExportError(
      "usage",
      "--repo <dir> is required with --format: name the trusted checkout root; the repository is never discovered from the spec directory",
    );
  }
  if (request.defaultRef === undefined || request.defaultRef.trim() === "") {
    throw new ExportError(
      "usage",
      "--default-ref <full ref name> is required with --format: the spec must be merged on that branch unchanged",
    );
  }
  let toplevel: string;
  try {
    toplevel = repoToplevel(path.resolve(request.repo));
  } catch (err) {
    if (!(err instanceof DigestError)) throw err;
    throw new ExportError(
      err.code === "repo-not-found" || err.code === "repo-invalid"
        ? "repo-invalid"
        : "git-failed",
      `--repo: ${err.message}`,
    );
  }
  let commit: string;
  try {
    commit = resolveRef(toplevel, request.defaultRef);
  } catch (err) {
    if (!(err instanceof LintGitError)) throw err;
    if (err.code === "ref-invalid") {
      throw new ExportError(
        "ref-invalid",
        "--default-ref is not a valid full ref name under refs/ (for example refs/remotes/origin/main)",
      );
    }
    if (err.code === "ref-unresolvable" || err.code === "not-a-commit") {
      throw new ExportError(
        "ref-unresolvable",
        `--default-ref ${request.defaultRef} does not resolve to a commit in the repository`,
      );
    }
    throw new ExportError("git-failed", "--default-ref could not be resolved");
  }

  let root: string;
  try {
    root = fs.realpathSync(toplevel);
  } catch {
    throw new ExportError(
      "git-failed",
      "the repository top level git reported could not be resolved",
    );
  }
  let specReal: string;
  try {
    specReal = fs.realpathSync(specDir);
  } catch {
    throw new ExportError("spec-dir-invalid", `${specDir} does not exist`);
  }
  if (!isInside(root, specReal)) {
    throw new ExportError(
      "spec-dir-invalid",
      "the spec directory is not inside the repository --repo names",
    );
  }
  const specRel = path.relative(root, specReal).split(path.sep).join("/");
  if (specRel === "") {
    throw new ExportError(
      "spec-dir-invalid",
      "the spec directory is the repository root; a spec lives in a directory of its own",
    );
  }

  const workTexts: Record<string, string> = {};
  for (const name of SPEC_FILES) {
    const rel = `${specRel}/${name}`;
    let blobBytes: Buffer;
    try {
      // The hardened read classifies the entry (present, a regular file,
      // valid UTF-8); the equality check itself needs the raw bytes,
      // because the text that read decodes drops a leading byte order
      // mark. `rel` has passed the read's path check and `commit` is a
      // full id, so the rev `commit:rel` names exactly that entry.
      readBlobAtCommit(toplevel, commit, rel);
      const blob = runGit(toplevel, [
        "cat-file",
        "blob",
        "--end-of-options",
        `${commit}:${rel}`,
      ]);
      if (blob.status !== 0) {
        throw new LintGitError(
          "object-unreadable",
          "a file of a commit could not be read",
        );
      }
      blobBytes = blob.stdout;
    } catch (err) {
      if (!(err instanceof LintGitError)) throw err;
      const at = `at ${request.defaultRef} (${commit})`;
      if (err.code === "path-missing") {
        throw new ExportError(
          "not-merged",
          `${rel} is not merged: the commit ${at} does not hold it`,
        );
      }
      if (err.code === "path-not-regular") {
        throw new ExportError(
          "not-regular",
          `${rel} ${at} is not a regular file in the tree; a link, a submodule and a directory are refused`,
        );
      }
      if (err.code === "path-not-utf8") {
        throw new ExportError("not-utf8", `${rel} ${at} is not valid UTF-8`);
      }
      if (err.code === "path-invalid") {
        throw new ExportError(
          "path-invalid",
          `${specRel} is not a path this command can read from a commit (names must use letters, digits, '.', '_' and '-' in '/'-separated segments)`,
        );
      }
      throw new ExportError(
        "git-failed",
        `${rel} could not be read from ${at}`,
      );
    }
    const work = readWorktreeBytes(
      path.join(specReal, name),
      `the work tree copy of ${rel}`,
      "not-merged",
    );
    const text = decodeWorktreeText(work, `the work tree copy of ${rel}`);
    if (!work.equals(blobBytes)) {
      throw new ExportError(
        "not-merged",
        `${rel} is not merged unchanged: the work tree copy differs from the copy at ${request.defaultRef} (${commit})`,
      );
    }
    workTexts[name] = text;
  }

  const spec = parseInput(
    parseSpec(workTexts[SPEC_FILE]!),
    "spec-invalid",
    SPEC_FILE,
  );
  if (spec.frontmatter.status !== "proposed") {
    throw new ExportError(
      "not-proposed",
      `${specRel}/${SPEC_FILE} has status ${spec.frontmatter.status}; export needs a proposed spec`,
    );
  }
  const testPlan = parseInput(
    parseTestPlan(workTexts[TESTPLAN_FILE]!),
    "testplan-invalid",
    TESTPLAN_FILE,
  );
  // The path rules of `docs/export.md`: the briefing is built from paths
  // export can judge, so a binding that spells its path any other way is
  // refused before the briefing exists. The check runs on the decoded
  // document, before the format parser, so the refusal is about the
  // spelling and not about anything else the file may also get wrong.
  // `buildOwExport` checks the parsed bindings again with the same rule.
  assertCanonicalBindingPaths(workTexts[BINDINGS_FILE]!);
  const bindings = parseInput(
    parseBindings(workTexts[BINDINGS_FILE]!),
    "bindings-invalid",
    BINDINGS_FILE,
  );
  return { spec, testPlan, bindings, toplevel, commit, specRel };
}
