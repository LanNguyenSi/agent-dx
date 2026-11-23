/**
 * `spec-gate lint`: load the spec directory, pick the profile, run the
 * rules that apply, apply the acknowledgements and build the report.
 */
import fs from "node:fs";
import { applyAcks } from "./acks.js";
import { loadAcks, loadInputs, type FindingSink } from "./load.js";
import { resolveProfile } from "./profile.js";
import { RULES, activeRules, findRule } from "./registry.js";
import { buildReport } from "./report.js";
import type {
  Finding,
  GitInputs,
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
  /** The repository and base revision for rules that need them. */
  git?: GitInputs;
}

export type LintRunResult =
  { ok: true; report: LintReport } | { ok: false; message: string };

/** Turns a rule id and a rule's finding into a `Finding` with the registered level. */
function stamp(
  rules: readonly RuleDef[],
  rule: string,
  finding: RuleFinding,
): Finding {
  const def = findRule(rules, rule);
  if (def === undefined) {
    throw new Error(`rule ${rule} is not in the registry`);
  }
  return { rule, level: def.level, ...finding };
}

/**
 * Lints one spec directory. `rules` defaults to the registry; a test passes
 * its own list. Returns a failure only when `specDir` is not a directory;
 * every problem inside the directory is a finding.
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

  const found: Finding[] = [];
  const sink: FindingSink = {
    add: (rule, finding) => found.push(stamp(rules, rule, finding)),
  };
  const inputs = loadInputs(specDir, sink);
  const acks = loadAcks(specDir, sink);

  const mode: Mode = options.final === true ? "final" : "lint";
  const choice = resolveProfile(inputs.triage, options.profile);
  for (const { rule, finding } of choice.findings) sink.add(rule, finding);

  const spec = inputs.spec.state === "ok" ? inputs.spec.value : null;
  const ctx = {
    inputs,
    status: spec?.frontmatter.status ?? null,
    profile: choice.profile,
    mode,
    ...(options.git !== undefined ? { git: options.git } : {}),
  };
  for (const rule of activeRules(rules, ctx)) {
    for (const finding of rule.check!(ctx)) sink.add(rule.id, finding);
  }

  const errors = found.filter((f) => f.level === "error");
  const outcome = applyAcks(
    acks,
    found.filter((f) => f.level === "warning"),
    rules,
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
  });
  return { ok: true, report };
}
