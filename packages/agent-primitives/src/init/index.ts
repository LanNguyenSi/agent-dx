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
  warnings: string[];
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
 * Resolves `harness`'s target file under `absTargetDir` and refuses it when
 * it would land outside that root: both the target directory and the final
 * file path are resolved to their deepest existing real path (walking up
 * past any segment that does not exist yet, such as the harness's own skill
 * subdirectory on a first run) before the containment check, so a
 * pre-existing symlink anywhere along the way (e.g. `.claude` itself
 * pointing outside `targetDir`) cannot redirect the write, even though the
 * final `SKILL.md` segment itself never exists beforehand on a fresh
 * install.
 */
function resolveTargetPath(absTargetDir: string, harness: Harness): string {
  const filePath = path.join(absTargetDir, HARNESS_REL_PATH[harness]);
  const resolvedRoot = resolveDeepestExisting(absTargetDir);
  const resolvedFile = resolveDeepestExisting(filePath);
  if (!isPathContained(resolvedRoot, resolvedFile)) {
    throw new UsageError(
      `init: resolved target for harness "${harness}" escapes --target-dir ` +
        `(${absTargetDir}): ${filePath}`,
    );
  }
  return filePath;
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
 */
function writeOne(
  harness: Harness,
  filePath: string,
  content: string,
  force: boolean,
): InitTargetResult {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
    return { harness, path: filePath, status: "written" };
  }
  const existing = fs.readFileSync(filePath, "utf8");
  if (existing === content) {
    return { harness, path: filePath, status: "unchanged" };
  }
  if (!force) {
    return { harness, path: filePath, status: "conflicted" };
  }
  fs.writeFileSync(filePath, content, "utf8");
  return { harness, path: filePath, status: "written" };
}

/**
 * Installs the packaged `assets/skill/SKILL.md` into one or more harnesses'
 * skill directories under `targetDir`. Every requested harness's target
 * path is resolved and containment-checked up front, before any file is
 * written: an escape on, say, the third of three requested harnesses is
 * therefore refused without leaving the first two written, rather than
 * leaving the run partially applied. The top-level `status` is the worst
 * of the per-target statuses (`conflicted` a finding, `written`/`unchanged`
 * ok), so a caller can gate on the aggregate result alone.
 */
export async function init(options: InitOptions = {}): Promise<InitResult> {
  const harnesses = options.harnesses ?? ["claude"];
  const absTargetDir = path.resolve(options.targetDir ?? process.cwd());
  const force = options.force ?? false;
  const content = options.content ?? readPackagedSkill();

  const filePaths = harnesses.map((harness) => ({
    harness,
    filePath: resolveTargetPath(absTargetDir, harness),
  }));

  const targets = filePaths.map(({ harness, filePath }) =>
    writeOne(harness, filePath, content, force),
  );

  const status: InitTargetStatus = targets.some(
    (t) => t.status === "conflicted",
  )
    ? "conflicted"
    : targets.some((t) => t.status === "written")
      ? "written"
      : "unchanged";

  return { status, targets, warnings: [] };
}
