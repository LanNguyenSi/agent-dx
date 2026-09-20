import { createHash } from "node:crypto";
import YAML from "yaml";
import type {
  FileTarget,
  PackDefinition,
  ResolvedConfig,
  Rule,
  RuleContext,
  Violation,
} from "../types.js";
import { findAllRegex, offsetToLineCol } from "../util/text.js";
import { DEFAULT_NODE20_ACTIONS } from "../data/node20-actions.js";
import {
  DEFAULT_EXECUTED_ACTION_INPUTS,
  type ExecutedActionInputEntry,
} from "../data/executed-action-inputs.js";

// ─────────────────────────── file targeting ───────────────────────────

// GitHub Actions only ever reads workflow files directly under
// `.github/workflows/` (no further nesting) with a `.yml`/`.yaml`
// extension. Matched on the raw `file.path` (not scan-root-relativized:
// unlike `placement-slop`'s instruction globs, this rule needs no
// `RuleContext.scanRoot`, so `appliesTo` can decide with only the
// `FileTarget` it is given), forward-slash normalized so it also matches
// a path built with `path.join` on Windows.
const WORKFLOW_FILE_RE = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;

// Exported (not just used internally) so `engine.ts` can filter the file
// list down to workflow files before handing them to
// `findUnmatchedAllowExpressions`, without re-deriving this pattern
// there. Takes only `{ path }` (a subset of `FileTarget`) so a caller that
// has not built a full `FileTarget` (no `.text`/`.kind` yet) can still use
// it.
export function isWorkflowFile(file: { path: string }): boolean {
  const normalized = file.path.split("\\").join("/");
  return WORKFLOW_FILE_RE.test(normalized);
}

// ─────────────────────────── expression allowlist ───────────────────────────

// Every entry here is a bare `github.*`/`runner.*` context reference this
// pack treats as NOT attacker-controllable, verified against GitHub's own
// docs (see packages/slop-detector/README.md "workflow-slop by example"
// for the exact quotes and the two source URLs). Deliberately exact,
// whole-expression matches only (see `isAllowedExpression` below): this
// rule does not attempt to parse the GitHub Actions expression grammar
// (functions, comparisons, string concatenation, ternaries), so a
// compound expression built out of only-safe pieces is still flagged
// rather than risk misjudging a mixed expression as safe.
const DEFAULT_ALLOWED_EXPRESSIONS = new Set([
  "github.workspace",
  "runner.temp",
  "runner.os",
  "runner.arch",
  "runner.tool_cache",
  "github.action_path",
  "github.run_id",
  "github.run_number",
  "github.run_attempt",
  "github.sha",
  "github.job",
  "github.repository",
  "github.repository_owner",
  "github.actor",
  "github.event_name",
  "github.workflow",
  "github.server_url",
  "github.api_url",
  "github.token",
]);

// `secrets.<NAME>` is data (the secret's stored value is not attacker-
// supplied; the *name* is fixed by the workflow author), so any secret
// name is allowed, matched structurally rather than enumerated.
const SECRET_REF_RE = /^secrets\.[A-Za-z_][A-Za-z0-9_]*$/;

// `steps.<id>.outcome` and `steps.<id>.conclusion` are NOT step outputs
// (the `steps.*.outputs.*` shape the task brief calls out as unsafe):
// GitHub's own contexts reference documents both as one of exactly four
// runtime-assigned enum values (`success`, `failure`, `cancelled`,
// `skipped`), never attacker-supplied text, so any step id is safe here.
// Everything else under `steps.<id>.*` (in particular `.outputs.*`)
// stays unmatched by this and therefore still flagged.
const STEP_OUTCOME_RE =
  /^steps\.[A-Za-z_][A-Za-z0-9_-]*\.(outcome|conclusion)$/;

// `matrix.*` is deliberately NOT in the default allowlist: it is only
// safe when every value the matrix can take is a literal written in the
// workflow itself (never sourced from `steps.*.outputs`, `needs.*`, or an
// `include`/`exclude` built from untrusted input), and this rule has no
// way to check that from a single scalar's text. Per the task brief:
// "if you cannot check that, keep matrix out and say so." A repo that has
// verified its own matrix is literal-only can add `matrix.<field>`
// entries to `workflow.allowExpressions` explicitly.
function isAllowedExpression(expr: string, config: ResolvedConfig): boolean {
  const trimmed = expr.trim();
  if (DEFAULT_ALLOWED_EXPRESSIONS.has(trimmed)) return true;
  if (SECRET_REF_RE.test(trimmed)) return true;
  if (STEP_OUTCOME_RE.test(trimmed)) return true;
  const extra = config.workflow?.allowExpressions ?? [];
  return extra.some((e) => e.trim() === trimmed);
}

// ─────────────────────────── run-scalar scan ───────────────────────────

// Matches a `${{ ... }}` expression, non-greedy so two expressions on the
// same line are found as two matches rather than one match spanning both,
// and `[\s\S]` (not `.`) so a rare expression wrapped across a line break
// inside a block-scalar `run:` body is still matched as one expression.
const EXPRESSION_RE = /\$\{\{([\s\S]*?)\}\}/g;

/**
 * True when `node` is a mapping-like value with a `.items` array of
 * key/value pairs (`yaml`'s `YAMLMap`) — the only node kind that can
 * contain a `run:` key. `yaml`'s `isMap`/`isSeq` are avoided here in
 * favor of a duck-typed check so this walk keeps working across a
 * `yaml` major bump that renames or restructures those helpers, since
 * the only shape this walk actually depends on is "has `.items`".
 */
function hasItems(node: unknown): node is { items: unknown[] } {
  return (
    typeof node === "object" &&
    node !== null &&
    Array.isArray((node as { items?: unknown }).items)
  );
}

function isPairNode(node: unknown): node is { key: unknown; value: unknown } {
  return typeof node === "object" && node !== null && "key" in (node as object);
}

function isScalarWithRange(
  node: unknown,
): node is { value: string; range: [number, number, number] } {
  if (typeof node !== "object" || node === null) return false;
  const candidate = node as { value?: unknown; range?: unknown };
  return (
    typeof candidate.value === "string" &&
    Array.isArray(candidate.range) &&
    candidate.range.length >= 2
  );
}

