import { parse as parseToml } from "@iarna/toml";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { PACKAGE_VERSION } from "./assets.js";
import type { Manifest } from "./init.js";
import {
  MANIFEST_PATH,
  knowledgeEntryProblems,
  readInstalledManifest,
} from "./init.js";
import type { Profile, Role } from "./models.js";
import { DEFAULT_MODELS, rolesForProfile } from "./models.js";
import { compareRoutingState } from "./routing-state.js";
import type {
  OperatorManifest,
  OperatorManifestLockOptions,
  OperatorManifestState,
  OperatorTarget,
} from "./operator-manifest.js";
import {
  OPERATOR_MANIFEST_FILENAME,
  operatorManifestState,
  updateOperatorManifest,
} from "./operator-manifest.js";

/**
 * A target's status against the operator's registry. `drift` takes
 * precedence over `divergent`/`version-lag` (a target can carry both a
 * profile/tiers/models divergence and a hash drift at the same time; the
 * drift is the more actionable fact, so it wins the status field while the
 * divergence is still reported on the target). `divergent` in turn takes
 * precedence over `version-lag`: a target can be both divergent and
 * version-lagging (see `versionLag` below), and both facts are reported,
 * but the status is `divergent`. `unverifiable` is separate from both
 * `missing` and `no-manifest`: the target directory or its repo manifest
 * could not be checked at all (a stat failure other than ENOENT, most
 * commonly EACCES on an ancestor directory, or a manifest file present but
 * unreadable/unparseable), so nothing is actually known about this
 * target's real state. Unlike `missing`/`no-manifest`, `--prune` never
 * removes an `unverifiable` target (review round 2, M1): an unreadable
 * target might still be perfectly fine, and dropping its registry row on
 * that basis would be an unrecoverable guess.
 */
export type TargetStatus =
  | "clean"
  | "divergent"
  | "version-lag"
  | "drift"
  | "missing"
  | "no-manifest"
  | "unverifiable";

export interface TargetDivergence {
  profile: boolean;
  tiers: boolean;
  models: boolean;
  /** Present only when explicit effective routing differs. */
  routing?: boolean;
}

/**
 * Per-target report. Only `path`, `status`, `installedVersion`, `pin`,
 * `divergence`, `driftFiles`, `versionLag`, and `reason` are part of the
 * `--json` contract (`targetReportToJson` below picks exactly those); the
 * remaining fields exist to let the human-output printer in `cli.ts`
 * render detail lines without recomputing values `inspectTarget` already
 * worked out.
 */
export interface TargetReport {
  path: string;
  status: TargetStatus;
  installedVersion: string | null;
  pin: string | null;
  divergence: TargetDivergence | null;
  driftFiles: string[] | null;
  /** Selected legacy opencode leaves that cannot be compared offline. */
  routingComparisonGaps?: string[];
  /**
   * Knowledge-bundle warnings against this target's own filesystem: a
   * malformed `knowledge` entry dropped on read (index and reason), a
   * configured `path` or `repoRoot` that is not a directory under the
   * target's top level, or a non-empty `knowledge` list that omits an
   * existing `docs/okf/` at the target's root. Omitted when there is none.
   * Printed as `knowledge:` detail lines in the human output. These
   * warnings never change `status` or the doctor exit code -- they surface
   * a documentation-locator drift, not a kit-file install drift.
   */
  knowledgeWarnings?: string[];
  /**
   * Codex instruction-budget warnings against this target's own filesystem:
   * the target's manifest selects the `codex` harness and the root
   * instruction file Codex would load (`AGENTS.override.md` when it is a
   * regular file, else `AGENTS.md`) is affected by the decided
   * `project_doc_max_bytes` budget: the file is larger than a
   * positive-integer budget Codex would silently truncate it to (naming
   * the file, its size, the budget, its source and the first heading
   * lost); or that budget is `0`, which makes Codex load no project
   * instruction file at all; or the value is invalid, and Codex refuses
   * to load that config file. Omitted when there is none. Printed as
   * `codex:` detail lines in the human output. Like the knowledge
   * warnings, these never change `status` or the doctor exit code -- they
   * surface an instruction-file truncation, not a kit-file install drift.
   */
  codexWarnings?: string[];
  /** Human-output-only: the repo's own profile, or null when unknown. */
  repoProfile: Profile | null;
  /** Human-output-only: the operator default profile, for the comparison line. */
  operatorProfile: Profile;
  /** Human-output-only: the repo's own tiers flag, or null when unknown. */
  repoTiers: boolean | null;
  /** Human-output-only: the operator default tiers flag, for the comparison line. */
  operatorTiers: boolean;
  /** Human-output-only: roles whose resolved model differs from the operator default. */
  divergentModelRoles: Role[];
  /**
   * Whether this target is lagging the running kit version (no pin
   * recorded, and the installed version differs from the kit version),
   * independent of the final `status` field. Lets the printer show the
   * "installed X, operator Y" line for a target whose status was
   * overridden to `divergent` or `drift` because it is also lagging.
   * Part of the `--json` contract since fix-round-2 (review finding L6):
   * a `--json` consumer previously had no way to see version-lag on a
   * target whose status field reads `divergent` or `drift`.
   */
  versionLag: boolean;
  /**
   * `null` for every status except `unverifiable`, where it explains what
   * could not be checked: `"directory not accessible"` (the target
   * directory, or a directory on the path to its repo manifest, failed to
   * stat for a reason other than ENOENT) or `"manifest unreadable"` (the
   * directory itself stats fine and the manifest file exists, but it could
   * not be parsed or read). Part of the `--json` contract (review finding
   * M1) so a `--json` consumer can distinguish the two causes without
   * re-deriving them.
   */
  reason: string | null;
}

