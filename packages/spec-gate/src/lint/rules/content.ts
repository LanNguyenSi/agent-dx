/**
 * The content rules: what the spec says, not whether it parses. Each is a
 * pure function over the loaded inputs; a rule that needs a file that did
 * not parse is skipped by the engine before it runs. Everything a format
 * parser already rejects (per-kind fields, ID shapes, duplicate IDs, live
 * retired spec IDs, missing attributes) arrives as a `format` finding and
 * is not re-checked here.
 */
import { DEFAULT_QUESTIONS_WARN_ABOVE } from "../../formats/config.js";
import { KIND_SPECS } from "../../formats/layers.js";
import { OWNER_NONE } from "../../formats/spec.js";
import { deriveTriageClass, TRIAGE_RULE_VERSION } from "../../triage/index.js";
import type {
  Questions,
  SpecGateConfig,
  TestPlan,
} from "../../formats/index.js";
import { valueOf } from "../inputs.js";
import { TRIAGE_FILE } from "../profile.js";
import { findProseWords } from "../prose.js";
import type { Loaded, RuleContext, RuleDef, RuleFinding } from "../types.js";

const SPEC = "spec.md";
const TESTPLAN = "testplan.yaml";
const BINDINGS = "bindings.yaml";
const QUESTIONS = "questions.json";
const META = "source/meta.json";

/** The value of an input a rule declared in `uses`, or undefined when absent. */
function used<T>(input: Loaded<T>): T | undefined {
  return input.state === "ok" ? input.value : undefined;
}

/** Every DF whose `affects_behavior` is true is covered by a test-plan row. */
export function checkDfCoverage(ctx: RuleContext): RuleFinding[] {
  const spec = valueOf(ctx.inputs.spec);
  const plan = valueOf(ctx.inputs.testplan);
  const covered = new Set(plan.flatMap((row) => row.covers));
  return spec.defaults
    .filter((df) => df.affects_behavior && !covered.has(df.id))
    .map((df) => ({
      file: SPEC,
      path: df.id,
      id: df.id,
      line: df.line,
      message: `${df.id} affects behaviour and is covered by no test-plan row`,
    }));
}

/** Every `covers` entry of a row names an AC, DF or NG of spec.md. */
export function checkTpCoversUnknown(ctx: RuleContext): RuleFinding[] {
  const spec = valueOf(ctx.inputs.spec);
  const plan = valueOf(ctx.inputs.testplan);
  const known = new Set([
    ...spec.acceptance.map((ac) => ac.id),
    ...spec.defaults.map((df) => df.id),
    ...spec.nonGoals.map((ng) => ng.id),
  ]);
  const findings: RuleFinding[] = [];
  for (const row of plan) {
    for (const target of row.covers) {
      if (known.has(target)) continue;
      findings.push({
        file: TESTPLAN,
        path: `${row.id}.covers`,
        id: row.id,
        message: `${row.id} covers ${target}, which is no AC, DF or NG of spec.md`,
      });
    }
  }
  return findings;
}

/** Every key of bindings.yaml is the ID of a test-plan row. */
export function checkBindingUnknown(ctx: RuleContext): RuleFinding[] {
  const plan = valueOf(ctx.inputs.testplan);
  const bindings = used(ctx.inputs.bindings) ?? {};
  const rows = new Set(plan.map((row: { id: string }) => row.id));
  return Object.keys(bindings)
    .filter((tpId) => !rows.has(tpId))
    .map((tpId) => ({
      file: BINDINGS,
      path: tpId,
      id: tpId,
      message: `bindings.yaml maps ${tpId}, which is no test-plan row`,
    }));
}

/**
 * At `proposed` the binding of each row matches what its kind requires in
 * `KIND_SPECS`: `new` or `existing` demand that very status, `none` allows
 * no entry at all, and `any` is unchecked. A missing binding for a kind
 * that needs one is an error of its own.
 */