function scalarKeyName(key: unknown): string | undefined {
  if (typeof key === "object" && key !== null && "value" in (key as object)) {
    const v = (key as { value?: unknown }).value;
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

/**
 * The non-null, non-empty `uses:` scalar value of `node`'s own mapping, or
 * `undefined` when `node` carries no `uses:` key, or that key's value is
 * null (`uses:` with nothing after it) or an empty string (`uses: ""`).
 *
 * Fail-closed helper for `collectRunScalars`' and
 * `collectExecutedInputScalars`' `with:` exemption: a step whose `uses:`
 * is null or empty is not a step that actually names an action to run, so
 * it no longer counts as a `uses:` step for that exemption either. Its
 * `with:` block, if it has one, is then walked like an ordinary mapping
 * instead of being treated as an action's input block -- a `run:` or an
 * executed-input match found there is reported like any other, rather
 * than silently exempted because a malformed `uses:` happened to be
 * present. A step whose `uses:` is a real, non-empty value (including a
 * `./local` path or a `docker://` reference this pack cannot resolve to
 * an `owner/repo`) keeps the ordinary exemption; only the null/empty case
 * changes behaviour.
 */
function usesStepValue(node: { items: unknown[] }): string | undefined {
  const usesPair = node.items.find(
    (item) => isPairNode(item) && scalarKeyName(item.key) === "uses",
  );
  if (!usesPair || !isPairNode(usesPair)) return undefined;
  const value = (usesPair as { value: unknown }).value;
  if (!isScalarWithRange(value)) return undefined;
  return value.value.trim().length > 0 ? value.value : undefined;
}

/**
 * Collect every `run:` scalar node in the parsed document, walking every
 * mapping/sequence regardless of nesting depth (a step's `run:`, a
 * composite action's `runs.steps[].run:`, etc.), this rule cares about
 * "is this text a `run:` value", not which exact GitHub Actions schema
 * position it sits in.
 *
 * `insideWith` is set once the walk descends into a step's `with:` block
 * and stays set for everything under it: `with:` holds an action's own
 * input parameters, arbitrary key/value pairs an action author names
 * however it likes (a custom action can have an input literally called
 * `run`), never a shell script GitHub itself executes. Without this gate,
 * a `with: { run: "..." }` input (or a `${{ ... }}` inside one) is walked
 * and reported exactly like a real `run:` step, which is not the shell
 * injection surface this rule exists to catch.
 *
 * The gate is keyed on *schema position*, not on a mapping key literally
 * spelled `with` at any depth: a `with:` pair only starts an input block
 * when its own containing mapping also carries a real (non-null,
 * non-empty) `uses:` key, the shape GitHub Actions requires for a step
 * that names an action to run (`isUsesStep` below, computed once per
 * mapping from that mapping's own `items` via `usesStepValue`, before the
 * loop that walks them). A job, a step, or any other mapping key can be
 * *named* `with` without being a `uses:` step's input block; gating on
 * the name alone let such a mapping (e.g. a job literally called `with`)
 * silence every `run:` in its entire subtree. A `uses:` key present but
 * null or empty is fail-closed the same way: see `usesStepValue`.
 */
function collectRunScalars(
  node: unknown,
  out: Array<{ value: string; range: [number, number, number] }>,
  insideWith = false,
): void {
  if (!hasItems(node)) return;
  const isUsesStep = usesStepValue(node) !== undefined;
  for (const item of node.items) {
    if (isPairNode(item)) {
      const keyName = scalarKeyName(item.key);
      if (keyName === "run" && !insideWith && isScalarWithRange(item.value)) {
        out.push({ value: item.value.value, range: item.value.range });
      } else {
        collectRunScalars(
          item.value,
          out,
          insideWith || (isUsesStep && keyName === "with"),
        );
      }
    } else {
      collectRunScalars(item, out, insideWith);
    }
  }
}

/**
 * Fold an executed-action-input name the way the Actions runner and
 * `@actions/core` fold it before an action ever sees a name comparison:
 * the runner exports a step's `with:` values as `INPUT_<NAME>` using
 * `Replace(' ', '_').ToUpperInvariant()`, and `core.getInput(name)` reads
 * that variable via `INPUT_${name.replace(/ /g, "_").toUpperCase()}` --
 * so `script`, `Script`, `SCRIPT`, and (were the input named with a
 * space) `my input`/`my_input` are all the same input from the runner's
 * own point of view. Applied to every name this rule compares -- a
 * built-in `DEFAULT_EXECUTED_ACTION_INPUTS` entry's `input`, a
 * `workflow.executedActionInputs`-parsed entry's `input`, and a workflow
 * step's own `with:` key.
 *
 * The body is the expression `@actions/core` itself applies, and it folds
 * UP on purpose. Unicode case folding is not symmetric: a dotless i or a
 * long s upper-cases to the ASCII letters of `SCRIPT` but lower-cases to
 * itself, so a lower-case fold would let `with: scr\u0131pt:` reach
 * `INPUT_SCRIPT` on the runner while scanning clean here. JavaScript's
 * `toUpperCase` applies the full case mappings, a superset of the simple
 * mappings an invariant-culture upper-case applies, so where the two
 * differ this rule matches more, never less.
 */
function normalizeExecutedInputName(name: string): string {
  return name.replace(/ /g, "_").toUpperCase();
}

/**
 * Every `${{ ... }}` expression location inside a `with:` input this
 * pack's executed-input list names as code an action executes at runtime
 * (see `data/executed-action-inputs.ts` and
 * `workflow.executedActionInputs`) -- for example `actions/github-script`'s
 * `script` input, which that action runs as a Node.js script body, never
 * data the action merely reads or forwards.
 *
 * Consulted BEFORE `run-expression`'s ordinary `with:` exemption: a
 * `with:` input on this list is scanned for `${{ ... }}` expressions the
 * same way a `run:` scalar is (same allowlist via `isAllowedExpression`),
 * while every OTHER input of the same step, and this same input name on
 * an action not on the list, stay exempt exactly as before.
 *
 * Matching is `owner/repo` only, case-insensitive (`normalizeMajorKey`),
 * independent of the step's ref (tag, sha, branch): `actions/github-script
 * @v7`, a sha-pinned ref, and `Actions/Github-Script@main` all resolve to
 * the same entry. A `docker://` or local `./`/`../` reference, or a
 * reusable-workflow call, never resolves to an `owner/repo`
 * (`parseUsesValue` returns `undefined` for all three) and so can never
 * match, the same scope the default list's own entries are limited to.
 * The input-name half is matched the same way, case- and
 * space/underscore-insensitively (`normalizeExecutedInputName`), because
 * that is how the Actions runner itself folds a `with:` input name before
 * an action's own code ever reads it: `with: Script:` and `with: SCRIPT:`
 * on `actions/github-script` are the same input as `with: script:`.
 *
 * Gated by the same fail-closed `usesStepValue` `collectRunScalars` uses:
 * a step whose `uses:` is null or empty is not a real `uses:` step, so
 * its `with:` block (if present) is not treated as an input block here
 * either -- nothing under it can match an executed-input entry.
 */
function collectExecutedInputScalars(
  node: unknown,
  entries: ExecutedActionInputEntry[],
  out: Array<{
    value: string;
    range: [number, number, number];
    entry: ExecutedActionInputEntry;
  }>,
): void {
  if (!hasItems(node)) return;
  const usesValue = usesStepValue(node);
  const parsedUses =
    usesValue !== undefined ? parseUsesValue(usesValue) : undefined;
  for (const item of node.items) {
    if (!isPairNode(item)) {
      collectExecutedInputScalars(item, entries, out);
      continue;
    }
    const keyName = scalarKeyName(item.key);
    if (keyName === "with" && parsedUses && hasItems(item.value)) {
      for (const withItem of item.value.items) {
        if (!isPairNode(withItem)) continue;
        const inputName = scalarKeyName(withItem.key);
        if (inputName === undefined || !isScalarWithRange(withItem.value)) {
          continue;
        }
        const match = entries.find(
          (entry) =>
            normalizeMajorKey(entry.uses) ===
              normalizeMajorKey(parsedUses.ownerRepo) &&
            normalizeExecutedInputName(entry.input) ===
              normalizeExecutedInputName(inputName),
        );
        if (match) {
          out.push({
            value: withItem.value.value,
            range: withItem.value.range,
            entry: match,
          });
        }
      }
      // `with:` input blocks hold scalar inputs only (see the module-level
      // gating discussion above): nothing further to walk inside one.
      continue;
    }
    collectExecutedInputScalars(item.value, entries, out);
  }
}

function makeViolation(
  rule: Rule,
  file: FileTarget,
  index: number,
  matched: string,
  expr: string,
): Violation {
  const start = offsetToLineCol(file.text, index);
  const end = offsetToLineCol(file.text, index + matched.length);
  return {
    ruleId: rule.id,
    pack: rule.pack,
    severity: rule.defaultSeverity,
    path: file.path,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
    message: `\`\${{ ${expr.trim()} }}\` is interpolated directly into a \`run:\` shell script. Route it through \`env:\` and reference it as \`$NAME\` instead, unless it is one of the documented non-attacker-controllable contexts (see workflow-slop README).`,
    rationale: rule.rationale,
    matched,
  };
}

/**
 * The executed-input-specific twin of `makeViolation`: same shape and
 * same allowlist (`isAllowedExpression`), but the message names the
 * `uses:`/input pair the expression is executed by instead of `run:`, per
 * the acceptance requirement that the finding say the input is executed
 * as code.
 */
function makeExecutedInputViolation(
  rule: Rule,
  file: FileTarget,
  index: number,
  matched: string,
  expr: string,
  entry: ExecutedActionInputEntry,
): Violation {
  const start = offsetToLineCol(file.text, index);
  const end = offsetToLineCol(file.text, index + matched.length);
  return {
    ruleId: rule.id,
    pack: rule.pack,
    severity: rule.defaultSeverity,
    path: file.path,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
    message: `\`\${{ ${expr.trim()} }}\` is passed to \`${entry.uses}\`'s \`${entry.input}\` input, which that action executes as code, not data. Route it through \`env:\` (or the action's own env-reading convention) instead, unless it is one of the documented non-attacker-controllable contexts (see workflow-slop README).`,
    rationale: rule.rationale,
    matched,
  };
}

// ─────────────────────────── unparseable-workflow ───────────────────────────

// `YAML.parseDocument` does not throw on most YAML syntax errors: it
// records them on `doc.errors` and still returns whatever partial tree it
// managed to build. `run-expression` walks that partial tree without
// knowing it is incomplete, so a workflow file broken partway through (an
// unterminated quoted scalar, an unbalanced flow collection) can silently
// drop everything after the break, including a `${{ ... }}` expression
// this pack exists to catch. This rule closes that gap: any parse error
// on a workflow file is itself a `workflow-slop` finding, so a broken file
// is never reported clean.
function firstParseErrorSummary(
  errors: readonly { message: string }[],
): string {
  const first = errors[0];
  // yaml's error message embeds "at line N, column M" followed by a
  // multi-line source excerpt with a "^" pointer; keep only the first
  // line so the violation message stays one line.
  const firstLine = first.message.split("\n")[0]?.trim();
  return firstLine && firstLine.length > 0 ? firstLine : first.message;
}

const unparseableWorkflow: Rule = {
  id: "workflow-slop/unparseable-workflow",
  pack: "workflow-slop",
  defaultSeverity: "block",
  enabledByDefault: true,
  rationale:
    "yaml's parseDocument does not throw on most YAML syntax errors: it records them on `doc.errors` and still returns whatever partial tree it managed to build, which `run-expression` then walks without knowing it is incomplete. A workflow file broken partway through can drop everything after the break from that partial tree, so an unsafe `${{ ... }}` expression sitting after the break is never seen, in a way indistinguishable from a genuinely clean file. Reporting the parse error itself closes that gap: a broken workflow file always produces at least one workflow-slop finding, instead of a false-clean result.",
  appliesTo: isWorkflowFile,
  check(ctx: RuleContext): Violation[] {
    const { file } = ctx;
    let parsed: ReturnType<typeof YAML.parseDocument>;
    try {
      parsed = YAML.parseDocument(file.text, {});
    } catch {
      // A hard throw (not the usual doc.errors-recording path): nothing
      // this rule can inspect either way.
      return [];
    }
    if (parsed.errors.length === 0) return [];
    const summary = firstParseErrorSummary(parsed.errors);
    const pos = parsed.errors[0]?.linePos?.[0];
    return [
      {
        ruleId: unparseableWorkflow.id,
        pack: unparseableWorkflow.pack,
        severity: unparseableWorkflow.defaultSeverity,
        path: file.path,
        line: pos?.line ?? 1,
        column: pos?.col ?? 1,
        message: `This workflow file did not parse as valid YAML (${summary}). \`workflow-slop/run-expression\` can only scan the part of the file that parsed, so a result for this file cannot be trusted clean until the YAML syntax error is fixed.`,
        rationale: unparseableWorkflow.rationale,
        matched: summary,
      },
    ];
  },
};

// ─────────────────────────── allowExpressions usage ───────────────────────────

/**
 * The effective executed-input match list for this scan: the package's
 * built-in default list plus `config.workflow.executedActionInputs`
 * (`owner/repo:input` strings, parsed into the same entry shape). Unlike
 * `resolveNode20Majors`, there is no ignore/subtractive list: an
 * executed-input entry is either matched by `owner/repo` (ref-independent)
 * or it is not, and this pack ships only one built-in entry to remove.
 */
function resolveExecutedActionInputs(
  config: ResolvedConfig,
): ExecutedActionInputEntry[] {
  const extra = (config.workflow?.executedActionInputs ?? []).map(
    (raw): ExecutedActionInputEntry => {
      const colonIndex = raw.indexOf(":");
      return {
        uses: raw.slice(0, colonIndex),
        input: raw.slice(colonIndex + 1),
        source: "configured via workflow.executedActionInputs",
      };
    },
  );
  return [...DEFAULT_EXECUTED_ACTION_INPUTS, ...extra];
}

/**
 * Every distinct expression body (trimmed, as written between `${{` and
 * `}}`) found inside a `run:` scalar, or inside a `with:` input this
 * pack's executed-input list treats as executed code, in `file`,
 * regardless of whether this pack's allowlist treats it as safe. Used
 * only by `findUnmatchedAllowExpressions` below, kept separate from
 * `runExpression.check` because it needs the full set of expression texts
 * (allowed and flagged alike), not just the ones that end up as
 * violations.
 */
function collectExpressionTexts(
  file: { path: string; text: string },
  config: ResolvedConfig,
): Set<string> {
  const result = new Set<string>();
  if (!isWorkflowFile(file)) return result;
  let doc: unknown;
  try {
    doc = YAML.parseDocument(file.text, {}).contents;
  } catch {
    return result;
  }
  const runScalars: Array<{ value: string; range: [number, number, number] }> =
    [];
  collectRunScalars(doc, runScalars);
  const executedInputScalars: Array<{
    value: string;
    range: [number, number, number];
    entry: ExecutedActionInputEntry;
  }> = [];
  collectExecutedInputScalars(
    doc,
    resolveExecutedActionInputs(config),
    executedInputScalars,
  );
  for (const scalar of [...runScalars, ...executedInputScalars]) {
    const [start, end] = scalar.range;
    const raw = file.text.slice(start, end);
    for (const m of findAllRegex(raw, EXPRESSION_RE)) {
      const expr = (m.groups[1] ?? "").trim();
      if (expr) result.add(expr);
    }
  }
  return result;
}

/**
 * `config.workflow.allowExpressions` entries that never matched any
 * `${{ ... }}` expression body across the given files: a typo'd or
 * stale entry otherwise sits there silently doing nothing, the same
 * failure mode `placement.instructionGlobs`'s zero-match warning exists
 * to catch (see `checkFiles` in engine.ts, which turns this into a
 * `CheckSummary.warnings` entry). `files` need not be pre-filtered to
 * workflow files; non-workflow files are skipped internally.
 */
export function findUnmatchedAllowExpressions(
  files: Array<{ path: string; text: string }>,
  config: ResolvedConfig,
): string[] {
  const extra = (config.workflow?.allowExpressions ?? []).map((e) => e.trim());
  if (extra.length === 0) return [];
  const seen = new Set<string>();
  for (const file of files) {
    for (const expr of collectExpressionTexts(file, config)) seen.add(expr);
  }
  return extra.filter((e) => !seen.has(e));
}

const runExpression: Rule = {
  id: "workflow-slop/run-expression",
  pack: "workflow-slop",
  defaultSeverity: "block",
  enabledByDefault: true,
  rationale:
    "GitHub substitutes `${{ ... }}` expressions into the `run:` text before the shell ever parses it. When the expression's value is attacker-influenced (a PR title, a branch/tag name, a step output derived from either), a crafted value breaks out of its intended argument position and the job — often holding write or publish permissions — executes it. The fix is the same every time: assign the value to an `env:` variable and reference it as `$NAME` in the script, where the shell treats it as inert data instead of program text. The same substitution happens just as literally inside a `with:` input an action's own runtime then executes as code (`actions/github-script`'s `script` input, at minimum) -- a `with:` input is normally this pack's exemption from `run:` scanning exactly because most inputs are inert data, but a listed input is code, so it is scanned before that exemption applies, not after.",
  appliesTo: isWorkflowFile,
  check(ctx: RuleContext): Violation[] {
    const { file, config } = ctx;
    let doc: unknown;
    try {
      doc = YAML.parseDocument(file.text, {}).contents;
    } catch {
      // Not valid YAML (or YAML.parseDocument threw for some other
      // reason): nothing this rule can safely inspect. Not this rule's
      // job to report a YAML-syntax error.
      return [];
    }
    const runScalars: Array<{
      value: string;
      range: [number, number, number];
    }> = [];
    collectRunScalars(doc, runScalars);
    const executedInputScalars: Array<{
      value: string;
      range: [number, number, number];
      entry: ExecutedActionInputEntry;
    }> = [];
    collectExecutedInputScalars(
      doc,
      resolveExecutedActionInputs(config),
      executedInputScalars,
    );

    const violations: Violation[] = [];
    for (const scalar of runScalars) {
      const [start, end] = scalar.range;
      const raw = file.text.slice(start, end);
      for (const m of findAllRegex(raw, EXPRESSION_RE)) {
        const expr = m.groups[1] ?? "";
        if (isAllowedExpression(expr, config)) continue;
        violations.push(
          makeViolation(runExpression, file, start + m.index, m.match, expr),
        );
      }
    }
    for (const scalar of executedInputScalars) {
      const [start, end] = scalar.range;
      const raw = file.text.slice(start, end);
      for (const m of findAllRegex(raw, EXPRESSION_RE)) {
        const expr = m.groups[1] ?? "";
        if (isAllowedExpression(expr, config)) continue;
        violations.push(
          makeExecutedInputViolation(
            runExpression,
            file,
            start + m.index,
            m.match,
            expr,
            scalar.entry,
          ),
        );
      }
    }
    return violations;
  },
};

// ─────────────────────────── node20-action-major ───────────────────────────

// A generic scalar-node guard (unlike `isScalarWithRange`, which also
// requires `.value` to be a `string`): `continue-on-error: true` parses as
// a YAML *boolean* scalar, whose `.value` is `true`/`false`, not a string.
function isScalarNode(
  node: unknown,
): node is { value: unknown; range: [number, number, number] } {
  if (typeof node !== "object" || node === null) return false;
  const candidate = node as { value?: unknown; range?: unknown };
  return (
    "value" in candidate &&
    Array.isArray(candidate.range) &&
    candidate.range.length >= 2
  );
}

/**
 * Every `uses:` scalar in the parsed document, at any nesting depth (a
 * job-level `uses:` calling a reusable workflow, a step-level `uses:`
 * naming an action). Gated on schema position the same way
 * `collectRunScalars` gates `run:`: a `uses:` key found while walking
 * inside a step's own `with:` input block is not a real `uses:` step (a
 * custom action can name an input literally `uses`, the same way one can
 * name an input `run`), so `insideWith` is threaded down and a `with:`
 * pair only starts an input block when its containing mapping also
 * carries the step's real `uses:` key (`isUsesStep`, computed once per
 * mapping before the loop, same as `collectRunScalars`).
 */
function collectUsesRefs(
  node: unknown,
  out: Array<{ value: string; range: [number, number, number] }>,
  insideWith = false,
): void {
  if (!hasItems(node)) return;
  const isUsesStep = node.items.some(
    (item) => isPairNode(item) && scalarKeyName(item.key) === "uses",
  );
  for (const item of node.items) {
    if (isPairNode(item)) {
      const keyName = scalarKeyName(item.key);
      if (keyName === "uses" && !insideWith && isScalarWithRange(item.value)) {
        out.push({ value: item.value.value, range: item.value.range });
      }
      collectUsesRefs(
        item.value,
        out,
        insideWith || (isUsesStep && keyName === "with"),
      );
    } else {
      collectUsesRefs(item, out, insideWith);
    }
  }
}

// A version-ish ref: "v4", "V4", "v4.1.2", or a bare "4" (some workflows
// pin a bare major without the "v"). Only the leading major number is used
// for matching: a fixed point release like "v4.1.2" still runs whatever
// Node runtime its v4 line shipped, so it matches the same "v4" list entry
// a moving-major "v4" ref would. Case-insensitive ("V4" resolves the same
// as "v4"): GitHub Actions itself treats a ref name case-sensitively at
// the git level, but nothing stops an author from writing an uppercase
// "V" by hand, and this rule's job is catching the major, not validating
// the tag's exact casing. A trailing prerelease-ish suffix
// (`-beta`, `-rc.1`) is tolerated and ignored for major resolution
// ("v4-beta" still resolves to major "v4"): documented in the README as a
// deliberate simplification, not an attempt to parse full semver
// prerelease/build-metadata grammar.
const VERSION_REF_RE = /^v?(\d+)(?:\.\d+){0,2}(?:-[0-9A-Za-z.]+)?$/i;
// A commit sha (7-40 hex chars): never a version by itself. Distinguished
// from a version ref by content (hex-only), not length, since a short sha
// can coincide with a version-looking string only if it also matches
// VERSION_REF_RE first, which is checked first below.
const SHA_REF_RE = /^[0-9a-f]{7,40}$/i;

interface ParsedUses {
  ownerRepo: string;
  major?: string;
  shaRef?: boolean;
}

/**
 * Parses a `uses:` value into `owner/repo` plus (when determinable) its
 * major version. Returns `undefined` for anything this rule cannot or
 * should not evaluate: a local `./path` or `../path` action, a
 * `docker://image` reference, or a reusable-workflow call (`uses:` whose
 * pre-`@` part names a `.yml`/`.yaml` file rather than an action): none of
 * those name a published action with a `vN` major the way the default list
 * is keyed.
 */
function parseUsesValue(raw: string): ParsedUses | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) return undefined;
  if (trimmed.startsWith("docker://")) return undefined;
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex === -1) return undefined;
  const before = trimmed.slice(0, atIndex);
  const ref = trimmed.slice(atIndex + 1);
  if (/\.ya?ml$/i.test(before)) return undefined; // reusable workflow call
  const segments = before.split("/").filter(Boolean);
  if (segments.length < 2) return undefined;
  const ownerRepo = `${segments[0]}/${segments[1]}`;
  const versionMatch = ref.match(VERSION_REF_RE);
  if (versionMatch) return { ownerRepo, major: `v${versionMatch[1]}` };
  if (SHA_REF_RE.test(ref)) return { ownerRepo, shaRef: true };
  return { ownerRepo };
}

