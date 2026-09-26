# Configuration reference

Full `slop.config.yml` schema, severity overrides, the path-pattern anchor rule, the cross-file corpus pre-pass, and the per-line disable comments. See the [README](../README.md) for the quick-start commands.

## Severity model

Each rule has a default severity:

- `block`: exits non-zero in CLI, fails pre-commit / CI checks. Reserved for objectively-wrong patterns (stray XML tags).
- `warn`: surfaced but does not fail. Default for stylistic rules.
- `info`: listed but treated as advisory. Used for rules that have legitimate counter-examples.

Promote any rule to `block` (or downgrade to `info`) per repo:

```yaml
# slop.config.yml
rules:
  prose-slop/em-dash:
    severity: block
  agent-tics/claude-code-footer:
    enabled: false
```

## Configuration

```yaml
# slop.config.yml
packs:
  agent-tics: true
  prose-slop: true
  comment-slop: false

rules:
  prose-slop/em-dash:
    severity: block
  prose-slop/redundant-note:
    enabled: true

ignorePaths:
  - "**/vendor/**"
  - "docs/legal/**"

treatAsProse:
  - "**/CHANGELOG.md"
  - "**/templates/*.txt"

treatAsCode:
  - "**/Dockerfile.*"

placement:
  markers:
    - "example-org"
  instructionGlobs:
    - "**/PLAYBOOK.md"
  allow:
    - "github\\.com/example-org/"

workflow:
  allowExpressions:
    - "matrix.node"

review:
  allow:
    - "R1"
  allowPaths:
    - "**/CHANGELOG.md"
```

Defaults applied even without a config: `agent-tics` and `prose-slop` packs on; `comment-slop`, `code-slop`, `ui-slop`, `placement-slop`, `workflow-slop`, `review-slop` off; ignores cover `node_modules`, `dist`, `build`, `coverage`, `.git`, lockfiles; `placement.markers`, `placement.instructionGlobs`, `placement.allow`, `workflow.allowExpressions`, `workflow.node20Majors`, `workflow.node20MajorsIgnore`, `workflow.auditGateTemplates`, and `workflow.executedActionInputs` default to `[]`; `review.allow` defaults to `[]` and `review.allowPaths` defaults to `["**/CHANGELOG.md"]` (see [the review-slop docs](review-slop.md)).

## Path pattern anchor

One rule, for every path pattern family in the config: when a `--config`/`configPath` is given AND the checked target lies inside that config file's own directory, every path pattern is matched against the target's path made relative to the config file's directory. Without that containment each family keeps its own pre-existing resolution, and those differ from one another, so the table below states both columns per family rather than one rule for all six:

| config key | target inside the `--config` file's directory | otherwise (no `--config` given, or a target outside its directory) |
| --- | --- | --- |
| `review.allowPaths` | the scanned file's path relative to the config file's directory | the scanned file's path relative to the scan root: a directory target is its own scan root, a single-file target's scan root is its parent directory |
| `placement.instructionGlobs` | the scanned file's path relative to the config file's directory | the scanned file's path relative to the same scan root `review.allowPaths` uses |
| `entrypointGlobs` | the scanned file's path relative to the config file's directory | the scanned file's path relative to the same scan root `review.allowPaths` uses |
| `ignorePaths` | the candidate path relative to the config file's directory | the candidate path exactly as spelled on the command line: the target as it was typed, plus each walked directory and file name joined onto it |
| `treatAsProse` | the scanned file's path relative to the config file's directory | the scanned file's path exactly as spelled on the command line |
| `treatAsCode` | the scanned file's path relative to the config file's directory | the scanned file's path exactly as spelled on the command line |

