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

// ─────────────────────────── audit-gate-shape ───────────────────────────

const AUDIT_WORKFLOW_FILE_RE = /(^|\/)\.github\/workflows\/audit\.ya?ml$/;

function isAuditWorkflowFile(file: FileTarget): boolean {
  const normalized = file.path.split("\\").join("/");
  return AUDIT_WORKFLOW_FILE_RE.test(normalized);
}

type ScalarWithRange = { value: unknown; range: [number, number, number] };

interface StepRunInfo {
  runRange: [number, number, number];
  continueOnError?: ScalarWithRange;
  /**
   * The `continue-on-error:` of this step's *enclosing job* (the
   * `jobs.<job_id>` mapping, identified by its own `steps:` key), when
   * present — GitHub Actions honours `continue-on-error` at the job level
   * too, not just per-step, so a step-level check alone misses a job that
   * stays green regardless of what any of its steps (including the gate)
   * exit.
   */
  jobContinueOnError?: ScalarWithRange;
}

/**
 * Every `run:`-carrying step mapping in the document, together with that
 * same step's `continue-on-error:` sibling and its enclosing job's
 * `continue-on-error:` (see `StepRunInfo.jobContinueOnError`), when
 * present. Unlike `collectRunScalars` (which only needs the scalar node),
 * this rule also needs the *step's* other keys, so it collects at the
 * mapping level: any mapping with a `run:` key not inside a `uses:` step's
 * `with:` input block (same schema-position gating as `collectRunScalars`,
 * for the same reason: a custom action can name an input `run`) is
 * treated as a step. `jobContinueOnError` is threaded down from the
 * nearest enclosing mapping that itself carries a `steps:` key (a job
 * mapping), not reset by `with:` gating since a job's own
 * `continue-on-error:` is never inside any step's `with:` block.
 */
function collectStepRuns(
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
      out.push({
        runRange: runPair.value.range,
        continueOnError,
        jobContinueOnError: effectiveJobCoE,
      });
    }
  }
  for (const item of node.items) {
    if (isPairNode(item)) {
      const keyName = scalarKeyName(item.key);
      collectStepRuns(
        item.value,
        out,
        insideWith || (isUsesStep && keyName === "with"),
        effectiveJobCoE,
      );
    } else {
      collectStepRuns(item, out, insideWith, effectiveJobCoE);
    }
  }
}

// `moderate`/`low` are STRONGER gates than `high`/`critical` (npm's
// `--audit-level` sets the *minimum* severity that fails the command, so a
// lower threshold fails on strictly more advisories), so they count as a
// recognised gate too. Scoped to `npm audit` only (see `isGateCommand`
// below): a `pnpm audit --audit-level=high` or a non-npm audit command
// (`pip-audit`, `cargo audit`) is out of this rule's reach, documented in
// the README rather than guessed at here.
const AUDIT_GATE_RE = /--audit-level=(low|moderate|high|critical)\b/;

function isGateCommand(raw: string): boolean {
  return /\bnpm\s+audit\b/.test(raw) && AUDIT_GATE_RE.test(raw);
}

// ─────────────────────── run-block normalisation ───────────────────────
//
// One normalisation step stands between a gate step's raw `run:` source
// slice and every check in this rule: `normalizeRunBlock` below. No check
// reads the raw block text any more. Before it existed the analysis was
// comment-blind and quote-blind, and each of those was a bypass: a
// `#`-commented `exit $STATUS` satisfied the non-zero-verdict
// requirement, a comment merely naming `--audit-level=high` moved the
// gate boundary so the `set +e` half never ran at all, a gate command
// written only inside a comment counted as a present gate, and a
// `set +e` inside an `echo "..."` string was flagged as a real one.

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
 * One shell statement cut out of a normalized logical line at an
 * unquoted `;`, `&&`, `||` or `|` boundary. `line` is the logical line it
 * came from, kept because the `||` and `; true`/`; :` tail checks are
 * defined over the gate's whole logical line rather than one statement;
 * `indexInLine` is this statement's first character inside `line.text`.
 */