export function checkBindingStatus(ctx: RuleContext): RuleFinding[] {
  const plan = valueOf(ctx.inputs.testplan);
  const bindings = used(ctx.inputs.bindings) ?? {};
  const findings: RuleFinding[] = [];
  for (const row of plan) {
    const want = KIND_SPECS[row.kind].bindingStatusAtProposed;
    const binding = bindings[row.id];
    if (want === "any") continue;
    if (want === "none") {
      if (binding !== undefined) {
        findings.push({
          file: BINDINGS,
          path: row.id,
          id: row.id,
          message: `kind ${row.kind} takes no binding, but bindings.yaml maps ${row.id}`,
        });
      }
      continue;
    }
    if (binding === undefined) {
      findings.push({
        file: BINDINGS,
        path: row.id,
        id: row.id,
        message: `kind ${row.kind} needs a binding with status ${want} at proposed; bindings.yaml has none for ${row.id}`,
      });
    } else if (binding.status !== want) {
      findings.push({
        file: BINDINGS,
        path: `${row.id}.status`,
        id: row.id,
        message: `${row.id} has binding status ${binding.status}; kind ${row.kind} needs ${want} at proposed`,
      });
    }
  }
  return findings;
}

/**
 * The ledger maps exactly the source lines of `source/meta.json`: one
 * finding per meta line with no ledger entry, one per ledger entry whose
 * source line the meta does not list.
 */
export function checkLedgerComplete(ctx: RuleContext): RuleFinding[] {
  const spec = valueOf(ctx.inputs.spec);
  const meta = valueOf(ctx.inputs.meta);
  const findings: RuleFinding[] = [];
  const mapped = new Set(spec.ledger.map((entry) => entry.sourceLine));
  meta.lines.forEach((line, i) => {
    if (mapped.has(line.id)) return;
    findings.push({
      file: META,
      path: `lines[${i}]`,
      id: line.id,
      message: `source line ${line.id} is listed in ${META} and mapped by no ledger entry`,
    });
  });
  const wanted = new Set(meta.lines.map((line) => line.id));
  for (const entry of spec.ledger) {
    if (wanted.has(entry.sourceLine)) continue;
    findings.push({
      file: SPEC,
      path: entry.id,
      id: entry.id,
      line: entry.line,
      message: `${entry.id} maps source line ${entry.sourceLine}, which ${META} does not list`,
    });
  }
  return findings;
}

/** Every target of a ledger entry is a live ID of spec.md. */
export function checkLedgerTargetUnknown(ctx: RuleContext): RuleFinding[] {
  const spec = valueOf(ctx.inputs.spec);
  const live = new Set(spec.ids);
  const findings: RuleFinding[] = [];
  for (const entry of spec.ledger) {
    for (const target of entry.targets) {
      if (live.has(target)) continue;
      findings.push({
        file: SPEC,
        path: entry.id,
        id: entry.id,
        line: entry.line,
        message: `${entry.id} maps to ${target}, which is no ID of spec.md`,
      });
    }
  }
  return findings;
}

/** Every SL ID an AC cites is the ID of a source-ledger entry. */
export function checkAcSourceUnknown(ctx: RuleContext): RuleFinding[] {
  const spec = valueOf(ctx.inputs.spec);
  const ledger = new Set(spec.ledger.map((entry) => entry.id));
  const findings: RuleFinding[] = [];
  for (const ac of spec.acceptance) {
    for (const source of ac.source) {
      if (ledger.has(source)) continue;
      findings.push({
        file: SPEC,
        path: `${ac.id}.source`,
        id: ac.id,
        line: ac.line,
        message: `${ac.id} cites ${source}, which is no source-ledger entry`,
      });
    }
  }
  return findings;
}

