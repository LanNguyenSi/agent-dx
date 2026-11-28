/**
 * The evidence rules: is the runner's evidence in the layout, and is it
 * attributable, fresh and external enough to count. The layout itself
 * (names, kinds of entries, parse) is the loader's (`load.ts`), so these
 * rules only see parsed envelopes and never repeat a layout finding.
 *
 * - `stale-evidence` (needs git): a `baseline` envelope that no longer
 *   matches what the spec was written against. The five causes are the
 *   commit, the cleanliness, the command-set digest, the selector and an
 *   indeterminable row command (`command-unknown`: the row is not
 *   `static` and its binding has no selector, or the row is selector-bound
 *   and no command of the set carries the placeholder; a `static` row
 *   naming no command of the set is reported by `static-command-unknown`).
 *   The expected digest is `expectedCommandsDigest` of the one command the
 *   row uses in `.spec-gate/commands.yaml` at `commands_ref`, read at that
 *   commit like the reference-state rules do, never at the head or the
 *   default tip; an indeterminable command fails closed, it never skips
 *   the digest silently. `closure` envelopes are never stale
 *   (`staleEvidenceApplies`).
 * - `unproven`: a `stays-green` row with no fresh, passing `baseline`
 *   envelope. It judges the causes visible in the envelope's own fields
 *   (commit, dirty, selector); the digest cause belongs to
 *   `stale-evidence`, the only evidence rule that reads the repository.
 * - `self-reported`: a row whose file holds an envelope of `producer:
 *   local`. `producer: ci` is not judged here: closure marks it verified
 *   only when the host vouches for its run (`--github-repo`), which lint
 *   has no part of.
 * - `evidence-unknown-row`: a well-named `evidence/TP-<n>.jsonl` whose
 *   `TP-<n>` is no test-plan row.
 */
import {
  EVIDENCE_DIR,
  EVIDENCE_FILE_SUFFIX,
  expectedCommandsDigest,
  staleEvidenceApplies,
  type EvidenceEnvelope,
  type TestPlanRow,
} from "../../formats/index.js";
import {
  COMMANDS_PATH,
  rowTemplate,
  templatesAtCommandsRef,
  type Templates,
} from "../commands-at-ref.js";
import { LintGitError } from "../git/index.js";
import { valueOf } from "../inputs.js";
import type {
  GitInputs,
  Loaded,
  RuleContext,
  RuleDef,
  RuleFinding,
} from "../types.js";

const TESTPLAN = "testplan.yaml";
const FULL: RuleDef["profiles"] = ["full"];

/** The value of an input a rule declared in `uses`, or undefined when absent. */
function used<T>(input: Loaded<T> | undefined): T | undefined {
  return input?.state === "ok" ? input.value : undefined;
}

/** The repository of a rule that declared `needsGit`; the engine skips the rule otherwise. */
function gitOf(ctx: RuleContext): GitInputs {
  if (ctx.git === undefined) {
    throw new Error("a rule read git inputs it did not declare in needsGit");
  }
  return ctx.git;
}

function evidenceFile(tpId: string): string {
  return `${EVIDENCE_DIR}/${tpId}${EVIDENCE_FILE_SUFFIX}`;
}

// ------------------------------------------------------------- stale-evidence

