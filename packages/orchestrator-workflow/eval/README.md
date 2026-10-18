# Reviewer prompt replay evaluation

A repeatable benchmark that answers one question: does a changed (for example
shorter) reviewer prompt keep its behaviour? It replays a reviewer session on
historical changes with a prompt variant and scores the return.

This directory is a maintainer tool. It is not part of the published package:
`package.json` `files` does not list it, `tsconfig.json` does not compile it,
and a test pins both. It runs through `tsx` and is covered by the package
tests (`test/eval-*.test.ts`), which use a stub in place of the `claude`
binary and never start a model session.

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
  text, and nothing that names the variant or the entry.
- **False positives**: medium-or-higher findings reported on entries of kind
  `control` (changes the original review accepted without such a finding). A
  control finding can be a real defect the original review missed, so
  spot-check before reading a difference as a regression.
- **Cost and duration**: the session's reported USD cost and wall time.
- **Noise**: the same variant run more than once on the same entries; the
  range between repeats is the yardstick for a difference between variants.

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

| field | meaning |
|---|---|
| `schema` | `1` |
| `id` | `[a-z0-9-]`, unique, also the file stem |
| `kind` | `finding` (at least one known medium-or-higher defect) or `control` (no known finding) |
| `repo` | `name`, `path` (a local repository to fetch from), `head_sha` and `base_sha` (full 40-character shas), optional `fetch_note` |
| `setup` | list of `{cwd, argv, timeout_s?}` run inside the checkout (for example `npm ci`); `cwd` stays inside the checkout, `argv` is not a shell string |
| `review_method` | `normal`, `rigorous` or `adversarial` |
| `brief` | the reviewer briefing text, machine paths replaced by placeholders |
| `task_spec` | the task specification text, inlined (the session has no tracker) |
| `known_findings` | for `finding`: `{id: "K<n>", severity, category, description, files?}`; for `control`: empty |
| `provenance` | `{source, round, notes?}`; kept in the dataset, never given to a session or the judge |

Placeholders in `brief` and `task_spec`: `{{WORKTREE}}`, `{{EVIDENCE_DIR}}`,
`{{RUN_DIR}}`, `{{BASE_SHA}}`, `{{HEAD_SHA}}`. The runner replaces them with
the checkout, a per-run evidence directory, a per-run (empty) run directory and
the two shas. Validation rejects a brief or spec that still contains a home
directory path.

Choose entries whose commits can be rebuilt from a local repository:
`git cat-file -e <sha>^{commit}` succeeds, or the commit was fetched into
`FETCH_HEAD` of that repository once (never into a named ref).

## Running

All commands run from `packages/orchestrator-workflow`:

```
npm run eval -- validate-dataset --dataset <dir>

npm run eval -- run --dataset <dir> --out <results> --variant current \
  --scratch <dir outside any repository> [--only id,id] [--kind control] \
  [--repeat 2] [--model opus] [--effort high] [--timeout-min 45] \
  [--budget-usd 15] [--jobs 1]

npm run eval -- judge   --dataset <dir> --out <results> [--judge-model sonnet]
npm run eval -- score   --dataset <dir> --out <results>
npm run eval -- compare --dataset <dir> --out <results> --a current --b degraded
```

Variants (`--variant`):

- `current`: `assets/agents/reviewer.md` at a git revision (`--rev`, default
  the revision named in `eval/variants.ts`).
- `degraded`: the same file with the whole `Check, at minimum:` list removed
  (from its heading line up to the `Rules:` heading), everything else
  byte-identical. It is the negative control: a benchmark that cannot tell it
  from `current` does not discriminate.
- `file:<path>`: any prompt file, for example a shortened candidate. Give it an
  id with `--variant-id`.

Sessions run one after the other by default. `--jobs <n>` runs up to n at
once, each in its own checkout; mind the API rate limit and the load, since
every session runs tests in its checkout. Progress lines then arrive in
completion order.

A result directory keeps one folder per variant id; reusing an id for a
different prompt is refused. Every run folder has `result.json` (variant id and
file hash, prompt hash, model, effort, status, exit code, cost, turns, session
time, final text, validity), the composed `prompt.md`, the raw `session.json`,
`stderr.log`, `setup.log` and `agents.json`. A run that already has a
`result.json` is skipped unless `--force` is given, so an interrupted batch
resumes.