/** `owner: none` records that nobody stands behind the line: a divergence, not a requirement. */
export function checkOwnerNone(ctx: RuleContext): RuleFinding[] {
  const spec = valueOf(ctx.inputs.spec);
  return spec.acceptance
    .filter((ac) => ac.owner === OWNER_NONE)
    .map((ac) => ({
      file: SPEC,
      path: `${ac.id}.owner`,
      id: ac.id,
      line: ac.line,
      message: `${ac.id} has owner ${OWNER_NONE}: nobody stands behind the line, so it is a divergence and needs a question, not an AC`,
    }));
}

/**
 * At `proposed` nothing may be left open: no residual with status `open`
 * (a residual class is always one of `divergence`, `blind-spot` and
 * `untestable`), and no `blocking` `divergence` or `blind-spot` question
 * of questions.json without an answer.
 */
export function checkResidualOpen(ctx: RuleContext): RuleFinding[] {
  const spec = valueOf(ctx.inputs.spec);
  const findings: RuleFinding[] = spec.residuals
    .filter((rs) => rs.status === "open")
    .map((rs) => ({
      file: SPEC,
      path: rs.id,
      id: rs.id,
      line: rs.line,
      message: `${rs.id} is an open ${rs.class}: resolve it or record the decision before the spec is proposed`,
    }));
  const questions = used(ctx.inputs.questions);
  if (questions === undefined) return findings;
  const answered = new Set(questions.answers.map((a) => a.question));
  for (const question of questions.questions) {
    if (!question.blocking) continue;
    if (question.class !== "divergence" && question.class !== "blind-spot") {
      continue;
    }
    if (answered.has(question.id)) continue;
    findings.push({
      file: QUESTIONS,
      path: question.id,
      id: question.id,
      message: `${question.id} is a blocking ${question.class} question and has no answer`,
    });
  }
  return findings;
}

/** Every DC rests on a question of questions.json that has an answer. */
export function checkDcUnanswered(ctx: RuleContext): RuleFinding[] {
  const spec = valueOf(ctx.inputs.spec);
  const questions = valueOf(ctx.inputs.questions);
  const answered = new Set(questions.answers.map((a) => a.question));
  return spec.decisions
    .filter((dc) => !answered.has(dc.question))
    .map((dc) => ({
      file: SPEC,
      path: `${dc.id}.question`,
      id: dc.id,
      line: dc.line,
      message: `${dc.id} rests on ${dc.question}, which ${QUESTIONS} holds no answer to`,
    }));
}

/** A DC backed only by a self-reported answer has nothing checkable behind it. */
export function checkDcSelfReported(ctx: RuleContext): RuleFinding[] {
  const spec = valueOf(ctx.inputs.spec);
  const questions = valueOf(ctx.inputs.questions);
  const answers = new Map(questions.answers.map((a) => [a.question, a]));
  const findings: RuleFinding[] = [];
  for (const dc of spec.decisions) {
    const answer = answers.get(dc.question);
    if (answer === undefined || answer.comment_url !== undefined) continue;
    findings.push({
      file: SPEC,
      path: `${dc.id}.question`,
      id: dc.id,
      line: dc.line,
      message: `${dc.id} is answered through ${answer.channel} with no comment_url: nothing checkable backs the decision`,
    });
  }
  return findings;
}

/**
 * A retired ID may not be in use again. Spec IDs are already a `format`
 * error; here the live places are the test-plan row IDs and the question
 * IDs.
 */
export function checkRetiredIdLive(ctx: RuleContext): RuleFinding[] {
  const spec = valueOf(ctx.inputs.spec);
  const plan = used<TestPlan>(ctx.inputs.testplan);
  const questions = used<Questions>(ctx.inputs.questions);
  const findings: RuleFinding[] = [];
  for (const id of spec.frontmatter.retired_ids) {
    if (plan?.some((row) => row.id === id)) {
      findings.push({
        file: TESTPLAN,
        path: id,
        id,
        message: `${id} is listed in retired_ids and still a test-plan row`,
      });
    }
    if (questions?.questions.some((q) => q.id === id)) {
      findings.push({
        file: QUESTIONS,
        path: id,
        id,
        message: `${id} is listed in retired_ids and still a question`,
      });
    }
  }
  return findings;
}