/** The subset of `TargetReport` that is part of the `--json` contract. */
export interface TargetReportJson {
  path: string;
  status: TargetStatus;
  installedVersion: string | null;
  pin: string | null;
  divergence: TargetDivergence | null;
  driftFiles: string[] | null;
  /** Selected legacy opencode leaves that cannot be compared offline. */
  routingComparisonGaps?: string[];
  /** See {@link TargetReport.knowledgeWarnings}. */
  knowledgeWarnings?: string[];
  /** See {@link TargetReport.codexWarnings}. */
  codexWarnings?: string[];
  versionLag: boolean;
  reason: string | null;
}

export function targetReportToJson(report: TargetReport): TargetReportJson {
  return {
    path: report.path,
    status: report.status,
    installedVersion: report.installedVersion,
    pin: report.pin,
    divergence: report.divergence,
    driftFiles: report.driftFiles,
    ...(report.routingComparisonGaps?.length
      ? { routingComparisonGaps: report.routingComparisonGaps }
      : {}),
    ...(report.knowledgeWarnings?.length
      ? { knowledgeWarnings: report.knowledgeWarnings }
      : {}),
    ...(report.codexWarnings?.length
      ? { codexWarnings: report.codexWarnings }
      : {}),
    versionLag: report.versionLag,
    reason: report.reason,
  };
}

/**
 * Maps a single target's status to `adopt`'s single-target exit-code
 * contract: 0 for `clean`/`divergent`/`version-lag`, 1 for `drift`, 2 for
 * `missing`/`no-manifest`/`unverifiable`. A pure function, exported and
 * unit-testable directly against all seven {@link TargetStatus} values,
 * rather than left as the inline ternary chain `cli.ts`'s `adopt` action
 * used to carry (fix-round, review findings M3/L5): a live `adopt` run can
 * only ever exercise `clean`/`divergent`/`version-lag`/`drift` in practice
 * (the directory and manifest were just read successfully immediately
 * before this status is computed), so the `missing`/`no-manifest`/
 * `unverifiable` branches were previously pinned by nothing at all.
 */
export function adoptExitCodeForStatus(status: TargetStatus): 0 | 1 | 2 {
  switch (status) {
    case "missing":
    case "no-manifest":
    case "unverifiable":
      return 2;
    case "drift":
      return 1;
    case "clean":
    case "divergent":
    case "version-lag":
      return 0;
  }
}

/**
 * Whether `adopt`'s human-mode success line ("Adopted ...") must be
 * suppressed for a target report whose status is `status`: true for exactly
 * the three statuses {@link adoptExitCodeForStatus} maps to exit code 2
 * (`missing`, `no-manifest`, `unverifiable`), statuses that should not
 * occur for a target whose directory and manifest were just verified
 * immediately before this status was computed, so printing the success line
 * ahead of the stderr bug note would be misleading. A pure function,
 * exported and unit-tested directly against all seven {@link TargetStatus}
 * values, rather than left as `cli.ts`'s inline `exitCode === 2` check
 * (fix-round-2), the same reasoning that already pulled
 * `adoptExitCodeForStatus` itself out of an inline ternary chain.
 */
export function suppressSuccessLine(status: TargetStatus): boolean {
  return adoptExitCodeForStatus(status) === 2;
}

export interface DoctorReport {
  operatorHome: string;
  operatorVersion: string;
  targets: TargetReport[];
  pruned: string[];
  exitCode: 0 | 1 | 2;
  /**
   * The count of raw `targets` array entries in the on-disk operator
   * manifest that `readOperatorManifest`'s own per-entry validation
   * silently dropped (wrong shape, a missing field, ...), distinct from
   * the targets named in `pruned` above (which were validly-shaped but
   * `missing`/`no-manifest`). Always `0` unless `--prune` both ran and
   * actually wrote (`pruned.length > 0`); `cli.ts`'s human-output prune
   * note prints only when this is greater than zero, naming the count
   * (fix-round-2 review finding M3: the note used to print unconditionally
   * whenever anything at all was pruned, even when the file held no
   * unvalidatable raw entry to report).
   */
  unvalidatedDropped: number;
  /**
   * Set only when no operator manifest was evaluated; `targets` is then
   * `[]`. `no-operator-manifest`: no file exists at
   * `<operatorHome>/manifest.json`. `operator-manifest-unreadable`: the
   * file exists but `readOperatorManifest` could not parse or validate it
   * (corrupt JSON, or an envelope that does not match this kit).
   */
  error?: "no-operator-manifest" | "operator-manifest-unreadable";
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Resolves a role's model against a possibly-partial models map, falling
 * back to the shipped default the same way `cli.ts`'s `defaultsAsManifest`
 * and `readInstalledManifest`'s per-role degradation both already do. */
function resolvedModel(
  models: Partial<Record<Role, string>>,
  role: Role,
): string {
  return models[role] ?? DEFAULT_MODELS[role];
}

/**
 * Relative paths (from the repo manifest's `files` ledger) whose on-disk
 * sha256 no longer matches the recorded hash, or that are missing/not a
 * regular file on disk. Empty when the target is clean of drift.
 */
function computeDriftFiles(targetPath: string, manifest: Manifest): string[] {
  const drifted: string[] = [];
  for (const [relativePath, recordedHash] of Object.entries(manifest.files)) {
    const filePath = join(targetPath, relativePath);
    let isFile = false;
    try {
      isFile = existsSync(filePath) && statSync(filePath).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      drifted.push(relativePath);
      continue;
    }
    // A file that exists and stat's as a regular file can still fail to
    // read (permissions, a race with something else removing it, ...). A
    // read failure means this path's drift status against the recorded
    // hash cannot be verified, so it is counted as drift rather than
    // aborting the whole target (and the rest of the registry).
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      drifted.push(relativePath);
      continue;
    }
    if (sha256(content) !== recordedHash) {
      drifted.push(relativePath);
    }
  }
  return drifted;
}

