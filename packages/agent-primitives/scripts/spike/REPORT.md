# Spike: changed-branch enumerator for mutation plans

Throwaway measurement, not shipped, not referenced by `package.json`. It asks
whether a heuristic that lists the added or changed behaviour branches in
`base..head` and marks those without a planned mutant would have listed the
surviving mutants that reviewers found on branches the implementer or lane
never probed. The tracker task that asked for this spike is referenced from the pull request.

## Verdict

Do not build it as specified (list branches that have no planned mutant).

- Recall of reviewer-found survivors, counting a survivor only when an
  uncovered candidate lies within 3 lines of it and "covered" means a planned
  mutant within 3 lines: **3 of 22 (14%)** with the first heuristic, **5 of 22
  (23%)** with the tuned one. The suggested bar is 70%.
- Even with the most lenient reading (planned mutants must sit on the exact
  line to count as covering) the figure is 10 of 22 (45%) and 12 of 22 (55%).
- Noise passes the suggested bar on average (3.4 uncovered candidates per
  changed source file, bar 8) but 9 of 60 changed files in the survivor cases
  exceed 8 uncovered candidates, and those are mostly the large behaviour
  files (6 of the 9 also carry a survivor).
- The reason recall is low is not that the enumerator misses branches. It
  lists 14 of 22 survivors as candidates (64%, 73% tuned). The reason is that
  14 of 22 survivors sit within 3 lines of a planned mutant, 6 of them on the
  same line (a planned mutant sits on that line; whether the survivor is a
  second operator on the same line is not measured here, and one of the six
  is a missing check scored by hand) and 8 within 1 to 3 lines (a
  neighbouring branch was probed). A "no planned mutant here" marker cannot
  see either class.

## Method

1. Cases. The audit return that motivated the spike counts 21 review returns
   with a survivor, inert-test or unpinned finding but does not list them. The
   review returns of batches 161 to 169 were searched for the same
   classes; 14 returns carry a surviving mutant with a stated file and line (or
   an inert test whose mutant location the next round states), 13 in
   TypeScript or JavaScript and one in bash. Seven more returns that the
   count may include were left out, each with its reason: a prompt-prose
   pin (batch 162), a bash near-equivalent survivor the lane had justified
   (batch 164), a bash equivalent mutant (batch 164), a missing route-level
   test without a mutant (batch 164), a python test pin gap (batch 167), a
   survivor the implementer itself justified (batch 167), a test precondition
   gap without a mutant (batch 163). The exact 21 cannot be reconstructed from
   the audit return, so the 14 are this report's population, not a replay of
   its count. Reviewer-withdrawn equivalent mutants are excluded (two,
   listed in the evidence).
2. Range. For each case the range is `merge-base(base, head)..head` using the
   base and head commits the review return names, so the reviewer's line
   numbers apply to the head. Where a return names no head, the PR head or
   the lane commit that carries the cited line was used and checked by
   printing the cited line. Repos were cloned read-only into the evidence
   directory and the PR heads fetched from `refs/pull/<n>/head`; no range
   failed to resolve.