const PROSE_NOTE =
  ": normative text states what is checked, not what would be nice to have";

/** A vague word of the fixed list in an AC text or a TP claim or expected. */
export function checkProse(ctx: RuleContext): RuleFinding[] {
  const spec = valueOf(ctx.inputs.spec);
  const plan = valueOf(ctx.inputs.testplan);
  const findings: RuleFinding[] = [];
  for (const ac of spec.acceptance) {
    for (const word of findProseWords(ac.text)) {
      findings.push({
        file: SPEC,
        path: `${ac.id}.text`,
        id: ac.id,
        line: ac.line,
        message: `${ac.id} uses the word "${word}"${PROSE_NOTE}`,
      });
    }
  }
  for (const row of plan) {
    for (const field of ["claim", "expected"] as const) {
      const text = row[field];
      if (text === undefined) continue;
      for (const word of findProseWords(text)) {
        findings.push({
          file: TESTPLAN,
          path: `${row.id}.${field}`,
          id: row.id,
          message: `${row.id}.${field} uses the word "${word}"${PROSE_NOTE}`,
        });
      }
    }
  }
  return findings;
}

/** The unanswered questions of questions.json stay at or below the budget. */
export function checkQuestionBudget(
  ctx: RuleContext,
  config?: SpecGateConfig,
): RuleFinding[] {
  const questions = valueOf(ctx.inputs.questions);
  const answered = new Set(questions.answers.map((a) => a.question));
  const unanswered = questions.questions.filter(
    (q) => !answered.has(q.id),
  ).length;
  const budget = config?.questions.warn_above ?? DEFAULT_QUESTIONS_WARN_ABOVE;
  if (unanswered <= budget) return [];
  return [
    {
      file: QUESTIONS,
      path: "questions",
      id: "questions",
      message: `${unanswered} questions are unanswered, above the budget of ${budget}; answer them or raise questions.warn_above`,
    },
  ];
}

/**
 * The stored `class` and `rule_version` of triage.json still match the
 * fields of the file: what the triage step wrote has not gone stale, and
 * nothing rewrote the class behind the derivation.
 */
export function checkTriageStale(ctx: RuleContext): RuleFinding[] {
  const triage = valueOf(ctx.inputs.triage);
  if (triage.class === undefined) return [];
  const findings: RuleFinding[] = [];
  const derived = deriveTriageClass(triage).class;
  if (triage.class !== derived) {
    findings.push({
      file: TRIAGE_FILE,
      path: "class",
      id: "triage",
      message: `triage.json stores class ${triage.class} while its fields derive ${derived}; run triage again`,
    });
  }
  if (triage.rule_version !== TRIAGE_RULE_VERSION) {
    findings.push({
      file: TRIAGE_FILE,
      path: "rule_version",
      id: "triage",
      message: `triage.json was written by rule version ${String(triage.rule_version)}; the current version is ${TRIAGE_RULE_VERSION}; run triage again`,
    });
  }
  return findings;
}

const FULL: RuleDef["profiles"] = ["full"];

