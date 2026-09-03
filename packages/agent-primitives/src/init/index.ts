import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../envelope.js";
import {
  isPathContained,
  resolveDeepestExisting,
} from "../probe/containment.js";

/** A harness whose skill directory `init` can write into. */
export type Harness = "claude" | "codex" | "opencode";

export const ALL_HARNESSES: readonly Harness[] = [
  "claude",
  "codex",
  "opencode",
];

/**
 * Path, relative to the target directory, of the skill file for each
 * harness. `init` never writes anywhere under `.claude/agents/`: that
 * directory is owned by a different installer (orchestrator-workflow) and
 * carries its own role prompts and manifest hashes.
 */
const HARNESS_REL_PATH: Record<Harness, string> = {
  claude: path.join(".claude", "skills", "agent-primitives", "SKILL.md"),
  codex: path.join(".agents", "skills", "agent-primitives", "SKILL.md"),
  opencode: path.join(".opencode", "skills", "agent-primitives", "SKILL.md"),
};

/** One target file's outcome. Values match the status vocabulary the
 * envelope already knows about (`written`/`unchanged` -> ok, `conflicted`
 * -> finding), so no envelope change was needed to add this subcommand. */
export type InitTargetStatus = "written" | "unchanged" | "conflicted";

export interface InitTargetResult {
  harness: Harness;
  path: string;
  status: InitTargetStatus;
}

export interface InitOptions {
  /** Harnesses to install into. Defaults to `["claude"]`. */
  harnesses?: Harness[];
  /** Directory the harness-specific skill paths are resolved under.
   * Defaults to `process.cwd()`. */
  targetDir?: string;
  /** Overwrite a conflicting existing file instead of reporting
   * `conflicted`. Defaults to `false`. */
  force?: boolean;
  /** Test seam: skill content to install, in place of the packaged
   * `assets/skill/SKILL.md`. */
  content?: string;
}

export interface InitResult {
  /** `conflicted` if any target conflicted; else `written` if any target
   * was newly written or overwritten; else `unchanged`. */
  status: InitTargetStatus;
  targets: InitTargetResult[];
  /** Reserved for non-fatal notes; always empty today. Kept so `init`'s
   * result shape matches every other subcommand's envelope-facing fields. */
  warnings: string[];
}

/** The filesystem conditions `init` maps to a named usage-error reason
 * instead of letting the raw errno message through: `-t`, or a path
 * segment above the target, is a file (`ENOTDIR`); a directory sits at
 * the target file path itself (`EISDIR`); the target is not writable
 * (`EACCES`, e.g. a read-only file with `--force`); a symlink sits at the
 * target file path, whether caught by pre-validation or, for one planted
 * after pre-validation ran, by the write's own `O_NOFOLLOW` open
 * (`ELOOP`); the resolved target falls outside `--target-dir`. */
export type InitFsErrorReason =
  | "target_not_a_directory"
  | "target_path_is_a_directory"
  | "target_not_writable"
  | "target_is_a_symlink"
  | "target_escapes_directory";

/** A `UsageError` carrying one of `InitFsErrorReason`, so the CLI action
 * can report it on the envelope's own `reason` field instead of the
 * generic `"usage_error"` every other usage error gets. `targets` is
 * filled in by `init()` itself with whatever harnesses were already
 * written or found unchanged before this error surfaced: the helpers that
 * construct this error (`resolveTargetPath`, `writeOne`) validate or write
 * one harness at a time and have no view of the others, so `init()` is the
 * only place that can attach that history. */
export class InitFsUsageError extends UsageError {
  public targets: InitTargetResult[] = [];

  constructor(
    message: string,
    public readonly reason: InitFsErrorReason,
  ) {
    super(message);
  }
}

/** Maps an errno-bearing filesystem error to `InitFsUsageError`. Returns
 * the original error unchanged when its code is not one of the named
 * cases. */
function mapInitFsError(
  err: unknown,
  harness: Harness,
  filePath: string,
): unknown {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOTDIR") {
    return new InitFsUsageError(
      `init: a path segment above the target for harness "${harness}" is ` +
        `not a directory: ${filePath}`,
      "target_not_a_directory",
    );
  }
  if (code === "EISDIR") {
    return new InitFsUsageError(
      `init: the target for harness "${harness}" is a directory, not a ` +
        `file: ${filePath}`,
      "target_path_is_a_directory",
    );
  }
  if (code === "EACCES") {
    return new InitFsUsageError(
      `init: the target for harness "${harness}" is not writable: ${filePath}`,
      "target_not_writable",
    );
  }
  if (code === "ELOOP") {
    return new InitFsUsageError(
      `init: the target for harness "${harness}" is a symbolic link and ` +
        `will not be followed: ${filePath}`,
      "target_is_a_symlink",
    );
  }
  return err;
}