**Stdin:** a `--stdin-path` value the caller actually gave (and an MCP `slop_check` `filename` the caller actually gave) is the target path for both the containment decision and the patterns above; without one (absent or empty) there is no named target, so the working directory never decides WHETHER the input is anchored: it is not, and it takes the right-hand column. In that column `review.allowPaths` and `placement.instructionGlobs` fall back to the nearest directory holding a `package.json`, walking up from the directory of the named value, from the process working directory when no value was given, and from one level above it for an explicitly empty value, since `path.resolve("")` is the working directory itself (and failing that, `process.cwd()`), so for unnamed input the scan root still depends on where the command runs, exactly as before the anchor existed; `treatAsProse`/`treatAsCode` match the target path exactly as spelled: the named value, the placeholder when nothing was named (`input.md` for MCP `text`, `<stdin>` for the CLI), or the empty string for an explicitly empty value. Two families never apply to stdin or MCP `text` at all: `entrypointGlobs`, since those branches build no corpus, and `ignorePaths`, since the content is scanned directly rather than reached by walking a directory.

**Symlinks:** containment is decided with `path.resolve` alone, never `fs.realpathSync`, for the target and for the `--config` path alike, so a config spelled through a symlink anchors to the symlink's own directory (a target spelled through that same symlink is inside it; the identical file spelled through the real directory is not) and a symlinked target is judged by the path it was spelled with rather than by where it points.