/** The kit-wide implicit default knowledge-bundle location every site falls
 * back to when a target configures no `knowledge` list at all. */
const DEFAULT_KNOWLEDGE_PATH = "docs/okf";

/** The raw `knowledge` value of a target's manifest file, before
 * `readInstalledManifest` drops invalid entries; `undefined` when the field
 * is absent or the file cannot be re-read. */
function readRawKnowledge(targetPath: string): unknown {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(targetPath, MANIFEST_PATH), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return (parsed as Record<string, unknown>).knowledge;
  } catch {
    return undefined;
  }
}

function isDirectoryAt(path: string): boolean {
  const stat = statOrClassify(path);
  return stat.kind === "ok" && stat.stat.isDirectory();
}

/**
 * Checks a target's configured `knowledge` list against its own filesystem.
 * Each raw entry `readInstalledManifest` dropped as malformed is reported
 * with its index and reason. For each kept entry, `path` and `repoRoot` are
 * resolved against the target's top level independently (the manifest's
 * model; `path` is not nested under `repoRoot`) and each one that is not a
 * directory is reported by name. A non-empty list whose normalised `path`s
 * omit an existing `docs/okf/` at the target's root (the implicit default
 * every kit site assumes absent a `knowledge` field) is reported once.
 * Absent or empty `knowledge` is today's default behaviour and never warns
 * about `docs/okf/`: a repo that never configured `knowledge` is not warned
 * about lacking an entry for its own default.
 */
function computeKnowledgeWarnings(
  targetPath: string,
  manifest: Manifest,
): string[] {
  const knowledge = manifest.knowledge ?? [];
  const warnings: string[] = knowledgeEntryProblems(
    readRawKnowledge(targetPath),
  );
  for (const bundle of knowledge) {
    if (!isDirectoryAt(join(targetPath, bundle.path))) {
      warnings.push(`missing configured knowledge path: ${bundle.path}`);
    }
    if (
      bundle.repoRoot !== "." &&
      !isDirectoryAt(join(targetPath, bundle.repoRoot))
    ) {
      warnings.push(
        `missing configured knowledge repoRoot: ${bundle.repoRoot}`,
      );
    }
  }
  if (knowledge.length > 0) {
    const docsOkfExists = isDirectoryAt(
      join(targetPath, DEFAULT_KNOWLEDGE_PATH),
    );
    const docsOkfConfigured = knowledge.some(
      (bundle) => bundle.path === DEFAULT_KNOWLEDGE_PATH,
    );
    if (docsOkfExists && !docsOkfConfigured) {
      warnings.push(
        `${DEFAULT_KNOWLEDGE_PATH}/ exists but is not in the configured knowledge list`,
      );
    }
  }
  return warnings;
}

/**
 * The one byte budget Codex gives every project instruction file it loads.
 * Read from the Codex source at codex-cli 0.163.0 (as were the layering and
 * truncation facts below): the top-level `project_doc_max_bytes` key of a
 * Codex `config.toml`, default `32 * 1024`. Codex loads project instruction
 * files per directory from the project root (the directory with `.git`)
 * down to the working directory, taking `AGENTS.override.md` over
 * `AGENTS.md` in each directory; all of them share this one budget, and
 * content past it is cut off with only a log warning. Codex keeps the
 * value of the highest layer that sets the key: `0` is accepted and makes
 * it load no project instruction file at all, and a value that is not an
 * integer from 0 up to 9223372036854775807 makes it refuse to load that
 * configuration; none of these falls back to a lower layer. For a project
 * Codex does not trust it loads neither the project config nor any
 * instruction file; this check assumes a trusted project.
 */
const CODEX_PROJECT_DOC_MAX_BYTES_DEFAULT = 32 * 1024;

/** Where a resolved Codex instruction budget came from. The profiles, the
 * system layer, managed layers and `-c` session flags are config layers
 * Codex itself consults but are not considered here; only these three are. */
type CodexBudgetSource = "project config" | "user config" | "default";