/**
 * Reads the packaged skill file. Resolved relative to this module's own
 * compiled location (`dist/init/index.js` -> `../../assets/skill/SKILL.md`,
 * two levels up to the package root, the same depth `src/init/index.ts`
 * sits at under `src/`), so the same relative path resolves correctly
 * whether this file is running from `dist/` or, via `tsx`, from `src/`
 * directly.
 */
function readPackagedSkill(): string {
  const url = new URL("../../assets/skill/SKILL.md", import.meta.url);
  return fs.readFileSync(url, "utf8");
}

/**
 * Resolves `harness`'s target file under `absTargetDir` and refuses it
 * before anything is written when the refusal can be known without
 * writing anything: a symlink at the literal target path is refused
 * outright, whether it dangles, resolves inside `absTargetDir`, or
 * escapes it, and whether or not `--force` was given, since a target file
 * is never written through a symlink; a directory already sitting at the
 * target file path is refused the same way `EISDIR` from the write itself
 * would be, but before any write happens; an existing regular file that
 * `--force` would overwrite is checked for write access up front so an
 * unwritable target is refused before any write happens too; the final
 * path is then resolved (walking up past any segment that does not exist
 * yet, such as the harness's own skill subdirectory on a first run) and
 * checked for containment, so a pre-existing symlink anywhere further up
 * the path (e.g. `.claude` itself pointing outside `targetDir`) cannot
 * redirect the write either.
 */
function resolveTargetPath(
  absTargetDir: string,
  resolvedTargetDir: string,
  harness: Harness,
  force: boolean,
): string {
  const filePath = path.join(absTargetDir, HARNESS_REL_PATH[harness]);

  // `throwIfNoEntry: false` only suppresses ENOENT (nothing there yet, the
  // common case); an ancestor segment that is a file rather than a
  // directory (`-t` itself, most often) still throws ENOTDIR here, so that
  // case is mapped the same way writeOne's own filesystem calls are.
  let lst: fs.Stats | undefined;
  try {
    lst = fs.lstatSync(filePath, { throwIfNoEntry: false });
  } catch (err) {
    throw mapInitFsError(err, harness, filePath);
  }

  if (lst !== undefined && lst.isSymbolicLink()) {
    throw new InitFsUsageError(
      `init: resolved target for harness "${harness}" is a symbolic link ` +
        `and will not be followed (--target-dir ${absTargetDir}): ${filePath}`,
      "target_is_a_symlink",
    );
  }

  if (lst !== undefined && lst.isDirectory()) {
    throw new InitFsUsageError(
      `init: the target for harness "${harness}" is a directory, not a ` +
        `file: ${filePath}`,
      "target_path_is_a_directory",
    );
  }

  if (lst !== undefined && lst.isFile() && force) {
    try {
      fs.accessSync(filePath, fs.constants.W_OK);
    } catch (err) {
      throw mapInitFsError(err, harness, filePath);
    }
  }

  const resolvedFile = resolveDeepestExisting(filePath);
  if (!isPathContained(resolvedTargetDir, resolvedFile)) {
    throw new InitFsUsageError(
      `init: resolved target for harness "${harness}" escapes --target-dir ` +
        `(${absTargetDir}): ${filePath}`,
      "target_escapes_directory",
    );
  }
  return filePath;
}

// `O_NOFOLLOW` gates writeOne's own open() against a symlink planted after
// resolveTargetPath's pre-validation ran (see that function's own
// docblock). It is combined into the open flags below with a bitwise OR,
// which silently drops an operand that turns out to be `0` or
// `undefined` instead of failing loudly; asserted once, at module load,
// so a platform where the constant is missing or falsy is refused outright
// rather than quietly writing through a symlink from then on.
const O_NOFOLLOW_IS_VALID =
  typeof fs.constants.O_NOFOLLOW === "number" && fs.constants.O_NOFOLLOW > 0;
if (!O_NOFOLLOW_IS_VALID) {
  throw new Error(
    "init: fs.constants.O_NOFOLLOW is not a positive number on this " +
      "platform; refusing to load a module whose symlink guard would be " +
      "silently dropped from the write's open flags",
  );
}

