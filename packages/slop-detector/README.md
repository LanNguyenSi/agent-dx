# slop-detector

Configurable AI-slop linter for PRs and committed content: catches leaked tool-call XML wrappers, em dashes in user-facing prose, hedging openers, marketing adjectives, and doubled summary headings.

Part of [agent-dx](https://github.com/LanNguyenSi/agent-dx), playbooks and tooling for teams shipping with AI agents.

## Overview

Agents leave fingerprints in committed text: leaked `</result>` artefacts from MCP serialisation, em dashes and hedging openers in prose, empty marketing adjectives, and doubled `## Summary` blocks. None of these are caught by tests, typecheck, or a reviewer under load, so they accumulate. slop-detector turns the recognisable ones into a deterministic linter for pre-commit, CI, or a directory scan, so slop is caught at commit time instead of months later. The first real run against a sampled org's merged PR bodies found real violations, mostly em dashes and auto-appended agent-harness footers, across a majority of the sample, with zero false positives.

## Key features

- Eight rule packs, 47 rules total: `agent-tics` and `prose-slop` on by default, six more opt-in (`comment-slop`, `code-slop`, `ui-slop`, `placement-slop`, `workflow-slop`, `review-slop`).
- CLI (`slop-detector check`), stdio MCP server (`slop-detector-mcp`), and a programmatic API (`checkPath` / `checkFiles` / `checkText`).
- Per-line and per-pack disable comments, JSON output, and a `--explain` mode.
- `workflow-slop` catches GitHub Actions expression injection into `run:` steps and executed action inputs; `placement-slop` catches org-, machine-, and time-bound evidence leaking into reusable instruction files.

## Install / quick start

Requires Node.js 20 or newer (`engines.node` in `package.json`). Not yet published to npm (the bare `slop-detector` name is an unrelated package), so run it from a local build of this monorepo:

```bash
git clone https://github.com/LanNguyenSi/agent-dx
cd agent-dx
cd packages/slop-detector && npm install && npm run build && cd ../..

# alias the local CLI for this shell; the examples below use the bare `slop-detector` command
alias slop-detector="node $PWD/packages/slop-detector/dist/cli.js"
```

Without the alias, invoke the built CLI directly: `node packages/slop-detector/dist/cli.js check README.md`.

## Usage

```bash
# scan a path (file or directory)
slop-detector check packages/

# scan stdin (use in pre-commit pipes)
git diff --cached --name-only | xargs cat | slop-detector check --stdin-path PR_BODY.md

# only run a specific pack, and see why a rule fires
slop-detector check . --pack agent-tics --explain
```

Run `slop-detector list-rules` for the full rule catalogue with severities and rationales. See [What a run looks like](docs/integration.md#what-a-run-looks-like) for sample output.

## Documentation

- [Rule pack reference](docs/rule-packs.md): the full pack table, plus `ui-slop` and `placement-slop` worked examples.
- [workflow-slop rule pack](docs/workflow-slop.md): GitHub Actions expression-injection and CI-guard rules, worked examples, scope and limitations.
- [review-slop rule pack](docs/review-slop.md): run-local review-token rules, in depth.
- [Configuration reference](docs/configuration.md): full `slop.config.yml` schema, severity overrides, the "Path pattern anchor" rule (and its migration note), the cross-file corpus pre-pass, and per-line opt-out.
- [Integration reference](docs/integration.md): sample output, the scan pipeline, pre-commit/CI recipes, the MCP server, exit codes, and the roadmap.
- [CHANGELOG.md](CHANGELOG.md): release notes from 0.3.1 on.

## Development

```bash
npm install
npm run build       # tsc -> dist/
npm test            # vitest run
npm run typecheck
npm run format:check
```

This repository also runs a dedicated `review-guard` CI job: it builds this package and runs `node packages/slop-detector/dist/cli.js check . --pack review-slop --config slop.config.yml` against the whole repository.

## License

MIT, see [LICENSE](../../LICENSE) at repo root.
