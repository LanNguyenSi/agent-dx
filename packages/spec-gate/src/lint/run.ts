/**
 * `spec-gate lint`: load the spec directory, pick the profile, run the
 * rules that apply, apply the acknowledgements and build the report.
 */
import fs from "node:fs";
import path from "node:path";
import { ackTextProblem, applyAcks } from "./acks.js";
import { loadConfigAtReference } from "./git/config.js";
import {
  hasGitInputs,
  resolveGitInputs,
  type GitRequest,
} from "./git/resolve.js";
import { loadAcks, loadConfig, loadInputs, type FindingSink } from "./load.js";
import { resolveProfile } from "./profile.js";
import { RULES, findRule, planRules } from "./registry.js";
import { buildReport } from "./report.js";
import type {
  Finding,
  LintReport,
  Mode,
  Profile,
  RuleDef,
  RuleFinding,
} from "./types.js";

export interface LintOptions {
  /** Unacknowledged warnings fail the run. */
  strict?: boolean;
  /** Treat the spec as `proposed` whatever its status says. */
  final?: boolean;
  /** Used when `triage.json` gives no profile; an error when it disagrees. */
  profile?: Profile;
  /**
   * The git flags for the rules that read the repository. With a default ref
   * or a base commit the repository is read, offline and read-only, and
   * `.spec-gate/config.yaml` is read at the reference commit; without one
   * every rule that needs git is skipped. Resolved once, here.
   */
  git?: GitRequest;
  /**
   * A `.spec-gate/config.yaml`-format file, read for the rules that take
   * repo-wide settings. Absent: every rule uses its format default. A file
   * that cannot be read or parsed is a `file` or `format` finding and the
   * rules still run on their defaults. The empty string is a usage error:
   * the run fails without a report, and so is a path together with git
   * inputs (the config is read at the reference commit then).
   */
  configPath?: string;
}

export type LintRunResult =
  { ok: true; report: LintReport } | { ok: false; message: string };

/**
 * Turns a rule id and a rule's finding into a `Finding` with the registered
 * level. The registry fields come last, so a rule cannot change its own id
 * or level. A finding of an ackable rule must name its target `id`: that is
 * what an ack matches on, and a rule without one breaks its contract.
 */
function stamp(
  rules: readonly RuleDef[],
  rule: string,
  finding: RuleFinding,
): Finding {
  const def = findRule(rules, rule);
  if (def === undefined) {
    throw new Error(`rule ${rule} is not in the registry`);
  }
  if (
    def.ackable &&
    (finding.id === undefined || ackTextProblem(finding.id) !== null)
  ) {
    throw new Error(
      `rule ${rule} is ackable and returned a finding without an id an ack can name`,
    );
  }
  return { ...finding, rule, level: def.level };
}

/**
 * Lints one spec directory. `rules` defaults to the registry; a test passes
 * its own list. Returns a failure only on a usage error: `specDir` is not a
 * directory, `configPath` names no file (empty, or a path without a file
 * name) or comes with git inputs, or a git input does not resolve; every
 * problem inside the directory is a finding.
 */
export function lintSpecDir(
  specDir: string,
  options: LintOptions = {},
  rules: readonly RuleDef[] = RULES,
): LintRunResult {
  let isDir = false;
  try {
    isDir = fs.statSync(specDir).isDirectory();
  } catch {
    // reported below
  }
  if (!isDir) {
    return { ok: false, message: `${specDir} is not a directory` };
  }
  if (
    options.configPath !== undefined &&
    path.basename(options.configPath).trim() === ""
  ) {
    return { ok: false, message: "--config needs a path" };
  }
  if (options.configPath !== undefined && hasGitInputs(options.git)) {
    return {
      ok: false,
      message:
        "--config cannot be combined with --default-ref or --base: the config is read at the reference commit then",
    };
  }
  const resolved = resolveGitInputs(specDir, options.git);
  if (!resolved.ok) return { ok: false, message: resolved.message };
  const git = resolved.git;

  const found: Finding[] = [];
  const sink: FindingSink = {
    add: (rule, finding) => found.push(stamp(rules, rule, finding)),
  };
  const inputs = loadInputs(specDir, sink);
  const acks = loadAcks(specDir, sink);
  const config =
    options.configPath !== undefined
      ? loadConfig(options.configPath, sink)
      : git !== undefined
        ? loadConfigAtReference(git, sink)
        : undefined;

  const mode: Mode = options.final === true ? "final" : "lint";
  const choice = resolveProfile(inputs.triage, options.profile);
  for (const { rule, finding } of choice.findings) sink.add(rule, finding);

  const spec = inputs.spec.state === "ok" ? inputs.spec.value : null;
  const ctx = {
    inputs,
    status: spec?.frontmatter.status ?? null,
    profile: choice.profile,
    mode,
    ...(git !== undefined ? { git } : {}),
    ...(config?.state === "ok" ? { config: config.value } : {}),
  };
  const plan = planRules(rules, ctx);
  for (const rule of plan.evaluated) {
    if (rule.check === undefined) continue;
    for (const finding of rule.check(ctx)) sink.add(rule.id, finding);
  }
  if (mode === "final" && findRule(rules, "rule-skipped") !== undefined) {
    for (const skip of plan.skipped) {
      if (
        (skip.reason === "no-git" || skip.reason === "input-absent") &&
        findRule(rules, skip.rule)?.level === "error"
      ) {
        sink.add("rule-skipped", {
          file: "$",
          path: "$",
          id: skip.rule,
          code: skip.reason,
          message: `the error rule ${skip.rule} was skipped (${skip.reason}) and a final run does not pass without it`,
        });
      }
    }
  }

  const errors = found.filter((f) => f.level === "error");
  const outcome = applyAcks(
    acks,
    found.filter((f) => f.level === "warning"),
    rules,
    new Set(plan.evaluated.map((rule) => rule.id)),
  );
  const ackFindings = outcome.findings.map(({ rule, finding }) =>
    stamp(rules, rule, finding),
  );

  const report = buildReport({
    spec: spec?.frontmatter.id ?? null,
    mode,
    profile: choice.profile,
    profileSource: choice.source,
    status: ctx.status,
    strict: options.strict === true,
    errors: [...errors, ...ackFindings.filter((f) => f.level === "error")],
    warnings: [
      ...outcome.warnings,
      ...ackFindings.filter((f) => f.level === "warning"),
    ],
    acked: outcome.acked,
    skipped: plan.skipped,
  });
  return { ok: true, report };
}
