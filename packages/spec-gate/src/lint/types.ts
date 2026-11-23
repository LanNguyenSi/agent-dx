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
  SpecStatus,
  TestPlan,
  Triage,
} from "../formats/index.js";
import type { SourceMetaLines } from "./meta.js";

export type Level = "error" | "warning";
export type Profile = "light" | "full";
export type ProfileSource = "triage" | "flag" | "default";
export type Mode = "lint" | "final";

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
  meta: Loaded<SourceMetaLines>;
}

/**
 * Where rules that read the repository get it. No rule in the engine reads
 * it; the field is the seam for rules that need a repository and a base
 * revision. The engine skips a rule that needs it while it is absent.
 */
export interface GitInputs {
  repo: string;
  base: string;
}

export interface RuleContext {
  inputs: LintInputs;
  /** Frontmatter `status`, or `null` when `spec.md` did not parse. */
  status: SpecStatus | null;
  profile: Profile;
  mode: Mode;
  git?: GitInputs;
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