/**
 * The major version named in a trailing `# vN` comment on the same
 * physical line as a sha-pinned `uses:` value (e.g.
 * `uses: actions/checkout@8f4b7f8 # v4`). `afterOffset` is the end offset
 * of the `uses:` scalar; only text between there and the next newline (or
 * end of file) is inspected, so a comment on an unrelated later line can
 * never match. Returns `undefined` (not a violation) when no such
 * comment is present: a bare sha pin with no version annotation is the
 * documented limitation of this rule (see README), not a finding.
 */
function trailingCommentMajor(
  text: string,
  afterOffset: number,
): string | undefined {
  const newlineIndex = text.indexOf("\n", afterOffset);
  const restOfLine = text.slice(
    afterOffset,
    newlineIndex === -1 ? text.length : newlineIndex,
  );
  const match = restOfLine.match(/#.*?\bv(\d+)\b/i);
  return match ? `v${match[1]}` : undefined;
}

// Case-folds an `owner/repo@vN` match key (or half of one) for comparison:
// `Actions/Checkout@v4` and `actions/checkout@V4` resolve to the same
// entry as `actions/checkout@v4`. Applied to the default list, to
// `workflow.node20Majors`/`node20MajorsIgnore` config entries, and to the
// candidate built from a scanned `uses:` value, so all three sides of the
// comparison are folded consistently.
function normalizeMajorKey(key: string): string {
  return key.trim().toLowerCase();
}

/**
 * The effective Node-20-major match set for this scan: the package's
 * built-in default list, plus `config.workflow.node20Majors`, minus
 * `config.workflow.node20MajorsIgnore` (applied last, so it can also drop
 * a config-added entry). All three are `owner/repo@vN` strings, compared
 * case-insensitively via `normalizeMajorKey`.
 */
function resolveNode20Majors(config: ResolvedConfig): Set<string> {
  const majors = new Set(
    DEFAULT_NODE20_ACTIONS.map((entry) => normalizeMajorKey(entry.uses)),
  );
  for (const extra of config.workflow?.node20Majors ?? [])
    majors.add(normalizeMajorKey(extra));
  for (const ignored of config.workflow?.node20MajorsIgnore ?? [])
    majors.delete(normalizeMajorKey(ignored));
  return majors;
}

function makeNode20Violation(
  rule: Rule,
  file: FileTarget,
  ref: { range: [number, number, number] },
  candidate: string,
  matchedText: string,
): Violation {
  const start = offsetToLineCol(file.text, ref.range[0]);
  const end = offsetToLineCol(file.text, ref.range[0] + matchedText.length);
  return {
    ruleId: rule.id,
    pack: rule.pack,
    severity: rule.defaultSeverity,
    path: file.path,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
    message: `\`uses: ${matchedText}\` resolves to \`${candidate}\`, a GitHub Actions major on the Node-20 runtime list (the pack's built-in default, or \`workflow.node20Majors\`). Bump to a newer major, or drop this entry via \`workflow.node20MajorsIgnore\` once it has moved off Node 20.`,
    rationale: rule.rationale,
    matched: matchedText,
  };
}

const node20ActionMajor: Rule = {
  id: "workflow-slop/node20-action-major",
  pack: "workflow-slop",
  defaultSeverity: "block",
  enabledByDefault: true,
  rationale:
    "A fleet-wide sweep moved every workflow off the actions/runtimes still pinned to the deprecated Node-20 actions major, but nothing stopped a later workflow edit from reintroducing one (copy-pasting a step from an old gist, an unreviewed dependency bump). This rule flags a `uses:` value whose `owner/repo@major` is on the Node-20 list, so the regression is caught at review time instead of silently landing again. The list is data (`workflow.node20Majors`/`workflow.node20MajorsIgnore` in slop.config.yml, on top of the package's built-in default), not hardcoded logic, so a newly discovered or newly fixed major does not need a package release. A docker-container action (`runs.using: docker`) or a composite action is never Node-20 by itself and is intentionally never on the default list, even when it commonly sits next to Node-20 actions in the same job.",
  appliesTo: isWorkflowFile,
  check(ctx: RuleContext): Violation[] {
    const { file, config } = ctx;
    let doc: unknown;
    try {
      doc = YAML.parseDocument(file.text, {}).contents;
    } catch {
      return [];
    }
    const usesRefs: Array<{ value: string; range: [number, number, number] }> =
      [];
    collectUsesRefs(doc, usesRefs);
    const activeMajors = resolveNode20Majors(config);

    const violations: Violation[] = [];
    for (const ref of usesRefs) {
      const parsed = parseUsesValue(ref.value);
      if (!parsed) continue;
      if (parsed.major) {
        const candidate = `${parsed.ownerRepo}@${parsed.major}`;
        if (activeMajors.has(normalizeMajorKey(candidate))) {
          violations.push(
            makeNode20Violation(
              node20ActionMajor,
              file,
              ref,
              candidate,
              ref.value,
            ),
          );
        }
        continue;
      }
      if (parsed.shaRef) {
        const commentMajor = trailingCommentMajor(file.text, ref.range[1]);
        if (!commentMajor) continue; // documented sha-pin limitation, not a finding
        const candidate = `${parsed.ownerRepo}@${commentMajor}`;
        if (activeMajors.has(normalizeMajorKey(candidate))) {
          violations.push(
            makeNode20Violation(
              node20ActionMajor,
              file,
              ref,
              candidate,
              ref.value,
            ),
          );
        }
      }
    }
    return violations;
  },
};

// ───────────────── audit-gate-missing / audit-gate-shape ─────────────────
//
// Two rules over `.github/workflows/audit.yml`, both `block`:
//
//   - `audit-gate-missing` answers "is there a gate at all": does any
//     step's normalised run block invoke `npm audit --audit-level=...`
//     in a statement the shell would actually execute.
//   - `audit-gate-shape` answers "is the gate one we recognise": the
//     gate step's normalised statement list must match one of the
//     shapes below (`R-bare`, `R-classify`) or a template the consuming
//     repo registered in `workflow.auditGateTemplates`, and neither the
//     step nor its job may carry a `continue-on-error` that cannot be
//     proven false.
//
// The recognition is a SHAPE ALLOWLIST, not a neutralisation blocklist.
// Earlier revisions of this rule enumerated the ways a gate can be
// neutralised (`|| true`, `; true`, a bare `set +e`, ...); every such
// enumeration leaks in the false-CLEAN direction, because the next bash
// construct nobody listed scans green. An allowlist leaks the other way:
// a legitimate block nobody modelled is reported, which is a visible
// false positive an operator can read, disable per rule, or register as
// a template. For a `block`-severity security gate that is the only
// acceptable leak direction.
//
// The neutralisation checks survive only as message ENRICHMENT on a
// block that is already unrecognised (`neutralisationSignal` below).
// They can never produce a clean verdict.

const AUDIT_WORKFLOW_FILE_RE = /(^|\/)\.github\/workflows\/audit\.ya?ml$/;

function isAuditWorkflowFile(file: FileTarget): boolean {
  const normalized = file.path.split("\\").join("/");
  return AUDIT_WORKFLOW_FILE_RE.test(normalized);
}

type ScalarWithRange = { value: unknown; range: [number, number, number] };

/**
 * Which YAML scalar style a step's `run:` was written in. Only two
 * styles are analysable as shell text without first undoing YAML's own
 * processing, and both are the styles the fleet's workflows actually
 * use:
 *
 * - `literal-block` (`run: |`): every source line is one script line,
 *   verbatim apart from the block's common indentation.
 * - `single-line-plain` (`run: npm audit --audit-level=high`): one line,
 *   no YAML escapes.
 *
 * Everything else is `other` and refuses: a folded block scalar (`>`)
 * joins lines with spaces, so the statement boundaries in the source are
 * not the statement boundaries bash sees; a multi-line plain scalar
 * folds the same way; a quoted scalar carries YAML escape sequences
 * (`\n`, `\"`) that would have to be decoded before any shell-level
 * reasoning. Refusing is the fail-closed answer: the block is reported,
 * not certified.
 */
type RunScalarStyle = "literal-block" | "single-line-plain" | "other";

interface StepRunInfo {
  runRange: [number, number, number];
  /** YAML scalar style of the `run:` value (see `RunScalarStyle`). */
  style: RunScalarStyle;
  /** Human-readable name of the scalar style, for a refusal message. */
  styleLabel: string;
  continueOnError?: ScalarWithRange;
  /**
   * The `continue-on-error:` of this step's *enclosing job* (the
   * `jobs.<job_id>` mapping, identified by its own `steps:` key), when
   * present. GitHub Actions honours `continue-on-error` at the job level
   * too, not just per-step, so a step-level check alone misses a job
   * that stays green regardless of what any of its steps (including the
   * gate) exit.
   */
  jobContinueOnError?: ScalarWithRange;
}

/**
 * The YAML scalar style of a `run:` node, from `yaml`'s own `type` tag
 * plus (for a plain scalar) whether the source slice spans more than one
 * line. Duck-typed on `.type` rather than imported from `yaml`'s
 * `Scalar.Type` enum, for the same reason `hasItems` is duck-typed: the
 * only shape this depends on is "the node reports its style as a
 * string".
 */
function runScalarStyle(
  node: unknown,
  raw: string,
): { style: RunScalarStyle; styleLabel: string } {
  const type =
    typeof node === "object" && node !== null && "type" in (node as object)
      ? (node as { type?: unknown }).type
      : undefined;
  if (type === "BLOCK_LITERAL") {
    return { style: "literal-block", styleLabel: "a literal block scalar" };
  }
  if (type === "BLOCK_FOLDED") {
    return { style: "other", styleLabel: "a folded block scalar (`>`)" };
  }
  const multiline = raw.includes("\n");
  if (type === "PLAIN") {
    return multiline
      ? { style: "other", styleLabel: "a multi-line plain scalar" }
      : {
          style: "single-line-plain",
          styleLabel: "a single-line plain scalar",
        };
  }
  if (type === "QUOTE_SINGLE" || type === "QUOTE_DOUBLE") {
    return {
      style: "other",
      styleLabel: multiline
        ? "a multi-line quoted scalar"
        : "a quoted scalar (YAML escapes are not decoded before shell analysis)",
    };
  }
  return { style: "other", styleLabel: "an unrecognised scalar style" };
}

/**
 * Every `run:`-carrying step mapping in the document, together with that
 * step's `continue-on-error:` sibling and its enclosing job's
 * `continue-on-error:` (see `StepRunInfo.jobContinueOnError`), when
 * present. Unlike `collectRunScalars` (which only needs the scalar
 * node), these rules also need the *step's* other keys, so it collects
 * at the mapping level: any mapping with a `run:` key not inside a
 * `uses:` step's `with:` input block (same schema-position gating as
 * `collectRunScalars`, for the same reason: a custom action can name an
 * input `run`) is treated as a step. `jobContinueOnError` is threaded
 * down from the nearest enclosing mapping that itself carries a `steps:`
 * key (a job mapping), not reset by `with:` gating since a job's own
 * `continue-on-error:` is never inside any step's `with:` block.
 */
function collectStepRuns(
  fileText: string,
  node: unknown,
  out: StepRunInfo[],
  insideWith = false,
  jobContinueOnError?: ScalarWithRange,
): void {
  if (!hasItems(node)) return;
  const isUsesStep = node.items.some(
    (item) => isPairNode(item) && scalarKeyName(item.key) === "uses",
  );
  const isJobMapping = node.items.some(
    (item) => isPairNode(item) && scalarKeyName(item.key) === "steps",
  );
  const effectiveJobCoE = isJobMapping
    ? (() => {
        const jobCoePair = node.items.find(
          (item) =>
            isPairNode(item) && scalarKeyName(item.key) === "continue-on-error",
        );
        return jobCoePair &&
          isPairNode(jobCoePair) &&
          isScalarNode(jobCoePair.value)
          ? { value: jobCoePair.value.value, range: jobCoePair.value.range }
          : undefined;
      })()
    : jobContinueOnError;
  if (!insideWith) {
    const runPair = node.items.find(
      (item) => isPairNode(item) && scalarKeyName(item.key) === "run",
    );
    if (runPair && isPairNode(runPair) && isScalarWithRange(runPair.value)) {
      const coePair = node.items.find(
        (item) =>
          isPairNode(item) && scalarKeyName(item.key) === "continue-on-error",
      );
      const continueOnError =
        coePair && isPairNode(coePair) && isScalarNode(coePair.value)
          ? { value: coePair.value.value, range: coePair.value.range }
          : undefined;
      const range = runPair.value.range;
      const { style, styleLabel } = runScalarStyle(
        runPair.value,
        fileText.slice(range[0], range[1]),
      );
      out.push({
        runRange: range,
        style,
        styleLabel,
        continueOnError,
        jobContinueOnError: effectiveJobCoE,
      });
    }
  }
  for (const item of node.items) {
    if (isPairNode(item)) {
      const keyName = scalarKeyName(item.key);
      collectStepRuns(
        fileText,
        item.value,
        out,
        insideWith || (isUsesStep && keyName === "with"),
        effectiveJobCoE,
      );
    } else {
      collectStepRuns(fileText, item, out, insideWith, effectiveJobCoE);
    }
  }
}

// `moderate`/`low` are STRONGER gates than `high`/`critical` (npm's
// `--audit-level` sets the *minimum* severity that fails the command, so
// a lower threshold fails on strictly more advisories), so they count as
// a recognised gate too. Scoped to `npm audit` only (see `isGateCommand`
// below): a `pnpm audit --audit-level=high` or a non-npm audit command
// (`pip-audit`, `cargo audit`) is out of these rules' reach, documented
// in the README rather than guessed at here.
const AUDIT_GATE_RE = /--audit-level=(low|moderate|high|critical)\b/;

function isGateCommand(raw: string): boolean {
  return /\bnpm\s+audit\b/.test(raw) && AUDIT_GATE_RE.test(raw);
}

// ─────────────────────── run-block normalisation ───────────────────────
//
// One normalisation step stands between a gate step's raw `run:` source
// slice and every check in these two rules. No check reads the raw block
// text. In order: here-doc bodies are dropped, physical lines are joined
// across backslash continuations, each logical line loses its trailing
// shell comment, and the result is cut into statements at quote-aware
// command boundaries. Each of those was a bypass before it existed: a
// `#`-commented `exit $STATUS` satisfied a verdict requirement, a
// `set +e` inside an `echo "..."` string was read as a real one, and a
// gate command written only inside a `cat <<'MSG'` body counted as a
// present gate.

/**
 * One logical line of a `run:` block after normalisation: physical lines
 * joined across backslash continuations, then the trailing shell comment
 * stripped. `offsets[i]` is the absolute file offset of `text[i]`,
 * tracked per character rather than as a single line-start offset
 * because joining a continuation drops the backslash and the newline, so
 * a character index past a join no longer differs from its file offset
 * by a constant.
 */
interface NormalizedLine {
  text: string;
  offsets: number[];
  /** 0-based position of this logical line inside its run block. */
  lineIndex: number;
}

/**
 * How a statement is attached to the one before it. `start` is the first
 * statement of the block; `newline` is a plain line break. The operator
 * separators are kept (rather than thrown away as in a plain split)
 * because a recognised shape constrains them: `R-bare` allows no
 * separator at all, and `R-classify` allows `|` only between the gate
 * command and a `tee`.
 */
type StatementSeparator = "start" | "newline" | ";" | "&&" | "||" | "|";

/**
 * One shell statement cut out of a normalized logical line at an
 * unquoted `;`, `&&`, `||` or `|` boundary. `line` is the logical line
 * it came from (kept so a message can point at the gate's own line);
 * `indexInLine` is this statement's first character inside `line.text`;
 * `trimmed` is `text` without surrounding whitespace, the form every
 * shape check and the template hash read.
 */
interface NormalizedStatement {
  text: string;
  trimmed: string;
  line: NormalizedLine;
  indexInLine: number;
  separatorBefore: StatementSeparator;
}

/** The absolute file offset of `line.text[index]`. */
function lineOffsetAt(line: NormalizedLine, index: number): number {
  return line.offsets[index] ?? line.offsets[line.offsets.length - 1] ?? 0;
}

/** The absolute file offset of `statement.text[index]`. */
function statementOffsetAt(
  statement: NormalizedStatement,
  index: number,
): number {
  return lineOffsetAt(statement.line, statement.indexInLine + index);
}

type QuoteContext = "bare" | "single" | "double";

/**
 * The quoting context of every character in `text`, from the same
 * parity-and-escape scan `stripTrailingComment` uses (a backslash inside
 * a double-quoted span escapes the next character; nothing is special
 * inside single quotes). A quote delimiter is reported as part of the
 * span it opens or closes, so a match starting on the opening quote
 * counts as quoted.
 */
function quoteContexts(text: string): QuoteContext[] {
  const contexts: QuoteContext[] = new Array<QuoteContext>(text.length).fill(
    "bare",
  );
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inDouble && ch === "\\") {
      contexts[i] = "double";
      if (i + 1 < text.length) contexts[i + 1] = "double";
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      contexts[i] = "single";
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      contexts[i] = "double";
      inDouble = !inDouble;
      continue;
    }
    contexts[i] = inSingle ? "single" : inDouble ? "double" : "bare";
  }
  return contexts;
}