/**
 * The injectable filesystem inputs of the Codex user-config layer, so a
 * test never reads the real home directory or the real `process.env`
 * (defaults: {@link homedir} and `process.env`).
 */
export interface CodexBudgetInputs {
  /** The user home directory, the fallback root when `env` has no
   * `CODEX_HOME`: the user file is then `<homeDir>/.codex/config.toml`. */
  homeDir: string;
  /** The environment, read for `CODEX_HOME`. */
  env: Record<string, string | undefined>;
}

/** One layer's read of its Codex `config.toml`: `{ parseError }` when the
 * file is present but doctor's TOML 0.5 parser cannot read it (a syntax
 * error, a key set twice, or a TOML 1.0 / 1.1 form Codex may accept);
 * `{ value }` when it
 * parses and the top-level `project_doc_max_bytes` key is set (a key
 * inside a `[table]` header is a different key and does not count);
 * `undefined` when the file is absent or sets no top-level key. */
type CodexConfigRead = { value: unknown } | { parseError: string } | undefined;

/**
 * Reads one Codex `config.toml` with a TOML parser ({@link parseToml},
 * `@iarna/toml`, which implements TOML 0.5 while Codex reads TOML 1.1):
 * quoted keys, inline comments, multi-line strings and every integer
 * form 0.5 knows are understood in full. A file the parser cannot read
 * is reported with its first message line and is not claimed to be
 * rejected by Codex, which may load it. Only the top-level
 * `project_doc_max_bytes` key counts; its parsed value is returned
 * untouched and what Codex makes of it is decided in
 * {@link decideCodexBudgetValue}. A file that cannot be read at all is
 * treated as absent.
 */
function readCodexProjectDocMaxBytes(configFile: string): CodexConfigRead {
  let text: string;
  try {
    text = readFileSync(configFile, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: Record<string, unknown> = parseToml(text);
    return Object.hasOwn(parsed, "project_doc_max_bytes")
      ? { value: parsed["project_doc_max_bytes"] }
      : undefined;
  } catch (error) {
    return { parseError: parseTomlFirstLine(error) };
  }
}

/** The first line of a TOML parser error, without the source excerpt the
 * rest of the `@iarna/toml` message quotes back. */
function parseTomlFirstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split("\n", 1)[0] ?? "").replace(/:$/, "");
}

/** What doctor makes of the parsed value of the top-level
 * `project_doc_max_bytes` key. Codex accepts integers from 0 up to
 * 9223372036854775807: `0` (TOML spells `-0` that same value) makes it
 * load no project instruction file at all, a positive integer is the
 * byte budget, and a negative integer, a float, a string, a boolean, an
 * array or a table makes it reject the whole file. Doctor cannot match
 * Codex in four known places and says what it does not know rather than
 * claim a rejection: (1) the parser reads TOML 0.5, Codex TOML 1.1, so a
 * file the parser refuses may still load in Codex (see
 * {@link readCodexProjectDocMaxBytes}); (2) an integer outside the safe JS
 * range comes back as `BigInt.asIntN(64, literal)` with its high bits
 * dropped, so a `BigInt` budget is unknown; (3) an integer-valued float
 * (`65536.0`, `1e2`) comes back as the plain number and reads as that
 * integer although Codex rejects it; (4) a file the parser accepts but
 * Codex rejects whole (stricter TOML 1.x rules, a wrong-typed other key)
 * still yields its budget although Codex refuses to load it. */
function decideCodexBudgetValue(
  value: unknown,
  configFile: string,
  source: CodexBudgetSource,
): CodexBudgetDecision {
  if (typeof value === "bigint") {
    return {
      kind: "unknown",
      source,
      reason: `project_doc_max_bytes in the ${source} file ${configFile} is outside the range doctor can read exactly; Codex accepts up to 9223372036854775807`,
    };
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value === 0
      ? { kind: "zero", configFile, source }
      : { kind: "budget", bytes: value, source };
  }
  return {
    kind: "reject",
    configFile,
    source,
    reason: `project_doc_max_bytes = ${describeCodexValue(value)} is not a non-negative integer`,
  };
}

/** How an unusable config value is quoted in a warning: a string keeps
 * the quotes it has in the file, a number prints as itself, and
 * anything else prints best effort. */
function describeCodexValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value !== "object" || value === null) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** What the config layers decide about the instruction budget. The
 * highest layer that sets the key decides and no lower layer ever
 * applies: `budget` is a winning positive byte count and its layer;
 * `zero` means the winning value is `0`, and Codex then loads no project
 * instruction file at all; `unknown` means doctor cannot tell the budget
 * of the winning layer (its TOML 0.5 parser cannot read the file, or the
 * value is outside the integer range doctor reads exactly), `reason`
 * says why, and no size comparison is made; `reject` means Codex refuses
 * to load that config file because of its unusable value, and `reason`
 * says why. */
type CodexBudgetDecision =
  | { kind: "budget"; bytes: number; source: CodexBudgetSource }
  | { kind: "zero"; configFile: string; source: CodexBudgetSource }
  | { kind: "unknown"; source: CodexBudgetSource; reason: string }
  | {
      kind: "reject";
      configFile: string;
      source: CodexBudgetSource;
      reason: string;
    };

