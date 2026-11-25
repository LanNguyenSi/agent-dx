/**
 * Shared types of the lint engine: the finding, the report, the rule
 * registry entry and the inputs a rule reads.
 *
 * A rule never builds a finding itself. It returns `RuleFinding`s and the
 * engine stamps the rule id and the level from the registry, so a level
 * lives in exactly one place and the report shape never depends on a rule.
 */
import type {
  Bindings,
  Questions,
  Spec,
  SpecGateConfig,
  SpecStatus,
  TestPlan,
  Triage,
} from "../formats/index.js";
import type { LintSourceMeta } from "./meta.js";

export type Level = "error" | "warning";
export type Profile = "light" | "full";
export type ProfileSource = "triage" | "flag" | "default";
export type Mode = "lint" | "final";

/** Why a rule was not evaluated in a run. */
export const SKIP_REASONS = [
  "profile",
  "gate",
  "input-absent",
  "input-failed",
  "no-git",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface SkippedRule {
  rule: string;
  reason: SkipReason;
}

export const REPORT_FORMAT = "spec-gate-lint/1";

/** What a rule returns; the engine adds `rule` and `level`. */
export interface RuleFinding {
  /** Relative to the spec directory, `/` separated. */
  file: string;
  /** Dotted location like the format layer: `$`, `AC-2`, `TP-1.kind`, `[0].rule`. */
  path: string;
  /** The spec or test-plan ID the finding is about, or a rule-defined target. */
  id?: string;
  /** 1-based line in `file` where the file is line oriented. */
  line?: number;
  /** Stable machine-readable code of the underlying problem, where one exists. */
  code?: string;
  message: string;
}

export interface Finding extends RuleFinding {
  rule: string;
  level: Level;
}

export interface AckedFinding extends Finding {
  reason: string;
}

export interface LintReport {
  format: typeof REPORT_FORMAT;
  spec: string | null;
  mode: Mode;
  profile: Profile;
  profile_source: ProfileSource;
  status: SpecStatus | null;
  ok: boolean;
  errors: Finding[];
  warnings: Finding[];
  acked: AckedFinding[];
  /** The rules not evaluated in this run, by rule id. */
  skipped: SkippedRule[];
  counts: { errors: number; warnings: number; acked: number };
}

/** A file the loader read: parsed, not there, or there and unusable. */
export type Loaded<T> =
  { state: "ok"; value: T } | { state: "absent" } | { state: "failed" };

export const INPUT_NAMES = [
  "spec",
  "testplan",
  "bindings",
  "questions",
  "triage",
  "meta",
] as const;
export type InputName = (typeof INPUT_NAMES)[number];

export interface LintInputs {
  spec: Loaded<Spec>;
  testplan: Loaded<TestPlan>;
  bindings: Loaded<Bindings>;
  questions: Loaded<Questions>;
  triage: Loaded<Triage>;
  meta: Loaded<LintSourceMeta>;
}

/**
 * The repository a rule that needs git reads, resolved once before any rule
 * runs (`resolveGitInputs`): every commit is a full commit id of a commit
 * object in `repo`. The lint only reads; it never fetches.
 */
export interface GitInputs {
  /** The top level of the work tree; never printed in a report. */
  repo: string;
  /**
   * The commit the ancestry checks compare against: `--base` when given
   * (the pull request base), otherwise the commit `--default-ref` names.
   */
  reference: string;
  /** `merge-base(head, reference)`: the commit a diff of the spec change starts at. */
  diffBase: string;
  /** `HEAD` of the repository. */
  head: string;
}

export interface RuleContext {
  inputs: LintInputs;
  /** Frontmatter `status`, or `null` when `spec.md` did not parse. */
  status: SpecStatus | null;
  profile: Profile;
  mode: Mode;
  git?: GitInputs;
  /**
   * The spec directory as the caller named it. A rule reads the spec
   * directory through `inputs`; only a rule that reads a file the loader
   * does not load (`bindings.log`) or must name the directory in the
   * repository uses this.
   */
  specDir?: string;
  /**
   * The parsed `.spec-gate/config.yaml` given to `--config`, or `undefined`
   * when none was given or it did not parse or could not be read. It is not
   * one of the spec directory inputs: a rule that reads it falls back to
   * the format defaults when it is absent, it is never skipped for it.
   */
  config?: SpecGateConfig;
}

export interface RuleDef {
  /** Stable, lower-kebab-case, English. */
  id: string;
  level: Level;
  /** The profiles the rule runs in. */
  profiles: readonly Profile[];
  /** True: applies only when the status is `proposed` or the run is final. */
  gated: boolean;
  /** True for a warning that `acks.yaml` may acknowledge. */
  ackable: boolean;
  /** True when the rule reads the repository; skipped without `ctx.git`. */
  needsGit?: boolean;
  /** One line for the rule table in `docs/lint.md`. */
  summary: string;
  /**
   * Inputs that must have parsed. The rule is skipped when one of them is
   * absent or failed, so a missing parse result never cascades into
   * follow-up findings.
   */
  needs: readonly InputName[];
  /** Inputs the rule reads when present; skipped only when one failed. */
  uses?: readonly InputName[];
  /**
   * The check. A rule without one is raised by the loader, the profile
   * step or the acknowledgement step instead.
   */
  // eslint-disable-next-line no-unused-vars
  check?: (ctx: RuleContext) => RuleFinding[];
}