/** True when `text`'s quote scan ends inside a quoted span. */
function hasUnbalancedQuote(text: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inDouble && ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
  }
  return inSingle || inDouble;
}

/**
 * Which quoting contexts a match may start in. Rather than blanking
 * every quoted span for every search, this follows the shell:
 *
 * - `"command"` requires a bare start. A command word written inside
 *   quotes is data, not program text, so `echo "set +e"` is not a
 *   `set +e` and `echo "exit 1"` is not an exit verdict.
 * - `"expansion"` also accepts a double-quoted start, because `$?` and
 *   `$VAR` still expand inside double quotes: `STATUS="$?"` is a real
 *   status capture and `exit "$STATUS"` a real verdict, while a
 *   single-quoted `'$?'` is inert.
 */
type MatchKind = "command" | "expansion";

function allowedContext(ctx: QuoteContext, kind: MatchKind): boolean {
  if (ctx === "bare") return true;
  return kind === "expansion" && ctx === "double";
}

interface UnquotedMatch {
  index: number;
  match: string;
}

/**
 * Every match of `re` in `text` at or after `from` whose start sits in a
 * quoting context the match can take effect in (see `MatchKind`), in
 * order. `re` need not be global; a non-global pattern is recompiled
 * with the flag rather than mutated.
 */
