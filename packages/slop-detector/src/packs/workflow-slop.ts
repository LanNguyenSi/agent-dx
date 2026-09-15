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
 * when its own containing mapping also carries a `uses:` key, the shape
 * GitHub Actions requires for a step that names an action to run
 * (`isUsesStep` below, computed once per mapping from that mapping's own
 * `items`, before the loop that walks them). A job, a step, or any other
 * mapping key can be *named* `with` without being a `uses:` step's input
 * block; gating on the name alone let such a mapping (e.g. a job literally
 * called `with`) silence every `run:` in its entire subtree.
 */
function collectRunScalars(
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
 * Every distinct expression body (trimmed, as written between `${{` and
 * `}}`) found inside a `run:` scalar in `file`, regardless of whether this
 * pack's allowlist treats it as safe. Used only by
 * `findUnmatchedAllowExpressions` below, kept separate from
 * `runExpression.check` because it needs the full set of expression texts
 * (allowed and flagged alike), not just the ones that end up as
 * violations.
 */
function collectExpressionTexts(file: {
  path: string;
  text: string;
}): Set<string> {
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
  for (const scalar of runScalars) {
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
    for (const expr of collectExpressionTexts(file)) seen.add(expr);
  }
  return extra.filter((e) => !seen.has(e));
}

const runExpression: Rule = {
  id: "workflow-slop/run-expression",
  pack: "workflow-slop",
  defaultSeverity: "block",
  enabledByDefault: true,
  rationale:
    "GitHub substitutes `${{ ... }}` expressions into the `run:` text before the shell ever parses it. When the expression's value is attacker-influenced (a PR title, a branch/tag name, a step output derived from either), a crafted value breaks out of its intended argument position and the job — often holding write or publish permissions — executes it. The fix is the same every time: assign the value to an `env:` variable and reference it as `$NAME` in the script, where the shell treats it as inert data instead of program text.",
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
    return violations;
  },
};

// ─────────────────────────── pack export ───────────────────────────

export const workflowSlopPack: PackDefinition = {
  id: "workflow-slop",
  description:
    "GitHub Actions workflow injection: a `${{ ... }}` expression interpolated directly into a `run:` shell script, where the expression is not one of the documented non-attacker-controllable contexts. Off by default; opt in via `--pack workflow-slop` or `packs.workflow-slop: true`.",
  rules: [unparseableWorkflow, runExpression],
};
