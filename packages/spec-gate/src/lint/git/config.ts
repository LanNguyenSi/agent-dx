/**
 * `.spec-gate/config.yaml` at the reference commit: the settings come from
 * the default branch or the pull request base, never from the working tree
 * and never from the head of the spec pull request.
 */
import { parseConfig, type SpecGateConfig } from "../../formats/index.js";
import type { FindingSink } from "../load.js";
import { formatFindings } from "../load.js";
import type { GitInputs, Loaded } from "../types.js";
import { LintGitError, readBlobAtCommit } from "./index.js";

export const CONFIG_PATH = ".spec-gate/config.yaml";

const FILE = `repo:${CONFIG_PATH}`;

/** The `file` finding codes of the loader, for the failures a git read has. */
const FILE_CODE = {
  "path-not-regular": ["input-not-regular", "is not a regular file"],
  "path-not-utf8": ["input-not-utf8", "is not valid UTF-8"],
  "output-too-large": ["input-too-large", "is too large"],
} as const;

/**
 * Reads and parses the config at `git.reference`. A config that does not
 * exist there is `absent` and the rules use the format defaults, as for a
 * repository without one; a config that cannot be read or does not parse is
 * a `file` or `format` finding and the rules still run on their defaults.
 */
export function loadConfigAtReference(
  git: GitInputs,
  sink: FindingSink,
): Loaded<SpecGateConfig> {
  let text: string;
  try {
    text = readBlobAtCommit(git.repo, git.reference, CONFIG_PATH);
  } catch (err) {
    if (!(err instanceof LintGitError)) throw err;
    if (err.code === "path-missing") return { state: "absent" };
    const known = (FILE_CODE as Record<string, readonly [string, string]>)[
      err.code
    ];
    const [code, what] = known ?? ["input-unreadable", "could not be read"];
    sink.add("file", {
      file: FILE,
      path: "$",
      code,
      message: `${CONFIG_PATH} at the reference commit ${what}`,
    });
    return { state: "failed" };
  }
  const parsed = parseConfig(text);
  if (!parsed.ok) {
    formatFindings(sink, FILE, parsed.errors);
    return { state: "failed" };
  }
  return { state: "ok", value: parsed.value };
}