function unquotedMatches(
  text: string,
  re: RegExp,
  kind: MatchKind,
  from = 0,
): UnquotedMatch[] {
  const contexts = quoteContexts(text);
  const global = re.global ? re : new RegExp(re.source, `${re.flags}g`);
  return findAllRegex(text, global)
    .filter(
      (m) =>
        m.index >= from && allowedContext(contexts[m.index] ?? "bare", kind),
    )
    .map((m) => ({ index: m.index, match: m.match }));
}

function firstUnquoted(
  text: string,
  re: RegExp,
  kind: MatchKind,
  from = 0,
): UnquotedMatch | undefined {
  return unquotedMatches(text, re, kind, from)[0];
}

/**
 * `line` with a trailing shell comment removed, only when the `#` sits
 * outside single/double quotes (a quote-parity scan with one piece of
 * escape handling: a backslash inside a double-quoted span, e.g.
 * `--note="it\"s fine"`, escapes the next character instead of closing
 * the double-quoted span, matching bash's own double-quote escaping.
 * Single-quoted spans get no escape handling, matching bash: nothing is
 * special inside single quotes) and is preceded by whitespace or is the
 * first character. A `#` that fails either test is left alone: it is
 * either quoted data or not a comment delimiter at all (e.g. `foo#bar`,
 * not preceded by whitespace).
 */
function stripTrailingComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inDouble && ch === "\\") {
      i++; // skip the escaped character (e.g. the `"` in `\"`)
      continue;
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      const prev = i === 0 ? undefined : line[i - 1];
      if (prev === undefined || /\s/.test(prev)) return line.slice(0, i);
    }
  }
  return line;
}

/** One physical source line of a run block, with its file offset. */
interface PhysicalLine {
  text: string;
  offset: number;
}

/**
 * A here-doc redirection found on one physical line: the delimiter word
 * and whether the `<<-` form (leading tabs stripped from the terminator)
 * was used. `quoted` is unused by the terminator scan (bash accepts
 * `EOF`, `'EOF'` and `"EOF"` with the same terminator line) and kept
 * only to make the parse explicit.
 */
interface HeredocRedirection {
  delimiter: string;
  dashed: boolean;
}

/**
 * Every here-doc redirection opened on `text`, in order. A redirection
 * is an unquoted `<<` (optionally `<<-`) that is not the `<<<`
 * herestring, followed by an optionally quoted delimiter word.
 *
 * `malformed` is set when an unquoted `<<` is found whose delimiter
 * cannot be read: the normaliser then has no way to know where the body
 * ends, which is a refusal, never a guess.
 */
function heredocRedirections(text: string): {
  redirections: HeredocRedirection[];
  malformed: boolean;
} {
  const contexts = quoteContexts(text);
  const redirections: HeredocRedirection[] = [];
  let malformed = false;
  for (let i = 0; i + 1 < text.length; i++) {
    if (contexts[i] !== "bare") continue;
    if (text[i] !== "<" || text[i + 1] !== "<") continue;
    if (text[i + 2] === "<") {
      i += 2; // `<<<` is a herestring: no body, nothing to strip.
      continue;
    }
    let j = i + 2;
    const dashed = text[j] === "-";
    if (dashed) j++;
    while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
    const quote = text[j] === "'" || text[j] === '"' ? text[j] : undefined;
    if (quote) {
      const end = text.indexOf(quote, j + 1);
      if (end === -1) {
        malformed = true;
        break;
      }
      redirections.push({ delimiter: text.slice(j + 1, end), dashed });
      i = end;
      continue;
    }
    const word = /^[A-Za-z0-9_.+-]+/.exec(text.slice(j));
    if (!word) {
      malformed = true;
      break;
    }
    redirections.push({ delimiter: word[0], dashed });
    i = j + word[0].length - 1;
  }
  return { redirections, malformed };
}

/**
 * The common indentation a literal block scalar's source lines carry.
 * GitHub Actions hands the *dedented* script to bash, so a here-doc
 * terminator that sits at column 0 of the script sits at exactly this
 * indentation in the file.
 */
function blockIndent(lines: PhysicalLine[]): string {
  for (const line of lines) {
    if (line.text.trim().length === 0) continue;
    return /^[ \t]*/.exec(line.text)?.[0] ?? "";
  }
  return "";
}

/**
 * True when `line` is the terminator of a here-doc opened with
 * `delimiter`. Bash requires the terminator to be the delimiter alone on
 * its own line (leading tabs allowed only for the `<<-` form), so the
 * file line must be the block's own indentation plus the delimiter. A
 * line that merely mentions the delimiter mid-script does not terminate
 * anything.
 */
function isHeredocTerminator(
  line: string,
  indent: string,
  redirection: HeredocRedirection,
): boolean {
  if (!line.startsWith(indent)) return false;
  let rest = line.slice(indent.length);
  if (redirection.dashed) rest = rest.replace(/^\t+/, "");
  return rest.trimEnd() === redirection.delimiter;
}

/**
 * The outcome of dropping every here-doc body from a run block's
 * physical lines. The redirection statement itself is KEPT (it is real
 * program text, and no recognised shape permits it, so a block carrying
 * one is reported); only the body lines, which bash never executes, are
 * dropped.
 */
interface HeredocStrip {
  lines: PhysicalLine[];
  /** A here-doc redirection was seen at all. */
  found: boolean;
  /** A here-doc whose body end could not be located. */
  unterminated: boolean;
}

function stripHeredocBodies(lines: PhysicalLine[]): HeredocStrip {
  const indent = blockIndent(lines);
  const kept: PhysicalLine[] = [];
  let found = false;
  let unterminated = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    kept.push(line);
    const { redirections, malformed } = heredocRedirections(line.text);
    if (malformed) {
      found = true;
      unterminated = true;
      continue;
    }
    if (redirections.length === 0) continue;
    found = true;
    for (const redirection of redirections) {
      let terminated = false;
      while (i + 1 < lines.length) {
        i++;
        if (isHeredocTerminator(lines[i].text, indent, redirection)) {
          terminated = true;
          break;
        }
      }
      if (!terminated) {
        unterminated = true;
        break;
      }
    }
  }
  return { lines: kept, found, unterminated };
}

/**
 * `raw` (a `run:` scalar's source slice, minus a block scalar's header
 * line) as here-doc-free, comment-free logical lines: a physical line
 * ending in a backslash is joined onto the next one (the trailing
 * backslash itself is dropped, nothing else inserted, matching bash's
 * own backslash-newline removal), so a gate command's `||`/`;` tail
 * written on a continuation line is inspected as part of the logical
 * line it actually runs on; then the joined line's trailing shell
 * comment is stripped. `baseOffset` is `raw`'s own start offset in the
 * full file text, so every recorded offset is an absolute file offset
 * usable for a violation location.
 */
function normalizeLogicalLines(
  raw: string,
  baseOffset: number,
): { lines: NormalizedLine[]; heredoc: HeredocStrip } {
  const physical: PhysicalLine[] = [];
  let offset = baseOffset;
  for (const source of raw.split("\n")) {
    const stripped = source.endsWith("\r") ? source.slice(0, -1) : source;
    physical.push({ text: stripped, offset });
    offset += source.length + 1;
  }
  const heredoc = stripHeredocBodies(physical);

  const lines: NormalizedLine[] = [];
  const pushLine = (joined: string, joinedOffsets: number[]) => {
    const commentFree = stripTrailingComment(joined);
    lines.push({
      text: commentFree,
      offsets: joinedOffsets.slice(0, commentFree.length),
      lineIndex: lines.length,
    });
  };
  let joined = "";
  let joinedOffsets: number[] = [];
  let continuing = false;
  for (const line of heredoc.lines) {
    const continues = line.text.endsWith("\\");
    const keep = continues ? line.text.length - 1 : line.text.length;
    for (let i = 0; i < keep; i++) {
      joined += line.text[i];
      joinedOffsets.push(line.offset + i);
    }
    if (continues) {
      continuing = true;
    } else {
      pushLine(joined, joinedOffsets);
      joined = "";
      joinedOffsets = [];
      continuing = false;
    }
  }
  if (continuing) pushLine(joined, joinedOffsets);
  return { lines, heredoc };
}

/**
 * `line` cut into statements at every unquoted `;`, `&&`, `||` or `|`
 * boundary that is not inside a command substitution, so "the statement
 * list" is a list of things the shell actually runs in sequence.
 * Whitespace-only pieces are dropped (a comment-only line strips to
 * one), so a statement list only ever holds real commands.
 *
 * `substitutionSpansSeparator` reports a `$( ... )` or a backtick span
 * that contains one of those boundaries. Such a boundary is NOT a
 * statement boundary of the block, and splitting there would invent a
 * statement list bash never runs, so the caller refuses the block
 * instead of reasoning about it.
 */
function splitStatements(line: NormalizedLine): {
  statements: NormalizedStatement[];
  substitutionSpansSeparator: boolean;
} {
  const contexts = quoteContexts(line.text);
  const pieces: Array<{
    start: number;
    end: number;
    separatorBefore: StatementSeparator;
  }> = [];
  let start = 0;
  let i = 0;
  let separator: StatementSeparator = "newline";
  let depth = 0;
  let inBacktick = false;
  let substitutionSpansSeparator = false;
  while (i < line.text.length) {
    if (contexts[i] !== "bare") {
      i++;
      continue;
    }
    if (line.text[i] === "`") {
      inBacktick = !inBacktick;
      i++;
      continue;
    }
    if (line.text[i] === "$" && line.text[i + 1] === "(") {
      depth++;
      i += 2;
      continue;
    }
    if (line.text[i] === ")" && depth > 0) {
      depth--;
      i++;
      continue;
    }
    const pair = line.text.slice(i, i + 2);
    const separatorLength =
      pair === "&&" || pair === "||"
        ? 2
        : line.text[i] === ";" || line.text[i] === "|"
          ? 1
          : 0;
    if (separatorLength === 0) {
      i++;
      continue;
    }
    if (depth > 0 || inBacktick) {
      substitutionSpansSeparator = true;
      i += separatorLength;
      continue;
    }
    pieces.push({ start, end: i, separatorBefore: separator });
    separator =
      separatorLength === 2
        ? (pair as "&&" | "||")
        : (line.text[i] as ";" | "|");
    i += separatorLength;
    start = i;
  }
  pieces.push({ start, end: line.text.length, separatorBefore: separator });
  const statements = pieces
    .map((piece) => ({
      text: line.text.slice(piece.start, piece.end),
      trimmed: line.text.slice(piece.start, piece.end).trim(),
      line,
      indexInLine: piece.start,
      separatorBefore: piece.separatorBefore,
    }))
    .filter((statement) => statement.trimmed.length > 0);
  return { statements, substitutionSpansSeparator };
}