/**
 * Resolves the instruction budget for one target across the layers this
 * kit considers, highest first: the project file
 * `<target>/.codex/config.toml`, then the user file `$CODEX_HOME/
 * config.toml` (`<homeDir>/.codex/config.toml` when the environment does
 * not set `CODEX_HOME`), then the default. The highest layer that sets
 * the key decides: its positive integer value is the budget, its `0`
 * means Codex loads no project instruction file at all, a value Codex
 * cannot use means Codex rejects that file, and a file doctor cannot
 * parse or a value outside its exact integer range leaves the budget
 * unknown; none of these falls back to a lower layer, so a file doctor
 * cannot parse is reported whatever the other file says.
 */
function resolveCodexBudget(
  targetPath: string,
  inputs: CodexBudgetInputs,
): CodexBudgetDecision {
  const codexHome = inputs.env["CODEX_HOME"];
  const layers: Array<{ configFile: string; source: CodexBudgetSource }> = [
    {
      configFile: join(targetPath, ".codex", "config.toml"),
      source: "project config",
    },
    {
      configFile: join(
        codexHome ? codexHome : join(inputs.homeDir, ".codex"),
        "config.toml",
      ),
      source: "user config",
    },
  ];
  for (const layer of layers) {
    const read = readCodexProjectDocMaxBytes(layer.configFile);
    if (read === undefined) continue;
    if ("parseError" in read) {
      return {
        kind: "unknown",
        source: layer.source,
        reason: `doctor could not read the ${layer.source} file ${layer.configFile} with its TOML 0.5 parser (${read.parseError}); Codex reads TOML 1.1 and may load the file`,
      };
    }
    return decideCodexBudgetValue(read.value, layer.configFile, layer.source);
  }
  return {
    kind: "budget",
    bytes: CODEX_PROJECT_DOC_MAX_BYTES_DEFAULT,
    source: "default",
  };
}

const ATX_HEADING_LINE = /^ {0,3}#{1,6}( |\t|$)/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The text of the first Markdown heading line that starts at or after
 * `budget` bytes into `content` -- the first heading Codex loses entirely
 * -- or `null` when no heading starts at or after the budget. Lines
 * inside a fenced code block (```` or ~~~) are not headings; a line is
 * taken as opening or closing a fence by its marker alone.
 */
function firstLostHeading(content: string, budget: number): string | null {
  let offset = 0;
  let openFence: string | undefined;
  for (const line of content.split("\n")) {
    const fence = FENCE_LINE.exec(line);
    if (fence) {
      if (openFence === undefined) openFence = fence[1][0];
      else if (fence[1][0] === openFence) openFence = undefined;
    } else if (
      openFence === undefined &&
      offset >= budget &&
      ATX_HEADING_LINE.test(line)
    ) {
      return line.trim();
    }
    offset += Buffer.byteLength(line, "utf8") + 1;
  }
  return null;
}

/** Whether `path` names a regular file, like Codex's own per-directory
 * `is_file` check: anything else (no entry, a directory, ...) is not an
 * instruction file. */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * One warning per target whose manifest selects the `codex` harness and
 * whose root Codex instruction file -- `AGENTS.override.md` when it is a
 * regular file, else `AGENTS.md` -- is affected by the instruction budget
 * decided in {@link resolveCodexBudget}. Three outcomes: the deciding
 * positive-integer budget is below the file's size, and the warning names
 * the file, its size in bytes, the budget, where the budget came from
 * (project config, user config, or default) and the first heading that is
 * lost entirely (or says none is); the deciding value is `0`, and the
 * warning says Codex loads no project instruction file at all (no size
 * comparison); the deciding file holds a value Codex rejects, and the
 * warning says so, naming the file and the reason (no size comparison);
 * the deciding layer's budget is unknown to doctor (its TOML 0.5 parser
 * cannot read the file, which Codex's TOML 1.1 reader may load, or the
 * value is outside the integer range doctor reads exactly), and the
 * warning says so, with the file's size and the default budget for
 * context and no size comparison. Absent file, other harnesses and files
 * within the budget warn nothing; like the knowledge warnings this never changes
 * `status` or the doctor exit code. The check assumes Codex trusts the
 * project. Profiles, the system layer, managed layers and `-c` session
 * flags are config layers Codex itself consults that this check does not
 * consider.
 */