interface NormalizedStatement {
  text: string;
  line: NormalizedLine;
  indexInLine: number;
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

/**
 * Which quoting contexts a match may start in. Rather than blanking every
 * quoted span for every search, this follows the shell:
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
 * order. `re` need not be global; a non-global pattern is recompiled with
 * the flag rather than mutated.
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
 * `raw` (a `run:` scalar's raw source slice) as comment-free logical
 * lines: a physical line ending in a backslash is joined onto the next
 * one (the trailing backslash itself is dropped, nothing else inserted,
 * matching bash's own backslash-newline removal), so a gate command's
 * `||`/`;` tail written on a continuation line is inspected as part of
 * the logical line it actually runs on; then the joined line's trailing
 * shell comment is stripped. `baseOffset` is `raw`'s own start offset in
 * the full file text, so every recorded offset is an absolute file offset
 * usable for a violation location.
 */
function normalizeLogicalLines(
  raw: string,
  baseOffset: number,
): NormalizedLine[] {
  const lines: NormalizedLine[] = [];
  const pushLine = (joined: string, joinedOffsets: number[]) => {
    const commentFree = stripTrailingComment(joined);
    lines.push({
      text: commentFree,
      offsets: joinedOffsets.slice(0, commentFree.length),
      lineIndex: lines.length,
    });
  };
  let offset = baseOffset;
  let joined = "";
  let joinedOffsets: number[] = [];
  let continuing = false;
  for (const physical of raw.split("\n")) {
    const stripped = physical.endsWith("\r") ? physical.slice(0, -1) : physical;
    const continues = stripped.endsWith("\\");
    const keep = continues ? stripped.length - 1 : stripped.length;
    for (let i = 0; i < keep; i++) {
      joined += stripped[i];
      joinedOffsets.push(offset + i);
    }
    if (continues) {
      continuing = true;
    } else {
      pushLine(joined, joinedOffsets);
      joined = "";
      joinedOffsets = [];
      continuing = false;
    }
    offset += physical.length + 1;
  }
  if (continuing) pushLine(joined, joinedOffsets);
  return lines;
}

/**
 * `line` cut into statements at every unquoted `;`, `&&`, `||` or `|`
 * boundary, so "before the gate command" and "after the gate command"
 * are decided on real command boundaries instead of raw character
 * distance. Whitespace-only pieces are dropped (a comment-only line
 * strips to one), so a statement list only ever holds real commands.
 */
function splitStatements(line: NormalizedLine): NormalizedStatement[] {
  const contexts = quoteContexts(line.text);
  const pieces: Array<{ start: number; end: number }> = [];
  let start = 0;
  let i = 0;
  while (i < line.text.length) {
    if (contexts[i] !== "bare") {
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
    pieces.push({ start, end: i });
    i += separatorLength;
    start = i;
  }
  pieces.push({ start, end: line.text.length });
  return pieces
    .map((piece) => ({
      text: line.text.slice(piece.start, piece.end),
      line,
      indexInLine: piece.start,
    }))
    .filter((statement) => statement.text.trim().length > 0);
}

/**
 * The single input every `audit-gate-shape` check consumes: one `run:`
 * block's raw source slice turned into comment-free shell statements
 * (see the section header above for what each bypass looked like before
 * this existed).
 */
function normalizeRunBlock(
  raw: string,
  baseOffset: number,
): NormalizedStatement[] {
  const statements: NormalizedStatement[] = [];
  for (const line of normalizeLogicalLines(raw, baseOffset)) {
    statements.push(...splitStatements(line));
  }
  return statements;
}

/**
 * True when `statement` runs before (respectively after) `gate` in the
 * same normalized block: an earlier (later) logical line, or an earlier
 * (later) statement on the gate's own logical line. Ordered by
 * `lineIndex`/`indexInLine` rather than by position in the statement
 * array, so the comparison says what it means independently of how the
 * array was assembled.
 */
function runsBeforeGate(
  statement: NormalizedStatement,
  gate: NormalizedStatement,
): boolean {
  if (statement.line.lineIndex !== gate.line.lineIndex) {
    return statement.line.lineIndex < gate.line.lineIndex;
  }
  return statement.indexInLine < gate.indexInLine;
}

function runsAfterGate(
  statement: NormalizedStatement,
  gate: NormalizedStatement,
): boolean {
  if (statement.line.lineIndex !== gate.line.lineIndex) {
    return statement.line.lineIndex > gate.line.lineIndex;
  }
  return statement.indexInLine > gate.indexInLine;
}

/**
 * The first comment-free statement in a normalized block that actually
 * invokes the npm-audit gate command. This, not a search over the raw
 * block text, is what decides whether a step is a gate step at all: a
 * `# TODO: restore npm audit --audit-level=high` line is a comment, not
 * a gate.
 */
function findGateStatement(
  statements: NormalizedStatement[],
): NormalizedStatement | undefined {
  return statements.find((statement) => isGateCommand(statement.text));
}

function blockHasGateCommand(statements: NormalizedStatement[]): boolean {
  return findGateStatement(statements) !== undefined;
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

interface AuditFinding {
  offset: number;
  matched: string;
  message: string;
}

/**
 * A post-gate `exit` that actually converts a captured status into a
 * non-zero step exit: either a literal nonzero exit code (`exit 1`,
 * `exit 2`), or `exit` of a captured variable (`exit $STATUS`,
 * `exit "$STATUS"`, `exit ${STATUS}`, `exit $?`). Presence of `$?` and
 * `set -e` alone is not enough: a step can capture the status, restore
 * strict mode, and then only ever `exit 0` or merely `echo` it, which
 * still lets the step succeed. This regex is deliberately permissive
 * about *which* variable is exited (not just `STATUS`): the point is
 * that some captured value is actually handed to `exit`, not that this
 * rule can prove that value is always nonzero at runtime.
 */
const NONZERO_EXIT_VERDICT_RE =
  /\bexit\s+(?:[1-9]\d*\b|"?\$\{?(?:STATUS|[A-Za-z_][A-Za-z0-9_]*|\?)\}?"?)/;

const SET_PLUS_E_RE = /\bset\s+\+e\b/;
const SET_MINUS_E_RE = /\bset\s+-e\b/;
const STATUS_CAPTURE_RE = /\$\?/;
const OR_OPERATOR_RE = /\|\|/g;
// Not end-anchored (`; true ; echo done` is still caught mid-line), only
// boundary-checked so it does not fire inside a longer token (`; truest`).
const TAIL_NOOP_RE = /;\s*(true|:)(?=[\s;]|$)/;

/**
 * Every neutralisation signal found in one gate step's `run:` block,
 * given that block's normalized statements (`normalizeRunBlock`): every
 * check below reads comment-free, quote-aware text, never the raw block.
 * The caller has already confirmed the block carries the `npm audit
 * --audit-level=(low|moderate|high|critical)` gate command in a real
 * statement (`blockHasGateCommand`).
 *
 * `set +e` is only flagged when it precedes the gate command AND the
 * statements after the gate command do *not* all three of: capture the
 * gate's exit status (`$?`), restore `set -e`, AND convert that captured
 * status into a non-zero step exit (`NONZERO_EXIT_VERDICT_RE` above) —
 * the shape a legitimate "classify the gate's own exit code" step uses
 * (see the canonical audit.yml fixture in this pack's tests/README):
 * `set +e`, run the gate command, `STATUS=$?`, `set -e`, then
 * `exit $STATUS` (or an equivalent nonzero exit) on a failing status.
 * Capturing and restoring alone is not enough: `set +e; ...; STATUS=$?;
 * set -e; exit 0` (or an echo-only branch that never exits nonzero) still
 * surfaces nothing. A bare `set +e` with no
 * capture-and-restore-and-verdict afterward is the actual neutralisation
 * this half of the rule exists to catch.
 *
 * The `||` and `; true`/`; :` checks run on the part of the gate's own
 * logical line that comes *after* the gate command, so text before it
 * (`cd api; true && npm audit --audit-level=high`) is never read as a
 * tail on the gate.
 */
function checkGateNeutralization(
  statements: NormalizedStatement[],
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const gate = findGateStatement(statements);
  if (!gate) return findings;
  const gateFlag = gate.text.match(AUDIT_GATE_RE);
  const gateEndInStatement = gateFlag
    ? (gateFlag.index ?? 0) + gateFlag[0].length
    : gate.text.length;

  const setPlusE = (() => {
    for (const statement of statements) {
      if (!runsBeforeGate(statement, gate)) continue;
      const hit = firstUnquoted(statement.text, SET_PLUS_E_RE, "command");
      if (hit) return { statement, index: hit.index };
    }
    return undefined;
  })();
  if (setPlusE) {
    const after = [
      gate.text.slice(gateEndInStatement),
      ...statements
        .filter((statement) => runsAfterGate(statement, gate))
        .map((statement) => statement.text),
    ];
    const capturesStatus = after.some((text) =>
      firstUnquoted(text, STATUS_CAPTURE_RE, "expansion"),
    );
    const restoresStrict = after.some((text) =>
      firstUnquoted(text, SET_MINUS_E_RE, "command"),
    );
    const convertsToNonzeroExit = after.some((text) =>
      firstUnquoted(text, NONZERO_EXIT_VERDICT_RE, "command"),
    );
    if (!capturesStatus || !restoresStrict || !convertsToNonzeroExit) {
      findings.push({
        offset: statementOffsetAt(setPlusE.statement, setPlusE.index),
        matched: "set +e",
        message:
          !capturesStatus || !restoresStrict
            ? "`set +e` appears before the `npm audit --audit-level=...` gate command in this run block without both capturing its exit status (`$?`) and restoring `set -e` afterward, so a failing gate no longer fails the step."
            : "`set +e` appears before the `npm audit --audit-level=...` gate command in this run block; the exit status is captured (`$?`) and `set -e` is restored, but nothing afterward turns that captured status back into a non-zero step exit (no `exit <nonzero>` / `exit $STATUS` verdict), so a failing gate no longer fails the step.",
      });
    }
  }

  const gateLine = gate.line;
  const tailStart = gate.indexInLine + gateEndInStatement;

  for (const m of unquotedMatches(
    gateLine.text,
    OR_OPERATOR_RE,
    "command",
    tailStart,
  )) {
    const rest = gateLine.text.slice(m.index + 2).trimStart();
    if (!/^(exit|false|return)\b/.test(rest)) {
      findings.push({
        offset: lineOffsetAt(gateLine, m.index),
        matched: gateLine.text.slice(m.index, m.index + 12).trimEnd(),
        message:
          "`||` appears after the `npm audit --audit-level=...` gate command on its logical line, and the right-hand side is not `exit`/`false`/`return`: a failing gate no longer fails the step.",
      });
      break;
    }
  }

  const tailNoop = firstUnquoted(
    gateLine.text,
    TAIL_NOOP_RE,
    "command",
    tailStart,
  );
  if (tailNoop) {
    findings.push({
      offset: lineOffsetAt(gateLine, tailNoop.index),
      matched: tailNoop.match.trim(),
      message:
        "The gate line contains `; true` or `; :` after the `npm audit --audit-level=...` gate command: a neutralisation attempt that is ineffective under the runner's `bash -e` today (the step still fails on a nonzero gate exit), but becomes effective the moment a `set +e` is added earlier in this run block.",
    });
  }

  return findings;
}

/**
 * `continue-on-error` findings for one gate step: checked on the step
 * itself and on its enclosing job (see `StepRunInfo.jobContinueOnError`).
 * Flags any value that is not literally `false` (boolean `false` or the
 * string `"false"`): a literal `true`, the string `"true"`, or an
 * unresolved `${{ ... }}` expression (which parses as a plain string and
 * cannot be evaluated statically) is not provably `false`, so all three
 * are treated the same — a step- or job-level `if:` that would actually
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

const auditGateShape: Rule = {
  id: "workflow-slop/audit-gate-shape",
  pack: "workflow-slop",
  defaultSeverity: "block",
  enabledByDefault: true,
  rationale:
    'A fleet sweep added a two-step audit.yml to several repos: a non-blocking report step, then a `npm audit --audit-level=high` (or `critical`) gate step that fails the job on a HIGH/CRITICAL advisory. Nothing stops a later edit from quietly removing the protection while keeping the job green, for example dropping the gate step, appending `|| true`, or flipping `continue-on-error: true` on it. This rule flags an `audit.yml`/`audit.yaml` with no recognised `npm audit --audit-level=low|moderate|high|critical` run step at all (`moderate`/`low` are stronger gates than `high`/`critical` and also count; scoped to `npm audit` only, not `pnpm audit` or a non-npm audit command), and flags a gate step whose command is neutralised: a `||` after the gate command (on its own logical line, joined across a backslash continuation) whose right-hand side is not `exit`/`false`/`return`; a `set +e` before the gate command with no matching exit-status capture, `set -e` restore, AND a resulting non-zero exit verdict afterward; `continue-on-error: true` (or any value not provably `false`, including an unresolved `${{ }}` expression) on the gate step or its enclosing job; or a gate line containing `; true`/`; :` after the gate command. Deliberately conservative: it can still flag a legitimate `|| echo "logged"` on the gate line itself, which is fine as false positives go for a security gate; use a `slop-detector:disable-line` comment for a reviewed exception, or disable the rule entirely per repo via `rules: { "workflow-slop/audit-gate-shape": { enabled: false } }` (e.g. a non-npm audit workflow this rule cannot evaluate).',
  appliesTo: isAuditWorkflowFile,
  check(ctx: RuleContext): Violation[] {
    const { file } = ctx;
    let doc: unknown;
    try {
      doc = YAML.parseDocument(file.text, {}).contents;
    } catch {
      return [];
    }
    const steps: StepRunInfo[] = [];
    collectStepRuns(doc, steps);
    // Every step's run block goes through the one normalisation step
    // (`normalizeRunBlock`) before any check, including the check that
    // decides whether the step is a gate step at all.
    const stepBlocks = steps.map((step) => ({
      step,
      statements: normalizeRunBlock(
        file.text.slice(step.runRange[0], step.runRange[1]),
        step.runRange[0],
      ),
    }));
    const gateSteps = stepBlocks.filter((entry) =>
      blockHasGateCommand(entry.statements),
    );

    if (gateSteps.length === 0) {
      return [
        makeAuditViolation(
          auditGateShape,
          file,
          0,
          "",
          "No recognised npm-audit gate command was found in this audit workflow: no `run:` step invokes `npm audit` with `--audit-level=low`, `--audit-level=moderate`, `--audit-level=high`, or `--audit-level=critical`, so the gate never fails the job on a matching advisory. (This rule only recognises `npm audit`; a `pnpm audit` or a non-npm audit command is out of its scope, see the README.)",
        ),
      ];
    }

    const violations: Violation[] = [];
    for (const { step, statements } of gateSteps) {
      for (const finding of checkGateNeutralization(statements)) {
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
      for (const finding of continueOnErrorFindings(step)) {
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
    }
    return violations;
  },
};

// ─────────────────────────── pack export ───────────────────────────

export const workflowSlopPack: PackDefinition = {
  id: "workflow-slop",
  description:
    "GitHub Actions workflow injection and CI-guard regressions: a `${{ ... }}` expression interpolated directly into a `run:` shell script (unless one of the documented non-attacker-controllable contexts), a reintroduced Node-20 action major, and a neutralised or missing npm-audit gate in audit.yml. Off by default; opt in via `--pack workflow-slop` or `packs.workflow-slop: true`.",
  rules: [
    unparseableWorkflow,
    runExpression,
    node20ActionMajor,
    auditGateShape,
  ],
};