/**
 * One gate step's `run:` block, normalised: the statement list every
 * check reads, plus the lexical refusals that make the statement list
 * untrustworthy as a model of the script.
 *
 * `refusal` is a reason string, not a boolean: `audit-gate-shape`
 * reports it verbatim so an operator can see WHICH construct the
 * normaliser does not model. A construct nobody thought of does not
 * silently pass here; it fails one of the shape allowlists instead,
 * because no shape permits an unmodelled statement.
 */
interface NormalizedBlock {
  statements: NormalizedStatement[];
  refusal?: string;
  /** Start offset of the block's first content character. */
  offset: number;
}

const FUNCTION_DEF_RE =
  /^(?:function\s+[A-Za-z_][A-Za-z0-9_]*\b|[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\))/;
const EVAL_RE = /(^|[\s;&|(])eval([\s;&|)]|$)/;

/**
 * An unquoted `&` that backgrounds a command, as opposed to one that is
 * part of `&&` or of a file-descriptor redirection (`2>&1`, `&>log`,
 * `>&2`). A backgrounded command's exit status never reaches the step,
 * so a block containing one is refused rather than certified.
 */
function hasBackgroundingAmpersand(text: string): boolean {
  const contexts = quoteContexts(text);
  for (let i = 0; i < text.length; i++) {
    if (contexts[i] !== "bare" || text[i] !== "&") continue;
    const prev = i > 0 ? text[i - 1] : "";
    const next = i + 1 < text.length ? text[i + 1] : "";
    if (prev === "&" || next === "&") continue; // `&&`
    if (prev === ">" || prev === "<") continue; // `2>&1`, `<&3`
    if (next === ">") continue; // `&>log`
    return true;
  }
  return false;
}

/**
 * The first lexical refusal in a normalised block, or `undefined` when
 * the statement list can be trusted as a model of the script.
 *
 * A miss in this list yields a FALSE POSITIVE, never a false clean: an
 * unmodelled construct that slips past every entry here still has to
 * match a recognised shape, and no shape permits a statement it does not
 * name. That is why this may be a list at all.
 */
function lexicalRefusal(
  statements: NormalizedStatement[],
  lines: NormalizedLine[],
  heredoc: HeredocStrip,
  substitutionSpansSeparator: boolean,
): string | undefined {
  if (heredoc.unterminated) {
    return "the run block opens a here-doc whose terminator this rule could not locate";
  }
  if (heredoc.found) {
    return "the run block redirects a here-doc, a construct this rule does not model";
  }
  for (const line of lines) {
    if (hasUnbalancedQuote(line.text)) {
      return "a line of the run block leaves a quote unbalanced";
    }
  }
  if (substitutionSpansSeparator) {
    return "a command substitution in the run block spans a statement separator";
  }
  for (const statement of statements) {
    if (FUNCTION_DEF_RE.test(statement.trimmed)) {
      return "the run block defines a shell function, a construct this rule does not model";
    }
  }
  for (const statement of statements) {
    if (EVAL_RE.test(statement.trimmed)) {
      return "the run block calls `eval`, a construct this rule does not model";
    }
  }
  for (const statement of statements) {
    if (hasBackgroundingAmpersand(statement.text)) {
      return "the run block backgrounds a command with `&`";
    }
  }
  return undefined;
}

/**
 * One step's `run:` block turned into the single input both rules read.
 * `raw` is the scalar's source slice; a literal block scalar's header
 * line (`|`, `|-`, `|2`) is dropped first so the first logical line is
 * the first script line.
 */
function normalizeRunBlock(
  raw: string,
  baseOffset: number,
  style: RunScalarStyle,
): NormalizedBlock {
  let body = raw;
  let offset = baseOffset;
  if (style === "literal-block") {
    const headerEnd = raw.indexOf("\n");
    if (headerEnd === -1) return { statements: [], offset: baseOffset };
    body = raw.slice(headerEnd + 1);
    offset = baseOffset + headerEnd + 1;
  }
  const { lines, heredoc } = normalizeLogicalLines(body, offset);
  const statements: NormalizedStatement[] = [];
  let substitutionSpansSeparator = false;
  for (const line of lines) {
    const split = splitStatements(line);
    if (split.substitutionSpansSeparator) substitutionSpansSeparator = true;
    if (statements.length === 0 && split.statements.length > 0) {
      split.statements[0] = {
        ...split.statements[0],
        separatorBefore: "start",
      };
    }
    statements.push(...split.statements);
  }
  return {
    statements,
    refusal: lexicalRefusal(
      statements,
      lines,
      heredoc,
      substitutionSpansSeparator,
    ),
    offset,
  };
}

/**
 * The first statement in a normalized block that actually invokes the
 * npm-audit gate command. This, not a search over the raw block text, is
 * what decides whether a step is a gate step at all: a
 * `# TODO: restore npm audit --audit-level=high` line is a comment, and
 * the same text inside a `cat <<'MSG'` body is data, not a gate.
 */
function findGateStatement(
  statements: NormalizedStatement[],
): NormalizedStatement | undefined {
  return statements.find((statement) => isGateCommand(statement.trimmed));
}

// ───────────────────────── `set` option parsing ─────────────────────────

interface SetStatement {
  isSet: boolean;
  disablesErrexit: boolean;
  enablesErrexit: boolean;
  enablesPipefail: boolean;
  /** No `+` flag group at all: the statement only ever turns things on. */
  onlyEnables: boolean;
}

/**
 * A `set` builtin call, parsed into the two options these rules care
 * about. Parsed rather than pattern-matched on `set +e`/`set -e` alone,
 * because bash spells the same thing several ways and every unhandled
 * spelling was a bug: `set +eu` and `set +o errexit` disable errexit
 * exactly as `set +e` does, and `set -euo pipefail` restores it exactly
 * as `set -e` does. A flag group ending in `o` (`-o`, `-euo`) takes the
 * option name from the following word.
 */
function parseSetStatement(trimmed: string): SetStatement {
  const none: SetStatement = {
    isSet: false,
    disablesErrexit: false,
    enablesErrexit: false,
    enablesPipefail: false,
    onlyEnables: false,
  };
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
  if (tokens[0] !== "set") return none;
  const result: SetStatement = { ...none, isSet: true, onlyEnables: true };
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    const sign = token[0];
    if (sign !== "-" && sign !== "+") continue;
    if (sign === "+") result.onlyEnables = false;
    const letters = token.slice(1);
    if (letters.includes("e")) {
      if (sign === "+") result.disablesErrexit = true;
      else result.enablesErrexit = true;
    }
    if (letters.endsWith("o")) {
      const option = tokens[i + 1];
      i++;
      if (option === "errexit") {
        if (sign === "+") result.disablesErrexit = true;
        else result.enablesErrexit = true;
      }
      if (option === "pipefail" && sign === "-") result.enablesPipefail = true;
    }
  }
  return result;
}

// ───────────────────────── recognised gate shapes ─────────────────────────

/**
 * `R-bare`: the gate command is the whole block. Exactly one statement,
 * no separator before it, an optional `timeout <arg>` prefix, any
 * `npm audit` flags, and no redirection, substitution or operator at
 * all. Redirections are refused wholesale rather than only for a
 * discarding sink (`>/dev/null`): a gate whose output goes somewhere is
 * a `R-classify` gate (it pipes into `tee`), and "which sink discards"
 * is exactly the kind of enumeration this rule stopped making.
 */
const BARE_GATE_RE =
  /^(?:timeout\s+[^\s<>&|;$`]+\s+)?npm\s+audit(?:\s+[^\s<>&|;$`]+)*$/;

/** `VAR=$?` / `VAR="$?"`: the gate's exit status, captured. */
const STATUS_CAPTURE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"\$\?"|\$\?)$/;

/** A `tee <arg>` pipeline stage, the only downstream stage a gate may have. */
const TEE_STAGE_RE = /^tee(?:\s+-[aip]+)*\s+[^\s<>&|;]+$/;

/** `exit <non-zero literal>`. */
const NONZERO_LITERAL_EXIT_RE = /^exit\s+[1-9]\d*$/;

/** `exit 0` (also `exit 00`), the verdict that makes a gate pointless. */
const ZERO_EXIT_RE = /^exit\s+0+$/;

/** Any `exit`, with or without an operand. */
const EXIT_STATEMENT_RE = /^exit\b/;

/**
 * Statements permitted before the `set +e` window opens. A `trap` is
 * among them (the canonical classification block cleans up a temp file
 * on `EXIT`), but only one that does not itself call `exit`: an `EXIT`
 * trap leaves the script's exit status alone unless its own body exits,
 * and `trap 'exit 0' EXIT` would make every later verdict irrelevant.
 * Matched case-sensitively, so the `EXIT` signal name is not mistaken
 * for the `exit` builtin.
 */
const PRE_WINDOW_COMMAND_RE = /^(?:trap|mkdir|mktemp|cd|echo|printf)\b/;
const TRAP_RE = /^trap\b/;
const EXIT_WORD_RE = /\bexit\b/;
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Statements permitted after the `set -e` restore. */
const POST_RESTORE_COMMAND_RE = /^(?:if|then|else|elif|fi|echo|printf|exit)\b/;

/** `exit $VAR` / `exit "$VAR"` / `exit ${VAR}` of one specific variable. */
function isExitOfVariable(trimmed: string, variable: string): boolean {
  const re = new RegExp(
    `^exit\\s+(?:"?\\$${variable}"?|"?\\$\\{${variable}\\}"?)$`,
  );
  return re.test(trimmed);
}

/** A short, quotable form of a statement for a message. */
function quoteStatement(trimmed: string): string {
  const clipped =
    trimmed.length > 48 ? `${trimmed.slice(0, 48).trimEnd()}...` : trimmed;
  return `\`${clipped}\``;
}

type ShapeAttempt = { ok: true } | { ok: false; reason: string };

function tryBareShape(
  statements: NormalizedStatement[],
  gate: NormalizedStatement,
): ShapeAttempt {
  if (statements.length !== 1) {
    const other = statements.find((statement) => statement !== gate);
    if (other) {
      switch (other.separatorBefore) {
        case "||":
          return {
            ok: false,
            reason: `the gate command's logical line carries a \`||\` tail (${quoteStatement(other.trimmed)})`,
          };
        case "&&":
          return {
            ok: false,
            reason: `the gate command's logical line carries a \`&&\` tail (${quoteStatement(other.trimmed)})`,
          };
        case ";":
          return {
            ok: false,
            reason: `the gate command's logical line carries a \`;\` tail (${quoteStatement(other.trimmed)})`,
          };
        case "|":
          return {
            ok: false,
            reason:
              "the gate command is piped, which only the `set +e` classification shape permits",
          };
        default:
          return {
            ok: false,
            reason: `the run block carries another statement beside the gate command (${quoteStatement(other.trimmed)}) without a \`set +e\` classification window`,
          };
      }
    }
  }
  if (gate.separatorBefore !== "start") {
    return {
      ok: false,
      reason: "the gate command is not the first statement of the run block",
    };
  }
  if (!BARE_GATE_RE.test(gate.trimmed)) {
    return {
      ok: false,
      reason: `the gate statement (${quoteStatement(gate.trimmed)}) carries a redirection, a substitution or a token this rule does not model`,
    };
  }
  return { ok: true };
}