**Library callers:** `CheckOptions.scanRoot` drives the first three families and the optional `CheckOptions.configAnchor` drives the other three, so a direct caller of `checkPath`/`checkFiles`/`checkText` has to set both (to the config file's directory) to get the anchored behaviour, and gets the as-spelled matching of the bottom three rows whenever it leaves `configAnchor` unset.

This is what makes `check <file> [<file>...] --config slop.config.yml` judge each named file exactly as `check . --config slop.config.yml` judges it, from the same working directory: a root-anchored pattern (e.g. `packages/foo/README.md`) still matches when `packages/foo/README.md` is scanned as an explicit file argument instead of being reached by walking `.`. All four entry points, the CLI's file/directory branch, the CLI's `--stdin-path` branch, and the MCP `slop_check` tool's `path` and `text` branches, derive the anchor through the same helper (`resolvePatternAnchor` in `src/util/pattern-anchor.ts`), so a root-anchored pattern reads the same way from any of them. It also means an out-of-tree or central `--config` (one whose directory does not contain the scanned target, for example `check . --config ../shared/slop.config.yml`, or an absolute path to a config outside the scan) leaves every pattern family in the right-hand column: pointing at a shared config from inside a subdirectory does not retroactively move the anchor to that config's own directory, so a directory scan's own verdict is never affected by an out-of-tree `--config`.

**Migration note:** a directory or file target that lies below the config file's own directory now resolves every pattern relative to that config directory, not relative to the target itself. A pattern written relative to a scanned subdirectory (for example `entrypointGlobs: ["src/index.ts"]` meant relative to that subdirectory, while `--config` lives at the repo root) stops matching once `--config` is given; rewrite it relative to the config file's directory instead (`packages/my-pkg/src/index.ts`).

The `placement` block only matters once `placement-slop` is enabled (see [`placement-slop` by example](rule-packs.md#placement-slop-by-example)):

- `markers`: regex patterns (compiled as given, no implicit `i` flag) naming this org's own handles, products, or paths: each match is a `placement-slop/org-marker` violation. Empty by default, so the rule never fires until you configure it. A pattern that would match the empty string (e.g. `"a*"`) is rejected at config-load time, and matching runs per line with a 50-violations-per-file cap, so a runaway or pathological pattern can't blow up the output. These are repo-authored regexes, evaluated by the linter itself, not by an external process.
- `instructionGlobs`: additive glob patterns, on top of the pack's built-in instruction-file globs (`SKILL.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/agents/**`, `.opencode/agents/**`, `.claude/skills/**`); this only ever widens the built-in set, it can't narrow it. Matched against each scanned file's path relative to the anchor described in [Path pattern anchor](#path-pattern-anchor) below. A pattern must not start with `/`, same restriction as `entrypointGlobs`, and a leading `./` is normalized away. A pattern that matches zero scanned files is surfaced in `CheckSummary.warnings`, same mechanism as an unmatched `entrypointGlobs` pattern.
- `allow`: regex patterns (also rejected at config-load time if they'd match the empty string), matched per line, and only the matched span is excused across every rule in the pack, including `block`-severity ones (the escape hatch for something like a legitimate install URL that carries an org handle). The exclusion is scoped to the matched span, not the whole line: a home path, a date, or a tally phrase elsewhere on the same line as an allowed match still fires. For narrower, single-rule suppression use a per-line disable comment instead (see [Per-line opt-out](#per-line-opt-out) below).

The `workflow` block only matters once `workflow-slop` is enabled (see [`workflow-slop` by example](workflow-slop.md)): `allowExpressions` is an additive list of exact, whitespace-trimmed `${{ ... }}` expression bodies treated as safe on top of the pack's built-in allowlist, consumed by `run-expression`. `node20Majors` (additive) and `node20MajorsIgnore` (subtractive, applied after `node20Majors`) are both lists of exact `owner/repo@vN` entries consumed by `node20-action-major`, on top of the pack's built-in default list. `auditGateTemplates` is a list of `{ name, sha256 }` or `{ name, statements }` entries consumed by `audit-gate-shape`, each registering one exact gate block as recognised (see "Registering a gate template" in [the workflow-slop reference](workflow-slop.md)); an entry carrying neither or both of `sha256`/`statements` is rejected at config-load time. `executedActionInputs` is an additive list of exact `owner/repo:input` entries (no `@ref`; matching is ref-independent) consumed by `run-expression` to decide which `with:` inputs are scanned like `run:` scalars before the ordinary `with:` exemption applies, on top of the pack's built-in default list (see [Executed action inputs](workflow-slop.md#workflow-slop-executed-action-inputs)). All five are empty by default, so none of them widen or narrow what a rule accepts until you configure them.

## Cross-file rules (experimental)

Two `code-slop` rules analyse symbols across all files in the scan root rather than per file. They are **off by default** and require a corpus pre-pass that parses every TypeScript/JavaScript file once before the rule loop runs. The pre-pass also builds an inverted name → referencing-files index, so `unused-export`'s "does any other file use this?" check is an O(1) map lookup per export rather than an O(files) scan repeated for every export in the scan root.

| Rule                               | Default severity | What it finds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code-slop/unused-export`          | warn             | Exported symbols not imported by any other file and not reachable via `package.json` entrypoints (`main`, `bin`, `exports`, or `entrypointGlobs`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `code-slop/single-callsite-helper` | warn             | Named functions/`const`s with a body of at most 3 statements that are called from at most one place in the package (candidates for inlining). Exempts files reachable via an entrypoint, same as `unused-export`: a helper whose only real callers are external to the scan is expected to show a low in-package call count. Precision cost of that exemption: it's file-wide, so a genuinely inlinable one-callsite helper that happens to live in the entrypoint/barrel file is now permanently invisible to this rule, not just the helpers that are actually part of the public API. This also applies to a bare `export *` barrel target, not just `package.json`/`entrypointGlobs` entrypoints (see the blast-radius note in Known limitations below). |

### Enabling the corpus pre-pass

Three equivalent switches, use whichever fits your workflow:

**Environment variable** (one-off or CI step):

```sh
SLOP_CORPUS=1 slop-detector check src/
```

**Config file** (`slop.config.yml`):

```yaml
corpus: true
```

**Programmatic API** (`CheckOptions`):

```ts
import { checkFiles } from "slop-detector";
checkFiles(files, { packs, config, corpusEnabled: true });
```

### Opting individual rules in

Because both rules are `enabledByDefault: false` you must also enable them via `ruleOverrides`:

```yaml
# slop.config.yml
corpus: true # enable the pre-pass

rules:
  code-slop/unused-export:
    enabled: true
  code-slop/single-callsite-helper:
    enabled: true
```

### Marking a src barrel as an entrypoint

`package.json` `main`/`bin`/`exports` fields typically point at compiled output (`dist/index.js`). When the scan targets `src/`, those paths don't resolve to any file in the scan root, so the real `src/` public-API barrel is never recognised as an entrypoint and its re-exports get flagged as unused. Use `entrypointGlobs` to mark it explicitly:

```yaml
# slop.config.yml
corpus: true
entrypointGlobs:
  - "src/index.ts"
```

Patterns are matched against each scanned file's path relative to the anchor described in [Path pattern anchor](#path-pattern-anchor); a bare `checkFiles([...])` call with no `scanRoot` option falls back the same way, to the nearest directory containing a `package.json`, and failing that, `process.cwd()`. A pattern must not start with `/`: that can never match a relative path and is rejected at config-load time. A pattern that matches zero scanned files (a typo, or the wrong root assumption) doesn't fail silently: `checkFiles`'s returned `CheckSummary.warnings` names it. There's no equivalent guard against an _overly broad_ pattern, though: `entrypointGlobs: ["**"]` is valid config that silently exempts every file and reduces both rules to zero output; treat a broad barrel pattern as suspicious paired with the two rules producing nothing.

### Known limitations (v1)

- **Name-only, scope-blind symbol matching.** The corpus matches symbols by identifier name across files, not by import binding or lexical scope. Two unrelated exports with the same name in different files are counted as references to each other (false negative on `unused-export`). A local variable or parameter that shadows an imported/exported name may likewise suppress a violation (false positive suppression). Both re-export forms are handled: a named re-export (`export { x } from "./mod.js"`) counts as a reference to `x`, so the original declaration is no longer flagged, but the re-export statement itself is also tracked as an export _of the barrel file_, so if nothing consumes `x` from the barrel either (and the barrel isn't an entrypoint), the "unused" violation simply moves from the declaration to the barrel rather than disappearing; that's a defensible outcome (the barrel re-export genuinely is the dead surface in that case) but worth knowing when triaging a violation's location. `export * as ns from "./mod.js"` declares a real name (`ns`) on the barrel file and is tracked exactly like a named re-export (same "moves to the barrel" behavior applies to it). A _bare_ `export * from "./mod.js"` (no `as ns`) is different: it declares no trackable name of its own, so instead the whole resolved target file is treated as reachable public API (like a `main`/`entrypointGlobs` entrypoint) rather than tracking which individual symbols the barrel actually forwards (resolving that precisely would mean walking the full re-export graph). **Blast radius of that exemption: it applies to both corpus rules, not just `unused-export`.** A file that's the target of a bare `export *` is fully invisible to `single-callsite-helper` too: a genuinely dead or genuinely inlinable symbol inside it won't be flagged by either rule, not only the ones actually re-exported through the barrel. TypeScript's `export = foo` (CommonJS-style export assignment) is recognised as neither an export nor a reference at all; a file using it will misbehave under both corpus rules. A **non-call** use of an identifier (passing a function by reference, e.g. `arr.map(helperA)`, `setTimeout(helperA)`, `export const onClick = helperA`) is also still not tracked, so a helper consumed only that way can be misflagged as unused or single-callsite. Treat both rules as directional signals to double-check, not ground truth, until these are closed.
- **`buildCorpus` still makes a separate initial pass** over every file before the per-file rule loop runs. Measured on a synthetic 500-file project (median of 7 warmed runs, `code-slop` pack with both corpus rules enabled): `checkFiles` took ~172ms with the corpus pre-pass off and ~343ms with it on: the extra pass costs roughly as much as the rest of the scan combined (about half of corpus-on runtime), several times more than the O(files²)→O(1) lookup this change removed. It exists because `buildCorpus` and the per-file rule loop each construct their own `FileTarget` for the same file, and `parseTsFile`'s cache is a `WeakMap` keyed by that object, so the second pass's parse is always a cache miss, never reused. Unlike the double-parse `code-slop/unused-export` used to do (fixed in this change: it now reads `corpus.exportsByFile` directly instead of re-parsing), this one is structural: threading the corpus's own `FileTarget`s through into the main loop, or keying the parse cache by path+text instead of by object identity, would close it, but that's a `checkFiles`-level change and is an open follow-up, not something fixed here.

## Per-line opt-out

Disable on a single line:

```md
It is important to note that this sentence keeps its hedging opener. <!-- slop-detector:disable-line=prose-slop/hedging-opener -->
```

Or scope by pack:

```md
<!-- slop-detector:disable-next-line=agent-tics -->

</result> a real example for the docs
```

`slop-detector:disable-line` and `slop-detector:disable-next-line` accept either a rule id, a pack id, or no argument (disables every rule on that line).