3. Survivors. Locations come from the review return (file:line, quoted from
   the reviewer's own runner output). One finding cites a range
   (`scripts/check-compose-isolation.mjs:282-293`) for a missing check.
4. Planned mutants. File and line of every mutant in the implementer or lane
   return that precedes the review (`mutation_probes` tables, lane report
   tables); rounds before the review are unioned. Entries with a text anchor
   instead of a line were resolved by searching the head file (20 of the 273 planned-mutant
   locations were resolved this way, 6 stayed unresolved; the cases and
   controls affected are in the per-case JSON).
5. Enumerator (`branch-enumerator.mjs`). Reads `git diff -U0`, takes added
   lines of non-test TypeScript or JavaScript files, strips strings and
   comments, and classifies each line by regular expression into
   `conditional` (`if`, `else`, `switch`/`case`, `while`, ternary),
   `default` (`??`, `||` fallback, parameter or destructuring default),
   `flag` (`--flag` string literals, `.option(`, optional property
   declarations) and `early-return` (`if (...) return|throw`, or a
   `return|throw|continue|break` right under an added `if`/`else`). It does
   not parse the language. Version 1 is what was written before the survivor
   lines were looked at. Version 2 (`--v2`) adds two rules after looking at the
   first misses: lines that start or end with `&&`/`||` (arms of a multi-line
   condition) and typed parameter defaults (`name: T = value,`). Version 2 is
   therefore tuned to this sample and optimistic; version 1 is the honest
   figure.
6. Scoring. Per survivor: `hit` = a candidate on the survivor line or within 3
   lines; `partial` = no such candidate but one in the same diff hunk; `miss` =
   otherwise (including a survivor line that the range does not change).
   "Covered" = a planned mutant in the same file within 3 lines of the
   candidate (the suggested rule); a tolerance of 0 lines is reported as a
   sensitivity. A survivor counts as listed-as-uncovered only when a hit
   candidate is not covered.
7. Controls. Ten tasks from the same batches whose review found no surviving
   mutant, taken in batch order, TypeScript or JavaScript only (docs-only,
   bash and python tasks of those batches are skipped). Two controls have no changed
   TypeScript or JavaScript source file or no candidate at all
   (agent-dx #604 changes prompts and tests, project-forge #180 pins a
   dependency and edits one file with no branch), which pulls their per-file
   noise to zero. Control means are therefore a floor.

Scripts in this directory: `branch-enumerator.mjs` (the deliverable),
`extract-probes.mjs` (planned-mutant locations), `run-cases.mjs` (scoring),
`tables.mjs` (these tables). Raw per-case JSON, the case list with the paths
of the review and implementer returns, and the baseline logs are in the run's
evidence directory (outside the repository; `cases.json` there
is the input of `run-cases.mjs`).

## Per-case results

Columns: `v1`/`v2` = verdict of the first / tuned heuristic; `exact line` = a
candidate sits on the survivor's own line (v1); `nearest probe` = distance in
lines to the nearest planned mutant in the same file (`none` = no planned
mutant in that file); `cand.` = candidates in the range (v1); `files` =
changed non-test TypeScript or JavaScript files; `uncov./file` = candidates
with no planned mutant within 3 lines, per changed file. The batch 164 bash
case (tech-debt #4, four survivors) is resolved but out of language scope.

### Cases (reviewer-found surviving mutants)

| case | repo | range (merge-base..head) | resolved | survivors (file:line) | v1 | v2 | exact line | nearest probe | cand. | files | cand./file | uncov./file |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| case-batch163-project-pilot-pr181-r2 | project-pilot | 571f15a636b3..7eabe5162990 | yes | ui/Select.tsx:14 | miss | miss | no | 32 | 3 | 9 | 0.3 | 0.1 |
| case-batch164-agent-tasks-pr732-r1 | agent-tasks | dfda7f50a3a8..6662411f40bb | yes | routes/tasks.ts:4429 | hit | hit | yes | 1 | 116 | 12 | 9.7 | 5.7 |
| case-batch164-agent-tasks-pr732-r2 | agent-tasks | dfda7f50a3a8..7153fa71369f | yes | routes/tasks.ts:4434 | hit | hit | yes | 1 | 120 | 12 | 10.0 | 4.7 |
|  |  |  |  | routes/tasks.ts:4435 | hit | hit | yes | 0 |  |  |  |  |
| case-batch164-deploy-panel-pr211-r1 | deploy-panel | 84f8b370ccd4..6d29303d79fe | yes | routes/apps.ts:60 | miss | miss | no | 1 | 11 | 6 | 1.8 | 1.3 |
| case-batch164-depsight-pr232-r1 | depsight | c5d1a0a743c4..291664bb35cd | yes | lib/manifest-discovery.ts:2247 | hit | hit | no | 2 | 61 | 2 | 30.5 | 5.5 |
|  |  |  |  | lib/manifest-discovery.ts:2238 | hit | hit | yes | 0 |  |  |  |  |
|  |  |  |  | lib/manifest-discovery.ts:2086 | partial | partial | no | 7 |  |  |  |  |
| case-batch164-tech-debt-pr4-r1 | tech-debt | e0854a12fe64..128cd6cc0174 | yes | bin/debt:242, bin/debt:250, bin/debt:275, bin/debt:289 | out of language scope | | | | | | | |
| case-batch165-depsight-pr236-r1 | depsight | 5de99d6c4a36..8817f3234cf9 | yes | scripts/check-compose-isolation.mjs:282-293 | partial | partial | yes | 0 | 4 | 1 | 4.0 | 0.0 |
| case-batch167-agent-tasks-pr737-r1 | agent-tasks | f83519a74e9c..7a2af749ff32 | yes | services/grounding-github-webhook.ts:226 | miss | miss | no | none | 5 | 1 | 5.0 | 2.0 |
| case-batch167-deploy-panel-pr214-r1 | deploy-panel | 1c2488b32c45..e41359ab6167 | yes | services/relay-self-update.ts:85 | hit | hit | yes | 2 | 77 | 8 | 9.6 | 3.3 |
| case-batch167-depsight-pr238-r1 | depsight | a0996d3d59c0..a294e840f93e | yes | scripts/check-compose-isolation.mjs:340 | hit | hit | no | 3 | 30 | 1 | 30.0 | 11.0 |
|  |  |  |  | scripts/check-compose-isolation.mjs:350 | partial | partial | no | 3 |  |  |  |  |
| case-batch169-agent-dx-pr606-r1 | agent-dx | 0796ac493a3b..59011fdaa7da | yes | hygiene/index.ts:135 | hit | hit | yes | 16 | 25 | 2 | 12.5 | 6.5 |
|  |  |  |  | hygiene/index.ts:138 | hit | hit | no | 19 |  |  |  |  |
|  |  |  |  | hygiene/index.ts:140 | partial | hit | no | 21 |  |  |  |  |
| case-batch169-agent-dx-pr606-r3 | agent-dx | 0796ac493a3b..e889aaa2b20f | yes | hygiene/index.ts:210 | hit | hit | yes | 0 | 17 | 2 | 8.5 | 2.0 |
|  |  |  |  | hygiene/index.ts:188 | hit | hit | yes | 1 |  |  |  |  |
| case-batch169-clawd-monitor-pr134-r1 | clawd-monitor | dbf7eebf8239..fb1e2dcf9490 | yes | lib/login-rate-limit.ts:170 | hit | hit | yes | 0 | 13 | 2 | 6.5 | 0.0 |
|  |  |  |  | lib/login-rate-limit.ts:97 | miss | hit | no | 39 |  |  |  |  |
|  |  |  |  | lib/login-rate-limit.ts:203 | hit | hit | yes | 0 |  |  |  |  |
| case-batch169-deploy-panel-pr217-r1 | deploy-panel | 318b1a818407..68486b155972 | yes | [id]/page.tsx:231 | hit | hit | no | 4 | 10 | 2 | 5.0 | 2.5 |

### Controls (review found no surviving mutant)

| control | repo | range | resolved | cand. v1 | cand. v2 | changed src files | cand./file | covered (<=3 lines) | uncov./file | unresolved probes |
|---|---|---|---|---|---|---|---|---|---|---|
| control-batch163-project-forge-pr175 | project-forge | 46a62ef5b885..e30752f84fce | yes | 9 | 9 | 1 | 9.0 | 2/9 | 7.0 | 0 of 3 |
| control-batch164-agent-dx-pr603 | agent-dx | 5499bbbe34ab..4fb08999369d | yes | 1 | 1 | 1 | 1.0 | 1/1 | 0.0 | 0 of 1 |
| control-batch164-agent-relay-pr132 | agent-relay | 569599292014..5e685287b5cf | yes | 13 | 13 | 3 | 4.3 | 1/13 | 4.0 | 0 of 5 |
| control-batch164-harness-pr762 | harness | 8cee81fd740b..2bdcadf42b92 | yes | 5 | 5 | 3 | 1.7 | 3/5 | 0.7 | 0 of 2 |
| control-batch165-project-pilot-pr184 | project-pilot | a86f690c5324..c07662446afc | yes | 2 | 2 | 4 | 0.5 | 2/2 | 0.0 | 1 of 4 |
| control-batch167-agent-dx-pr604 | agent-dx | 28262b794343..ad5cd2cf8ddc | yes | 0 | 0 | 0 | n/a | 0/0 | n/a | 2 of 3 |
| control-batch167-agent-memory-pr193 | agent-memory | b9842e7d085f..2d472b45c047 | yes | 5 | 5 | 7 | 0.7 | 0/5 | 0.7 | 0 of 8 |
| control-batch167-harness-pr764 | harness | e30905e3cf05..81394eeea17b | yes | 13 | 13 | 3 | 4.3 | 6/13 | 2.3 | 0 of 8 |
| control-batch167-project-forge-pr180 | project-forge | ecf315ff8e89..f449149e1310 | yes | 0 | 0 | 1 | 0.0 | 0/0 | 0.0 | 0 of 1 |
| control-batch167-project-pilot-pr189 | project-pilot | 843fa71edc1a..4e7bdf64cba0 | yes | 2 | 2 | 2 | 1.0 | 2/2 | 0.0 | 0 of 6 |

## Aggregate

Survivors: 22 in the 13 TypeScript or JavaScript cases (four more in the bash
case are out of scope). Per-file figures pool every changed non-test source
file of the group, including files with no candidate.

| measure | v1 | v2 |
|---|---|---|
| survivors listed as a candidate (`hit`, within 3 lines) | 14 of 22 (64%) | 16 of 22 (73%) |
| `hit` + `partial` (same diff hunk) | 18 of 22 (82%) | 19 of 22 (86%) |
| candidate on the survivor's own line | 11 of 22 (50%) | 14 of 22 (64%) |
| survivor listed by an uncovered candidate, planned mutants within 3 lines count as covering (suggested rule) | 3 of 22 (14%) | 5 of 22 (23%) |
| same, planned mutants must be on the exact line to cover | 10 of 22 (45%) | 12 of 22 (55%) |
| survivor's own line is an uncovered candidate, 3-line cover | 1 of 22 (5%) | 4 of 22 (18%) |
| survivor's own line is an uncovered candidate, exact-line cover | 6 of 22 (27%) | 9 of 22 (41%) |
| survivors with a planned mutant on the same line / within 1 to 3 lines / farther or none | 6 / 8 / 8 | 6 / 8 / 8 |

| measure | survivor cases (13) | controls (10) |
|---|---|---|
| changed non-test source files | 60 | 25 |
| candidates (v1) | 492 | 50 |
| candidates per changed file, mean / median (pooled) | 8.2 / 1 | 2.0 / 0 |
| candidates per changed file, mean of per-case means | 10.3 | 2.5 |
| uncovered candidates per changed file, mean / median (pooled) | 3.4 / 0 | 1.3 / 0 |
| uncovered candidates per changed file, mean of per-case means | 3.4 | 1.6 |
| files with more than 8 uncovered candidates | 9 of 60 | 1 of 25 |
| share of candidates already covered, 3-line / exact-line | 58% / 30% | 34% / 22% |
| candidates per changed file with at least one candidate, mean | 11.2 | 4.2 |

Version 2 changes the case figures by under 5% (515 candidates, 3.5 uncovered
per file) and leaves the controls unchanged.

| kind | candidates (cases) | uncovered | survivors whose neighbourhood has this kind (v1) |
|---|---|---|---|
| conditional | 278 | 111 | 11 |
| early-return | 115 | 41 | 6 |
| default | 64 | 20 | 7 |
| flag | 35 | 33 | 0 |

A survivor can be near several kinds, so the last column does not sum to 14.
`early-return` almost always sits on a line already counted as `conditional`,
so it adds lines without adding survivors. `flag` is the worst kind: 35
candidates, 33 of them uncovered, no survivor near any (optional property
declarations in type literals, 12 of them in one pull request). `default` has the best yield (7
survivor neighbourhoods in 64 candidates) and `conditional` the most noise in
absolute terms (278).

## What the misses look like

- `miss` (4): a type-level requirement (`Select.tsx:14`, `"aria-label": string`
  to optional, killed by `tsc` only at call sites), an object property
  (`orderBy: { createdAt: "desc" }`, `apps.ts:60`), a typed constructor
  parameter default (`login-rate-limit.ts:97`, listed by v2), and a line the
  range does not change (`grounding-github-webhook.ts:226`: a new integration
  test whose fixture did not discriminate pre-existing code).
- `partial` (4): a missing branch (the dev database guard did not check
  `network_mode`; no candidate can point at an absent check, so this is scored
  partial by hand: the finding cites lines 282 to 293 and the nearest candidate
  is a neighbouring existing check), a `replaceAll('$$', '')` expression, an
  `indexOf` expression, and a `startsWith(",")` arm of a multi-line `||`
  (v2 lists the last one).
- Assignments such as `deployPollCancelled.current = true` are only "hits"
  because an unrelated `if` stands within 3 lines; the enumerator does not
  list state writes, only branches. Strictly, 11 of 22 survivors have a
  candidate on their own line.

## Threats to validity

- The 22 survivors are what reviewers chose to try, biased toward branches
  they thought unprobed; that favours the enumerator and it still falls short.
  Controls are tasks whose review found no unjustified surviving mutant, not
  tasks proven to have none: two of them (agent-relay #132, harness #764)
  carry a justified survivor or an unpinned-test note, and agent-relay #132
  also appears in the exclusion list. Controls only feed the noise
  comparison, so control noise says nothing about precision.
- Pseudo-replication and fix-round dependence: the 22 survivors come from 9
  distinct pull requests (agent-tasks #732 and agent-dx #606 appear with two
  review rounds each, depsight #236 and #238 touch the same script). In the
  re-review rounds the planned mutants include probes written in response to
  the earlier round's survivors, which makes adjacency likelier by
  construction. Dropping the three re-review cases leaves 17 survivors with
  4 same-line, 6 within 1 to 3 lines and 7 farther (59% near a probe instead
  of 64%); the conclusion holds.
- Line numbers of planned mutants come from the implementer's return and may
  have shifted by a few lines to the review's head; text anchors were resolved
  at the review's head. The effect on the 3-line rule is small and in the
  direction of calling candidates uncovered.
- Two controls use the PR's final head because the review's head commit is
  not in the clone (batch 163 project-forge #175, batch 164 agent-relay
  #132); their planned mutants are from the first round only, so their
  coverage is understated and their noise overstated.
- Version 2's two rules were added after looking at the misses; its figures are
  an upper bound for this approach on this sample, not an estimate of new
  data. The sample is 13 reviews in six repositories, all written by the same
  fleet of agents; no confidence interval is claimed.
- TypeScript and JavaScript only. The bash survivors (four in one case) and
  the prose, python and PHP items are not covered; a shell or PHP enumerator
  would need its own rules and the PHP shapes from the hygiene work show how
  fragile line-based rules are.
- Branch heuristics are regular expressions on diff lines. Multi-line
  conditions, JSX conditionals and chained optional-call logic are
  under-reported; template-literal and type-level code is over- or
  under-reported without a parser. An `ast-grep` version was not tried.

## Recommendation under the stated thresholds

Suggested bar: recall at least 70% with at most 8 uncovered candidates per
changed file supports building.

| threshold | measured | met |
|---|---|---|
| recall >= 70% (uncovered-candidate definition, v1 / v2) | 14% / 23% (lenient 45% / 55%) | no |
| uncovered candidates per changed file <= 8 | 3.4 mean, 9 of 60 files above 8 | yes on the mean, no per file |

Do not build the tool as described. The branch list itself is good (64% of
survivors appear in it, 73% tuned); what fails is the "no planned mutant on
this branch" filter, because most survivors were on branches that had one.
If something is built from this, the measured numbers point to a different
shape, which is a hypothesis for a follow-up and was not measured here:

1. List each candidate with the planned mutant's operator next to it (`??`
   fallback, comparison, constant, removal) instead of a covered/uncovered
   flag. 6 survivors sit on a line that already had a planned mutant, and
   a per-line list of what was tried would show an untried operator (a
   hypothesis, not measured here).
2. Restrict the list to `default` and `conditional` candidates; `flag` and
   `early-return` add 30% of the candidates and list no survivor that
   `default` and `conditional` do not already list (15 of 22 either way).
3. A cheaper variant needs no tool: ask the implementer for one mutant per
   default value, fallback, constant and property value on a changed line.
   Eight of the 22 survivors changed exactly such a thing (two dropped
   payload properties, an agent id operand, `?? recTarget`, a typed parameter
   default, `Math.ceil`, an `orderBy` direction, a case fold).

## Reproduce

```
node branch-enumerator.mjs <repo-dir> <base>..<head> [--v2]
node run-cases.mjs <cases.json> <repos-dir> <out-dir>
node tables.mjs <out-dir>
```

`cases.json` (outside the repository, in the run's evidence directory) lists
the repository, base, head, survivors and the files holding the planned
mutants for every case and control.