/**
 * `R-classify`: the gate's own exit status is captured and turned into
 * the step's exit status.
 *
 *     <pre-window assignments / option-enabling `set -` / trap / mkdir>
 *     set +e
 *     <gate command>            (optionally `| tee <file>`, with pipefail)
 *     VAR=$?
 *     set -e
 *     <if/then/else/fi, echo, exit>   with an `exit <non-zero literal>`
 *                                     and an `exit $VAR`, and no `exit 0`
 *
 * Everything is positional and exhaustive: a statement the shape does
 * not name makes the block unrecognised, so a construct this rule never
 * heard of cannot ride along inside a recognised block.
 */
function tryClassifyShape(
  statements: NormalizedStatement[],
  gate: NormalizedStatement,
): ShapeAttempt {
  const parsed = statements.map((statement) => ({
    statement,
    set: parseSetStatement(statement.trimmed),
  }));
  const openers = parsed.filter((entry) => entry.set.disablesErrexit);
  if (openers.length === 0) {
    return {
      ok: false,
      reason:
        "the run block neither is the bare gate command nor opens a `set +e` classification window",
    };
  }
  if (openers.length > 1) {
    return {
      ok: false,
      reason: "the run block disables `errexit` more than once",
    };
  }
  const openerIndex = parsed.indexOf(openers[0]);
  const restores = parsed.filter(
    (entry, index) => index > openerIndex && entry.set.enablesErrexit,
  );
  if (restores.length === 0) {
    return {
      ok: false,
      reason: "`set +e` is never followed by a `set -e` restore",
    };
  }
  if (restores.length > 1) {
    return {
      ok: false,
      reason: "`set +e` is followed by more than one `set -e` restore",
    };
  }
  const restoreIndex = parsed.indexOf(restores[0]);
  const gates = statements.filter((statement) =>
    isGateCommand(statement.trimmed),
  );
  if (gates.length !== 1) {
    return {
      ok: false,
      reason: `the run block carries ${gates.length} npm-audit gate commands, not one`,
    };
  }
  const gateIndex = statements.indexOf(gate);
  if (gateIndex <= openerIndex || gateIndex >= restoreIndex) {
    return {
      ok: false,
      reason:
        "the gate command does not sit strictly between the `set +e` and its `set -e` restore",
    };
  }

  const window = statements.slice(openerIndex + 1, restoreIndex);
  let cursor = 0;
  if (window[cursor] !== gate) {
    return {
      ok: false,
      reason: `the \`set +e\` window carries a statement before the gate command (${quoteStatement(window[cursor].trimmed)})`,
    };
  }
  cursor++;
  let piped = false;
  while (cursor < window.length && window[cursor].separatorBefore === "|") {
    if (!TEE_STAGE_RE.test(window[cursor].trimmed)) {
      return {
        ok: false,
        reason: `the gate command is piped into something other than \`tee\` (${quoteStatement(window[cursor].trimmed)})`,
      };
    }
    piped = true;
    cursor++;
  }
  if (piped) {
    const pipefailBeforeGate = parsed
      .slice(0, gateIndex)
      .some((entry) => entry.set.enablesPipefail);
    if (!pipefailBeforeGate) {
      return {
        ok: false,
        reason:
          "the gate command is piped without `set -o pipefail` earlier in the run block, so the pipeline reports `tee`'s exit status, not the gate's",
      };
    }
  }
  let captured: string | undefined;
  if (cursor < window.length) {
    const candidate = window[cursor];
    const capture = STATUS_CAPTURE_RE.exec(candidate.trimmed);
    if (
      !capture ||
      (candidate.separatorBefore !== "newline" &&
        candidate.separatorBefore !== ";")
    ) {
      return {
        ok: false,
        reason: `the \`set +e\` window carries a statement other than a \`VAR=$?\` capture (${quoteStatement(candidate.trimmed)})`,
      };
    }
    captured = capture[1];
    cursor++;
  }
  if (cursor !== window.length) {
    return {
      ok: false,
      reason: `the \`set +e\` window carries more statements than the gate command and one \`VAR=$?\` capture (${quoteStatement(window[cursor].trimmed)})`,
    };
  }
  if (!captured) {
    return {
      ok: false,
      reason:
        "the `set +e` window does not capture the gate's exit status (`VAR=$?`)",
    };
  }

  for (const statement of statements.slice(0, openerIndex)) {
    const set = parseSetStatement(statement.trimmed);
    const permitted =
      (set.isSet && set.onlyEnables) ||
      ASSIGNMENT_RE.test(statement.trimmed) ||
      (PRE_WINDOW_COMMAND_RE.test(statement.trimmed) &&
        !(
          TRAP_RE.test(statement.trimmed) &&
          EXIT_WORD_RE.test(statement.trimmed)
        ));
    const separatorOk =
      statement.separatorBefore === "start" ||
      statement.separatorBefore === "newline" ||
      statement.separatorBefore === ";";
    if (!permitted || !separatorOk) {
      return {
        ok: false,
        reason: `a statement this rule does not model runs before the \`set +e\` (${quoteStatement(statement.trimmed)})`,
      };
    }
  }

  const after = statements.slice(restoreIndex + 1);
  for (const statement of after) {
    const separatorOk =
      statement.separatorBefore === "newline" ||
      statement.separatorBefore === ";";
    if (!POST_RESTORE_COMMAND_RE.test(statement.trimmed) || !separatorOk) {
      return {
        ok: false,
        reason: `a statement this rule does not model runs after the \`set -e\` restore (${quoteStatement(statement.trimmed)})`,
      };
    }
    // Every `exit` after the restore must be one of the two verdicts the
    // shape is about. A bare `exit` exits with the status of whatever ran
    // last (post-restore that is an `echo`, so zero), and `exit $OTHER`
    // or `exit ${VAR:-0}` hands over a value the shape knows nothing
    // about; both would let a recognised block report success on a
    // failing gate, so neither may ride along inside one.
    if (!EXIT_STATEMENT_RE.test(statement.trimmed)) continue;
    if (ZERO_EXIT_RE.test(statement.trimmed)) {
      return {
        ok: false,
        reason:
          "an `exit 0` statement runs after the `set -e` restore, so the step can report success on a failing gate",
      };
    }
    if (
      !NONZERO_LITERAL_EXIT_RE.test(statement.trimmed) &&
      !isExitOfVariable(statement.trimmed, captured)
    ) {
      return {
        ok: false,
        reason: `an \`exit\` after the \`set -e\` restore exits neither a non-zero literal nor the captured status (${quoteStatement(statement.trimmed)})`,
      };
    }
  }
  if (
    !after.some((statement) => NONZERO_LITERAL_EXIT_RE.test(statement.trimmed))
  ) {
    return {
      ok: false,
      reason:
        "no `exit` of a non-zero literal runs after the `set -e` restore, so nothing turns a failing gate into a failing step",
    };
  }
  if (
    !after.some((statement) => isExitOfVariable(statement.trimmed, captured))
  ) {
    return {
      ok: false,
      reason: `no \`exit $${captured}\` of the captured gate status runs after the \`set -e\` restore`,
    };
  }
  return { ok: true };
}

// ───────────────────────── registered templates ─────────────────────────

/**
 * The text a template digest is taken over (comments, indentation, blank
 * lines and line-ending style are already gone at this point, so the
 * hash is stable against a pure reformat and changes on any edit to what
 * the script runs): one line per statement, and
 * a statement that followed a `;`, `&&`, `||` or `|` boundary carries
 * that separator as a prefix. Without the prefix two scripts that differ
 * only in how their statements are joined (an `exit 1` on its own line
 * versus `|| exit 1` glued to the previous command) hash identically,
 * and a registered template would keep matching after an edit that
 * changes what the script does. The `{ name, statements }` config form
 * describes a newline-separated block, so its entries carry no prefix.
 */
function templateDigestText(statements: NormalizedStatement[]): string {
  return statements
    .map((statement) =>
      statement.separatorBefore === "start" ||
      statement.separatorBefore === "newline"
        ? statement.trimmed
        : `${statement.separatorBefore} ${statement.trimmed}`,
    )
    .join("\n");
}

/** The template identity of a normalised block: the sha256 of {@link templateDigestText}. */
function templateDigest(statements: NormalizedStatement[]): string {
  return createHash("sha256")
    .update(templateDigestText(statements))
    .digest("hex");
}

/**
 * The name of the registered template this block's statements match, if
 * any. A template is an exact match on that digest, and a matched
 * template is trusted AS IS: registering one is a deliberate operator
 * act that says "I have reviewed this exact script", so no shape
 * analysis runs on it. That is the mechanism's cost as well as its
 * point: any later edit to a registered block, including a harmless
 * one, changes the digest and is reported until the operator registers
 * the new digest.
 */
function matchingTemplate(
  statements: NormalizedStatement[],
  config: ResolvedConfig,
): string | undefined {
  const templates = config.workflow?.auditGateTemplates ?? [];
  if (templates.length === 0) return undefined;
  const digest = templateDigest(statements);
  for (const template of templates) {
    const expected =
      template.sha256 ??
      (template.statements
        ? createHash("sha256")
            .update(template.statements.map((s) => s.trim()).join("\n"))
            .digest("hex")
        : undefined);
    if (expected && expected.toLowerCase() === digest) return template.name;
  }
  return undefined;
}

// ───────────── neutralisation signals (message enrichment only) ─────────────

const OR_OPERATOR_RE = /\|\|/g;
const TAIL_NOOP_RE = /;\s*(true|:)(?=[\s;]|$)/;

/**
 * A plain-language note about a known neutralisation pattern in a block
 * that is ALREADY unrecognised, appended to the finding's message so an
 * operator reading the report sees the likely intent, not just "shape
 * not recognised".
 *
 * This is the only surviving use of the neutralisation enumeration an
 * earlier revision of this rule used as its verdict. It cannot make a
 * block clean: it is called after recognition has already failed, and
 * returning `undefined` only shortens the message.
 */
function neutralisationSignal(
  statements: NormalizedStatement[],
  gate: NormalizedStatement,
): string | undefined {
  const gateFlag = AUDIT_GATE_RE.exec(gate.trimmed);
  const gateEnd = gate.indexInLine + gate.text.length;
  const tailStart = gateFlag
    ? Math.min(
        gate.indexInLine + gate.text.indexOf(gateFlag[0]) + gateFlag[0].length,
        gateEnd,
      )
    : gateEnd;
  for (const m of unquotedMatches(
    gate.line.text,
    OR_OPERATOR_RE,
    "command",
    tailStart,
  )) {
    const rest = gate.line.text.slice(m.index + 2).trimStart();
    if (!/^(exit|false|return)\b/.test(rest)) {
      return "the gate command's logical line ends in a `||` whose right-hand side is not `exit`/`false`/`return`, which makes a failing gate exit zero";
    }
  }
  if (firstUnquoted(gate.line.text, TAIL_NOOP_RE, "command", tailStart)) {
    return "the gate command's logical line ends in `; true` or `; :`, which makes the step's last command succeed";
  }
  const parsed = statements.map((statement) =>
    parseSetStatement(statement.trimmed),
  );
  const openerIndex = parsed.findIndex((set) => set.disablesErrexit);
  if (
    openerIndex !== -1 &&
    !parsed.slice(openerIndex + 1).some((set) => set.enablesErrexit)
  ) {
    return "the run block disables `errexit` and never restores it, so a failing gate does not fail the step";
  }
  return undefined;
}

// ───────────────────────────── the two rules ─────────────────────────────

