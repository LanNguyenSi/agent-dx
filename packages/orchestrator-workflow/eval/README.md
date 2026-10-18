# Reviewer prompt replay evaluation

A repeatable benchmark that answers one question: does a changed (for example
shorter) reviewer prompt keep its behaviour? It replays a reviewer session on
historical changes with a prompt variant and scores the return.

This directory is a maintainer tool. It is not part of the published package:
`package.json` `files` does not list it, `tsconfig.json` does not compile it,
and a test pins both. It runs through `tsx` and is covered by the package
tests (`test/eval-*.test.ts`), which use stubs in place of the `claude` and
`agent-primitives` binaries and never start a model session.

The dataset is not in this repository. It is built from private run records
(briefs name organisation internals), so each maintainer builds their own and
points the tool at it with `--dataset`. Only the format is defined here.

## What is measured

For every dataset entry and one prompt variant the runner starts a headless
reviewer session on an isolated checkout of the reviewed commit and keeps the
final message. The scorer then reports, per variant:

- **Validity**: the final message carries exactly one `yaml` fenced block and
  that block passes the reviewer output contract (mandatory fields and enum
  spellings; the same validator as `validate-review-report`). Deterministic.
- **Recall**: the share of known medium-or-higher defects (entries of kind
  `finding`) that the review reports, decided per defect class by a blind
  judge session. The judge sees the rubric, the known defects and the review
  text with the run's paths replaced by labels (`<worktree>`, `<results>`),
  and nothing that names the variant or the entry.
- **False positives**: medium-or-higher findings reported on entries of kind
  `control` (changes the original review accepted without such a finding). A
  control finding can be a real defect the original review missed, so
  spot-check before reading a difference as a regression.
- **Session failures and timeouts**, counted on their own. Validity, recall and
  false positives use completed sessions only.
- **Cost and duration**: the session's reported USD cost and wall time.
- **Noise**: the same variant run more than once on the same entries; the
  range between repeats is the yardstick for a difference between variants.

Repeats enter every figure as per-entry means, so an entry run three times
weighs as much as one run once.

## Dataset format

A dataset directory holds `index.json` and one JSON file per entry.

```json
{
  "schema": 1,
  "entries": [{ "id": "a-1", "kind": "finding", "file": "entries/a-1.json" }]
}
```

An entry (validated by `eval/dataset.ts`, `validate-dataset` prints every
violation):

| field            | meaning                                                                                                                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`         | `1`                                                                                                                                                                                                                                          |
| `id`             | `[a-z0-9-]`, unique, also the file stem                                                                                                                                                                                                      |
| `kind`           | `finding` (at least one known medium-or-higher defect) or `control` (no known finding)                                                                                                                                                       |
| `repo`           | `name`, `path` (a local repository to fetch from; a relative path is resolved against the dataset directory, so a bare repository kept next to the entries works), `head_sha` and `base_sha` (full 40-character shas), optional `fetch_note` |
| `setup`          | list of `{cwd, argv, timeout_s?}` run inside the checkout (for example `npm ci`); `cwd` stays inside the checkout, `argv` is not a shell string                                                                                              |
| `review_method`  | `normal`, `rigorous` or `adversarial`                                                                                                                                                                                                        |
| `leak`           | how much the briefing points at the known defect: `high`, `partial` or `none` (always `none` for a control)                                                                                                                                  |
| `brief`          | the reviewer briefing text, machine paths replaced by placeholders                                                                                                                                                                           |
| `task_spec`      | the task specification text, inlined (the session has no tracker)                                                                                                                                                                            |
| `known_findings` | for `finding`: `{id: "K<n>", severity, category, description, files?}`; for `control`: empty                                                                                                                                                 |
| `provenance`     | `{source, round, notes?}`; kept in the dataset, never given to a session or the judge                                                                                                                                                        |

Placeholders in `brief` and `task_spec`: `{{WORKTREE}}`, `{{EVIDENCE_DIR}}`,
`{{RUN_DIR}}`, `{{BASE_SHA}}`, `{{HEAD_SHA}}`. The runner replaces them with
the checkout, the session's evidence directory, an empty stand-in for the run
directory and the two shas. Validation rejects a brief or spec that still
contains a home directory path, and the runner refuses a run whose prompt
would name the entry id, the results or dataset tree, or the home directory.

Choose entries whose commits can be rebuilt from a local repository:
`git cat-file -e <sha>^{commit}` succeeds, or the commit was fetched into
`FETCH_HEAD` of that repository once (never into a named ref).

## Running

All commands run from `packages/orchestrator-workflow`. Every session,
the judge's included, authenticates with an API key read from the variable
named by `--api-key-env` (default `ANTHROPIC_API_KEY`); `agent-primitives`
must be on `PATH` (or pass `--guard <bin>`).

```
npm run eval -- validate-dataset --dataset <dir>

