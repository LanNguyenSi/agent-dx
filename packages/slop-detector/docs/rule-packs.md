# Rule pack reference

Each pack groups related rules; enable or disable a pack per repo via `slop.config.yml`. See the [README](../README.md) for the quick-start commands.

| Pack                       | Default                                 | Catches                                                                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-tics` (7 rules)     | on                                      | Stray `</result>` / `</invoke>` tags, auto-appended Claude Code footers, doubled Summary headings, template TODO placeholders                                                                                                                                              |
| `prose-slop` (7 rules)     | on                                      | Em-dashes in prose, hedging openers, empty marketing adjectives, signature LLM idioms like `delve into`, `tapestry of`, `leverage the power of`                                                                                                                            |
| `comment-slop` (5 rules)   | off, opt in via `--pack`                | JSDoc on trivial getters, comments that restate the next line, orphan markers (`// removed`, `// kept for backcompat`), comment-heavier-than-body helpers, ASCII banner dividers                                                                                           |
| `code-slop` (9 rules)      | off, opt in via `--pack`                | try/catch around code that cannot throw, defaults on required-typed params, empty / rethrow catches, `async` without `await`, backcompat shims for unreleased APIs, phantom imports of undeclared packages, stub function bodies, unused exports, single-callsite helpers  |
| `ui-slop` (6 rules)        | off, opt in via `--pack ui-slop`        | Gradient text, purple+cyan AI palettes, animated layout properties, skipped heading levels, plus opt-in monospace-everywhere and flat type hierarchy (info-level). Scans CSS / SCSS / LESS / HTML / JSX.                                                                   |
| `placement-slop` (5 rules) | off, opt in via `--pack placement-slop` | Org-, machine-, and point-in-time-bound evidence leaking into reusable instruction files (`SKILL.md`, `AGENTS.md`, `CLAUDE.md`, agent/skill prompt files): home paths, dated evidence, tally phrases (`n=8`, `p=0.016`, `so far`), opaque ids, and configured org markers. <!-- slop-detector:disable-line=placement-slop --> |
| `workflow-slop` (5 rules)  | off, opt in via `--pack workflow-slop`  | GitHub Actions workflow injection and CI-guard regressions: a `${{ ... }}` expression interpolated directly into a `run:` shell script or into a `with:` input a listed action executes as code (`actions/github-script`'s `script`, at minimum), unless it is one of the documented non-attacker-controllable contexts; a fail-closed check that a scanned workflow file actually parsed as YAML; a reintroduced Node-20 GitHub Actions major; an `audit.yml` with no certifiable `npm audit --audit-level=...` gate; and an npm-audit gate step whose shape is not one the pack recognises. Scans `.github/workflows/*.yml`/`*.yaml`. |
| `review-slop` (3 rules)    | off, opt in via `--pack review-slop`    | Run-local review tokens leaking into reusable content: finding ids (`F1`, `F2a`, or a severity-letter id like `M1`/`H2a` when the same sentence also carries a review-process word), round references (`round 2`, `R3`, `review round 1 fixes`), and workspace-handoff phrases (`per the <workspace> handoffs`). Scans Markdown, TypeScript/JavaScript source comments, test titles, and a commit-message file. |

The six opt-in packs (`comment-slop`, `code-slop`, `ui-slop`, `placement-slop`, `workflow-slop`, `review-slop`) are off by default because their false-positive surface in mixed codebases is wider; opt in with `--pack <id>` or set `packs.<id>: true` in `slop.config.yml`.

Run `slop-detector list-rules` for the full rule catalogue with severities and rationales.

## `ui-slop` (M3 v1) by example

Opt in with `--pack ui-slop`. Examples that trip the four default-on rules:

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
```

The two off-by-default info rules (`ui-slop/monospace-everywhere`, `ui-slop/flat-type-hierarchy`) need an explicit `rules.<id>.enabled: true` in `slop.config.yml` or a CLI override; they remain off because both have legitimate counter-uses (technical-product landing pages, mature design systems with subtle steps).

Known v1 limitations (tracked as M3 follow-ups):

- Tailwind class strings like `bg-gradient-to-r from-purple-500 to-cyan-500` are not detected; only literal CSS / hex / hsl in style declarations.
- JSX inline `style={{ background: 'linear-gradient(...)' }}` literals are not scanned for rules 1-3 (only `ui-slop/skipped-heading-levels` walks JSX).
- Vue / Svelte single-file-component `<style>` blocks are detected as `markup`, so CSS-shape rules don't fire on them; extract the styles or scope a separate `.css` file.
- `@media`-wrapped top-level selectors are not walked recursively by `ui-slop/monospace-everywhere`.
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
See agent-tasks task 7f38899d for the write-up.

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