function computeCodexBudgetWarnings(
  targetPath: string,
  manifest: Manifest,
  inputs: CodexBudgetInputs,
): string[] {
  if (!manifest.harnesses.includes("codex")) return [];
  const overrideFile = join(targetPath, "AGENTS.override.md");
  const hasOverride = isRegularFile(overrideFile);
  const instructionFile = hasOverride
    ? overrideFile
    : join(targetPath, "AGENTS.md");
  let content: Buffer;
  try {
    content = readFileSync(instructionFile);
  } catch {
    return [];
  }
  const decision = resolveCodexBudget(targetPath, inputs);
  if (decision.kind === "unknown") {
    return [
      `codex budget: ${decision.reason}; the budget from this layer is unknown, so no size comparison is made (${hasOverride ? "AGENTS.override.md" : "AGENTS.md"} is ${content.length} bytes, the default budget is ${CODEX_PROJECT_DOC_MAX_BYTES_DEFAULT} bytes)`,
    ];
  }
  if (decision.kind === "reject") {
    return [
      `codex budget: Codex rejects the ${decision.source} file ${decision.configFile}: ${decision.reason}, so Codex refuses to load that configuration`,
    ];
  }
  if (decision.kind === "zero") {
    return [
      `codex budget: ${hasOverride ? "AGENTS.override.md" : "AGENTS.md"} is never loaded: the ${decision.source} file ${decision.configFile} sets project_doc_max_bytes = 0, and Codex loads no project instruction file at all`,
    ];
  }
  const size = content.length;
  if (size <= decision.bytes) return [];
  const lost = firstLostHeading(content.toString("utf8"), decision.bytes);
  return [
    [
      `codex budget: ${hasOverride ? "AGENTS.override.md" : "AGENTS.md"} is ${size} bytes, over the ${decision.bytes}-byte project_doc_max_bytes budget from ${decision.source}`,
      lost === null
        ? "Codex silently truncates the file and no heading starts at or after the budget, so no heading is lost entirely"
        : `Codex silently truncates the file; first heading lost entirely: "${lost}"`,
    ].join("; "),
  ];
}

function baseReport(
  target: OperatorTarget,
  operator: OperatorManifest,
  status: "missing" | "no-manifest" | "unverifiable",
  reason: string | null,
): TargetReport {
  return {
    path: target.path,
    status,
    installedVersion: null,
    pin: null,
    divergence: null,
    driftFiles: null,
    repoProfile: null,
    operatorProfile: operator.defaults.profile,
    repoTiers: null,
    operatorTiers: operator.defaults.tiers,
    divergentModelRoles: [],
    versionLag: false,
    reason,
  };
}

/**
 * Stats `path`, distinguishing "does not exist" (`ENOENT`) from every other
 * stat failure (most commonly `EACCES` on an ancestor directory). Plain
 * `existsSync` cannot make this distinction: it swallows every error alike
 * and returns `false` either way (review round 2, M2), which is exactly
 * what let an inaccessible-but-present target get misreported as
 * `missing`/`no-manifest` and then pruned out of the registry on a guess.
 */
export function statOrClassify(
  path: string,
): { kind: "ok"; stat: Stats } | { kind: "enoent" } | { kind: "error" } {
  try {
    return { kind: "ok", stat: statSync(path) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "enoent" }
      : { kind: "error" };
  }
}

/**
 * Computes one target's status against the operator's registry. Pure
 * read-only I/O (existence checks, file hashing, reading the target's own
 * repo manifest); no printing, no `process.exit`. Exported standalone so a
 * later `adopt` command can reuse the same per-target computation `doctor`
 * uses. `codexInputs` overrides the home directory and environment the
 * Codex budget check reads (it defaults to the real {@link homedir} and
 * `process.env`); `runDoctor` threads its own test-only option through.
 */
export function inspectTarget(
  target: OperatorTarget,
  operator: OperatorManifest,
  kitVersion: string,
  codexInputs?: CodexBudgetInputs,
): TargetReport {
  const dirStat = statOrClassify(target.path);
  if (dirStat.kind === "enoent") {
    return baseReport(target, operator, "missing", null);
  }
  if (dirStat.kind === "error") {
    return baseReport(
      target,
      operator,
      "unverifiable",
      "directory not accessible",
    );
  }
  if (!dirStat.stat.isDirectory()) {
    return baseReport(target, operator, "missing", null);
  }

  const manifestStat = statOrClassify(join(target.path, MANIFEST_PATH));
  if (manifestStat.kind === "enoent") {
    return baseReport(target, operator, "no-manifest", null);
  }
  if (manifestStat.kind === "error") {
    return baseReport(
      target,
      operator,
      "unverifiable",
      "directory not accessible",
    );
  }

  let manifest: Manifest | undefined;
  try {
    manifest = readInstalledManifest(target.path);
  } catch {
    // Strict reinstall validation must not abort inspection of other targets.
    return baseReport(target, operator, "unverifiable", "manifest unreadable");
  }
  if (!manifest) {
    return baseReport(target, operator, "unverifiable", "manifest unreadable");
  }

  const driftFiles = computeDriftFiles(target.path, manifest);

  const divergentModelRoles = rolesForProfile(manifest.profile).filter(
    (role) =>
      manifest.harnesses.some(
        (harness) => harness === "claude" || harness === "opencode",
      ) &&
      resolvedModel(manifest.models, role) !==
        resolvedModel(operator.defaults.models, role),
  );
  const routingComparison = compareRoutingState(manifest, operator.defaults, {
    harnesses: manifest.harnesses,
    profile: manifest.profile,
    tiers: manifest.tiers,
  });
  const divergence: TargetDivergence = {
    profile: manifest.profile !== operator.defaults.profile,
    tiers: manifest.tiers !== operator.defaults.tiers,
    models: divergentModelRoles.length > 0,
    ...(routingComparison.differs ? { routing: true } : {}),
  };

  // A recorded pin suppresses version-lag only when the pin equals the
  // repo's own installed version: that is the expected, deliberate-stay
  // state. When the pin and the installed version differ, the installed
  // manifest no longer reflects what was pinned (someone changed the pin
  // without reapplying, or the installed version drifted some other way),
  // so the target is still version-lag, even though it carries a pin
  // (drift, if also present, still takes precedence over the final status
  // field below). With no pin at all, version-lag compares the installed
  // version against the running kit version, as before.
  const hasPin = typeof manifest.pin === "string" && manifest.pin.length > 0;
  const versionLag = hasPin
    ? manifest.pin !== manifest.version
    : manifest.version !== kitVersion;

  const knowledgeWarnings = computeKnowledgeWarnings(target.path, manifest);
  const codexWarnings = computeCodexBudgetWarnings(
    target.path,
    manifest,
    codexInputs ?? { homeDir: homedir(), env: process.env },
  );

  let status: TargetStatus;
  if (driftFiles.length > 0) {
    status = "drift";
  } else if (
    divergence.profile ||
    divergence.tiers ||
    divergence.models ||
    divergence.routing
  ) {
    status = "divergent";
  } else if (versionLag) {
    status = "version-lag";
  } else {
    status = "clean";
  }

  return {
    path: target.path,
    status,
    installedVersion: manifest.version.length > 0 ? manifest.version : null,
    pin: hasPin ? (manifest.pin as string) : null,
    divergence,
    driftFiles: driftFiles.length > 0 ? driftFiles : null,
    ...(routingComparison.gaps.length > 0
      ? { routingComparisonGaps: routingComparison.gaps }
      : {}),
    ...(knowledgeWarnings.length > 0 ? { knowledgeWarnings } : {}),
    ...(codexWarnings.length > 0 ? { codexWarnings } : {}),
    repoProfile: manifest.profile,
    operatorProfile: operator.defaults.profile,
    repoTiers: manifest.tiers,
    operatorTiers: operator.defaults.tiers,
    divergentModelRoles,
    versionLag,
    reason: null,
  };
}