npm run eval -- canary --dataset <dir> --out <results> [--scratch <dir>]

npm run eval -- run --dataset <dir> --out <results> --variant current \
  [--scratch <dir>] [--only id,id] [--kind control] [--repeat 2] \
  [--model opus] [--effort high] [--timeout-min 45] [--budget-usd 15] \
  [--max-rss-mib 8192] [--jobs 1] [--no-retry]

npm run eval -- judge   --dataset <dir> --out <results> [--judge-model sonnet] \
  [--judge-effort high]
npm run eval -- score   --dataset <dir> --out <results> [--exclude-leak high]
npm run eval -- compare --dataset <dir> --out <results> --a current --b degraded \
  [--exclude-leak high] [--noise-floor 1]
```

`--scratch` and `--out` must lie outside the dataset's parent directory, and
the scratch directory outside the home directory, outside every temp root and
outside `--out`; the commands refuse otherwise, since the session may read
none of them. The default scratch directory is `/Users/Shared/oe` on macOS;
on any other host `--scratch` is required. The path is deliberately short: a
run's tmp path (`<scratch>/<8 hex>/tmp`) may not exceed 44 bytes less one for
the separator and the bytes of `claude-<uid>` (33 bytes for uid 501), and the
commands refuse a longer `--scratch` (see "Claude Code sandbox" below for why).
They also refuse a scratch directory that is a symbolic link, belongs to
another user, or that the group or others can write; one that does not exist
yet is created with mode 0700.

Run `canary` before every batch and after every Claude Code update (see
Isolation). It exits 0 only when every check passed.

Variants (`--variant`):

- `current`: `assets/agents/reviewer.md` at a git revision (`--rev`, default
  the revision named in `eval/variants.ts`).
- `degraded`: the same file with the whole `Check, at minimum:` list removed
  (from its heading line up to the `Rules:` heading), everything else
  byte-identical. It is the negative control: a benchmark that cannot tell it
  from `current` does not discriminate.
- `file:<path>`: any prompt file, for example a shortened candidate. Give it an
  id with `--variant-id`. A variant id follows the entry id pattern.

Sessions run one after the other by default. `--jobs <n>` runs up to n at
once, each in its own scratch directory; mind the API rate limit and the load,
since every session runs tests in its checkout. Progress lines then arrive in
completion order.

A result directory keeps one folder per variant id; reusing an id for a
different prompt is refused. Every run folder has `result.json` (variant id and
file hash, prompt hash, model, effort, status and failure reason, exit code,
cost, turns, session time, final text, validity, the processes guard and the
sweep killed), the composed `prompt.md`, the raw `session.json`,
`stderr.log`, `setup.log`, `agents.json`, `settings.json`, guard's own
reports under `guard/` and a copy of the session's `evidence/`. A run that
already has a completed `result.json` is skipped unless `--force` is given,
so an interrupted batch resumes; a stored run that did not complete is run
again unless `--no-retry` is given.

`result.json` also records `claude --version` of the binary that ran the
session, and `judge.json` the judge's model, effort and CLI version; `compare`
prints a warning when the two variants differ in any of these or in the
reviewer model or effort.

`judge` writes `judge.json` next to each finding-run result that has none; an
unparseable answer is retried (`--attempts`) and otherwise leaves a
`judge-error.json` and the run unjudged. `score` leaves unjudged runs out of
recall and says how many there are. Runs whose setup failed are excluded from
every tally and counted separately.

### Scoring and comparing

Entries tagged `leak: high` measure whether a reviewer follows a pointer in
its briefing as much as the prompt, so `score` and `compare` leave them out of
the primary result by default and report them in a section of their own.
`--exclude-leak none` keeps every entry; `--exclude-leak high,partial`
leaves out both tags.

Repeat a variant (`--repeat 2` or more; a later `run` with a larger
`--repeat` adds the missing repeats and skips the existing ones) to get its
noise. The noise figures use one fixed set of entries in every repeat: those
with a completed run in every repeat (recall: also judged in every repeat).

`compare` pairs the two variants: each metric is computed for both on exactly
the entries both have values for, from per-entry means over repeats. The
verdict compares the delta with the larger of A's run-to-run range and a
noise floor of `--noise-floor` entries' worth of the metric (default 1, so the
floor is one over the number of paired entries): a zero range from identical
repeats does not make every delta a difference. Each verdict prints the
number of paired entries and the repeats behind A and B. A's range is measured
on single repeats while the delta compares means, which makes the verdict
conservative.

## Isolation

What contains a session:

- **Checkout**: a fresh repository in the run's scratch directory that fetches
  only the head and base commits from the local source, so no later history,
  branch or tag is reachable. The remote is removed again before anything
  runs, and the fetch bookkeeping file is deleted. Nothing is cloned into or
  modified in a shared worktree.
- **Opaque paths**: every run gets `<scratch>/<random id>/` (8 hex characters,
  mode 0700) with `checkout/`, `evidence/`, `run/`, `home/`, `tmp/`, `gh/` and
  `meta/`. No path the session or the judge sees names the variant, the entry
  or the dataset.
- **Environment allowlist** for setup commands and the session alike: `PATH`,
  `LANG`, `LC_*`, `TERM`, `USER`, `LOGNAME`, `SHELL`; `HOME`,
  `CLAUDE_CONFIG_DIR`, `TMPDIR`, `GH_CONFIG_DIR` and the npm cache point into
  the scratch directory (the session's npm cache is `home/.npm`, the setup
  commands share one under the scratch root; the variable is left out rather
  than set to a malformed path); git gets `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_SSH_COMMAND=false` and
  `GIT_TERMINAL_PROMPT=0`. Nothing else of the invoking environment passes:
  no tokens, no agent socket, no session or messaging variables. The API key
  goes to the claude process only, as `ANTHROPIC_API_KEY`, and a
  `sandbox.credentials.envVars` deny entry keeps it out of the session's Bash
  commands (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is never set: it would force
  the permission mode to `default`). A record never holds the key: it is
  redacted if a session prints it.
- **Claude Code sandbox** (a per-run settings file passed with `--settings`;
  each key names its documentation section in `eval/isolation.ts`): Bash
  commands are sandboxed, the session exits if the sandbox cannot start, there
  is no unsandboxed retry and no excluded command. Their network is a strict
  allowlist with no host on it, no Unix socket and no local listening port.
  They cannot read the invoking user's home, the dataset's parent tree, the
  results directory, the source repositories, the other runs' scratch
  directories or the shared temp roots (the system temp directory and `/tmp`),
  and they write only to the checkout, the evidence directory and the run's
  scratch temp directory and home (the session's `TMPDIR` and
  `CLAUDE_CODE_TMPDIR` point at the scratch temp directory, so Claude Code's
  per-user temp directory lies inside the run's scratch). The session's own
  Claude Code config directory (`home/.claude`, its `CLAUDE_CONFIG_DIR`) is
  excepted from the writable home in every path form: user settings there are
  a trusted tier, for example for `sandbox.excludedCommands`, and Claude Code
  reloads a changed settings file. Claude Code 2.1.302 keeps
  `CLAUDE_CODE_TMPDIR` only while `<tmp>/claude-<uid>` fits in 44 bytes (the
  constant `E1r = 44` in its bundled source); over it, it falls back silently
  to `/tmp/claude-<uid>`, which is denied, so every sandboxed command fails on
  Claude Code's own working-directory file. The limit for
  `<scratch>/<8 hex>/tmp` is therefore 44 bytes less one for the separator and
  the bytes of `claude-<uid>`: 33 bytes for uid 501, which matches the
  measurements (a 38 byte tmp path fell back, 31 and 29 bytes worked). The
  placement check computes it for the current uid and refuses a longer
  `--scratch`; the default `/Users/Shared/oe` gives 29.
- **Settings sources**: every session (reviewer, canary and judge) runs with
  `--setting-sources ""`, so Claude Code loads no user, project or local
  settings file (not the scratch config directory's, not a
  `.claude/settings.json` in the reviewed checkout); the per-run file passed
  with `--settings` and managed policy still apply. The empty list also turns
  off project memory and instruction files: no `CLAUDE.md`, `AGENTS.md`,
  `.claude/rules` or project skill of the checkout is loaded, in either mode.
  The project source stays off on purpose, because the checkout is writable
  and project settings could carry hooks; a replay that needs a project
  instruction file carries it inside the briefing instead.
- **Scratch location**: the file-tool deny rules below cover the home
  directory and the temp roots, and a deny rule always wins over an allow
  entry, so a checkout inside either would be unreadable to its own session.
  The scratch directory therefore lives outside both: `/Users/Shared/oe`
  by default on macOS, `--scratch` elsewhere. `TMPDIR` and
  `CLAUDE_CODE_TMPDIR` still point into the run's own scratch directory.
- **File tools**: Read and Edit deny rules cover the invoking user's home,
  the dataset's parent tree, the results directory and the source
  repositories, the shared temp roots in every path form, the run's `meta/`
  directory and its Claude Code config directory. Read deny rules also cover
  `meta/`, `evidence/` and `home/` of every run under the scratch root, as
  `<scratch>/*/meta` and so on, which includes this run's own evidence and
  home: the session reaches those through Bash. Edit rules cover only `meta/`
  there, because Claude Code 2.1.302 also turns Edit deny rules into sandbox
  write denials, which win over the writable directories, while Edit, Write
  and NotebookEdit are disallowed anyway. The
  `permissions.blockReadsOutsideWorkingDirectories` setting is not used: with
  the sandbox enabled it hangs Claude Code 2.1.302 before the first tool call.
  File edits, subagents, web tools and every tool that reaches another session, a
  remote service, a schedule or a notification are disallowed; inbound
  messages from other sessions are refused, and in the default bare mode the
  session binds no inbox socket at all. No MCP server is configured.
- **Processes**: setup commands and the session each run under
  `agent-primitives guard <timeout-s> <max-rss-MiB>`, which kills the whole
  process tree at the wall-clock bound or the memory cap (`--max-rss-mib`,
  default 8192) and reports what was left running. Afterwards every process
  still working inside the run's scratch directory is killed as well, which
  catches a descendant that left its process group between two of guard's
  samples. Both counts go into `result.json`.
- The scratch directory is deleted after each run (`--keep-checkout` keeps
  it); records stay in the results directory.

What it does not contain:

- **Setup commands** (`npm ci` and the like) run outside the Claude Code
  sandbox, with network, because they need the package registry; only the
  environment allowlist, the scratch home and guard apply. Dependency install
  scripts run there with the user's file access.
- **The claude process itself** runs unsandboxed and needs the network for
  its API calls. The file tools are held by permission rules, which Claude
  Code applies to Grep and Glob as a best effort, not by the operating system.
- **Other runs' checkouts while `--jobs` is above 1**: the Read tool (and Grep
  and Glob) can still read another run's `checkout/` and its scratch `tmp/`
  under the same scratch root, if the session learns that run's 8 hex id;
  only Bash is denied there. A run's prompt, evidence and home are covered
  (see "File tools" above). With the default `--jobs 1` no other run exists.
- **Settings keys are not validated**: in `-p` mode a settings file Claude
  Code does not accept is ignored without an error. The `canary` command is
  the proof that the settings took effect; run it again after a Claude Code
  update.
- **The canary's report is partly self-reported**: the host itself checks the
  touch target, that no settings file appeared in the session's config
  directory, the checkout write, the evidence and home writes, the node
  version, the permission mode and that no record holds a secret; whether ssh,
  the file reads, curl and the Read tool failed (or, on the session's own
  checkout, worked) comes from the session's own answer. The read probes
  target sentinel files with random content that the host plants under the
  home directory, the temp root and another run directory under the scratch
  root just before the session and deletes after it, so a read that worked
  shows up as a leak. Every credential-looking variable name the session
  prints fails the canary, except a name the sandbox itself injects (its proxy
  password and the git configuration it passes through the environment) that
  the runner's own environment does not hold. An action the session declined
  to attempt makes the canary inconclusive, never a pass.
- The sandbox runs on macOS, Linux and WSL2; on Linux it needs `bubblewrap`
  and `socat`. Some network keys (`allowUnixSockets`, `allowLocalBinding`)
  only apply on macOS, where the session's tests also cannot start a local
  server.
- The session runs with `--permission-mode bypassPermissions` so the reviewer
  can run tests in the checkout without prompts, and with
  `--permission-prompts none`, so anything that would still prompt is denied
  instead of waiting; the containment above is what limits it, not the
  permission mode. A session whose stderr says Claude Code forced the
  permission mode to `default` is recorded as failed and fails the canary.

## Deviations from the production route

In production the reviewer is a subagent started by an orchestrator session;
its definition is the installed copy of `assets/agents/reviewer.md` with model,
effort and tool restrictions from the routing selection. The replay is the
closest headless equivalent, not an identical one:

- The prompt body is passed as an agent definition (`--agents <file> --agent
reviewer`) and runs as the main thread of its own session, with the
  briefing on stdin. It is not spawned through the Agent tool of a parent
  session.
- Model and effort come from flags (`--model`, `--effort`), not from the
  agent frontmatter. The result records the values passed; check the raw
  `session.json` for the model the session reports.
- The project instruction files a production subagent would see
  (`CLAUDE.md`, `AGENTS.md`, rules, project skills) are absent in both modes,
  because every session runs with `--setting-sources ""` (see Settings
  sources). `--bare` (default; `--no-bare` omits it) also skips hooks, plugin
  sync and auto-memory; without `--bare`, managed-policy hooks and plugin sync
  run and the session binds an inbox socket (inbound messages are still
  refused). The home directory stays the scratch one in both modes, and both
  authenticate with the API key.
- The sandbox, the deny rules and the reduced environment above are not part
  of the production route: a command that needs the network or a file outside
  the checkout fails in the replay where it could succeed in production.
- No MCP servers (the production reviewer may have a tracker or code-search
  server), and the subagent, web and cross-session tools are denied.
- Run files named by the briefing (other briefs, evidence, run notes, tracker
  pages) do not exist. The runner appends a fixed paragraph that says so and
  that missing run files are not findings; the common reviewer rules and the
  task specification are inlined into the entry by whoever builds it.
- A briefing written by an orchestrator can describe the defect it expects
  (a focus list). That makes recall higher than for a neutral briefing and
  lowers the room to show a loss; the `leak` tag records it per entry.
- The argument list is pinned by tests against a stub binary. Whether the
  installed Claude Code build interprets the flags and settings as intended
  is what `canary` checks; then start with one entry (`--only`) and read its
  `session.json` and `result.json` before a batch.

## Cost

Cost is read from each session's own report (`total_cost_usd`) and summed per
variant by `score`; `--budget-usd` caps one session, and the `run` command
prints the worst case (entries times repeats times the cap) before it starts.
A full run costs about the number of entries times the mean per-session cost
at the chosen model and effort; measure the mean on a few entries first. The
judge is a short session per finding run (default model `sonnet`), and the
canary one short session.

## Tests

`npm test` runs `test/eval-dataset.test.ts` (schema, leak tag, placeholders,
relative repository paths), `test/eval-score.test.ts` (return validity, judge
prompt and answer, scoring, per-entry aggregation, failures, noise, paired
comparison and noise floor, leak split, variants), `test/eval-isolation.test.ts`
(scratch layout and permissions, placement checks and the tmp path limit,
session settings, secret names, secret scan and redaction, guard envelope,
process sweep), `test/eval-runner.test.ts`
(checkout isolation, environment allowlist, session flags and settings,
timeouts and process groups, leftover processes, records, retries, blindness)
and `test/eval-cli.test.ts` (canary, run, judge, score and compare end to
end). They use `test/fixtures/eval/stub-claude.mjs`,
`test/fixtures/eval/fake-guard.mjs` and a throwaway repository; no network
and no model are involved. One runner test also runs under the real
`agent-primitives guard` when it is on `PATH`.