/** The content rules: the full profile only, in the order of `docs/lint.md`. */
export const CONTENT_RULES: readonly RuleDef[] = [
  {
    id: "df-coverage",
    level: "error",
    profiles: FULL,
    gated: false,
    ackable: false,
    summary:
      "Every DF with affects_behavior true is covered by at least one test-plan row.",
    needs: ["spec", "testplan"],
    check: checkDfCoverage,
  },
  {
    id: "tp-covers-unknown",
    level: "error",
    profiles: FULL,
    gated: false,
    ackable: false,
    summary:
      "Every ID in a test-plan row's covers is an AC, DF or NG ID of spec.md.",
    needs: ["spec", "testplan"],
    check: checkTpCoversUnknown,
  },
  {
    id: "binding-unknown",
    level: "error",
    profiles: FULL,
    gated: false,
    ackable: false,
    summary:
      "Every key of bindings.yaml is a test-plan row ID; the file may be absent.",
    needs: ["testplan"],
    uses: ["bindings"],
    check: checkBindingUnknown,
  },
  {
    id: "binding-status",
    level: "error",
    profiles: FULL,
    gated: true,
    ackable: false,
    summary:
      "At proposed every binding has the status its row's kind requires, a kind needing one has one, and kind manual has none.",
    needs: ["testplan"],
    uses: ["bindings"],
    check: checkBindingStatus,
  },
  {
    id: "ledger-complete",
    level: "error",
    profiles: FULL,
    gated: false,
    ackable: false,
    summary:
      "The ledger's source line IDs are exactly the IDs in the lines of source/meta.json.",
    needs: ["spec", "meta"],
    check: checkLedgerComplete,
  },
  {
    id: "ledger-target-unknown",
    level: "error",
    profiles: FULL,
    gated: false,
    ackable: false,
    summary:
      "Every target ID of a source-ledger entry is a live ID of spec.md.",
    needs: ["spec"],
    check: checkLedgerTargetUnknown,
  },
  {
    id: "ac-source-unknown",
    level: "error",
    profiles: FULL,
    gated: false,
    ackable: false,
    summary:
      "Every SL ID in an AC's source is the ID of a source-ledger entry.",
    needs: ["spec"],
    check: checkAcSourceUnknown,
  },
  {
    id: "owner-none",
    level: "error",
    profiles: FULL,
    gated: false,
    ackable: false,
    summary:
      "No AC has owner none: such a line is a divergence, not a requirement.",
    needs: ["spec"],
    check: checkOwnerNone,
  },
  {
    id: "residual-open",
    level: "error",
    profiles: FULL,
    gated: true,
    ackable: false,
    summary:
      "At proposed no residual has status open and no blocking divergence or blind-spot question of questions.json is without an answer.",
    needs: ["spec"],
    uses: ["questions"],
    check: checkResidualOpen,
  },
  {
    id: "dc-unanswered",
    level: "error",
    profiles: FULL,
    gated: false,
    ackable: false,
    summary:
      "Every DC's question has an answer in questions.json; an unknown question ID is the same error.",
    needs: ["spec", "questions"],
    check: checkDcUnanswered,
  },
  {
    id: "dc-self-reported",
    level: "warning",
    profiles: FULL,
    gated: false,
    ackable: true,
    summary:
      "A DC whose answer has no comment_url has no checkable source. Acknowledge with the DC ID.",
    needs: ["spec", "questions"],
    check: checkDcSelfReported,
  },
  {
    id: "retired-id-live",
    level: "error",
    profiles: FULL,
    gated: false,
    ackable: false,
    summary:
      "No ID of retired_ids is a live test-plan row ID or question ID; live spec IDs are already a format error.",
    needs: ["spec"],
    uses: ["testplan", "questions"],
    check: checkRetiredIdLive,
  },
  {
    id: "prose",
    level: "warning",
    profiles: FULL,
    gated: false,
    ackable: true,
    summary:
      "No AC text, test-plan claim or expected contains a whole word of the fixed vague-word list in src/lint/prose.ts. Acknowledge with the AC or row ID.",
    needs: ["spec", "testplan"],
    check: checkProse,
  },
  {
    id: "question-budget",
    level: "warning",
    profiles: FULL,
    gated: false,
    ackable: true,
    summary:
      "The number of unanswered questions is at most questions.warn_above (default 7, set with --config). Acknowledge with id questions.",
    needs: ["questions"],
    check: (ctx) => checkQuestionBudget(ctx, ctx.config),
  },
  {
    id: "triage-stale",
    level: "error",
    profiles: FULL,
    gated: false,
    ackable: false,
    summary:
      "triage.json stores the class its own fields derive and the current rule version.",
    needs: ["triage"],
    check: checkTriageStale,
  },
];