`judge` writes `judge.json` next to each finding-run result that has none; an
unparseable answer is retried (`--attempts`) and otherwise leaves a
`judge-error.json` and the run unjudged. `score` leaves unjudged runs out of
recall and says how many there are. Runs whose setup failed are excluded from
every tally and counted separately.

Repeat a variant (`--repeat 2` or more; a later `run` with a larger
`--repeat` adds the missing repeats and skips the existing ones) to get its
noise. `compare`
prints A against B with the noise range of A next to each delta and a verdict
(above noise, within noise, or no noise reference).

## Isolation

- The checkout is a fresh repository that fetches only the head and base
  commits from the local source, so no later history, branch or tag is
  reachable. The remote is removed again before anything runs, and the fetch
  bookkeeping file is deleted. Nothing is cloned into or modified in a shared
  worktree.
- `GH_TOKEN`, `GITHUB_TOKEN` and the other listed token variables are blanked
  in every child process. The session gets an empty MCP configuration, no
  subagent tool and no web tools, and cannot edit files (the shipped agent
  already denies `Edit`, `Write` and `NotebookEdit`).
- In the default bare mode `HOME` and the Claude config directory point at a
  scratch folder for the session, so a session cannot touch the real user
  configuration (`--keep-home` turns this off).
- Every child (setup commands and the session) runs in its own process group
  with a wall-clock bound; on expiry the group gets SIGTERM and then SIGKILL,
  and group members left behind by an exited leader are killed too. The tool
  has no memory cap of its own: wrap a whole batch in
  `agent-primitives guard <timeout-s> <max-rss-MiB> -- npm run eval -- ...` when
  one is wanted.
- The session runs with `--permission-mode bypassPermissions` so the reviewer
  can run tests in the checkout without prompts. The checkout has no remote and
  no credentials, but a bypassing session is not a sandbox for the rest of the
  machine; run batches on a machine where that is acceptable.
- The checkout is deleted after each run (`--keep-checkout` keeps it); logs
  and records stay in the results directory.

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
- `--bare` (default; `--no-bare` omits it) skips hooks, plugin sync,
  auto-memory and `CLAUDE.md` discovery, so the project instruction files a
  production subagent would see are absent, and it authenticates with an API
  key from the environment (`ANTHROPIC_API_KEY`, or the variable named by
  `--api-key-env`) instead of the login. Without `--bare`, user settings and
  hooks apply and the home directory is not isolated.
- No MCP servers (the production reviewer may have a tracker or code-search
  server), and the subagent, web-fetch and web-search tools are denied.
- Run files named by the briefing (other briefs, evidence, run notes, tracker
  pages) do not exist. The runner appends a fixed paragraph that says so and
  that missing run files are not findings; the common reviewer rules and the
  task specification are inlined into the entry by whoever builds it.
- A briefing written by an orchestrator can describe the defect it expects
  (a focus list). That makes recall higher than for a neutral briefing and
  lowers the room to show a loss; record how many entries are affected when
  reading a result.
- The argument list is pinned by tests against a stub binary. Whether the
  installed Claude Code build interprets the flag combination as intended
  is confirmed by the first real run: start with one entry (`--only`) and
  read its `session.json` and `result.json` before a batch.

## Cost

Cost is read from each session's own report (`total_cost_usd`) and summed per
variant by `score`; `--budget-usd` caps one session, and the `run` command
prints the worst case (entries times repeats times the cap) before it starts.
A full run costs about the number of entries times the mean per-session cost
at the chosen model and effort; measure the mean on a few entries first. The
judge is a short session per finding run (default model `sonnet`).

## Tests

`npm test` runs `test/eval-dataset.test.ts` (schema and placeholders),
`test/eval-score.test.ts` (return validity, judge prompt and answer, scoring,
aggregation, noise, comparison, variants), `test/eval-runner.test.ts`
(checkout isolation, environment blanking, session flags, timeouts and process
groups, record files, cleanup) and `test/eval-cli.test.ts` (run, judge, score
and compare end to end). They use `test/fixtures/eval/stub-claude.mjs` and a
throwaway repository; no network and no model are involved.