const REMOVE_ON_PRUNE: ReadonlySet<TargetStatus> = new Set<TargetStatus>([
  "missing",
  "no-manifest",
]);

/**
 * Re-reads `<home>/manifest.json`'s raw JSON (independent of
 * `readOperatorManifest`'s own parsed, validated result) and counts the
 * entries in its `targets` array, or `null` when the file cannot be read
 * or parsed at all. `readOperatorManifest` silently drops any raw target
 * entry that fails its own per-entry shape check, so its parsed
 * `manifest.targets.length` alone cannot tell whether the file held extra,
 * unvalidatable entries; this reads the same bytes a second time to answer
 * exactly that (review round 2, M3).
 */
function countRawTargets(home: string): number | null {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(home, OPERATOR_MANIFEST_FILENAME), "utf8"),
    );
    if (typeof raw !== "object" || raw === null) return null;
    const candidate = raw as Record<string, unknown>;
    return Array.isArray(candidate.targets) ? candidate.targets.length : 0;
  } catch {
    return null;
  }
}

/**
 * Walks the operator manifest's target registry at `home` and reports each
 * target's status. No printing, no `process.exit`: `cli.ts` turns this
 * into human or `--json` output and applies `exitCode` itself.
 *
 * Exit-code contract: 2 when no operator manifest exists (nothing else is
 * evaluated); else 1 if any *remaining* target (after an optional prune) is
 * `drift`, `missing`, `no-manifest`, or `unverifiable`; else 0.
 *
 * `--prune`: targets whose status is `missing` or `no-manifest` are removed
 * from the operator manifest's `targets` array and persisted (only when at
 * least one target was actually removed, mirroring `setup`'s no-op-write
 * avoidance) before the exit code and `targets` in the returned report are
 * computed, so both reflect the post-prune registry. `unverifiable` targets
 * are never removed (see {@link TargetStatus}'s doc comment). `pruned`
 * always lists the removed paths, even when empty. The whole re-read,
 * report computation, and write run inside {@link updateOperatorManifest}'s
 * single locked critical section (review round 1, H1's own fix, reused
 * here rather than doctor keeping a second, unlocked read-modify-write path
 * of its own), so a concurrent `apply`/`setup`/another `doctor --prune`
 * cannot land its own write in between this read and this write.
 *
 * `options.lockOptions` is exposed only so tests can shrink
 * `updateOperatorManifest`'s lock-acquire timeout/staleness/poll windows
 * below their production defaults (see `OperatorManifestLockOptions`);
 * production callers should omit it entirely. `options.codexInputs` is
 * likewise test-only: it replaces the real home directory and `process.env`
 * the Codex user-config layer of {@link TargetReport.codexWarnings} reads.
 * `updateOperatorManifest`
 * (via `withOperatorManifestLock`) can itself throw rather than return,
 * most commonly `OperatorManifestLockTimeoutError` (another
 * orchestrator-workflow command holds the lock past the timeout) or any
 * other error raised while acquiring it (e.g. `EACCES` creating the lock
 * directory under a read-only operator home). This function deliberately
 * does not catch either: `cli.ts`'s `doctor` action is the layer that
 * turns such a throw into a `--json`/human-readable exit-2 report,
 * exactly the way it already turns a returned `DoctorReport` into one.
 */
