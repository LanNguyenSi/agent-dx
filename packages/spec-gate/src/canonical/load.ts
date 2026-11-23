/**
 * `computeSpecDigest`: reads one spec directory and the commands file at
 * `commands_ref`, and returns the digest. Any problem is a `DigestError`
 * and no digest exists for that input.
 */
import fs from "node:fs";
import path from "node:path";
import type { ParseResult, Spec, TestPlan } from "../formats/index.js";
import { parseSpec, parseTestPlan } from "../formats/index.js";
import type { DigestParts } from "./digest.js";
import { computeDigest, referencedCommandNames } from "./digest.js";
import { DigestError } from "./errors.js";
import type { DigestErrorCode } from "./errors.js";
import {
  assertCommit,
  assertRepo,
  readCommandSet,
  repoToplevel,
} from "./git.js";

export const SPEC_FILE = "spec.md";
export const TESTPLAN_FILE = "testplan.yaml";

/** More than the format layer accepts (1 MiB of characters, up to 3 bytes each). */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function readInput(dir: string, name: string): string {
  const file = path.join(dir, name);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DigestError(
        "input-missing",
        `${name} does not exist in ${dir}`,
        {
          file: name,
        },
      );
    }
    throw new DigestError(
      "input-unreadable",
      `${name} cannot be read: ${(err as Error).message}`,
      { file: name },
    );
  }
  if (!stat.isFile()) {
    throw new DigestError(
      "input-not-regular",
      `${name} must be a regular file, not a link or a directory`,
      { file: name },
    );
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new DigestError(
      "input-too-large",
      `${name} is ${stat.size} bytes, the limit is ${MAX_FILE_BYTES}`,
      { file: name },
    );
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    throw new DigestError(
      "input-unreadable",
      `${name} cannot be read: ${(err as Error).message}`,
      { file: name },
    );
  }
  try {
    // Fatal decoding: invalid bytes must not collapse to U+FFFD and so
    // give two different files the same digest.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DigestError("input-not-utf8", `${name} is not valid UTF-8`, {
      file: name,
    });
  }
}

function parsed<T>(
  result: ParseResult<T>,
  code: DigestErrorCode,
  name: string,
): T {
  if (result.ok) return result.value;
  throw new DigestError(
    code,
    `${name} is not valid (${result.errors.length} error(s))`,
    {
      file: name,
      formatErrors: result.errors,
    },
  );
}

export interface DigestOptions {
  /** The repository to read `commands_ref` from. Default: the git top level of the spec directory. */
  repo?: string;
}

/** Loads and parses the inputs and resolves the referenced commands. */
export function loadDigestParts(
  specDir: string,
  options: DigestOptions = {},
): DigestParts {
  const dir = path.resolve(specDir);
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    // reported below
  }
  if (!isDir) {
    throw new DigestError("spec-dir-invalid", `${specDir} is not a directory`);
  }
  const spec: Spec = parsed(
    parseSpec(readInput(dir, SPEC_FILE)),
    "spec-invalid",
    SPEC_FILE,
  );
  const testPlan: TestPlan = parsed(
    parseTestPlan(readInput(dir, TESTPLAN_FILE)),
    "testplan-invalid",
    TESTPLAN_FILE,
  );

  const repo =
    options.repo !== undefined ? path.resolve(options.repo) : repoToplevel(dir);
  assertRepo(repo);
  const ref = spec.frontmatter.commands_ref;
  assertCommit(repo, ref);

  const names = referencedCommandNames(testPlan);
  const commands: Record<string, readonly string[]> = {};
  if (names.length > 0) {
    const set = readCommandSet(repo, ref);
    for (const name of names) {
      // A name the file does not define is left out; `buildDigestInput`
      // refuses the missing argv, so there is one `command-ref-unknown` check.
      const entry = set.commands.find((c) => c.name === name);
      if (entry === undefined) continue;
      commands[name] = entry.argv;
    }
  }
  return { spec, testPlan, commands };
}

/** The digest of the spec directory, `sha256:<64 hex>`. */
export function computeSpecDigest(
  specDir: string,
  options: DigestOptions = {},
): string {
  return computeDigest(loadDigestParts(specDir, options));
}
