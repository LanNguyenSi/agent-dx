# Rule pack reference

Each pack groups related rules; enable or disable a pack per repo via `slop.config.yml`. See the [README](../README.md) for the quick-start commands.

| Pack                       | Default                                 | Catches                                                                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-tics` (7 rules)     | on                                      | Stray `</result>` / `</invoke>` tags, auto-appended Claude Code footers, doubled Summary headings, template TODO placeholders                                                                                                                                              |
| `prose-slop` (7 rules)     | on                                      | Em-dashes in prose, hedging openers, empty marketing adjectives, signature LLM idioms like `delve into`, `tapestry of`, `leverage the power of`                                                                                                                            |
| `comment-slop` (5 rules)   | off, opt in via `--pack`                | JSDoc on trivial getters, comments that restate the next line, orphan markers (`// removed`, `// kept for backcompat`), comment-heavier-than-body helpers, ASCII banner dividers                                                                                           |
| `code-slop` (9 rules)      | off, opt in via `--pack`                | try/catch around code that cannot throw, defaults on required-typed params, empty / rethrow catches, `async` without `await`, backcompat shims for unreleased APIs, phantom imports of undeclared packages, stub function bodies, unused exports, single-callsite helpers  |
| `ui-slop` (10 rules)       | off, opt in via `--pack ui-slop`        | Gradient text, purple+cyan AI palettes, animated layout properties, skipped heading levels, removed focus outlines, zoom-disabling viewport meta, `<img>` without `alt`, lorem ipsum filler, plus opt-in monospace-everywhere and flat type hierarchy (info-level). Scans CSS / SCSS / LESS / HTML / JSX.                                                                   |
| `placement-slop` (5 rules) | off, opt in via `--pack placement-slop` | Org-, machine-, and point-in-time-bound evidence leaking into reusable instruction files (`SKILL.md`, `AGENTS.md`, `CLAUDE.md`, agent/skill prompt files): home paths, dated evidence, tally phrases (`n=8`, `p=0.016`, `so far`), opaque ids, and configured org markers. <!-- slop-detector:disable-line=placement-slop --> |
| `workflow-slop` (6 rules)  | off, opt in via `--pack workflow-slop`  | GitHub Actions workflow injection and CI-guard regressions: a `${{ ... }}` expression interpolated directly into a `run:` shell script or into a `with:` input a listed action executes as code (`actions/github-script`'s `script`, at minimum), unless it is one of the documented non-attacker-controllable contexts; a fail-closed check that a scanned workflow file actually parsed as YAML; a fail-closed report of a `<<` merge key or an unresolvable alias, which the pack cannot read through; a reintroduced Node-20 GitHub Actions major; an `audit.yml` with no certifiable `npm audit --audit-level=...` gate; and an npm-audit gate step whose shape is not one the pack recognises. Scans `.github/workflows/` workflow files, plus `action.yml`/`action.yaml` for the `run:` and executed-input scan, `node20-action-major` and the parse rules. |
| `review-slop` (3 rules)    | off, opt in via `--pack review-slop`    | Run-local review tokens leaking into reusable content: finding ids (`F1`, `F2a`, or a severity-letter id like `M1`/`H2a` when the same sentence also carries a review-process word), round references (`round 2`, `R3`, `review round 1 fixes`), and workspace-handoff phrases (`per the <workspace> handoffs`). Scans Markdown, TypeScript/JavaScript source comments, test titles, and a commit-message file. |

The six opt-in packs (`comment-slop`, `code-slop`, `ui-slop`, `placement-slop`, `workflow-slop`, `review-slop`) are off by default because their false-positive surface in mixed codebases is wider; opt in with `--pack <id>` or set `packs.<id>: true` in `slop.config.yml`.

Run `slop-detector list-rules` for the full rule catalogue with severities and rationales.

## `ui-slop` (M3 v1) by example

Opt in with `--pack ui-slop`. Examples that trip the default-on rules:

```css
/* ui-slop/gradient-text */
.headline {
  background: linear-gradient(90deg, #7c3aed, #06b6d4);
  -webkit-background-clip: text;
  color: transparent;
}

/* ui-slop/ai-color-palette */
.hero {
  background: radial-gradient(circle, hsl(270, 70%, 50%), hsl(185, 80%, 50%));
}

/* ui-slop/animate-layout-properties */
@keyframes grow {
  from {
    width: 100px;
  }
  to {
    width: 200px;
  }
}
.panel {
  transition: height 0.3s ease;
}
```

```html
<!-- ui-slop/skipped-heading-levels -->
<section>
  <h1>Title</h1>
  <h3>Subtitle</h3>
  <!-- skipped h2 -->
</section>

<!-- ui-slop/viewport-zoom-disabled -->
<meta name="viewport" content="width=device-width, user-scalable=no" />

<!-- ui-slop/img-missing-alt -->
<img src="hero.png" />

<!-- ui-slop/lorem-ipsum-placeholder (one finding per file) -->
<p>Lorem ipsum dolor sit amet</p>
```

```css
/* ui-slop/focus-outline-removed */
button:focus {
  outline: none;
}
```

The four newer rules work like this:

- `ui-slop/focus-outline-removed` flags `outline: none` / `0` on a top-level `:focus` or `:focus-visible` rule unless the same block sets a replacement indicator: `box-shadow`, `background`, `background-color`, `background-image`, a `border` shorthand or colour / style longhand, `text-decoration`, `text-decoration-line` or `text-decoration-color`, with a value that actually paints. A value of `none`, `0`, `transparent`, `initial` or `unset` does not count, and neither do a width on its own (`border-width`), the other `text-decoration-*` longhands (`-thickness`, `-skip-ink`, ...), `border-radius*`, `border-collapse`, `border-image*` or `background-size`. `outline-color` / `outline-offset` do not count because the outline itself is removed, and a block whose last `outline` / `outline-style` declaration is visible is not flagged. A `:focus` block is also skipped when a `:focus-visible` block for the same base selector keeps an indicator. Both selectors have the same specificity, so the later block wins for a property both set: a `:focus-visible` block after the removal excuses it with a visible outline (one that paints: a value with `none`, `hidden`, `transparent`, `0`, `initial`, `unset`, `inherit` or `revert` does not count, a `var(...)` value does) or a replacement indicator, one before it only with a replacement indicator the `:focus` block does not reset (an earlier outline is overridden by the removal, an earlier `box-shadow` is not, unless the `:focus` block sets `box-shadow: none` or a shorthand such as `border: 0` over `border-color`). `:focus:not(:focus-visible)` is exempt.
- `ui-slop/viewport-zoom-disabled` flags `user-scalable=no|0` or `maximum-scale=1` in a viewport `<meta>` (markup and JSX).
- `ui-slop/img-missing-alt` flags a lowercase `<img>` with no `alt` (`alt=""` passes; a `{...spread}` is skipped because it may carry `alt`, a Svelte `{alt}` shorthand counts, and `alt` is matched as a case-insensitive attribute name, including `:alt`, `v-bind:alt`, `bind:alt`, `[alt]` and `[attr.alt]`, so `title="an alt text"` does not count). An `<img` inside a terminated `<!-- -->` comment in a markup file is skipped; an unterminated `<!--` skips nothing. JS and JSX comments are not skipped (see the limitations below).
- `ui-slop/lorem-ipsum-placeholder` flags `lorem ipsum` in markup or JSX, once per file. It also fires on stories and fixtures that use the filler on purpose; exclude those with path ignores.

The two off-by-default info rules (`ui-slop/monospace-everywhere`, `ui-slop/flat-type-hierarchy`) need an explicit `rules.<id>.enabled: true` in `slop.config.yml` or a CLI override; they remain off because both have legitimate counter-uses (technical-product landing pages, mature design systems with subtle steps).

Known v1 limitations (tracked as M3 follow-ups):

- Tailwind class strings like `bg-gradient-to-r from-purple-500 to-cyan-500` are not detected; only literal CSS / hex / hsl in style declarations.
- JSX inline `style={{ background: 'linear-gradient(...)' }}` literals are not scanned for rules 1-3 (`ui-slop/skipped-heading-levels` walks JSX markup, and the viewport, `img-missing-alt` and lorem-ipsum rules scan JSX text).
- Vue / Svelte single-file-component `<style>` blocks are detected as `markup`, so CSS-shape rules don't fire on them; extract the styles or scope a separate `.css` file.
- `@media`-wrapped top-level selectors are not walked recursively by `ui-slop/monospace-everywhere` or `ui-slop/focus-outline-removed`.
- `ui-slop/focus-outline-removed` does not see SCSS nested `&:focus` blocks or `:focus` rules nested in `@media`; the `:focus-visible` sibling lookup compares whole selector strings, so selector lists are matched as written. A `:focus` reset of an earlier replacement is recognised for the same property, its shorthand, or one of its longhands set to `none`, `0`, `transparent`, `initial` or `unset` (`border-width: 0` over an earlier `border`); a longhand that changes the indicator to another painting value is not treated as a reset. A later `:focus-visible` outline is judged by its last `outline` / `outline-style` declaration only, so a following `outline-width: 0` or `outline-color: transparent`, or a transparent colour spelled `#0000` / `rgba(0,0,0,0)`, still counts as visible.
- `ui-slop/img-missing-alt` does not mask JS or JSX comments, in `.tsx` / `.jsx` files or in `<script>` bodies, so an `<img>` mentioned in a JS or JSX comment is reported; suppress it with the usual ignore mechanism (a `slop-detector:disable-line` comment, see [Per-line opt-out](configuration.md#per-line-opt-out), or a path ignore). In markup, a `<!--` inside a quoted attribute value or a `<script>` / `<style>` body is still taken as a comment start, so a tag between it and the next `-->` is not scanned. A tag whose end cannot be found is skipped and the scan continues with the next `<img`.
- `transition: all` is flagged, but `animation: <name>` referencing a `@keyframes` outside the same file is not cross-resolved.

## `placement-slop` by example

Opt in with `--pack placement-slop`. Every rule below only looks at
instruction files: by default that means `SKILL.md`, `AGENTS.md`,
`CLAUDE.md`, and Markdown under `.claude/agents/`, `.opencode/agents/`,
`.claude/skills/`. The same content in, say, `README.md` never fires
under the built-in defaults; a repo can widen the set with
`placement.instructionGlobs` (below).

A monorepo with many package READMEs is a common case worth widening
for: a package README is exactly as reusable and exactly as
leak-prone as a `SKILL.md`, and nothing in the built-in defaults
covers it.

```yaml
placement:
  instructionGlobs:
    - "packages/*/README.md"
```

```markdown
<!-- placement-slop/home-path (block) -->
<!-- slop-detector:disable-next-line=placement-slop -->
Set `API_TOKEN` from `/home/alice/work/project/.env` before running the sweep.

<!-- placement-slop/dated-evidence + placement-slop/tally-phrase (warn) -->
<!-- slop-detector:disable-next-line=placement-slop -->
As of 2026-08-24 (n=8), the low tier reached accept a median 320 seconds slower, p=0.016, so prefer the default tier.

<!-- placement-slop/opaque-id (warn) -->
<!-- slop-detector:disable-next-line=placement-slop -->
See agent-tasks task 0badc0de for the write-up.

<!-- placement-slop/org-marker (block), with placement.markers: ["example-org"] -->

Run the example-org rescan before merging.
```

Every rule reports the durable instruction it thinks should replace the evidence-bound line, not just what tripped: a home path should become repo-relative, a dated measurement should become the standing rule it justified, an opaque id should become a link or be dropped, and an org marker should either be genericized or explicitly allow-listed.

`home-path`, `dated-evidence`, `opaque-id`, and `tally-phrase` skip matches inside an `http(s)://`/`www.` URL or a markdown link target (`](...)`), so a path segment, a date, a hex id, or a `?n=8`/`?p=0.016`-shaped query parameter that's part of a real link isn't leaked evidence. `home-path` also treats an angle-bracket placeholder (`/Users/<name>/`, `/home/<user>/`) as already-generic and doesn't flag it. A real account name in a path (`/home/node/app`, a container convention) still fires: telling a genuine machine-bound path apart from a container-convention one isn't a clean heuristic, so it's still flagged, add a disable comment for that line if it's a false positive in your repo, or a `placement.allow` entry to excuse the marker span itself. <!-- slop-detector:disable-line=placement-slop -->

`placement.allow` is the escape hatch for a span that legitimately carries a marker, e.g. an install URL:

```yaml
# slop.config.yml
packs:
  placement-slop: true

placement:
  markers:
    - "example-org"
  allow:
    - "github\\.com/example-org/"
```

With that config, `install from https://github.com/example-org/kit` does not fire `org-marker` (the `allow` pattern matches the URL span), while a bare `example-org` mention elsewhere in the file still does.

An `allow` match only excuses the span it actually matched, across every rule in the pack, including `block`-severity ones like `home-path` and `org-marker`: it is not a whole-line escape hatch. A home path, a date, or a tally phrase elsewhere on the same line as an allowed URL still fires, since it falls outside the span the `allow` pattern matched. An `allow` span also never crosses a line break, so a phrase wrapped across one (e.g. a tally phrase split by a line wrap) cannot be excused by `allow`; use a per-line disable comment for that case instead. To silence a single rule (or a single occurrence) instead, use a per-line disable comment: `<!-- slop-detector:disable-line=placement-slop/home-path -->` or `<!-- slop-detector:disable-next-line=placement-slop -->` (see [Per-line opt-out](configuration.md#per-line-opt-out)).
