# slop-detector

Configurable AI-slop linter for PRs and committed content. Catches the recognisable tells of agent-generated text: leaked tool-call XML wrappers, em-dashes in user-facing prose, hedging openers, marketing adjectives, doubled summary headings.

Part of [agent-dx](https://github.com/LanNguyenSi/agent-dx), playbooks and tooling for teams shipping with AI agents.

## Why

Agents leave fingerprints. Some are objectively wrong: `</result>` artefacts from MCP serialisation, doubled `## Summary` blocks. Others are stylistic tells the team has already decided to avoid: em-dashes in prose, `It is important to note` openers, empty marketing adjectives. This package turns those rules into a deterministic linter you can run in pre-commit, in CI, or against a directory tree.

## Install

```bash
npm install --save-dev slop-detector
# or run ad-hoc
npx slop-detector check README.md
```

## Quick start

```bash
# scan a path (file or directory)
npx slop-detector check packages/

# scan stdin (use in pre-commit pipes)
git diff --cached --name-only | xargs cat | npx slop-detector check --stdin-path PR_BODY.md

# only run a specific pack
npx slop-detector check . --pack agent-tics

# see why a rule fires
npx slop-detector check . --explain

# JSON output for tooling
npx slop-detector check . --format json
```

## Rule packs

Each pack groups related rules. Enable or disable per repo via `slop.config.yml`.

| Pack | Default | Catches |
|------|---------|---------|
| `agent-tics` | on | Stray `</result>` / `</invoke>` tags, auto-appended Claude Code footers, doubled Summary headings, template TODO placeholders |
| `prose-slop` | on | Em-dashes in prose, hedging openers, empty marketing adjectives, signature LLM idioms like `delve into`, `tapestry of`, `leverage the power of` |
| `comment-slop` | off | JSDoc on trivial getters, comments that restate the next line, orphan markers (`// removed`, `// kept for backcompat`), comment-heavier-than-body helpers, ASCII banner dividers |
| `code-slop` | off | try/catch around code that cannot throw, default values on required-typed params, empty/rethrow catches, async without await, backcompat shims for unreleased APIs |
| `ui-slop` | off (M3) | Visual tells of AI-generated UIs, modeled on [impeccable.style/slop](https://impeccable.style/slop/) |

Run `npx slop-detector list-rules` for the full rule catalogue with severities and rationales.

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
```

Defaults applied even without a config: `agent-tics` and `prose-slop` packs on; `comment-slop`, `code-slop`, `ui-slop` off; ignores cover `node_modules`, `dist`, `build`, `coverage`, `.git`, lockfiles.

## Per-line opt-out

Disable on a single line:

```md
This sentence has a deliberate em-dash — and it stays. <!-- slop-detector:disable-line=prose-slop/em-dash -->
```

Or scope by pack:

```md
<!-- slop-detector:disable-next-line=agent-tics -->
</result> a real example for the docs
```

`slop-detector:disable-line` and `slop-detector:disable-next-line` accept either a rule id, a pack id, or no argument (disables every rule on that line).

## Pre-commit recipe (Husky)

```jsonc
// package.json
{
  "scripts": {
    "slop": "slop-detector check ."
  },
  "husky": {
    "hooks": {
      "pre-commit": "npm run slop"
    }
  }
}
```

For a faster, staged-files-only variant pair with [lint-staged](https://github.com/okonet/lint-staged):

```jsonc
{
  "lint-staged": {
    "*.md": "slop-detector check"
  }
}
```

## CI usage

```yaml
- name: Slop check
  run: npx slop-detector check . --format json > slop-report.json
```

A dedicated GitHub Action with PR annotations is planned for M3.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | No `block`-severity violations. `warn` and `info` are reported but do not fail the run. |
| 1 | At least one `block`-severity violation. |
| 2 | CLI invocation error (missing config, unreadable path). |

## Roadmap

- M1: `agent-tics` + `prose-slop` packs, CLI, config loader, per-line disables.
- M2 (this release): `comment-slop` + `code-slop` packs (TypeScript AST via `@typescript-eslint/parser`). Both off by default; opt in via config or `--pack`. Within-file analysis only; cross-file rules (unused exports, single-callsite helpers) are tracked as a separate task.
- M3: `ui-slop` pack, GitHub Action, optional LLM-judged heuristic rules.

Track progress at [agent-dx](https://github.com/LanNguyenSi/agent-dx) issues and tasks.

## License

MIT, see [LICENSE](../../LICENSE) at repo root.