/**
 * Writes `content` to `filePath`, mirroring the write-if-new-or-identical /
 * conflicted-otherwise semantics of orchestrator-workflow's own
 * `installFile` (not imported: that module is internal to its own
 * package): a path that does not exist yet, or exists with byte-identical
 * content, is written or reported unchanged with no further action; a path
 * that exists with different content is reported `conflicted` unless
 * `force` is set, in which case it is overwritten and reported `written`
 * (not `updated`: `init`'s own status vocabulary has no third state, per
 * the acceptance contract).
 *
 * `dir` is created (`mkdirSync` with `recursive: true`) unconditionally
 * before anything else, which is also documented behavior: a missing `-t`
 * directory (or any missing segment of the harness's own skill
 * subdirectory) is created rather than treated as an error. Once created,
 * its real path is re-checked for containment: `mkdirSync` walks straight
 * through an existing directory symlink instead of refusing it, so a
 * symlink introduced between `resolveTargetPath`'s own check and this
 * call (e.g. `.claude` created by something else in the meantime) would
 * otherwise still land the write outside `resolvedTargetDir`. The actual
 * write opens the path with `O_NOFOLLOW`: `resolveTargetPath` already
 * refused a symlink that was there at pre-validation time, and this is
 * the matching guard for one planted in the gap between that check and
 * this write, which fails the open with `ELOOP` instead of following it
 * (mapped to the same named reason, `target_is_a_symlink`, as the
 * pre-validation check).
 */
function writeOne(
  harness: Harness,
  filePath: string,
  content: string,
  force: boolean,
  absTargetDir: string,
  resolvedTargetDir: string,
): InitTargetResult {
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });

    const realDir = fs.realpathSync(dir);
    if (!isPathContained(resolvedTargetDir, realDir)) {
      throw new InitFsUsageError(
        `init: resolved target for harness "${harness}" escapes ` +
          `--target-dir (${absTargetDir}) after directory creation: ${filePath}`,
        "target_escapes_directory",
      );
    }

    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, "utf8");
      if (existing === content) {
        return { harness, path: filePath, status: "unchanged" };
      }
      if (!force) {
        return { harness, path: filePath, status: "conflicted" };
      }
    }

    const fd = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_TRUNC |
        fs.constants.O_NOFOLLOW,
    );
    try {
      fs.writeSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
    return { harness, path: filePath, status: "written" };
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw mapInitFsError(err, harness, filePath);
  }
}

/**
 * Installs the packaged `assets/skill/SKILL.md` into one or more harnesses'
 * skill directories under `targetDir`. Every requested harness's target is
 * validated up front, before any file is written: containment, a symlink
 * or a directory already at the target path, and (under `--force`) an
 * existing target's write access are all conditions knowable without
 * writing anything, and all are checked before the first write, so an
 * escape or a pre-existing conflict of that kind on, say, the third of
 * three requested harnesses is refused without leaving the first two
 * written. A condition that only surfaces during the write itself (a race
 * between validation and the write, such as a symlink planted in that
 * gap) can still leave a prefix of the requested harnesses written; the
 * thrown `InitFsUsageError` then carries the already-completed `targets`
 * so a caller can see what was installed. The top-level `status` is the
 * worst of the per-target statuses (`conflicted` a finding,
 * `written`/`unchanged` ok), so a caller can gate on the aggregate result
 * alone. Synchronous throughout: every step is a plain filesystem call, so
 * there is nothing here for `async`/`await` to buy.
 */
export function init(options: InitOptions = {}): InitResult {
  const harnesses = options.harnesses ?? ["claude"];
  const absTargetDir = path.resolve(options.targetDir ?? process.cwd());
  const resolvedTargetDir = resolveDeepestExisting(absTargetDir);
  const force = options.force ?? false;
  const content = options.content ?? readPackagedSkill();

  const filePaths = harnesses.map((harness) => ({
    harness,
    filePath: resolveTargetPath(
      absTargetDir,
      resolvedTargetDir,
      harness,
      force,
    ),
  }));

  const targets: InitTargetResult[] = [];
  for (const { harness, filePath } of filePaths) {
    try {
      targets.push(
        writeOne(
          harness,
          filePath,
          content,
          force,
          absTargetDir,
          resolvedTargetDir,
        ),
      );
    } catch (err) {
      if (err instanceof InitFsUsageError) {
        err.targets = targets.slice();
      }
      throw err;
    }
  }

  const status: InitTargetStatus = targets.some(
    (t) => t.status === "conflicted",
  )
    ? "conflicted"
    : targets.some((t) => t.status === "written")
      ? "written"
      : "unchanged";

  return { status, targets, warnings: [] };
}