export function runDoctor(
  home: string,
  options: {
    prune?: boolean;
    lockOptions?: OperatorManifestLockOptions;
    codexInputs?: CodexBudgetInputs;
  } = {},
): DoctorReport {
  const state: OperatorManifestState = operatorManifestState(home);
  if (state.kind !== "ok") {
    // `absent`: no file to read. `unreadable`: the file exists but is
    // corrupt or does not validate. Distinguished here so the CLI can tell
    // an operator who has simply never run `setup` apart from one whose
    // manifest needs repair (the latter must not be papered over by
    // re-running `setup`, which would silently rewrite `targets: []` over
    // a possibly-fine targets array sitting next to the unreadable
    // envelope).
    const error: NonNullable<DoctorReport["error"]> =
      state.kind === "absent"
        ? "no-operator-manifest"
        : "operator-manifest-unreadable";
    return {
      operatorHome: home,
      operatorVersion: PACKAGE_VERSION,
      targets: [],
      pruned: [],
      exitCode: 2,
      unvalidatedDropped: 0,
      error,
    };
  }

  const pruned: string[] = [];
  let unvalidatedDropped = 0;
  let targets: TargetReport[];

  if (options.prune) {
    // `computedReports`/`pruned`/`unvalidatedDropped` are captured from
    // inside `mutate` (mirroring `apply`'s own `resolvedTargetPath`/
    // `alreadyRegistered` capture in cli.ts) since `mutate` can only return
    // an `OperatorManifest | undefined`. `mutate` re-reads and re-computes
    // from scratch rather than reusing `state` above (which may already be
    // stale by the time the lock is granted), the same reasoning `apply`'s
    // own re-read documents.
    let computedReports: TargetReport[] | undefined;
    const result = updateOperatorManifest(
      home,
      (current, innerState) => {
        if (innerState.kind !== "ok" || !current) {
          return undefined;
        }
        const reports = current.targets.map((target) =>
          inspectTarget(target, current, PACKAGE_VERSION, options.codexInputs),
        );
        computedReports = reports;

        const keepPaths = new Set<string>();
        for (const report of reports) {
          if (REMOVE_ON_PRUNE.has(report.status)) {
            pruned.push(report.path);
          } else {
            keepPaths.add(report.path);
          }
        }
        if (pruned.length === 0) {
          return undefined;
        }

        const rawTargetCount = countRawTargets(home);
        if (rawTargetCount !== null) {
          unvalidatedDropped = Math.max(
            0,
            rawTargetCount - current.targets.length,
          );
        }

        return {
          ...current,
          targets: current.targets.filter((target) =>
            keepPaths.has(target.path),
          ),
          updatedAt: new Date().toISOString(),
        };
      },
      options.lockOptions,
    );

    if (result.state.kind !== "ok") {
      // The manifest that read `"ok"` in the outer, unlocked check above
      // (`state`) was found gone or unreadable once the lock was actually
      // granted: a concurrent writer's own read-modify-write landed in
      // between that outer read and this one. `state` is now stale and
      // must not be used as a fallback source of targets (that fallback
      // is exactly what previously let a `--prune` run report, and
      // silently keep, target rows against a registry that no longer
      // exists on disk). Report the failure directly instead, the same
      // shape the outer absent/unreadable check above already returns.
      const error: NonNullable<DoctorReport["error"]> =
        result.state.kind === "absent"
          ? "no-operator-manifest"
          : "operator-manifest-unreadable";
      return {
        operatorHome: home,
        operatorVersion: PACKAGE_VERSION,
        targets: [],
        pruned: [],
        exitCode: 2,
        unvalidatedDropped: 0,
        error,
      };
    }

    // `result.state.kind === "ok"` means `mutate` above ran with a truthy
    // `current`, so `computedReports` was always assigned.
    targets = (computedReports as TargetReport[]).filter(
      (report) => !pruned.includes(report.path),
    );
  } else {
    targets = state.manifest.targets.map((target) =>
      inspectTarget(
        target,
        state.manifest,
        PACKAGE_VERSION,
        options.codexInputs,
      ),
    );
  }

  const exitCode: 0 | 1 = targets.some(
    (report) =>
      report.status === "drift" ||
      report.status === "missing" ||
      report.status === "no-manifest" ||
      report.status === "unverifiable",
  )
    ? 1
    : 0;

  return {
    operatorHome: home,
    operatorVersion: PACKAGE_VERSION,
    targets,
    pruned,
    exitCode,
    unvalidatedDropped,
  };
}

/**
 * The extra `--json` key `adopt` adds only for a target status that should
 * be unreachable immediately after a successful directory/manifest read
 * (`missing`/`no-manifest`/`unverifiable`, i.e. wherever
 * {@link adoptExitCodeForStatus} returns `2`): `error:
 * "unexpected-target-status"`, so a `--json` consumer can tell this genuine
 * internal-error case apart from any other result sharing the same exit
 * code (fix-round, review finding M3). Appended at the end of this module,
 * after every other exported member, so adding it does not shift any
 * existing `doctor.ts:` line citation in docs/okf. A pure function,
 * exported and unit-tested directly (the branch itself stays unreachable
 * through a live `adopt` run, the same "unreachable in practice" property
 * `cli.ts`'s own comment on that branch already documents).
 */
export function adoptJsonExtras(
  status: TargetStatus,
): { error: "unexpected-target-status" } | Record<string, never> {
  return adoptExitCodeForStatus(status) === 2
    ? { error: "unexpected-target-status" }
    : {};
}