function staleEvidenceCheck(ctx: RuleContext): RuleFinding[] {
  const spec = valueOf(ctx.inputs.spec);
  const plan = valueOf(ctx.inputs.testplan);
  const bindings = used(ctx.inputs.bindings) ?? {};
  const evidence = used(ctx.inputs.evidence);
  if (evidence === undefined) return [];
  const baseCommit = spec.frontmatter.base_commit;
  const rowsById = new Map(plan.map((row) => [row.id, row]));
  const baseline: {
    tpId: string;
    row: TestPlanRow | undefined;
    env: EvidenceEnvelope;
    index: number;
  }[] = [];
  for (const [tpId, envelopes] of Object.entries(evidence)) {
    envelopes.forEach((env, index) => {
      if (!staleEvidenceApplies(env.phase)) return;
      baseline.push({ tpId, row: rowsById.get(tpId), env, index });
    });
  }
  if (baseline.length === 0) return [];

  const needsTemplates = baseline.some(
    (item) =>
      item.row !== undefined &&
      (item.row.kind === "static" ||
        bindings[item.row.id]?.selector !== undefined),
  );
  const findings: RuleFinding[] = [];
  let templates: Templates | undefined;
  if (needsTemplates) {
    const git = gitOf(ctx);
    templates = templatesAtCommandsRef(
      git.repo,
      spec.frontmatter.commands_ref,
      git.reference,
    );
    if (!templates.ok) {
      findings.push({
        file: `repo:${COMMANDS_PATH}`,
        path: "$",
        id: "commands",
        code: templates.code,
        message: `${templates.message}; the commands_digest of the baseline envelopes was not checked`,
      });
    }
  }

  for (const { tpId, row, env, index } of baseline) {
    const file = evidenceFile(tpId);
    const at = (cause: string) =>
      `${tpId} ${file}[${index + 1}]: baseline envelope ${cause}`;
    if (env.commit !== baseCommit) {
      findings.push({
        file,
        path: `[${index}]`,
        line: index + 1,
        id: tpId,
        code: "commit-mismatch",
        message: `${at(`names commit ${env.commit}, the spec was written against base_commit ${baseCommit}`)}`,
      });
    }
    if (env.dirty) {
      findings.push({
        file,
        path: `[${index}]`,
        line: index + 1,
        id: tpId,
        code: "dirty",
        message: `${at("was gathered on a dirty work tree (dirty: true)")}`,
      });
    }
    if (row !== undefined) {
      const selectorBound = bindings[tpId]?.selector !== undefined;
      let unknownCommand: string | undefined;
      if (row.kind !== "static" && !selectorBound) {
        unknownCommand = "row is not static and its binding has no selector";
      } else if (templates?.ok === true) {
        const template = rowTemplate(
          row,
          bindings[tpId],
          templates.selectorArgv,
          templates.byName,
        );
        if (template === undefined) {
          if (selectorBound) {
            unknownCommand = `selector-bound row but no command with {selector} in ${COMMANDS_PATH} at commands_ref`;
          }
        } else if (env.commands_digest !== expectedCommandsDigest(template)) {
          findings.push({
            file,
            path: `[${index}]`,
            line: index + 1,
            id: tpId,
            code: "digest-mismatch",
            message: `${at("holds a commands_digest that is not the digest of the one command the row uses at commands_ref")}`,
          });
        }
      }
      if (unknownCommand !== undefined) {
        findings.push({
          file,
          path: `[${index}]`,
          line: index + 1,
          id: tpId,
          code: "command-unknown",
          message: `${at(`has no determinable command to compare its digest with: ${unknownCommand}`)}`,
        });
      }
    }
    if (row !== undefined) {
      const expected = bindings[tpId]?.selector ?? null;
      if (env.selector !== expected) {
        findings.push({
          file,
          path: `[${index}]`,
          line: index + 1,
          id: tpId,
          code: "selector-mismatch",
          message: `${at(`carries selector ${JSON.stringify(env.selector)}, the row's binding selector is ${JSON.stringify(expected)}`)}`,
        });
      }
    }
  }
  return findings;
}

/** A git read that could not run is a finding of the rule, never a pass. */
export function checkStaleEvidence(ctx: RuleContext): RuleFinding[] {
  try {
    return staleEvidenceCheck(ctx);
  } catch (err) {
    if (!(err instanceof LintGitError)) throw err;
    return [
      {
        file: `repo:${COMMANDS_PATH}`,
        path: "$",
        id: "commands",
        code: err.code,
        message: `the check could not read the repository (${err.code}); the baseline envelopes were not checked against the command set`,
      },
    ];
  }
}

// -------------------------------------------------------------------- unproven

/**
 * Whether one envelope proves the row green at `base_commit`: a `baseline`
 * envelope with `result: pass` that is not stale by the fields it carries
 * itself. The digest cause is not judged here; `stale-evidence` owns it
 * because it is the only evidence rule that reads the repository.
 */
function provesGreen(
  env: EvidenceEnvelope,
  baseCommit: string,
  expectedSelector: string | null,
): boolean {
  return (
    env.phase === "baseline" &&
    env.result === "pass" &&
    !env.dirty &&
    env.commit === baseCommit &&
    env.selector === expectedSelector
  );
}