interface AuditFinding {
  offset: number;
  matched: string;
  message: string;
}

/**
 * One step of an audit workflow, with its run block already normalised.
 * `certifiableGate` is the shared answer to "does this step invoke the
 * gate in a statement this rule can certify": the normalised statement
 * list carries the gate command AND the `run:` scalar is one of the two
 * analysable styles. `audit-gate-missing` needs exactly that predicate;
 * `audit-gate-shape` additionally looks at a non-analysable scalar whose
 * raw text mentions the gate, so a gate rewritten as a folded scalar is
 * reported rather than skipped.
 */
interface AuditStepBlock {
  step: StepRunInfo;
  block: NormalizedBlock;
  gate?: NormalizedStatement;
  certifiableGate: boolean;
  rawMentionsGate: boolean;
}

function collectAuditStepBlocks(file: FileTarget): AuditStepBlock[] {
  let doc: unknown;
  try {
    doc = YAML.parseDocument(file.text, {}).contents;
  } catch {
    return [];
  }
  const steps: StepRunInfo[] = [];
  collectStepRuns(file.text, doc, steps);
  return steps.map((step) => {
    const raw = file.text.slice(step.runRange[0], step.runRange[1]);
    const block = normalizeRunBlock(raw, step.runRange[0], step.style);
    const gate = findGateStatement(block.statements);
    return {
      step,
      block,
      gate,
      certifiableGate: step.style !== "other" && gate !== undefined,
      rawMentionsGate: isGateCommand(raw),
    };
  });
}

/**
 * `continue-on-error` findings for one gate step: checked on the step
 * itself and on its enclosing job (see `StepRunInfo.jobContinueOnError`).
 * Flags any value that is not literally `false` (boolean `false` or the
 * string `"false"`): a literal `true`, the string `"true"`, or an
 * unresolved `${{ ... }}` expression (which parses as a plain string and
 * cannot be evaluated statically) is not provably `false`, so all three
 * are treated the same. A step- or job-level `if:` that would actually
 * prevent the gate step from running is out of this rule's reach and is
 * not checked here (documented in the README as a limitation).
 */
function continueOnErrorFindings(step: StepRunInfo): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const check = (
    coe: ScalarWithRange | undefined,
    scope: "the gate step" | "the gate step's enclosing job",
  ) => {
    if (!coe) return;
    if (coe.value === false || coe.value === "false") return;
    const rendered =
      typeof coe.value === "string" ? coe.value : String(coe.value);
    findings.push({
      offset: coe.range[0],
      matched: `continue-on-error: ${rendered}`,
      message: `\`continue-on-error\` on ${scope} is set to \`${rendered}\`, which cannot be proven false: the job may stay green regardless of the \`npm audit --audit-level=...\` gate's exit status.`,
    });
  };
  check(step.continueOnError, "the gate step");
  check(step.jobContinueOnError, "the gate step's enclosing job");
  return findings;
}

function makeAuditViolation(
  rule: Rule,
  file: FileTarget,
  offset: number,
  matched: string,
  message: string,
): Violation {
  const start = offsetToLineCol(file.text, offset);
  return {
    ruleId: rule.id,
    pack: rule.pack,
    severity: rule.defaultSeverity,
    path: file.path,
    line: start.line,
    column: start.column,
    message,
    rationale: rule.rationale,
    matched,
  };
}

const MISSING_GATE_MESSAGE =
  "No certifiable npm-audit gate command was found in this audit workflow: no `run:` step's normalised shell statements invoke `npm audit` with `--audit-level=low`, `--audit-level=moderate`, `--audit-level=high`, or `--audit-level=critical`. Text inside a here-doc body is data, not a command, and a `run:` scalar that is not a literal block scalar (`|`) or a single-line plain scalar is not analysed as shell text, so neither counts as a present gate. (This rule only recognises `npm audit`; a `pnpm audit` or a non-npm audit command is out of its scope, see the README.)";

const auditGateMissing: Rule = {
  id: "workflow-slop/audit-gate-missing",
  pack: "workflow-slop",
  defaultSeverity: "block",
  enabledByDefault: true,
  rationale:
    'A fleet sweep added a two-step audit.yml to several repos: a non-blocking report step, then a `npm audit --audit-level=high` (or `critical`) gate step that fails the job on a HIGH/CRITICAL advisory. The cheapest way to lose that protection is to remove the gate step, or to move the gate command somewhere the shell never runs it. This rule reports an `audit.yml`/`audit.yaml` in which no step invokes `npm audit --audit-level=low|moderate|high|critical` in a statement that actually runs: a gate command sitting only in a comment, only inside a here-doc body, or only in a `run:` scalar style this pack does not analyse as shell text (a folded `>` block, a multi-line or quoted scalar) does not count as a present gate. `moderate`/`low` are stronger gates than `high`/`critical` and also count. Scoped to `npm audit`: a `pnpm audit`, a non-npm audit command, or a reusable-workflow-call audit.yml with no `run:` step reports as missing rather than being silently skipped; disable this one rule per repo via `rules: { "workflow-slop/audit-gate-missing": { enabled: false } }`.',
  appliesTo: isAuditWorkflowFile,
  check(ctx: RuleContext): Violation[] {
    const { file } = ctx;
    const blocks = collectAuditStepBlocks(file);
    if (blocks.some((entry) => entry.certifiableGate)) return [];
    return [
      makeAuditViolation(auditGateMissing, file, 0, "", MISSING_GATE_MESSAGE),
    ];
  },
};

const SHAPE_MESSAGE_TAIL =
  "A gate step must match one of the recognised shapes (`R-bare`: the gate command alone, no tail; `R-classify`: `set +e`, the gate, `VAR=$?`, `set -e`, then an `exit` of a non-zero literal and an `exit` of the captured status) or an exact template registered in `workflow.auditGateTemplates`.";

function shapeViolationMessage(
  reason: string,
  digest: string | undefined,
  signal: string | undefined,
): string {
  const parts = [
    `Unrecognised npm-audit gate shape in this audit workflow: ${reason}.`,
    SHAPE_MESSAGE_TAIL,
  ];
  if (digest) {
    parts.push(
      `No registered template matches this block; its normalised statements hash to sha256 ${digest}.`,
    );
  }
  if (signal) parts.push(`Detected neutralisation signal: ${signal}.`);
  return parts.join(" ");
}

const auditGateShape: Rule = {
  id: "workflow-slop/audit-gate-shape",
  pack: "workflow-slop",
  defaultSeverity: "block",
  enabledByDefault: true,
  rationale:
    "The npm-audit gate step in a fleet audit.yml can be kept in place and still be made harmless: `|| true` on the gate line, a `set +e` with no verdict afterward, a `continue-on-error: true` on the step or its job, a pipeline whose exit status is `tee`'s rather than the gate's. Enumerating those patterns leaks in the false-clean direction, because the next bash construct nobody listed scans green, so this rule inverts the question: a gate step is reported unless its normalised run block matches a recognised SHAPE (`R-bare`: exactly the gate command, no tail, no redirection; `R-classify`: exactly one `set +e`, the gate strictly inside the window, at most one `VAR=$?` capture, the gate optionally piped only into `tee` with `set -o pipefail` set earlier, then a `set -e` restore followed by an `exit` of a non-zero literal and an `exit` of the captured status, with no `exit 0`), or matches an exact template the consuming repo registered in `workflow.auditGateTemplates`. The normaliser refuses to certify a block carrying a construct it does not model (a here-doc, a function definition, `eval`, a backgrounded command, an unbalanced quote, a command substitution spanning a statement separator, a `run:` scalar that is not a literal block scalar or a single-line plain scalar) and reports the reason. A `continue-on-error` on the gate step or its enclosing job that cannot be proven `false` is reported too. This is an allowlist, so a legitimate unmodelled gate step is a false positive by design: register it as a template, use `# slop-detector:disable-line=workflow-slop/audit-gate-shape` for a reviewed exception, or disable the rule per repo via `rules: { \"workflow-slop/audit-gate-shape\": { enabled: false } }`.",
  appliesTo: isAuditWorkflowFile,
  check(ctx: RuleContext): Violation[] {
    const { file, config } = ctx;
    const blocks = collectAuditStepBlocks(file);
    const gateSteps = blocks.filter(
      (entry) =>
        entry.certifiableGate ||
        (entry.step.style === "other" && entry.rawMentionsGate),
    );
    const violations: Violation[] = [];
    for (const entry of gateSteps) {
      for (const finding of continueOnErrorFindings(entry.step)) {
        violations.push(
          makeAuditViolation(
            auditGateShape,
            file,
            finding.offset,
            finding.matched,
            finding.message,
          ),
        );
      }
      const offset = entry.gate
        ? statementOffsetAt(entry.gate, 0)
        : entry.step.runRange[0];
      const matched = entry.gate ? entry.gate.trimmed : entry.step.styleLabel;

      // 1. An unanalysable `run:` scalar style refuses before anything
      //    else, template included: the statement list of a folded or
      //    quoted scalar is not what bash runs, so it must not be
      //    hashed against a template either.
      if (entry.step.style === "other") {
        violations.push(
          makeAuditViolation(
            auditGateShape,
            file,
            offset,
            matched,
            shapeViolationMessage(
              `the gate step's \`run:\` value is ${entry.step.styleLabel}, not a literal block scalar (\`|\`) or a single-line plain scalar`,
              undefined,
              undefined,
            ),
          ),
        );
        continue;
      }
      const gate = entry.gate;
      if (!gate) continue;

      // 2. A registered template is an exact, operator-vouched match and
      //    short-circuits every shape check, including the lexical
      //    refusals (the fleet's canonical gate block defines shell
      //    functions, which no shape models).
      if (matchingTemplate(entry.block.statements, config) !== undefined) {
        continue;
      }
      const digest = (config.workflow?.auditGateTemplates ?? []).length
        ? templateDigest(entry.block.statements)
        : undefined;

      // 3. A construct the normaliser does not model: the statement list
      //    cannot be trusted, so no shape may be tried against it.
      if (entry.block.refusal) {
        violations.push(
          makeAuditViolation(
            auditGateShape,
            file,
            offset,
            matched,
            shapeViolationMessage(entry.block.refusal, digest, undefined),
          ),
        );
        continue;
      }

      // 4. The shape allowlist. A block with no `set +e` is judged as an
      //    `R-bare` candidate and one with a `set +e` as an `R-classify`
      //    candidate, so the reported reason is the one that names the
      //    shape the author was actually reaching for.
      const opensWindow = entry.block.statements.some(
        (statement) => parseSetStatement(statement.trimmed).disablesErrexit,
      );
      const attempt = opensWindow
        ? tryClassifyShape(entry.block.statements, gate)
        : tryBareShape(entry.block.statements, gate);
      if (attempt.ok) continue;
      violations.push(
        makeAuditViolation(
          auditGateShape,
          file,
          offset,
          matched,
          shapeViolationMessage(
            attempt.reason,
            digest,
            neutralisationSignal(entry.block.statements, gate),
          ),
        ),
      );
    }
    return violations;
  },
};

// ─────────────────────────── pack export ───────────────────────────

export const workflowSlopPack: PackDefinition = {
  id: "workflow-slop",
  description:
    "GitHub Actions workflow injection and CI-guard regressions: a `${{ ... }}` expression interpolated directly into a `run:` shell script (unless one of the documented non-attacker-controllable contexts), a reintroduced Node-20 action major, an audit.yml with no certifiable npm-audit gate, and an npm-audit gate step whose shape is not one this pack recognises. Off by default; opt in via `--pack workflow-slop` or `packs.workflow-slop: true`.",
  rules: [
    unparseableWorkflow,
    runExpression,
    node20ActionMajor,
    auditGateMissing,
    auditGateShape,
  ],
};