export function checkUnproven(ctx: RuleContext): RuleFinding[] {
  const spec = valueOf(ctx.inputs.spec);
  const plan = valueOf(ctx.inputs.testplan);
  const bindings = used(ctx.inputs.bindings) ?? {};
  const evidence = used(ctx.inputs.evidence) ?? {};
  const baseCommit = spec.frontmatter.base_commit;
  const findings: RuleFinding[] = [];
  for (const row of plan) {
    if (row.kind !== "stays-green") continue;
    const expectedSelector = bindings[row.id]?.selector ?? null;
    const proven = (evidence[row.id] ?? []).some((env) =>
      provesGreen(env, baseCommit, expectedSelector),
    );
    if (proven) continue;
    findings.push({
      file: TESTPLAN,
      path: `${row.id}.kind`,
      id: row.id,
      message: `${row.id} is stays-green and has no fresh passing baseline envelope in ${evidenceFile(row.id)}: the claim that it stays green rests on no evidence gathered at base_commit and matching the row`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------- self-reported

export function checkSelfReported(ctx: RuleContext): RuleFinding[] {
  const evidence = used(ctx.inputs.evidence) ?? {};
  const findings: RuleFinding[] = [];
  for (const [tpId, envelopes] of Object.entries(evidence)) {
    if (!envelopes.some((env) => env.producer === "local")) continue;
    findings.push({
      file: evidenceFile(tpId),
      path: "$",
      id: tpId,
      message: `${tpId} has an envelope of producer local: a run the spec directory itself reports. producer ci is not judged here: closure marks it verified only when the host vouches for its run (--github-repo)`,
    });
  }
  return findings;
}

// --------------------------------------------------------- evidence-unknown-row

export function checkEvidenceUnknownRow(ctx: RuleContext): RuleFinding[] {
  const plan = valueOf(ctx.inputs.testplan);
  const evidence = used(ctx.inputs.evidence) ?? {};
  const rows = new Set(plan.map((row) => row.id));
  const findings: RuleFinding[] = [];
  for (const tpId of Object.keys(evidence)) {
    if (rows.has(tpId)) continue;
    findings.push({
      file: evidenceFile(tpId),
      path: "$",
      id: tpId,
      message: `${evidenceFile(tpId)} names ${tpId}, which is no test-plan row: the file name is the mapping from an envelope to its row`,
    });
  }
  return findings;
}

// -------------------------------------------------------------------- registry

/**
 * The evidence rules, in the order of `docs/lint.md`. All four run in the
 * full profile only and are not gated; `stale-evidence` is the only one
 * that reads the repository, so it is the one skipped `no-git` without
 * git inputs (a warning, so it never becomes a `rule-skipped` error).
 */
export const EVIDENCE_RULES: readonly RuleDef[] = [
  {
    id: "stale-evidence",
    level: "warning",
    profiles: FULL,
    gated: false,
    ackable: true,
    needsGit: true,
    summary:
      "A baseline envelope is stale: its commit is not the frontmatter base_commit, its work tree was dirty, its commands_digest is not the expected digest of the one command its row uses at commands_ref, its row has no determinable command (the row is not static and its binding has no selector, or the row is selector-bound and no command of the set carries {selector}), or its selector is not its row's binding selector; closure envelopes are never stale. Acknowledge with the row ID; an unreadable command set is acknowledged with ID commands.",
    needs: ["spec", "testplan"],
    uses: ["bindings", "evidence"],
    check: checkStaleEvidence,
  },
  {
    id: "unproven",
    level: "warning",
    profiles: FULL,
    gated: false,
    ackable: true,
    summary:
      "A stays-green row has no baseline envelope with result pass that is unstale by its own fields: commit equal to base_commit, work tree clean, selector equal to the row's binding selector. The digest cause is judged by stale-evidence, the only evidence rule that reads the repository. Acknowledge with the row ID.",
    needs: ["spec", "testplan"],
    uses: ["bindings", "evidence"],
    check: checkUnproven,
  },
  {
    id: "self-reported",
    level: "warning",
    profiles: FULL,
    gated: false,
    ackable: true,
    summary:
      "A row's evidence file holds an envelope of producer local. producer ci is not judged by lint: closure marks it verified only when the host vouches for its run (closure --github-repo). Acknowledge with the row ID.",
    needs: [],
    uses: ["evidence"],
    check: checkSelfReported,
  },
  {
    id: "evidence-unknown-row",
    level: "error",
    profiles: FULL,
    gated: false,
    ackable: false,
    summary:
      "Every well-named evidence/TP-<n>.jsonl names a test-plan row: the file name is the mapping from an envelope to its row, and a file for an unknown TP ID is an error.",
    needs: ["testplan"],
    uses: ["evidence"],
    check: checkEvidenceUnknownRow,
  },
];
