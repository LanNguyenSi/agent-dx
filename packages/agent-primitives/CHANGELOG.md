# Changelog

All notable changes to `agent-primitives` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- README's `probe` isolation section and "Non-JS repositories" now state
  the realpath/linked-directory limitation of `-i worktree`: a linked
  directory is shared with the source tree, and code inside it that
  locates the project by resolving a real path (PHP `__DIR__`/
  `__FILE__`, Node's `fs.realpathSync`, Python's `os.path.realpath`)
  sees the operator's real tree, so a probe whose autoloader is
  bootstrapped from a linked directory tests the unmutated code and
  reports `survived` -- a silent false negative. Names `-i inplace` and
  a repo-side test-bootstrap fix as the two ways out, with a Drupal
  `core/tests/bootstrap.php` case as the worked example (issue #243).
  `--copy <dirs>` and a survived-detection heuristic remain proposals in
  that issue, not implemented here.

### Fixed

- `probe`'s `result`/`status` (and a `--plan` mutant's own `status`) now
  always report the mutant's actual, measured outcome -- `killed` when
  the test command failed with the mutant applied, `survived` when it
  passed -- independent of `--expect` (task `aef31231`). They used to
  report whether that outcome MATCHED `--expect` instead, so a mutant
  declared `--expect pass` that genuinely survived (the routine,
  expected case) came back `killed`, and a reader who did not already
  know `--expect` misread it as caught. A new field,
  `mutation_probe.expectation` (`"met"`/`"violated"`), carries that
  match separately, present only alongside a real `killed`/`survived`
  verdict. `--expect` still decides the exit code exactly as before (`0`
  for a met expectation, `1` for a violated one) -- unchanged for a
  caller not passing `--expect`, since `expectation` and the old,
  now-corrected `status` always agree under the default `--expect
  fail`. README and the package's skill updated to describe
  `killed`/`survived`/`expectation` under this contract. A `--plan`
  run's own `summary` gained `met`/`violated` counts alongside the
  existing `killed`/`survived`/`inconclusive`/`not_run` ones, so a
  plan-level `status: "survived"` (driven by `violated`, not by raw
  `survived`, once any mutant carries `--expect pass`) is explained by
  a number in the same envelope instead of only by re-deriving it from
  `results[].mutation_probe.expectation`.

## [0.2.0] - 2026-09-10

### Added

- `probe -i worktree`'s isolation copy auto-links a composer project's
  `vendor-dir`/`bin-dir` the same way it already auto-links
  `node_modules` (task `6c7e1532`, issue #225): wherever a
  `composer.json` sits, at the same depth cutoff and through the same
  link policy, its `config.vendor-dir`/`config.bin-dir` (defaulting to
  `vendor`/`vendor/bin`) are symlinked in, so a composer project's
  gitignored runtime no longer needs a `--link` per invocation. A
  `--plan` file now accepts its own `link` field (paths relative to the
  repository root, the same `$(...)`/backtick check `--link` itself now
  applies), merged and deduplicated with `--link`. A new repo-level
  defaults file, `.agent-primitives.json` at the repository root
  (`{ "link": [...] }` only; an unknown key or an unparsable file is a
  usage error naming the path), is read on every `probe`/`--plan`
  invocation; the full precedence across all three `link` sources is
  additive -- defaults file, then plan, then `--link`, each only ever
  adding a path, never removing one an earlier source already named.
- One link policy for every directory `probe -i worktree` links into
  the isolation copy, applied before any link is created and documented
  in the README's isolation section (task `6c7e1532`): containment
  judged on where a candidate sits rather than on where a symlinked
  candidate points (so a `node_modules` symlinked to a sibling
  checkout's install is linked, as the same symlink); the copy's root,
  the mapped cwd and the directory of every file the run mutates never
  linked over; a directory named by repository content (a composer
  `config` value, a `--plan` file's `link`, the defaults file's `link`)
  linked only when git does not track it; and nesting judged on the
  destination paths inside the copy, so two in-repo symlinks pointing
  at one shared install are both linked.
- The link policy decides about path STRINGS while `mkdirSync`,
  `rmSync` and `symlinkSync` resolve directory ENTRIES, and on a
  case-insensitive filesystem those are not the same thing (task
  `6c7e1532`): measured on APFS, `fs.realpathSync` returns the spelling
  it was given for a plain directory (`.../SRC` stays `.../SRC`), a
  recursive `mkdirSync` of `<copy>/VENDOR/deep` creates the directory in
  the operator's real `vendor/` once `vendor` is linked, and an
  `rmSync` of `<copy>/VENDOR/bin` deletes the operator's real
  `vendor/bin` and leaves a self-referential symlink in its place; git's
  own index, being case-sensitive, reports `SRC` as untracked while the
  copy carries a tracked `src` there. Three answers, all three probed:
  rules 2 and 3 (and the `:(literal)` pathspecs of the one `git
  ls-files` listing behind rule 3) are now decided on the COPY's own
  spelling of a destination, read back from its directory entry by
  inode identity rather than assumed from the source tree's spelling;
  containment is re-checked immediately before each of the three
  syscalls that create a link, and a link may never point back into the
  copy, so a destination that resolves through an earlier link of the
  same run is refused with a warning naming the destination, where it
  resolves to, and the link it would have resolved through; and once
  the links exist, the mapped cwd and every mutated path must still
  resolve inside the copy, a miss being `worktree_sync_failed` rather
  than a warning, since the run's next act is to write there. Rule 1
  additionally requires a directory named by repository content to
  RESOLVE inside the root, not merely to sit inside it (the gitignored
  `esc -> ..` a `composer.json` can point its `vendor-dir` at). Each
  shape is pinned by an end-to-end probe over a scratch fixture that
  hashes the source tree before and after and asserts the refusal text:
  see the "a destination the copy spells differently" tests in
  `test/probe-worktree.test.ts` (composer `bin-dir: "VENDOR/bin"`, a
  defaults file naming `cache` and `CACHE/inner`, the missing
  `VENDOR/deep/nested` that reaches the `mkdir`, `SRC` from all three
  link sources with the mutant in `src/`, the `esc -> ..` refusal, and
  the negative control that a case variant which is neither protected
  nor tracked still links), plus `canonicalDestRelPath` and the
  separator both ways in `test/link-policy.test.ts`. Every test that
  depends on the volume's case behaviour measures it (`test/helpers/
  case-fs.ts`) and asserts the branch it is on, rather than assuming a
  macOS host is case-insensitive.
- The whole worktree-relative destination of a link, not only its final
  component, is now read back from the isolation copy segment by segment
  (task `6c7e1532`): a case-variant PARENT (`SRC/sub` over a tracked
  `src/sub`, from the defaults file or from a composer
  `config.vendor-dir`) used to miss both rule 2 and rule 3 and to miss
  the `:(literal)` pathspec of the `git ls-files` listing behind rule 3,
  so the link was created with no warning and a `--pre` writing there
  clobbered the operator's tracked file whenever the mutant lived
  outside the aliased parent. Rule 4 is decided on the copy's spelling
  too, on both sides of the comparison. Alongside it, three narrower
  fixes to the same policy: a candidate from ANY source that resolves to
  the repository root or to a directory containing it (a gitignored
  `esc -> .` a composer `vendor-dir` names, an auto-discovered
  `node_modules -> .`) is refused, where before only a value repository
  content named was checked and only for resolving OUTSIDE the root, so
  the root itself passed (that refusal compared realpath STRINGS when it
  was written; it compares filesystem identity as of the entry below);
  a destination that CONTAINS a link this run already created is
  refused rather than linked, since the recursive delete before each
  link create would otherwise remove that earlier link while leaving it
  listed in `isolation.linked`; and a destination the untracked-file
  copy had already recreated as the very same symlink is now reported as
  left-as-synced in its own wording and listed in `isolation.linked`,
  instead of borrowing the "resolves outside the copy" refusal wording
  for a case where nothing is at risk. Rule 1's latitude for a target
  pointing AWAY from the root (a `node_modules` symlinked to a sibling
  checkout's install) is unchanged and still has its negative-control
  test. New end-to-end fixtures in `test/probe-worktree.test.ts`, each
  hashing the source tree before and after and asserting the refusal
  text: the tracked parent alias from the defaults file and from
  composer, both with the mutant outside the aliased parent and a
  `--pre` that writes into it; the composer `esc -> .` next to the
  existing `esc -> ..`; the reversed `["CACHE/inner", "cache"]` order,
  whose witness inside the copy asserts the first link survived; and the
  two halves of the postcondition, the mapped cwd and the mutated path,
  each reached by a run whose own inputs spell one directory two ways.
  `canonicalDestRelPath`'s per-segment walk, its missing-segment
  fallback and the two new policy refusals are unit-tested in
  `test/link-policy.test.ts`.
- Whether a link candidate IS the repository root or CONTAINS it is
  decided by filesystem identity (inode and device), not by comparing
  the two resolved path strings (task `6c7e1532`). `realpath` resolves
  symlinks and normalises neither case nor Unicode form, so an
  auto-discovered gitignored `node_modules` whose target reached the
  root under a second spelling passed every rule with no warning at all,
  was listed in `isolation.linked`, and a `--pre` writing through it
  created a file in the operator's real repository root. Three spellings
  did it: a relative target naming the repository's own directory in
  another case (`../REPO` for `repo`), an absolute target spelling an
  ANCESTOR segment in another case, and an NFD target for an NFC
  directory name. The containment half walks the root's own ancestors up
  to the filesystem root, comparing identity at each step, so an alias
  of a grandparent is caught as readily as one of the parent; the exact
  spellings (`-> ..`, `-> .`, `-> <the root>`) keep the wording they
  already had. Two narrower fixes ride along. A link target that
  CONTAINS the isolation copy is refused, the mirror of the existing
  refusal of a target INSIDE it: a defaults file naming the same in-repo
  directory a `--log-dir` puts the copy under is that shape. And a
  candidate whose destination has a FILE as an existing ancestor segment
  in the copy is skipped with a warning naming the blocking path,
  instead of throwing EEXIST out of the recursive `mkdir` and failing
  the whole sync (`worktree_sync_failed`) for every other link in the
  run: repository content naming `SRC/FILE.TXT/x` over a tracked
  `src/file.txt` reaches that honestly, since git tracks nothing UNDER a
  file and the tracked-directory rule has nothing to refuse. New
  end-to-end fixtures in `test/probe-worktree.test.ts`, each hashing the
  source tree before and after: "a link target that reaches the
  repository root under a SECOND SPELLING" runs all three aliases plus
  the three exact spellings as negative controls in one test, "a
  destination whose ancestor in the copy is a file" asserts the run
  completes with the warning, and "a link target that CONTAINS the
  isolation copy" pins the mirror. The identity helper itself is
  unit-tested in `test/link-policy.test.ts` ("entryRelationTo" and
  "planLinks: a target that reaches the root under a second spelling"),
  including a grandparent alias, which a walk stopping at the root's own
  parent never reaches. Every test that depends on the volume measures
  it first: case behaviour through `test/helpers/case-fs.ts`, and
  normalisation behaviour by creating an NFC name and asking for the NFD
  one.
- A NARROWING of the auto-discovery latitude: a link candidate is no
  longer created when git tracks what it POINTS AT, whatever name it
  sits under (task `6c7e1532`). The tracked-directory rule used to ask
  only about the DESTINATION, and only for a value repository content
  named, so an auto-discovered `node_modules` symlinked at the tracked
  `src` -- gitignored, committed, or spelled through an alias of the
  repository's own directory (`-> ../REPO/src`) -- and a `node_modules`
  git tracks as a directory of its own were all linked with no warning,
  listed in `isolation.linked`, and a `--pre` writing through any of
  them wrote into the operator's real tracked source. The question is
  now asked of every candidate but an operator's own `--link`, which
  keeps its documented latitude for both halves of the rule, and only
  about a target that sits INSIDE the repository root: a target outside
  it (a sibling checkout's install, the shape rule 1's latitude exists
  for) and an untracked one inside it (a hoisted monorepo install, a
  shared cache) link exactly as before, and both keep a negative-control
  test. Containment of the target and its spelling are decided by
  filesystem identity, the same way rule 1 decides whether a target IS
  the root, since `realpath` normalises neither case nor Unicode form;
  one `git ls-files` listing answers both halves for the whole run, and
  a listing that cannot run leaves every candidate but a `--link`
  treated as tracked. New end-to-end fixtures in
  `test/probe-worktree.test.ts` ("a link target that is TRACKED
  source"): five of the six hash the source tree before and after and
  assert the refusal names the target (the gitignored symlink, the
  committed one, the alias spelling, the tracked `node_modules`
  directory, and the negative control for a target OUTSIDE the root);
  the sixth, the negative control for an UNTRACKED target INSIDE the
  root, asserts by path instead, since its `--pre` writes into the tree
  by design. `linkTargetRelPath` and the rule's two
  provenance flags are unit-tested in `test/link-policy.test.ts`, which
  also pins `entryRelationTo`'s identity branches through a symlinked
  alias rather than a case-variant spelling, so both are exercised on a
  case-sensitive volume too. The dangling-symlink branch of the
  blocking-ancestor check and the case-variant form of the
  target-contains-the-copy mirror gained fixtures of their own.
- Rule 3's target half now also refuses a target sitting inside a
  NESTED repository's own boundary (task `6c7e1532`): a submodule's
  content is listed nowhere in the OUTER repository's index (only its
  gitlink is, at the submodule's own root), so an auto-discovered
  `node_modules -> sub/lib` under a submodule, or `node_modules ->
  nested/lib` under a gitignored nested plain repository, read as
  untracked to `isTrackedPath` and linked with no warning, while a
  `--pre` writing through either wrote straight into the nested
  checkout. `nestedRepoBoundaryRelPath` walks the target's path from the
  repository root looking for the same `.git` marker
  `copyUntrackedEntry`'s untracked-file sync already refuses to cross,
  and asks nothing of the nested repository's own index: sitting inside
  its boundary is enough. The submodule's own root stays refused by the
  outer index as before (pinned as a control), and a gitignored nested
  directory carrying no `.git` of its own still links (a second,
  negative control). The check never fires on the isolation copy's OWN
  directory tree (`LinkPolicyContext.copyRootReal`, the same `wtReal`
  `beginWorktree` already resolves): a linked git worktree carries a
  `.git` FILE at its own root too, and a `--log-dir` placed inside the
  repository puts that worktree where the composer/`node_modules`
  auto-discovery walk can find its own copied `vendor` and offer it back
  as a candidate; that shape already had its own, more specific refusal
  ("its target resolves to ..., inside the isolation copy itself"),
  which the new check would otherwise have pre-empted with a
  false-sounding "nested repository" reason. Fixtures for both shapes
  and the negative control live alongside the existing "a link target
  that is TRACKED source" group in `test/probe-worktree.test.ts`;
  `nestedRepoBoundaryRelPath` is unit-tested in
  `test/link-policy.test.ts`.
- The tracked-file listing's own fail-closed wording no longer claims
  git answered when it never got the chance to (task `6c7e1532`): when
  the `git ls-files` listing behind rule 3 cannot run, the per-candidate
  refusal now reads "could not check whether git tracks its target
  <path>; treated as tracked", and the "git tracks its target <path>"
  wording is reserved for a listing that actually answered. Pinned with
  the existing PATH-shim fixture (`test/probe-worktree.test.ts`, "the
  tracked-file listing behind the link policy"), updated to assert the
  new wording.
- The untracked-file sync now warns when a recreated untracked symlink
  resolves outside the isolation copy (task `6c7e1532`): the copy
  carries the SAME symlink the source tree does, so an absolute target,
  or a relative one escaping through `..`, still reaches the real tree,
  and a `--pre`/`-t` writing through it is not isolated for that path.
  `copySymlink` calls `resolveDeepestExisting` once per untracked
  symlink, after creating it, and names the symlink and where it
  resolves in a warning rather than refusing the sync outright. A
  COMMITTED absolute symlink is written by `git worktree add` itself,
  before this sync ever runs, so that half of the limit carries no
  warning; both README's isolation section and its Limitations
  paragraph now say so. Fixture: an untracked absolute symlink in
  `test/probe-worktree.test.ts`.
- `isolation.linkedNamedBy` in the result envelope (task `6c7e1532`):
  one `{ path, namedBy }` entry per ACCEPTED link that repository
  content asked for, carrying the same provenance phrase a refusal of
  that candidate would have carried. Until now only refusals named
  their source, so a link the repository had quietly added could not be
  told from one the operator typed. `linked` is unchanged and still
  lists every link; every path in `linkedNamedBy` appears there too.
- `probe --pass-regex <regex>` (plan files: `passWhen: { "regex": "<pattern>" }`,
  documented as the same thing) is an opt-in success predicate that
  replaces the exit code as the verdict for both the baseline and every
  mutant run: "passed" is the regex matching that run's own combined
  stdout+stderr, "failed" is the regex absent, whatever the exit code
  says (task `a435469b`, GitHub issue #225). Motivated by a PHP/Drupal
  monorepo running orchestrator-workflow 0.31.0, where phpunit 9.6
  exits `1` on a fully green suite because of deprecation notices, so
  every probe against it reported `baseline_failed`, and a
  `sh -c '... | grep -q "^OK ("'` shell-out workaround fixed the
  baseline only by losing the mutant run's own exit-code signal (a
  crash and a genuinely failing test then looked identical). A
  non-zero exit alongside a regex match is reported as a pass, with a
  `warnings` entry naming the exit code; a zero exit without a match is
  still a failure, with its own `warnings` entry naming the pattern, the
  side (baseline or mutant), the log path, and a truncation caveat when
  either side's captured tail was cut. The compiled pattern (both
  `--pass-regex` and `passWhen.regex`, through one shared
  `compilePassRegex`) always carries the `m` flag, unlike
  `--require-baseline-evidence`'s flagless compile: `^`/`$` anchor per
  LINE of the combined buffer, not only to its very first/last
  character, so the README's own `^OK \(` recipe still matches a real
  runner that prints something (a version banner) ahead of its green
  summary line. Independent of `--require-baseline-evidence`: the two
  may be given together, one without the other, or neither; given
  together, the evidence gate is now genuinely checked first (a
  same-baseline miss on both refuses `baseline_evidence_not_matched`,
  never `baseline_failed`, matching what was always documented). The
  generic byte-identical fallback (the zero-tests safety net for a
  runner neither built-in detector recognizes) is NOT disabled by
  `--pass-regex`: a custom "pass" string that itself matches on
  byte-identical, nothing-executed output from both runs is exactly the
  false-positive shape the fallback exists to catch, whichever predicate
  is in charge of the verdict. A mutant run that crashes SILENTLY (no
  output on either stream, an unusual exit code) is reported `killed`
  the same as a genuine test failure would be (neither can match an
  absent regex), and is distinguishable in the envelope via
  `test.exitCode` (kept as data regardless of `--pass-regex`) together
  with the empty `test.stdoutTail`/`test.stderrTail`, plus its own
  `warnings` entry naming the crash; no new typed field was added for
  this, and none is planned -- a crash that prints its own stack trace
  before exiting (an ordinary uncaught `throw`, not a segfault) is NOT
  distinguishable from a real test failure by this or any other
  mechanism here (same exit-non-zero, same `killed` verdict, and
  neither carries a miss warning), and a runner that prints its full
  green summary before crashing in its own teardown reads as a pass,
  same as a naive `grep` wrapper would read it -- both are inherent
  limits of an output-only predicate, not gaps this package closes. A
  run that reported NO exit code at all is never a pass under
  `--pass-regex`, whatever its partial output matched: a baseline that
  timed out, or whose own process-group LEADER (the `sh -c` wrapper each
  command runs under) was killed, refuses
  `inconclusive`/`baseline_failed` (never `baseline_evidence_not_matched`,
  a finding about a pattern rather than about a run that never
  finished), and such a mutant run reports `inconclusive`/`timeout`
  rather than `killed`/`survived`, with the signal shape named in
  `warnings` on both sides and no reason string added to the contract.
  A kill the wrapper shell SURVIVES is a different, un-ruled-out shape
  and is documented as such: an OOM killer picks the memory hog rather
  than the group leader, and whether the shell then reports the death as
  an ordinary exit code 128 + N depends on what runs after the killed
  command in the `-t`/`--pre` string itself -- a trailing `; exit $?`
  reports it that way, but a script whose last command still succeeds
  afterward (`; echo done`) or a pipeline (`| tee log`) reports that
  command's own exit code instead (typically `0`, no warning at all),
  and the single bare command most values actually are is `exec`'d by
  the wrapper in place of itself, so a kill on it reaches the
  process-group leader and lands in the no-exit-code case above, never
  in the 128 + N one. When the code IS reported, a green summary line
  printed before the kill still reads as a pass, one more inherent limit
  of an output-only predicate (nothing distinguishes `137` from a shell
  reporting SIGKILL from `137` a runner chose itself). Both verdict
  directions warn on it: an exit code in the 128 + N band (`129` through
  `192`, 128 plus every signal number a POSIX system can deliver) gets a
  `warnings` entry naming the code, the signal number it would encode
  and that the run may have been cut short: on the pass direction in
  place of the plain "matched despite a non-zero exit code" entry, on
  the fail direction as an additional entry (an out-of-band non-zero
  failing code carries no warning at all); the verdict is unchanged.
  The mutant-run miss warning fires only for an AMBIGUOUS miss (a
  truncated tail, an exit code of `0` disagreeing with the predicate, or
  `--expect pass`, where a miss means the mutant
  survived); a textbook kill under `--expect fail` carries none, so a
  healthy plan run's `warnings` stays empty instead of collecting one
  near-duplicate entry per killed mutant.
  Given on both the command line and inside a `--plan` file at once, the
  command-line value wins, the same precedence `-i`/`--expect`/
  `--timeout` already follow against their own plan-file counterparts.
  An unparseable pattern, in either place, is a usage error before any
  run starts.
- PHP support (task `55b0a5cc`, issue #225 part 3): `verify` gains three
  default detectors built from real captured tool output (see
  `test/fixtures/README.md`) -- `phpunit` (`OK (N tests, M assertions)`;
  `FAILURES!`/`ERRORS!`/`WARNINGS!`/`OK, but incomplete, skipped, or
  risky tests!` plus a `Tests: N, Assertions: M, ...` tally line whose
  named counts (`Errors`, `Failures`, `Warnings`, `Skipped`,
  `Incomplete`, `Risky`) are read by name rather than by a fixed
  position, since PHPUnit prints `Errors:` before `Failures:` -- and
  only the `ERRORS!` marker, never both -- whenever a run has both; and
  `No tests executed!`; PHP-level deprecation notices surfaced as
  detector warnings). The `phpunit` summary is derived from the run's
  own stated total by spending it category by category: Skipped,
  Incomplete and Warnings did not execute (PHPUnit counts a
  `No tests found in class "X".` warning as a whole synthetic test, and
  that run exits `0`), Failures, Errors and Risky did, so `executed` is
  the total less the first group and `passed` is what remains of it
  after failures and errors -- clamped, so `passed + failed + errors +
  skipped + warnings` always equals the stated total and `passed` never
  goes negative, for a truncated or self-contradictory tally too. A
  numbered `N) Class::method` entry becomes a `failures` entry only
  under an error or failure section header, since a risky or incomplete
  entry carries the same header shape (including the plural-header
  shape, `There were 2 failures:` / `There were 2 risky tests:` in one
  run); an entry's message ends at the next entry, the `--` divider, the
  next section header, a marker line, or the tally; the entry's own
  `file:line` locator is read only from a line preceded by a blank line
  inside the entry, PHPUnit's own convention, so a message ending in
  `:<digits>` (an address-and-port, say) on the entry's own first line
  is never mistaken for it. `phpstan` (` [OK] No errors` / a per-file table
  closed by ` [ERROR] Found N errors`), and `phpcs` (one `FOUND N
  ERRORS ... AFFECTING M LINES` summary PER FILE, summed across every
  file rather than read from the first alone, over per-finding rows) --
  selected by output shape exactly like the existing vitest/tsc/eslint
  detectors, pinned to never shadow them (a vitest fixture still
  selects `vitest` with every PHP detector present as a candidate, now
  also pinned for phpstan/phpcs against `DEFAULT_DETECTORS` directly).
  `probe`'s zero-tests guard now also recognizes PHPUnit's `No tests
  executed!` and any run whose derived executed count is zero (an
  all-skipped run, a warnings-only run, a stated `OK (0 tests, 0
  assertions)` -- the last defensive, not observed from a real capture),
  yielding `inconclusive`/`no_tests_executed` the same way it already
  does for vitest's and node's zero-count shapes (reusing the new
  `phpunit` detector's `phpunitZeroTestsExecuted` rather than restating
  its patterns). A red run that is ALSO all-skipped/incomplete is never
  misread as "nothing executed" by this guard, and an all-risky run is
  deliberately not flagged, since a risky test did run.
  `drift` now scans `.php` comment sites too: `//`, `#`, `/* ... */`,
  and docblock ` * ` continuation lines (PHP is the only recognized
  language that accepts both the `//`/`/* */` and `#` comment
  grammars); a `#[...]` PHP 8 attribute is excluded from the `#` line-
  comment grammar (real code, not a comment). README and the installed
  skill (`assets/skill/SKILL.md`) gain a "Non-JS test runners" section
  naming the exit-code assumption these three inherit (including
  PHPCS's measured `0`/`1`/`2`/`3` mapping, distinct from PHPUnit's and
  PHPStan's, and PHPUnit's own zero-exit hole: a warnings-only run exits
  `0` under 9.6, so the zero-tests guard and not the exit code is what
  catches it) and pointing at the `--pass-regex`/`passWhen` pass
  predicate and the composer `vendor-dir`/`bin-dir` auto-link rule
  (issue #225 parts 1 and 2, tasks `a435469b`/`6c7e1532`) without
  restating their surface. Running PHPUnit itself is out of scope for this
  package's own CI: the new detectors and the zero-tests/drift
  additions are proven only against the captured fixtures.
- Four corrections to the composer/`node_modules` link policy
  and the untracked-file sync's symlink check (task `6c7e1532`):
  (1) `copySymlink`'s containment check now runs on the link's OWN
  target -- resolved against the link's own directory the same way the
  filesystem would follow it, then through `resolveDeepestExisting` --
  rather than on the recreated link at `dest`: for a DANGLING target,
  realpathing `dest` itself cannot follow through the missing target and
  fell back to `dest`'s own (always-contained) path, so the check read
  back as trivially contained no matter where the target actually
  pointed. An untracked absolute symlink whose target does not exist yet
  (a `--pre` writing through it lands in the real tree, with the
  warning this time) and a relative `..`-escaping target with an
  in-repo `--log-dir` are both pinned in `test/probe-worktree.test.ts`.
  (2) Rule 3's target half now also refuses a candidate whose target
  sits at or under the repository's OWN `.git` directory, whatever name
  the candidate sits under: `.git` is neither a tracked path (git's own
  index never lists it) nor a nested repository's boundary
  (`nestedRepoBoundaryRelPath` looks for `<root>/.git/.git`, which a
  plain `.git` directory does not have), so an auto-discovered
  `node_modules -> .git` reached neither check and was linked with no
  warning. Pinned by a unit test in `test/link-policy.test.ts` and an
  e2e fixture that hashes the repository's own `.git` directory before
  and after a gitignored `node_modules -> .git` candidate's `--pre`
  tries to write into it. (3) The nested-repository refusal's own
  wording now opens with what is actually known -- "its target <path>
  sits inside a nested repository at <rel>, whose content the outer
  index never lists" -- rather than "git tracks its target <path>",
  which the outer index never does for nested content; the existing
  unit test and the submodule e2e fixture are updated to match. (4) The
  destination half of rule 3 (a directory named by repository content)
  now reads "could not check whether git tracks <path>; treated as
  tracked" instead of an unconditional "git tracks it" when the `git
  ls-files` listing behind it could not run, matching the target half's
  own fail-closed wording; pinned by a new unit test and by the
  existing PATH-shim fixture in `test/probe-worktree.test.ts`, which now
  asserts both halves' fail-closed wording in the one envelope a failed
  listing produces. README's rule 3 paragraph and Limitations section
  are corrected to match: the nested-repository boundary is walked from
  the root DOWN to the target, reporting the outermost boundary
  crossed, not "from the target up to the root" as previously stated,
  and Limitations now names the DANGLING-`.git`-symlink boundary gap
  (`fs.existsSync` on a symlink answers `false` when its target is
  missing, so a nested repository marked only that way is not caught)
  as a known, unaddressed residual rather than a fixed one.

- A sweep of `-m` budgets against a real `probe --plan` envelope (in-process
  `buildEnvelope`/`reconcileEnvelopeDiffTruncation`, plus a manual CLI sweep
  across 3,000-4,300 and a coarse 500-20,000 pass) found no case of the
  envelope exceeding its requested bound with no warning naming the true
  length; a regression test now pins that contract for the swept plan shape
  on every build (in bound with no could-not-be-met warning, or over the
  bound with a warning naming the exact final length). Two
  existing spawned-CLI regression tests that asserted a raw
  `stdout.length` ceiling near the reduction's edge lost that byte check in
  favor of the actual contract they already asserted next to it
  (`truncated`, the hunk-boundary shape, the descriptor clause).
- `agent-primitives drift --base <rev> --head <rev>`: a prototype-scope
  identifier-drift guard. Collects the identifiers whose declaration a
  git range removed (a regex over `git diff -U0`'s removed lines: a
  top-level/exported TS/JS declaration, a top-level JSON/YAML config
  key, or a wholly deleted file's own basename; an identifier declared
  again on an added line anywhere in the same diff is treated as MOVED,
  not removed), then reports every mention of those identifiers still
  present at `--head` in a doc file or a source comment, word-boundary
  matched so `RuntimeError` never matches `setRuntimeError`. A site is
  allowlisted by default (`--strict` reports it too, flagged) when it
  matches an `--allow` glob, sits in a released CHANGELOG section (never
  `## [Unreleased]`), sits under a `docs/**/migration*` path or a
  Markdown heading naming "migration", or its line carries a small,
  documented historical-phrase word list (`former`, `no longer`, `used
  to`, ...). Envelope carries `removed_identifiers`, `sites`,
  `allowlisted` (each with a `reason` on an allowlisted entry) and
  `counts`; exit `0` no site reported, `1` at least one site reported,
  `2` a usage error (`cwd` outside a git work tree, a bad `--base`/
  `--head`, or a failing `git diff`). Motivated by, and its synthetic
  test fixture modeled on, a real case: a deleted local error type that
  several docs and source comments across a repository kept describing
  as current after the deletion, including two sites a human reviewer's
  own pass had missed. Known limits: only TS/JS/JSON/YAML declarations
  and only `.md`/`.mdx`/`.txt` docs plus a fixed list of comment-bearing
  source extensions are scanned; a declaration split across more than
  one line, or a name bound by destructuring, is missed; no cross-repo
  scanning.
- `probe --plan <path>`: a JSON file naming one test command (and
  optionally `pre`, `isolation`, `expect`, `timeout`) plus a list of
  mutants, run against ONE shared baseline instead of one baseline per
  mutant. Each mutant is applied with its applied content verified by
  hash, tested, and restored with the restore verified by hash BEFORE the
  next one is applied; the loop re-hashes the target itself before every
  apply, so a restore that silently did not happen stops the plan instead
  of letting the next mutant land on the previous one's content. Every
  guarantee of the single probe holds per mutant: the same in-flight
  marker and backup, the same abort handling, the same restore-then-verify
  step. A restore that could not be verified (`restore_failed`), a target
  found not to be back at its pre-mutation content
  (`target_not_restored`), a failing baseline (`baseline_failed`) or a
  signal (`aborted`) is terminal: nothing further is applied and every
  remaining mutant is reported `not_run` rather than `inconclusive`.
  `-i worktree` syncs one worktree for the whole plan and removes it
  once; the lock is taken once for the whole plan (keyed on the
  repository, or outside one on each distinct target file). The envelope
  carries `plan: { baseline, results, summary }`, with the four
  `mutation_probe` contract fields, the `test` phase and a `status` per
  mutant, and `summary` counting killed/survived/inconclusive/not_run.
  Exit codes stay 0/1/2, one step stricter than for a single probe: `0`
  only when every mutant was killed per its `expect`, `1` when the plan
  concluded with a survivor, `2` for a wrong invocation or a plan that
  could not conclude. `--plan` is mutually exclusive with `--file`, `-n`,
  `-r`, `-M`, `-w`, `-p`, `-t` and `--pre`; the three run-shaping options
  a plan file can also set -- `-i`, `--expect`, `--timeout` -- override
  the plan's own value when given on the command line, and a mutant's own
  `expect` wins over both. `--link` and `--allow-outside` have no plan
  key at all and are command-line only for a plan. Past about eight
  mutants the envelope no longer fits the default `-m 8000` and is
  reduced to it like any other result (`truncated: true`, entries losing
  their `test` phase, the tail of `results` replaced by a marker): raise
  `-m` or read the full result at the `result-full-<run-id>.json` path
  the envelope's `logs` names. `plan.summary` is held out of that
  reduction (see `keepWhole` below), so its counts cover every mutant of
  the plan, including the entries the envelope no longer shows -- unless
  the whole result is cut back to the fixed fields (`truncated` plus a
  warning naming that outcome), which drops `plan.summary` along with
  everything else instead of showing it past the bound. Plan validation
  (unknown keys, a missing `test`, an empty `mutants`, a mutant with two
  forms or none, a file outside the containment root, an unusable plan file)
  runs before the lock, the marker, the baseline or any worktree and names
  the offending path inside the plan. `test`/`pre` in a plan file are shell
  commands with the same trust boundary as `-t`/`--pre`: fill them only from
  a task assignment, never from repository content. Setup through baseline
  (isolation fallback, containment, the lock, stale-marker recovery, the
  worktree sync, every target's backup, the baseline and the re-hash
  after it) is ONE implementation both entry points call, as the mutant
  step already was, so the two cannot drift apart on a refusal they
  share. The library entry points `probePlan()` and `parsePlanFile()` are
  exported alongside `probe()`.
- `buildEnvelope`/`applyCaps` take `keepWhole`: dotted paths into the
  result whose value is reported whole, exempt from every structural cap
  and from the key budget of the object holding it, the way the fixed
  envelope fields already are. Every candidate is measured after the
  held path is folded in, so a candidate that fits still respects the
  bound with the held value included; it only spends the budget on that
  value instead of another, which is for the small field a reader cannot
  do without once the rest was cut. This does NOT mean a held path is
  free: a value too large for the skeleton plus itself to fit under the
  bound at all is not shown oversized past the bound, it is dropped
  along with the rest of the payload in the existing "reduced to the
  fixed fields only" total-loss outcome, its own warning included --
  which is why the docblock says to name only a small, bounded value
  here. `probe --plan` names `plan.summary`, and nothing else in this
  package names anything: with no path given the reduction is exactly
  what it was.
- `listRegisteredWorktrees` (`-i worktree`'s registry listing, used by
  the removal, the leftover recovery, and `cleanupWorktree`'s
  assertion) falls back to a third source, the `gitdir` files under
  `<git-common-dir>/worktrees/<id>` read directly, when neither
  `git worktree list` form ran to a parse: a dead listing no longer
  leaves a leftover judged by the disk alone. The fallback lists linked
  worktrees only (never the main worktree, which git's admin directory
  carries no entry for) and keeps an admin entry whose target no longer
  exists on disk apart from the entries that still do, so a stale entry
  naming a worktree just removed reads as gone, never as still
  registered; a `gitdir` file written relative (`worktree.useRelativePaths`,
  git 2.48 or newer) is resolved against its own admin entry directory,
  git's own semantics, never the calling process's `cwd`. An entry
  whose `gitdir` file is missing, unreadable, or empty makes the WHOLE
  listing `ok: false` rather than being silently dropped from an
  otherwise `ok: true` one, named by id and reason in `detail`:
  `ok: true` for this form means every admin entry was read to a
  parse, so an entry's absence from `paths` can be trusted to mean it
  really is gone.
  `cleanupWorktree`'s previously-unverified double-fault outcome (both
  `git worktree list` forms dead, the target never registered in the
  first place) is now asserted (`verified: true`) whenever this source
  can list something -- which also makes a scratch-shaped worktree this
  source reports as registered eligible for removal even when it sits
  outside the current run's `--log-dir`, the same as one a real
  `git worktree list` reported.
- `doctor`'s `stale-worktree` check and the marker's own
  `SCRATCH_OWNER_MAX_AGE_HOURS`-bound age check (previously applied
  only to the scratch owner record) now also bound the repository-keyed
  worktree marker itself, against its own `timestamp` field: a marker
  whose pid is alive but whose record is older than the bound is
  reported as a leftover with the manual removal command, the same as
  a dead pid, since an alive pid recycled onto an unrelated process
  proves nothing once the marker's own record is this old.

- `probe -p/--patch` now needs neither `--file` nor `-n/--line`, so
  `-p <patch> -t '<cmd>'` alone is enough for a single-path patch;
  both are still required for `-r` and `-M`/`-w`, which have nothing
  to derive them from. `--file` is derived from the single path the
  patch touches; the reported `mutant.line` is the first line at which
  the dry run's applied result differs from the original -- the applied
  file, never a reading of the patch text, so the reported number and
  the `before` content quoted beside it always name the same line
  whatever the diff's shape (leading context or none, a removed `---`,
  an added `++`, a pure deletion, several hunks, CRLF). A `-n` passed
  alongside `-p` is neither used nor echoed back: when it names a
  different line than the patch changes, both numbers go into a
  warning. A patch touching two or more paths with no explicit `--file`
  is `status: "usage_error"`, `reason: "patch_file_ambiguous"`,
  exit `2`. A `-p, --patch` path that cannot be used (missing, not a
  regular file -- a FIFO, a socket, a directory -- unreadable
  permissions, or larger than the 8&nbsp;MiB `PATCH_MAX_BYTES` cap) is
  `status: "usage_error"`, `reason: "patch_not_readable"`, exit `2`,
  decided once from the path's metadata alone (a `stat` for the kind of
  file and its size, an access check for the permissions; the patch is
  never opened in-process, so a FIFO cannot block the probe and an
  oversized file is never loaded) before the `--file` derivation, the
  lock, the in-flight marker or any worktree, so it applies the same
  whether `--file` was given explicitly or is derived from the patch,
  and a refusal leaves nothing behind.
- A global `--json` option: a no-op alias for `-f json` (already the
  default). Combined with an explicit `-f text` it is
  `status: "usage_error"`, `reason: "format_conflict"`, exit `2`.
- An unrecognized option's `usage_error` message now names a common
  alias when it has one (`--text` -> `-f text`; `--json` is itself a
  real global option now, so it never reaches this hint), and an
  invalid `-f`/`--format` value that looks like a path adds a hint
  pointing at `probe`'s `--file` instead.
- `probe --help`'s description now states that `--file` is long-only
  because the global `-f` is `--format`, and that every global option
  may precede the subcommand; the packaged skill (`assets/skill/
SKILL.md`) and the README gained an "Invocation templates" section
  with a copy-pasteable line for each mutant form plus `verify` and
  `doctor`.
- `probe --env NAME=VALUE` (repeatable, task `b00efca1`): applied to
  both the baseline and the mutant's `--pre`/`-t` runs (they share one
  merged environment), and echoed back under the mutant's `test.env` so
  the isolation a caller asked for is visible in the report instead of
  only inferable from the command string. Also echoed once at the run
  level (a top-level `env` field, present whenever `--env` was given, on
  every status including `baseline_failed`, where there is no `test`
  phase for a per-test echo to live under). A value whose NAME carries
  `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`/`CREDENTIALS`, or `KEY` as
  its own `_`-delimited segment (case-insensitive; anchored via
  `SECRET_ENV_NAME_PATTERN` in `session.ts`, the segment sitting at the
  start or end of the name, or between two underscores) is redacted
  (`"<redacted>"`) in both places; values must not otherwise be assumed
  private, since the envelope is routinely pasted into PRs and task
  trackers. The anchoring is a fix in its own right, not just a rewording:
  the earlier pattern matched the recognized word ANYWHERE in the name, so
  `TOKENIZER_MODEL` and `KEYBOARD` were redacted despite carrying no
  secret, false positives now gone (`TOKENIZER_MODEL`/`KEYBOARD` are
  pinned verbatim in `test/cli.test.ts`'s redaction matrix alongside
  genuine matches like `API_TOKEN`). This redaction covers only the two
  echoes (`env`/`test.env`); it never touches `test.stdoutTail`/
  `test.stderrTail` or the linked exec log, so a value the test command
  itself prints still appears there verbatim regardless of its NAME.
  Fixes a friction measured across 109 real `probe`
  invocations in one batch: `agent-preflight`'s suite needs an isolated
  `HOME`, and every one of those invocations had to smuggle
  `HOME=<dir> npx vitest ...` into `-t` instead. No `=`, or an empty
  name before it, is a usage error. Not wired into `--plan`: combining
  `--env` with `--plan` is refused outright (added to
  `PLAN_EXCLUSIVE_OPTIONS` in `src/cli.ts`) rather than silently
  ignored.
- `probe`: a one-line stderr notice, printed before the baseline starts,
  when no `--timeout` was given and the test command looks like a whole
  test suite rather than one targeted file: `npm test`, `npm run test`/
  `npm run test:<anything>`, `yarn test`, `pnpm test` (each with nothing
  after it but flags, a bare `--` argument separator judged by the same
  rule as any other token -- it is flag-shaped in its own right, so it
  never alone disqualifies a command from looking full-suite, and
  whatever follows it is judged the same way, token by token, with no
  separate stripping step: `npm test -- --coverage` is still full-suite
  shaped, `npm test -- test/x.test.ts` is not), or `vitest
  run` (bare, through `npx` or not) with nothing after it but flags,
  `-t <pattern>` and a forwarded `--` included (task `b00efca1`, round
  3: the npm/yarn/pnpm shapes above always stripped one leading `--`
  before judging what followed it, but the `vitest run` shape never did
  -- so `npx vitest run -- --coverage` was misclassified as NOT
  full-suite, missing the timing hint for a command that genuinely runs
  the whole suite twice; both shapes now use the one uniform token rule
  above, with no separate stripping anywhere, so the same `--` is judged
  the same way regardless of which prefix precedes it. Pinned in
  `test/cli.test.ts`'s matcher table). A targeted command such as
  `vitest run test/x.test.ts` prints nothing. Names that the baseline
  and the mutant run the command serially with no bound and that
  `--timeout` caps each run. The result also now carries
  `totalDurationMs` (wall-clock time of the whole `probe()` call, every
  branch), the same field name and meaning `verify`'s result already
  carries. Motivated by the same friction as `--env` above: a probe
  over a full-suite command runs it twice with no visible runtime hint.

### Changed

- `--link` (task `6c7e1532`, behaviour change): a value containing
  `$(` or a backtick is now a usage error, the same check newly applied
  to a `--plan` file's own `link` field and the repo defaults file's
  `link` field (see the Added bullet above) -- applied to `--link`
  itself too so all three `link` sources genuinely share one rule
  rather than the command-line flag being merely assumed safe.
- Every link `probe -i worktree` does NOT create is now a warning in
  the envelope naming the directory, the file and entry that asked for
  it when repository content did, and the rule that refused it (task
  `6c7e1532`, behaviour change): a candidate outside the repository, a
  candidate over the copy's root or over a directory the run writes
  into, a tracked directory named by repository content, and a
  candidate already covered by a directory linked earlier in the same
  run (composer's default `vendor/bin` inside `vendor` is that last
  case, and is now reported rather than dropped before the policy sees
  it).
- `probe -i worktree`'s worktree cleanup unlinks a recorded worktree
  path that is itself a symlink, when the link sits at the probe's own
  scratch shape under the run's `--log-dir` (task `6c7e1532`): the gate
  judges a path through realpath, so such a leftover used to be refused
  (correctly, since nothing may delete the tree at the other end) and
  then kept alive by its own marker on every later run. Unlinking a
  symlink never reaches what it points at. Only a broken linking step
  can leave one, which the link policy above now prevents; this is the
  second line of defence for it.
- Test hygiene from the PR #218 reviews (task `482c3ef7`, no behaviour
  change): the node `--test` dot-reporter fixture builder shared by
  `test/probe-zero-tests.test.ts` and `test/plan.test.ts` now lives once
  in `test/helpers/node-test-dot-repo.ts`; the CLI's `--plan` help
  sentence is generated from `PLAN_EXCLUSIVE_OPTIONS` instead of
  hand-mirrored, with a cli test pinning it; the README's own mirror of
  that same flag list is corrected and pinned by the same test, so it
  cannot drift from the array again; and `probePlan`'s
  `--require-baseline-evidence` truncated-tail warning is now also
  exercised on the plan path, not only the single-probe path.

- `test/drift.test.ts`'s "'++ ' as content" case now uses a real rename
  (`src/old-thing.yaml` -> `src/new-thing.ts`, `---`/`+++` naming
  different paths) instead of a same-path edit: a same-path edit cannot
  observe a compound mutant that disables the whole `!sawHunk &&
  raw.startsWith("+++ ")` header branch, since `newPath ?? oldPath`
  then falls back to the SAME file either way; a same-extension rename
  is equally unobservable, since `extractIdentifier` classifies purely
  by extension bucket. Renaming across buckets (a YAML config key
  becoming a TS declaration) is what makes the fallback path
  disagree with the real one.
- `test/import-boundaries.test.ts`: a new guard, parsing each of
  `src/probe/session.ts`, `step.ts`, `setup.ts` and `index.ts`'s own
  import specifiers off the real TypeScript AST (`typescript`'s
  `createSourceFile`, already a devDependency), that fails if
  `session.ts` imports `step.ts`, `setup.ts` or `index.ts`, if
  `step.ts` imports `setup.ts` or `index.ts`, or if `setup.ts` imports
  `step.ts` or `index.ts` -- pinning the one-way layering `index.ts`'s
  own docblock already describes (`session.ts <- step.ts <- setup.ts
  <- index.ts`), so far kept only by convention. Parsing the AST
  (rather than a regex over the source text) is what lets the guard
  cover every statement form that actually creates a module
  dependency -- `import ... from "spec"`, `export ... from "spec"`, a
  bare side-effect `import "spec";`, and a dynamic `import("spec")` /
  `await import("spec")` -- while never mistaking a `from "..."`
  inside a comment or an unrelated string literal for one, and treats
  a relative specifier without an extension (`./index`) as the same
  module as its `.js`-suffixed form. A `type`-only import counts as
  forbidden the same as a value import: it is still a structural
  dependency, and nothing stops it becoming a value import later. The
  one documented, tolerated exception is the type-only `index.ts` <->
  `plan.ts` cycle (`PlanMutantSpec` one way, `ExpectVerdict`/
  `IsolationMode` the other); the guard does not require that cycle to
  exist, only that if both directions are present, neither is a value
  import.
- README's `--plan` example's `mutants` array now names only neutral
  placeholders (`src/example.ts`, `src/example-two.ts`,
  `src/example-three.ts`) instead of mixing one placeholder with a
  real source line (`src/lock.ts` line 44, `n > 0`) that was already
  inaccurate and drifts with every edit to that file. A one-line
  caveat next to the snippet says the example illustrates the plan
  file's shape only; it was never meant to be run as-is.
- `test/probe-worktree.test.ts` now pins `session.ts`'s stale-worktree
  marker removal after a successful recovery (`if (staleWt)
  removeMarkerFor(realRoot)`) with a test that mocks `beginWorktree` to
  fail before it reaches its own `onWorktreeAttempt` write: the run's
  own new-worktree attempt always rewrites the same marker on success,
  which would otherwise mask an inverted condition there entirely. A
  negative control confirms a normal run with no marker to recover
  still writes none.
- `test/doctor.test.ts`'s "hints: is empty when no required tool is
  missing" case now runs `doctor()` against a fresh `cwd` and `lockDir`
  fixture, the same isolation every other case in the file already
  uses, instead of the real defaults (`process.cwd()`, the uid-scoped
  tmp directory every `agent-primitives` invocation on this machine
  shares). This case's assertion is exact (`hints.length` must be `0`),
  so it is the one case in the file a stray hint from unrelated ambient
  state under those real defaults would actually break. The cause is
  reproduced, not merely plausible: a concurrent real `agent-primitives
  probe -i worktree` run against the same checkout (or any live scratch
  worktree already registered against it) makes `doctor`'s
  `stale-worktree` check emit exactly one "a live probe (pid N) owns
  the scratch worktree at ..." hint, because that check reads `git
  worktree list` for `containmentRoot(cwd)` regardless of `lockDir`;
  the shared lock directory is a second, weaker channel through the
  same check's own worktree-marker lookup. Pinning both `cwd` and
  `lockDir` to fresh, empty fixtures removes both channels.
- Internal, with no change to what a single probe reports: `probe()`'s
  pipeline is split into a shared setup, a per-mutant step
  (`prepareMutant` + `runMutantAttempt`), and a shared teardown, so
  `probePlan()` runs the very same step in a loop rather than a second
  copy of it. The signal, abort and worktree-cleanup machinery moved into
  one run controller both entry points use. `test/probe.test.ts` guards
  the extraction against four `probe()` results recorded from the package
  as it stood before it (`test/fixtures/single-probe-result-master-a908951.json`).
- Internal, no behavior change: `src/probe/index.ts` (formerly one
  ~3300-line file) is split into `probe/session.ts` (the run controller:
  signal/abort handling, the in-flight-run tracking the handler waits
  on, the `-i worktree` session, and `openTarget`'s per-file
  backup/restore, plus the shared field-shape result types every layer
  needs to name), `probe/step.ts` (the per-mutant step, `prepareMutant`
  + `runMutantAttempt`, built on `session.ts`), and `probe/setup.ts`
  (the shared `openRunSetup`: isolation fallback, refusals, containment,
  the lock, stale-marker recovery, the worktree sync, every target's
  backup, the baseline), with `index.ts` left holding the CLI-facing
  option/result types and the two entry points, `probe()` and
  `probePlan()`. Import direction is one way,
  `session.ts <- step.ts <- setup.ts <- index.ts`; in this codebase
  `setup.ts` ends up needing only `session.ts` (the mutant step it runs
  before its own baseline is supplied by its caller). The package's
  public surface (`src/index.ts`'s exports, `dist/index.d.ts`) is
  unchanged; the same identity fixture above still passes without
  regeneration.
- `-t/--test` is no longer enforced by the option parser (so `--plan` can
  supply it) but by the probe command itself; omitting both is still
  `status: "usage_error"`, exit `2`.
- `probe -r/--replace` and `-M/--match` (with `-w/--with`) without
  `--file`/`-n` now report `status: "usage_error"` with the message
  `probe: --file is required for -r/--replace (only -p/--patch can
derive it from the patch)` / `probe: -n/--line is required for
-r/--replace (...)`, instead of commander's own `required option
'--file <path>' not specified`; `status: "usage_error"` and exit `2`
  are unchanged.
- `probe -p/--patch` no longer reports
  `-p/--patch has no hunk header to derive -n from; pass -n explicitly`:
  nothing reads the patch's text any more, so there is no such
  condition to detect. A patch with no content change reaches the
  `--file` derivation as before -- for a rename-only patch that is the
  rename's destination, which does not exist yet, so the run ends in
  `status: "usage_error"`, `reason: "file_not_found"` naming that path,
  instead of `inconclusive`/`mutant_not_applicable`.
- `probe -p/--patch` with an explicit `-n/--line` reports the patch's
  first changed line as `mutant.line` instead of echoing `-n`, and
  warns when the two differ (`-n 5 differs from the patch's first
changed line 12; mutant.line reports 12`); `-r` and `-M`/`-w` still
  mutate exactly the line `-n` names.

### Fixed

- `probe`'s 128 + N band warning on a failing baseline now precedes
  every baseline-side refusal (task `150b07ba`): the two refusals that
  used to return ahead of it, the evidence gate
  (`baseline_evidence_not_matched`) and the zero-tests gate
  (`no_tests_executed`), now carry it too. Separately, the warning
  names the reason the result actually carries (`no_tests_executed`,
  `baseline_evidence_not_matched`, or `baseline_failed`) instead of
  always reading "the baseline_failed verdict"; on the plain
  `baseline_failed` path only that wording changed. A baseline killed under a surviving wrapper (exit `137`)
  with both `--pass-regex` and `--require-baseline-evidence` set now
  reports both that nothing proves tests ran and that the run may have
  been cut short, not only the former; the same pairing now also holds
  for a band-code baseline whose own output shows zero tests executed.

- `escapingRootMentions`'s `--log-dir` exclusion no longer swallows a
  SIBLING of the log dir along with it (task `5f9c57de`): the scratch
  (`--log-dir`) spelling now has its own boundary function,
  `isScratchPathBoundaryAt`, separate from the root's own wide rule
  (`isPathBoundaryAt`, unchanged). It accepts exactly four terminators --
  `/`, a backslash-escaped `/`, a backslash-newline pair followed by one
  of those two, or the end of the text -- none of which is ever itself a
  legal filename character, so none can manufacture an exempt region a
  sibling name rides through. This closes every sibling shape whose name
  continues the log dir's own spelling with a filename-legal word
  terminator -- `@`, `~`, `,`, `=`, `{`, `?`, a non-ASCII whitespace code
  point, or a quote (bare or wrapping a continuing sibling, including
  under `'`, `"` or a backtick, since the shell re-joins a word across a
  quoted or backtick-substituted segment) -- and the shell's own
  separator set (space, tab, newline, `|`, `&`, `;`, `<`, `>`, `(`, `)`)
  once quoted, all previously read as ending the scratch match and
  exempting the sibling, and the root mention underneath it, right along
  with the log dir itself. The trade is one GENERAL over-refusal instead:
  a bare `--log-dir` mention followed by anything other than the four
  terminators is refused rather than excluded, even where the shell would
  in fact still reach the isolation copy -- for example a mention
  immediately followed by a shell operator with legitimate isolation
  traffic after it (`cd <log-dir> && node t.js`), any line ending
  directly after the mention (LF or CRLF), a trailing comment marker
  (`<log-dir>#note`), or an unquoted `PATH` segment
  (`PATH=<log-dir>:/usr/bin`). Pinned at the `escapingRootMentions` level
  (the quoted-ender siblings under every quote style and `&`/`(`/`;`, the
  non-ASCII whitespace siblings including a miscased one under an
  injected `caseInsensitive` flag, the unquoted space sibling, the
  accepting half unquoted and quoted and across a backslash-escaped
  separator, a backslash-newline pair and end of text, and the general
  over-refusal shapes above) and through a real `probe` run (a double-
  quoted `<root>/l 2` sibling directory refused; a genuine `-i worktree`
  run under the same `--log-dir` still completes).

- `probe` refuses a test command, `--pre`, or an `--env` value that
  escapes `-i worktree`'s isolation copy (task `5bf16459`): a `-t` command
  of the shape `cd /abs/worktree/backend && npx vitest run ...` never
  touches the isolated copy at all and runs against the real, unmutated
  tree instead, reporting `survived` for a mutant the test actually kills.
  Any of the three channels that SPELLS THE REPOSITORY ROOT OUT LITERALLY,
  IN A FORM THE SCAN MODELS, is now refused outright (`reason:
  "test_command_escapes_isolation"`, a `usage_error`) before the run
  reaches its baseline, naming the offending channel(s), the matched
  region as that channel spells it (the root plus the path text after it,
  not the bare root), and the fix for that channel: a relative invocation
  resolved inside the copy or `--isolation inplace` for `-t`/`--pre`, a
  value relative to the package directory or `--isolation inplace` for an
  `--env` value, which cannot be "run relatively"; an absolute path to a
  runner binary under the root is refused the same way, with `--link`
  named as the fix for that shape. Because the check reads the raw text
  instead of tokenising or shell-parsing it, the spelling is caught
  whatever quoting, escaping, `=`-form or wrapper surrounds it (a plain
  `cd /abs/...`, a quoted path containing whitespace, a backslash-escaped
  space, a `--key=/abs` token, a `sh -c "..."` wrapper), and separator
  noise inside the path (`<root>//pkg`, `<root>/./pkg`, a
  backslash-escaped separator `<parent>\/<base>/pkg`, which every POSIX
  shell reads as a plain `/`, and a line continuation
  `<parent>\`+newline+`/<base>/pkg`, which the shell deletes) is tolerated
  as the same directory. The root is matched under two spellings (its own,
  as resolved, and its realpath, each also with spaces backslash-escaped),
  matched case-insensitively on a filesystem measured (by device and inode
  under the case-flipped spelling) to resolve a miscased path to the same
  directory and exactly otherwise, and only where the match ends at a path
  boundary, which is required only at the match's END, not at its START: a
  longer path that merely CONTAINS the root's spelling somewhere inside it
  (`/mnt/backup<root>/pkg`) is refused too, with the reported region
  starting at the root's own spelling. That end boundary is decided by
  enumerating what CONTINUES a path word rather than what terminates one,
  with the alphabet taken from POSIX shell word lexing, since the scanned
  string is what `sh -c` is handed: a portable filename character (`A-Z
  a-z 0-9 . _ -`) or any non-ASCII character continues the name, so the
  match is a different path's prefix and not a mention; a `/` continues
  the word as a further component and leaves it a mention; a `\` plus any
  character other than `/`, a newline, or an ANSI-C numeric-escape starter
  escapes a character inside the same word, so again not a mention; a `\`
  plus a newline plus a continuation defers to what follows the pair,
  which the shell deletes; a `\` before a `/` is a separator, so
  `<root>\/pkg` is refused; and a `\` before `x`, `u`, `U`, or an octal
  digit (`0`-`7`) is ALSO refused, over-refusing in the safe direction:
  bash/dash's `$'...'` (ANSI-C) quoting decodes `\xHH`,
  `\uHHHH`/`\UHHHHHHHH` and `\NNN` (octal) by numeric value, and `/` is
  reachable through any of them (`\x2f`, `\057`, `/`), so
  `$'<root>\x2fpkg'` reaches `<root>/pkg` exactly as `$'<root>/pkg'` does;
  the scan does not decode the escape, so the reported region stops right
  before the `\`. Everything else ends the word and is a boundary: the end
  of the string, whitespace, either quote, every POSIX operator character
  (`|`, `&`, `;`, `<`, `>`, `(`, `)` and a backtick), `$`, and punctuation
  such as `,`, `=`, `:`, `#`, `!`, `*`, `?`, `{`, `}`, `[`, `]` and `~`.
  So a sibling `<root>2`, `<root>-backup`, `<root>\ backup` (whose
  backslash escapes a space in its OWN name) or
  `<root>\`+newline+`-backup` is not a mention, while `cd
  <root>>/dev/null`, `cd <root><&-` and a backtick closing right after the
  root each name the root itself and are refused. Enumerating the
  continuations is what makes the decision total: an unforeseen character
  ends the word, so an unforeseen spelling over-refuses (with a named
  remedy) instead of silently reaching the real tree, at the cost of a
  false refusal for a sibling named with a character outside the portable
  set (`<root>~`, the likeliest real hit -- an editor's own
  backup-directory convention -- and `<root>@2`); the scan also reads raw
  text rather than shell semantics, so a mention sitting in a here-doc
  body, or a single-quoted `'<root>\`+newline+`/pkg'` (where the shell
  does NOT delete the pair, since single quotes suspend backslash
  processing, unlike this scan's separator pattern), is refused the same
  way. The `\` rules come from the shell, and an `--env` VALUE is not
  shell-processed, so the same widening over-refuses an env value naming a
  directory whose own name carries a literal backslash by design, with its
  two remedies unchanged. A match that resolves under the run's own
  `--log-dir` is excluded rather than refused (the one case a path under
  the repository root legitimately names the isolation copy itself), but
  only when that `--log-dir` is strictly under the root and only at a path
  boundary decided by the NARROW boundary rule (a `\`+ANSI-C-starter right
  after the `--log-dir` spelling does not end that match, unlike the WIDE
  rule the root's own spelling uses), so a `--log-dir` at or above the
  root cannot exempt the root itself, a `--log-dir` of `<root>/logs` does
  not swallow `<root>/logsrc/x.js`, and `-l <root>/l` with
  `$'<root>/l\x69b/fixture.test.js'` in the test command still refuses the
  root mention instead of reading the ANSI-C starter as ending the
  `--log-dir` match right there; `--isolation inplace` is exempt, and an
  absolute path outside the repository root is left alone. A legitimate
  absolute path under the root (a cache directory, `--env
  CACHE_DIR=<root>/.cache`) is refused too, with the same two fixes named.
  This is a best-effort gate on a literal spelling in a form the scan
  models, not a proof that a command stays inside the copy, and the
  residuals below are the ones known today rather than a closed set: a
  path built at run time from a shell variable, a command substitution
  whose own text does not spell the root out (one that DOES spell it,
  backticks included, is refused like any other literal spelling) or `~`
  expansion, a relative path that walks out via `..`, an absolute path
  that walks back in through `..` (`/abs/x/../my repo`, which the scan
  does not normalise), a spelling broken up from the INSIDE by quoting or
  backslash escaping (`/x/re"p"o`, `/x/re\po`), by an ANSI-C escape that
  decodes a SEPARATOR sitting inside the root's own spelling rather than
  at its end (`$'<parent>\x2f<base>/pkg'`, since the boundary widening
  only ever fires at the end of an already-matched spelling, never while
  a match is still forming), or by an ANSI-C escape that decodes a root
  CHARACTER rather than a separator (`$'/x/re\x70o/pkg'`, measured:
  `probe` reports `survived` against this spelling), or a `\c`-style
  control escape, which cannot decode to a separator either -- the
  `$'...'` family is closed only for a separator-decoding escape (`\xHH`,
  `\uHHHH`/`\UHHHHHHHH`, `\NNN`) at or after the end of the root's own
  spelling, since the shell reassembles each of these into the root while
  the scan does not model what the shell decodes there; a spelling
  differing only in unicode normalisation, a wrapper script that itself
  `cd`s using an unspelled path, a third unrelated symlink alias to the
  root, and a root path containing a character neither spelling represents
  each reach the real tree without being refused (README, same list); so
  did, for the `--log-dir` exclusion only, a sibling of the log dir whose
  name continues its spelling with a filename-legal word terminator
  (`<root>/l@2/y.js` beside `--log-dir <root>/l`), which the exclusion
  swallowed along with the log dir itself (named, not closed at the time;
  closed by task `5f9c57de`, below). The
  rounds this took, the shapes each one closed and the reproductions
  behind them are in the run files for this task.

- `probe`'s handling of a run that reported no exit code of its own, on
  the DEFAULT exit-code path and not only under `--pass-regex` (task
  `a435469b`): a mutant run killed without this package's own
  `--timeout` having fired (`exitCode: null`, `timedOut: false`: a kill
  reaching the run's own process-group leader) used to be classified
  from that `null`, which is not `0` and so certified a `killed` mutant
  under `--expect fail` out of a run that measured nothing. It is now
  `status: "inconclusive"`, `reason: "timeout"` with the signal named in
  `warnings`, matching what the baseline side already refused. The
  zero-tests guard is likewise skipped for a baseline that reported no
  exit code at all: a cut-short tail that happens to end on a zero-count
  summary line no longer reclassifies such a run as `no_tests_executed`
  (which both dropped the signal warning and claimed the suite executed
  nothing), so it stays `baseline_failed` with the signal named. And a
  `--pre` that reported no exit code is now named as timed out, or as
  terminated by a signal, on both the baseline and the mutant side,
  instead of through the literal prose `--pre exited null`.

- `probe`'s `survived`/`killed` verdict (task `273b3851`): a baseline
  (or mutant run) that exited `0` with nothing actually executed was
  read as a real pass, twice reported as `survived` in batch 43 by a
  vitest `-t "name (with parens)"` filter that matched no test inside
  the files vitest still loaded (`Tests N skipped (N)`, `130 skipped`
  both baseline and mutant, exit `0` both times). Two built-in
  detectors now run before any verdict is issued: vitest's own "No
  test files found"/all-skipped-or-zero-summary shapes (checked
  against the baseline's own output before a mutant is even applied,
  and again against the mutant run's own output), and node's built-in
  `--test` runner's zero-count summary line. Either hit is
  `status: "inconclusive"`, `reason: "no_tests_executed"`,
  `mutation_probe.result: "not_run"`, exit `2` -- never a verdict a
  suite that ran nothing has no business making. For a test runner
  neither detector recognizes, a mutant run whose own exit code is `0`
  (a `survived` verdict under the default `--expect fail`, or a
  `killed` one under `--expect pass`, both certified by nothing but
  that passing exit code) also falls back to comparing its own output
  against the baseline's: byte-identical stdout/stderr on both sides,
  with no summary line either detector recognizes on either side, is
  read the same way; a mutant run that exited non-zero never enters
  this fallback, whichever direction `--expect` points, since a
  disagreeing exit code already carries a real signal this
  output-only heuristic has no business second-guessing. The fallback
  is further scoped to only when there is some real, non-empty output
  to compare (two empty tails are common and legitimate, and carry no
  discriminating signal either way) and when neither side's captured
  output tail (`exec.ts`'s 60-line/6000-character bound) was
  truncated (a byte-identical comparison of two truncated tails proves
  nothing about the untruncated output). An opt-in
  `--require-baseline-evidence <regex>` adds a caller-supplied safety
  net for a suite neither built-in detector recognizes at all: when
  given, the baseline's own stdout+stderr must match it before any
  mutant is applied; a miss is `reason: "baseline_evidence_not_matched"`,
  the same shape, naming a truncated tail in its warning when one
  scrolled the pattern out of view instead of reading as a plain,
  unexplained miss; an unparseable pattern is a usage error. Once given
  AND matched, it is also the escape hatch for the generic fallback
  above: a genuine survivor of a quiet deterministic runner (`node
  --test --test-reporter=dot`'s bare `..`) is reported `survived` with
  the flag, `inconclusive`/`no_tests_executed` without it, by design.
  Available under `--plan` (a plan runs every mutant against ONE
  shared baseline, so unlike `--env` there is no second source for
  this value to conflict with), threaded through `probePlan`'s own
  setup so a plan's `results[]` and top-level `status`/`reason` carry
  the same detector/fallback/escape-hatch shape a single probe does.
  Both new reasons join `REFUSAL_RESULT_SHAPE` (`src/probe/session.ts`)
  and the README's "Refusal reason shape"/"Result shape" tables,
  provoked for real in `test/probe-refusal-contract.test.ts` the same
  way every other refusal reason already is. New detector module
  `src/probe/zero-tests.ts`, reusing `verify`'s own `vitestDetector`
  (`src/verify/detectors/vitest.ts`) rather than re-parsing vitest's
  summary shapes a second time, with its node `--test` summary regex
  shared (not duplicated) between the zero-count detector and the
  generic summary check. README documents the captured-tail scope, the
  escape hatch, the default-reporter-only limitation (vitest's
  `--reporter=json` `numTotalTests` is not recognized; use
  `--require-baseline-evidence` for a JSON-reporter run), and that a
  suite printing nothing at all on either run is protected by neither
  mechanism.

- `reconcileEnvelopeDiffTruncation`'s `enforceEnvelopeBudget` (task
  `e82f341a`): the `targets.length === 0` early return skipped the whole
  bound re-check whenever every correction was a case 3 (the whole `diff`
  object dropped by the reduction, descriptors intact, no `diff.path`).
  Case 3 never pushes a shrink target, but its own descriptor rewrite (the
  longer "mutant.diff omitted from this envelope; see logs" clause) can
  still grow the envelope, and with no target the growth was never
  re-measured and `pushBudgetOverrunWarning` never ran: a single-probe
  envelope in that shape, built through the real `buildEnvelope` plus
  `reconcileEnvelopeDiffTruncation`, measured growing from 573 to 623
  characters against a 620-character budget with `warnings: []` -- over
  budget with no warning at all. The early return is gone; the re-measure
  and overrun warning now run whenever `maxChars` is supplied, even with
  an empty `targets` (the shrink loop itself stays a no-op in that case,
  since there is nothing left to shrink). Covered by a new test in
  `test/mutant.test.ts` built through real `buildEnvelope` and
  `reconcileEnvelopeDiffTruncation` at a budget a few characters under the
  corrected length, which fails on the pre-fix code, plus a second test
  pinning that a stale overrun warning already on the envelope gets
  replaced (not duplicated) once the case-3 growth pushes it further
  over budget. The tracker task's premise that `probe`/`probe --plan`
  CLI output itself reaches this shape is superseded by measurement: a
  sweep of the package's own single-pass reduction did not produce the
  shape; the growth is reachable for a library caller's own composed
  envelope, or one handed in from a prior, harsher reduction pass, not
  for the CLI's own reduction.

- `reconcileEnvelopeDiffTruncation`'s `enforceEnvelopeBudget` (task
  `4af16fdf`): the adjacent, SHRINK-side gap in the same early return
  fixed for task `e82f341a` above. When a correction (`reconcileOneMutant`'s
  case 2, a re-cut to a hunk boundary) SHRANK an envelope that was
  already over `maxChars` before this function ran, `bound ===
  preCorrectionLength` and the shrunk result can land at or under it
  without the shrink loop ever running (measured directly against a
  15-hunk fixture: a case-2 re-cut that naturally lands at 803 or 733
  characters, depending on the budget, both under the 805-character
  `preCorrectionLength`) -- so the early return fired with a stale
  "envelope is N characters; requested max-chars M could not be met"
  warning (`buildEnvelope`'s own, or one a caller composed its own
  envelope with) still naming the larger PRE-correction length, whether
  the shrunk envelope was still over `maxChars` or had already landed
  back within it. Both exits of `enforceEnvelopeBudget` now call a
  shared `reconcileBudgetOverrunWarning`: it replaces a stale warning
  with the TRUE final length when the envelope is still over `maxChars`,
  and removes it outright once the envelope is back in bound -- but only
  a warning naming THIS SAME `maxChars`: `isBudgetOverrunWarning` is
  parameterised by the bound (round-2 review finding F2), so a prior
  warning about a DIFFERENT, harsher bound from an earlier reduction
  pass is left untouched by both the replace and the removal path (at
  most one "could not be met" warning is kept per bound, not one
  overall). Covered by tests in `test/mutant.test.ts`, built through the
  real `buildEnvelope` plus `reconcileEnvelopeDiffTruncation` with a
  caller-supplied stale warning and a `diff.path`-bearing excerpt (the
  same reachable-only-via-a-caller-composed-envelope premise as task
  `e82f341a`'s case-3 fixture -- a sweep confirmed `probe`'s own
  single-pass reduction cannot produce a warning next to a
  `diff.path`-bearing excerpt): one for the sync branch, one for the
  removal branch, two more pinning that a warning about a different
  bound survives both branches, and one pinning that the sync branch
  still appends a warning even when the envelope carried none at all
  before this call, all of which fail on the pre-per-bound-fix code.

- `reconcileEnvelopeDiffTruncation`'s `enforceEnvelopeBudget`: when
  restating a plan's descriptors and excerpts pushes the whole envelope
  back over `-m`/`--max-chars`, which mutant's excerpt gets shrunk
  further to close the gap is now a documented, pinned rule (largest
  CURRENT excerpt first, each shrunk to the largest size that still
  fits the whole envelope before the next is touched) rather than
  whatever order the correction happened to visit `plan.results` in.
  This was already the implementation's behavior; it is now covered by
  a discriminating test (two differently-sized single-hunk mutants,
  asserted at exact post-correction byte counts that a smallest-first
  or array-order rule would not produce) and documented in the README.

- `mutation_probe.mutant`/`verified_applied_via`: the `file` part is now
  capped at 200 characters, in the same truncation-marker wording
  `envelope.ts`'s own string cap uses (a kept prefix followed by
  `...(N more characters omitted)`, `N` the true number of characters
  left out). A target file resolved through a very long `-C`/`cwd` or a
  deep temp/log directory previously pasted its whole absolute path into
  both descriptors uncapped, unlike the excerpt beside it, which
  `buildEnvelope`'s own reduction and `reconcileEnvelopeDiffTruncation`
  already bound. A short, ordinary path (every existing fixture) is
  unaffected.

- `probe`'s CLI envelope for a failing baseline (task `b00efca1`): a
  failing baseline used to report `status: "inconclusive"`/`reason:
  "baseline_failed"` with `mutation_probe` entirely absent, so a
  consumer that read `mutation_probe.result` on every outcome without
  shape-sniffing threw on this one. The CLI now
  reports a literal `status: "baseline_failed"` for this case (the exit
  code is unchanged: same `cannot-conclude` class, exit `2`, so a caller
  gating on the exit code alone sees no difference), and the library's
  own `ProbeResult` (`probe()` in `src/probe/index.ts`) now always
  carries a `mutation_probe` object here too (`result: "not_run"`, a
  `reason: "baseline_failed"`, and the mutant this run would have
  applied -- already computed by the dry run before the baseline ever
  started, so there is a real mutant to describe rather than a
  placeholder). `baseline.exitCode` was already reported and is
  unchanged. The same object is now also carried by every OTHER refusal
  `openRunSetup` returns past that same dry run -- a failing `--pre`
  during the baseline (`reason: "pre_failed"`), an aborted baseline
  (`reason: "aborted"`), and a baseline that itself rewrote the target
  (`reason: "target_changed_during_baseline"`) -- each with its own
  `reason` echoed onto `mutation_probe.reason` instead of only
  `"baseline_failed"`: the fix above was scoped to one refusal reason
  when every refusal past the dry run shares the same fact (the mutant
  was already computed). Covered by a library-level test in
  `test/probe.test.ts` and CLI-level tests in `test/cli.test.ts` that
  spawn the built CLI against a failing baseline, a baseline-phase
  `--pre` failure, and a baseline that rewrites its target, and assert
  the envelope shape on each. The `aborted` reason covers BOTH of the
  baseline phase's own abort paths (an aborted `--pre`, an aborted
  baseline test) with the same `mutant`/`mutation_probe` shape either
  way, since the dry run has already computed the mutant by the time
  either can fire.

  What was four scattered site-level fixes is now one formalized
  contract: `src/probe/session.ts`'s new `REFUSAL_RESULT_SHAPE` constant
  (typed `Record<RefusalReason, { mutant: boolean; mutationProbe:
  boolean }>`, so a new `RefusalReason` with no entry fails to compile)
  is the single source of truth for every refusal `openRunSetup` can
  return -- not just the four covered above, but all sixteen, including
  the twelve setup-phase refusals from before the dry run (a
  containment, lock, stale-marker, or worktree-sync refusal,
  `worktree_allow_outside_unsupported`, and the dry run's own
  `mutant_not_applicable`/`git_apply_timeout`), where `mutant` and
  `mutation_probe` are both absent. `setup.ts`'s `refuse()` and
  `index.ts`'s envelope mapping both read this same table by `reason`
  (mechanically, not as a per-call flag), so the two locations cannot
  drift apart on a reason either already covers. `test/
  probe-refusal-contract.test.ts` (new) provokes every one of the
  sixteen reasons through `probe()` for real -- a `Record<RefusalReason,
  Provocation>` table of its own, so a reason with no provocation also
  fails to compile -- and asserts the reported envelope matches the
  contract exactly, in both directions. The README's Result shape
  section gained a "Refusal reason shape" table listing all sixteen.

- `probe -p/--patch`'s result now carries the whole applied change for a
  multi-line patch, not just its first changed line: `mutant.diff`
  reports every hunk the applied `git diff --no-index` found, plus the
  total `hunkCount`, `removed`, `added` and `changedLineCount` (removed
  and added lines, derived from each hunk's own `@@ -a,b +c,d @@`
  header, never from sniffing `text`'s own `+`/`-` prefixes), bounded to
  100 lines / 3,000 characters, cut to whole hunks only (never mid-hunk)
  with a `truncated` flag, when the applied change is bigger than that.
  Before this, `mutant.before`/`mutant.after` and `verified_applied_via`
  echoed only the first line a multi-hunk (or multi-line-single-hunk)
  patch changed, which read as the mutant's whole effect; a reviewer
  briefing concluded from that echo that a heartbeat-removal mutant had
  only changed a comment and was therefore impossible to kill, until the
  patch file itself was read by hand. `diff` is attached whenever the
  applied change is anything other than exactly one hunk with exactly
  one removed and one added line -- the only shape `before`/`after`
  truly cover (a like-for-like line replacement); a one-hunk pure
  deletion or pure insertion, or a one-hunk change removing/adding more
  than one line each, previously fell through this gate too, and for
  exactly those shapes `before`/`after` quote an untouched,
  merely-shifted neighbouring line as if it were the change itself (a
  two-line deletion read back as "line10 -> line12", a two-line
  insertion as "line6 -> inserted_a"). `mutant.line`/`before`/`after`
  still name only the first changed line (unchanged, and still what a
  single-hunk, single-line-replacement patch reports on its own, so
  every existing result -- including the identity fixture -- is
  unaffected).

  `mutant.diff.text` is the SINGLE carrier of the excerpt:
  `mutation_probe.verified_applied_via` no longer repeats it. Two
  earlier passes at this same bullet lowered the excerpt's own bound
  (200 lines/20,000 characters, then 100/3,000) trying to keep
  `verified_applied_via` -- built by pasting the excerpt onto a header --
  under `verify`/`probe`'s own default 8,000-character envelope budget;
  neither bound size fixed it, because the excerpt was being paid for
  TWICE in the same result (`mutant.diff.text` and
  `verified_applied_via`), so `truncated: false` could still sit beside
  text the envelope's own generic string reduction had cut further, at
  the default budget for a big enough `--plan` batch and always once
  `-m`/`--max-chars` was set below the default. Carrying the excerpt once
  removes that duplication; `verified_applied_via` is now a short, bounded
  descriptor pointing at `mutant.diff` (`"git diff --no-index of the
  before/after scratch copies: 3 hunks, 6 changed lines (3 removed, 3
  added); see mutant.diff"`). That alone still does not GUARANTEE
  `diff.text` survives the envelope unmodified (the envelope's own
  reduction, oblivious to hunks, can still cut it further for a large
  enough `--plan` batch or a tight enough `-m`), so `probe` and
  `probe --plan` now call a new `reconcileEnvelopeDiffTruncation` on the
  built envelope, WITH the pre-envelope result beside it: a delivered
  `diff.text` that DIFFERS from what the probe actually produced is
  rebuilt from that original under the same bound rule, inside the
  character budget the delivered text already occupied, and `truncated`
  is set `true` by construction against the delivered result rather than
  left at its pre-envelope value; `hunkCount`/`removed`/`added`/
  `changedLineCount` are never touched, since they already name the true
  totals fixed before either bound ran. Deciding on this comparison
  rather than on the envelope's own omission-marker suffix matters: a
  legitimate excerpt can end in that literal on its own (a mutant adding
  `...(12 more characters omitted)`), and a suffix-only check would empty
  it and set a false `truncated` on text nothing had actually cut. This
  runs after `buildEnvelope` rather than protecting `diff.text` with
  `keepWhole` (the mechanism already used for `plan.summary`) because
  `keepWhole` cannot reach into an array (`plan.results[]` always is),
  and because holding an excerpt bigger than a tight `-m` uncapped would
  make the WHOLE envelope fail to fit rather than only the excerpt.

  `mutation_probe.mutant`'s one-line summary names the hunk/changed-line
  totals and points at `mutant.diff` for the full excerpt (`"... (first
  of 4 changed lines across 1 hunk; see mutant.diff (truncated); full
  diff at mutant.diff.path)"`), and,
  when `removed !== added` (a pure deletion, a pure insertion, or a
  mixed edit), no longer presents a `before -> after` pair at all: an
  unequal count means the two do not correspond to each other one for
  one (the same untouched-neighbour risk `before`/`after` already carry
  for those shapes), so the summary instead names only the side actually
  removed or added (`"target.txt:5: line05 removed (1 changed line
  across 1 hunk; see mutant.diff (whole))"`). The pair form survives only when
  `removed === added` (the `=== 1` case is the one `diff` is never
  attached for at all). Both descriptor strings, and every existing test
  asserting the old duplicated `verified_applied_via` content, are
  updated; the identity fixture (`-r`, no `diff` field) is unchanged and
  stays byte-identical.

  The bound applies to EVERY hunk, the first one included. It used to
  keep `hunks[0]` whole no matter how large it was, so a one-hunk change
  of any size shipped uncut with `truncated: false` while the README,
  this entry and the field's own docblock all described an unconditional
  100-line/3,000-character bound. A first hunk that alone exceeds the
  bound is now cut inside itself, at a line boundary, keeping its `@@`
  header plus the whole body lines that fit, and says so with a
  `hunkTruncated` flag distinct from `truncated` (whole hunks dropped);
  the `--- `/`+++ ` preamble lines are dropped before any hunk content
  is, since they name only the comparison's own scratch copies; and when
  not even the header fits, `text` is `""` with `bodyOmitted: true`
  beside it, so an empty string is never delivered as though it were an
  excerpt. A `\ No newline at end of file` marker is body of its hunk
  that the hunk header does not count, so both the bound's own walk and
  `trimToLastCompleteHunk` step over it instead of spending a count on
  it; counting it ended a complete end-of-file hunk one line early,
  dropping the `+` line of a replacement so it read as a pure deletion,
  and aborted the walk at the marker for anything that followed.

  The whole applied diff is now always written to the probe's own log
  directory (`mutant-diff-<random>/mutant-diff.patch`) before any bound
  runs, and named by `mutant.diff.path` and in the mutant's `logs`. What
  either bound leaves out of `text` is therefore never lost, only moved:
  the descriptors point at that field rather than pasting the path
  itself, which is unbounded and would be the same "excerpt paid for
  twice" defect in another dress.

  Measured before this evidence-based decision replaced an earlier,
  suffix-matching draft: at `-m 4000` a descriptor read "15 hunks, 30
  changed lines ...; see mutant.diff" beside a delivered `diff` of
  `text: ""`, `truncated: true` -- the two had been formatted before the
  envelope ran and never revisited. Both descriptor strings are rebuilt
  from the corrected field instead, so `mutation_probe.mutant`/
  `verified_applied_via` can no longer state a truncation state the field
  contradicts. A descriptor the reduction had already cut is re-capped
  instead of restored, so the correction never adds back characters the
  envelope removed to meet its bound; and when the reduction dropped the
  `diff` object entirely, the descriptors stop pointing at it and name
  `logs` instead -- the top-level `logs` specifically, a PROTECTED_KEYS
  field the reduction never cuts and which carries the full, unreduced
  result's own path whenever anything was cut at all. In `probe --plan`,
  a plan entry's OWN `plan.results[i].logs` is a different field, capped
  like any other array/object value the same as everything else on that
  entry; the route to the full diff there is the top-level
  `result-full-<run-id>.json` the top-level `logs` names instead.
  `reconcileEnvelopeDiffTruncation`, `trimToLastCompleteHunk` and the
  `MutantDiffField` type are exported from the package root for library
  callers composing their own envelope.

  The excerpt's own `git diff --no-index` read is pinned against ambient
  git config (`-c core.autocrlf=false -c diff.noprefix=false
  --no-ext-diff --no-textconv`, the read-side counterpart to the
  write-side pins below) so neither a global `diff.external` nor a
  `core.attributesFile`-assigned `diff.<driver>.textconv` can make the
  excerpt vanish or fabricate its content silently, and its own output
  being too large to read back in full refuses the excerpt (with a
  warning) rather than risking an undercounted `hunkCount`; any other
  failure computing the excerpt is likewise turned into a warning
  (`mutant.diffWarning`, folded into the result's own `warnings` by
  `step.ts`, now covered by a test that forces the underlying `git diff`
  to fail) rather than a silently missing field or an uncaught
  exception. The before/after scratch copies this excerpt reads are
  removed once it has read them back.

  Investigated alongside this: a reviewer also reported one
  `expect: "pass"` mutant that came back `killed` inside a
  `probe --plan` batch while the identical single-mutant invocation came
  back `survived`. It does not reproduce: `probe()` and `probePlan()`
  share the same classify step (`step.ts`'s `runMutantAttempt`,
  unchanged by this fix), and a new parity suite (`test/plan.test.ts`)
  runs the same mutant through both entry points for all four
  `killed`/`survived` x `expect: "fail"`/`"pass"` combinations, including
  the exact "leaves the suite green under `expect: pass`" shape the
  reviewer described; all four agree in both modes. The README now
  states explicitly what `killed`/`survived` mean under each `expect`
  value, since the ambiguity that report described is otherwise easy to
  read as a code defect.
- `probe -p/--patch` now also pins its real `git apply`, the `-i
  worktree` checkout, and the tracked-diff sync apply with `-c
  core.autocrlf=false` and `-c apply.whitespace=nowarn`. A global
  setting for either key could otherwise make a real patch probe
  inconclusive despite its pinned dry run succeeding.
- `probe -p/--patch`'s dry-run `git apply` (the scratch-directory check
  that decides applicability before anything real is touched) now pins
  `-c core.autocrlf=false` and `-c apply.whitespace=nowarn`. The
  scratch directory has no `.git` of its own, so it previously inherited
  whichever ambient global/system git config the machine running `probe`
  happened to have; under a global `core.autocrlf = true` (a common
  Windows default) the write would silently convert the scratch copy's
  LF line endings to CRLF, making the dry run compare corrupted content
  against the original and derive the wrong line and before/after text
  for `mutation_probe.mutant`.
- `init` now distinguishes unreadable targets from unwritable ones with
  `target_not_readable`, maps otherwise-unclassified read failures into the
  same command-specific envelope, revalidates identical targets before
  reporting `unchanged`, and completes short filesystem writes instead of
  treating a partial byte count as success. Final absent-name creation uses
  `O_EXCL`, so a target planted in that gap is revalidated rather than
  truncated; zero-progress writes report `target_write_failed` after closing
  the descriptor.
- `probe --plan`: the signal handler's restore slot is cleared before a
  plan's baseline runs (it was still armed to whichever target
  `openTarget` opened last). A plan whose baseline rewrites more than
  one target, signalled mid-baseline, previously restored only that one
  target and left every other target as the baseline wrote it -- an
  asymmetry across targets that contradicted the plan's own non-signal
  rule ("left as the baseline wrote it, not restored"). A signal
  mid-baseline now restores nothing for a plan, same as the non-signal
  path, and the per-mutant step still re-arms the slot for its own
  target right before applying it. The single probe (always one target)
  is unaffected: its restore slot stays armed through its own baseline,
  the released contract.
- `probe --plan`'s envelope no longer flattens every mutant's own log
  paths (`test.logPath`, `logs`) into the top-level `logs`, which the
  envelope's reduction never cuts: at 55 mutants (default `-m 8000`,
  default log dir) that per-mutant growth alone pushed the reduction
  floor past the bound, dropping `plan` (summary included) rather than
  reducing it. The top level now carries only the baseline log, the
  plan's own setup logs and, once reduction runs, the full-result path;
  a mutant's own log paths stay on `plan.results[i]`, which the normal
  reduction can still cap or drop like any other field.
- `drift`'s historical-phrase allowlist check is now windowed to a
  bounded span around the identifier's own mention on a line (roughly
  60 characters before it, cut short at the nearest sentence boundary,
  plus 20 after) instead of the whole line, so an unrelated historical
  phrase far away on a long line no longer suppresses a present-tense
  mention of the identifier.
- `drift` no longer reports every wholly deleted file's basename as a
  removed identifier: a basename now only qualifies when its file
  extension is a recognized source extension AND the basename itself
  looks like an identifier; every basename skipped for either reason is
  named in a warning instead of silently dropped.
- `drift` resolves `--base`/`--head`/`--allow` and every underlying
  `git diff`/`git grep`/`git show` call against the git work tree's
  root rather than the caller's `cwd`, so running it from a
  subdirectory no longer risks a heading/released-section decision
  reading the wrong file, or an `--allow` glob written against a
  root-relative path failing to match.
- The removed-declaration regex now also recognizes `export async
  function`, `export abstract class`, and a generator `function*`
  (including `export async function*`).
- `drift`'s envelope keeps `counts` whole under `--max-chars`
  reduction, and each site's `text` is capped at 300 characters, so a
  large result's site count stays visible instead of disappearing
  along with a partially-cut `sites` array.
- `drift`'s migration-doc-path check now requires an actual `docs/**`
  subtree (a loose substring match previously also matched a path like
  `migration/docs/x.md`), and its heading parser skips fenced ``` /
  ~~~ code blocks so a `#`-prefixed line inside one is never read as a
  Markdown heading.
- `drift`'s diff parser no longer misreads a removed line whose own
  content starts with `-- ` (or an added line starting with `++ `) as
  a `--- `/`+++ ` file header: those are now recognized as headers only
  before a file's first hunk.

## [0.1.0] - 2026-09-04

### Added

- `init` subcommand: installs the packaged `assets/skill/SKILL.md` into
  one or more harnesses' skill directories (`-H claude,codex,opencode`,
  or the single value `all`; default `claude`), writing
  `<target>/.claude/skills/agent-primitives/SKILL.md`,
  `<target>/.agents/skills/agent-primitives/SKILL.md`, and
  `<target>/.opencode/skills/agent-primitives/SKILL.md` respectively.
  Mirrors a standard kit installer's write-if-new-or-unedited semantics
  without importing that internal module: a target that does not exist
  yet, or exists with byte-identical content, is written or reported
  `unchanged`; a target with different content is `conflicted`, exit
  `1`, and left untouched, unless `--force`, which overwrites it and
  reports `written`. Every requested harness's target path is resolved
  and checked against `--target-dir` before any file is written, so a
  condition knowable without writing (an escape through a pre-existing
  symlink, a symlink or a directory or a FIFO at the target file path,
  or, where a write is actually due under `--force`, a target that is
  not writable) refuses the whole run rather than leaving other
  harnesses partially written. Write access is checked only where the
  content differs, so a read-only target that already holds this skill
  is `unchanged` under `--force` too. A condition that only surfaces
  during the write itself, such as a symlink planted between validation
  and the write, can still leave a prefix of the requested harnesses
  installed; the `usage_error` envelope's `targets` field then names
  that prefix. Each such refusal carries a `reason` of its own
  (`target_not_a_directory`, `target_path_is_a_directory`,
  `target_not_a_regular_file`, `target_not_writable`,
  `target_is_a_symlink`, `target_escapes_directory`,
  `platform_unsupported`) instead of a raw filesystem message, and
  `InitFsUsageError` plus that reason type are exported for callers
  using `init` as a library. A target is never written through a
  symbolic link, at the target path or above it; a hard link at the
  target path is indistinguishable from a plain regular file and is
  written through like one. The `O_NOFOLLOW` the write's symlink guard
  needs is checked inside `init`, so a platform without it refuses
  `init` alone and leaves `probe`, `verify`, and `doctor` usable.
  `init` never writes under `.claude/agents/`, which belongs to a
  different installer. The skill document itself teaches the search,
  verify, probe, and doctor conventions to an agent working in the
  target repository. Evidence for the terrain claims and design
  decisions behind `probe`, `verify`, `doctor`, and `init` lives in the
  pandora workspace run `2026-09-03-agent-tools-kit` and its memory
  record.
- `verify` subcommand core: resolves each named check (`-x` override wins,
  else `package.json` `scripts[name]` as `npm run <name> --silent`, else
  `skipped`), runs `build, typecheck, lint, test` by default (or the `-c`
  list, deduplicated preserving the first occurrence, in order), through
  `exec.ts` with a per-check timeout and log file. Every resolved check
  name is validated against a conservative pattern before any command is
  built; an invalid name is `status: "usage_error"`, exit `2`, never run.
  Shell exit `126`/`127` maps to `status: "error"`, never `"fail"`.
  `--fail-fast` stops after the first check that fails or errors; a
  skipped check falls through instead of stopping the run. When every
  requested check resolves to `skipped`, the run is `status: "error"` with
  `reason: "nothing_verified"`, never a silent pass. Detector selection is
  by output shape first, command text only as a tiebreaker among shape
  matches, and only when it names exactly one of them; otherwise the
  generic detector is chosen and a warning lists the shapes seen. v0 wires
  the `generic` detector (parses no failures out of the text itself), with
  the selection seam left open for tool-specific detectors. The failures
  invariant is enforced once, centrally, for every detector and for both
  `fail` and `error` checks: a check with zero parsed failures always gets
  one synthetic failure entry (naming `timedOut`, or the exit code, plus
  output tail) instead of shipping an empty `failures` list, and an
  `error` check always reports at least one `summary.errors`. A detector's
  own warnings, and a log file the run could not write to, are merged into
  the top-level `warnings`, prefixed with the check name. `--max-failures`
  (a positive integer, default 20) caps each check's own `failures` list,
  failures-first; a cut is reported via `truncated: true` and the full,
  uncapped result is written to the log directory.
- `verify` gains three output-shape detectors, registered as
  `DEFAULT_DETECTORS` (the default when a caller passes none): `vitest`
  (the `Tests` summary line, parsed segment-wise so any combination of
  `failed`/`passed`/`expected fail`/`skipped`/`todo` vitest prints is
  read correctly, including an all-failing, all-skipped, or `it.fails`
  run, `expected fail` folded into `summary.passed`; ` FAIL  file > name`
  blocks with the assertion on the following line, or ` FAIL  file [
file ]` with no name for a file that fails to collect; and the `No
test files found` / `Tests  no tests` cases), `tsc` (`file(line,col):
error TSnnnn: message`, identically whether or not `--pretty false` was
  passed; `summary.errors` counts the diagnostics), and `eslint`'s
  stylish formatter (a file header line, structurally matched so a path
  containing a space is still recognized; `line:col  severity  message[
rule]` rows, the rule id optional so a rule-less row such as a
  `Parsing error: ...` is still a failure; `error` rows populate
  `failures`, `warning` rows count into `summary.warnings` alone and
  never become a failure). Every file-path capture across the three
  detectors is structural (up to the shape's own separator), never
  `\S+`. No reporter flags are injected; a check whose output carries
  more than one of these shapes at once (e.g. a `pretest` build followed
  by `vitest`) is ambiguous and falls back to `generic`, listing the
  shapes seen, the same as any other ambiguous selection. All three strip
  ANSI SGR color codes before matching or parsing, since a tool can
  default to colorized output even outside a real terminal (the Node
  floor eslint needs to develop against is documented once, in the
  package README's `verify` section). Truncation is read from exec.ts's
  own `stdoutTruncated`/`stderrTruncated` flags, never recomputed from
  the tail text itself (a tail that happens to end with a trailing
  newline is not a reliable way to tell a truncated tail from an
  untruncated one). When either flag is set, eslint's own reported total
  is preferred, only when the eslint detector was selected for that
  check, where one survives in the tail (eslint's `✖ N problems` line);
  either way a warning names the truncation, since the `failures` list
  itself can still be missing entries even when a trustworthy total was
  found. The failures invariant only adds its synthetic entry's count on
  top of a detector-reported 0, never doubling an already-correct count.
  Captured real-tool-output fixtures and one live integration test per
  tool (run through this package's own installed devDependency) live
  under `test/fixtures/`.

### Fixed

- **`probe -i worktree` on an older git, and across lock directories.** The
  worktree listing behind the removal's assertion, the leftover recovery,
  and `doctor` no longer requires `git worktree list --porcelain -z`: when
  git rejects `-z` (a release older than 2.36), the newline-separated
  `--porcelain` form runs instead and is parsed against the fixed attribute
  order, so a worktree path containing a newline is reported as unparseable
  rather than misread, a block that ends after its `worktree` line alone
  (the shape such a path takes when its newline reads as a block boundary)
  refused with the rest instead of registering a phantom path. A listing
  that cannot run in any form is an unknown registry, never "still
  registered": the removal is then judged by the disk alone (never by `git
worktree remove`'s exit status, which is non-zero for a path git never
  registered, so a marker naming such a path is recovered instead of
  stopping every later run), reported as done but unverified in a warning,
  and the marker is cleared, so a git that cannot list no longer turns a
  removal that took into a `stale_worktree` on every later run; a leftover
  still on disk after an unverified removal is reported with the marker file
  as the escape, since the manual `git worktree remove` cannot be relied on
  when the registration is unknown; the recovery and `doctor` say in a
  warning that a leftover registration could not be checked for. The
  worktree sync's own floor is git 2.35 (`git apply --allow-empty`); both
  floors are documented in the README, and `doctor` gained a `git-version`
  check that reads the installed git against them and warns below 2.36. Each
  scratch directory now carries an `owner.json` with the creating probe's
  pid and a timestamp, written before the add runs: the recovery and
  `doctor` skip a registered or marker-named scratch worktree whose owner is
  still alive under a record within 24 hours of the clock, the recovery
  naming it as a live probe under another `AGENT_PRIMITIVES_LOCK_DIR` in a
  warning and `doctor` in a hint (the pid, the path, the record, and the
  bound) rather than removing it (the lock serializes probes within one lock
  directory only), and the removal gate refuses such a path outright; a
  record past that bound no longer vouches for its worktree whatever its pid
  says, so the worktree is a leftover again, removed by the next run and
  reported by `doctor` with the manual command. A path git does not report
  is now checked against the recovering run's own `--log-dir`, never against
  the log dir a marker recorded, so a marker cannot certify its own
  containment; the scratch-shape check pins the uuid's 8-4-4-4-12 hex layout
  instead of any 36 characters of the class.

- **Envelope bound and reduction.** The bound is met by reducing the
  result's structure, never by cutting the serialized JSON text. The
  deep-copied result is walked once per attempt and four caps derived from
  the bound are applied together: the characters kept of a string, the
  elements kept of an array, the keys kept of an object, and the depth
  kept of a subtree. One scale factor drives all four (the three breadth
  caps linearly, the depth cap one level per halving of the scale), and a
  bounded bisection over that factor (a small, fixed number of attempts,
  each linear in the result and each re-derived from the same pristine
  copy, never from the previous attempt's output) takes the largest scale
  whose envelope fits; the floor of the search is the skeleton itself,
  which fits by construction, so the search always has an answer.
  Consequences worth naming: two equally large sibling values are
  cut alike instead of the first one consuming the whole budget; a wide
  collection is trimmed entry by entry instead of being deleted whole; a
  deeply nested result is reduced to a shallower sketch of itself instead
  of being lost whole, because depth now moves with the search rather than
  sitting at a fixed floor above the smallest structure the search can
  reach; the work done no longer depends on how far over the bound a
  result is, and no clock is read at all, so the envelope is a function of
  the result, the bound, and this process's run id (which reaches it
  through the full-result path in `logs`), and the wall-clock work budget
  (`reductionBudgetMs`) is gone with the loop it guarded. When even the
  shallowest structure the search reaches is over the bound, a depth-only
  fallback tries the last few levels explicitly at the narrowest widths
  and keeps the first sketch that fits; when nothing fits at all, a
  warning states that the result was reduced to the fixed fields alone and
  points at the full result on disk, so a caller can tell "the command
  produced no fields" from "the command's fields did not fit". Every cut
  is marked in band with a count taken from the original: a trailing array
  element, a `...` key in an object, a suffix on a string, and a
  placeholder naming the depth a subtree was pruned at, so kept plus
  omitted always accounts for what was there; entries are rebuilt with
  `Object.defineProperty`, so a result carrying an own `__proto__` key
  (from `JSON.parse`) keeps it as an own property and in that arithmetic
  instead of silently reassigning the rebuilt object's prototype. The
  fixed envelope fields are held apart from the payload for the whole
  reduction and lead the serialized object, so the real invariant is
  `serializedLength(envelope) <= max(maxChars, skeletonFloor)`; whenever
  the literal requested `-m`/`maxChars` cannot be honored, a warning names
  the envelope's true final length, solved exactly (the warning's own
  digits are part of the length it reports) instead of approximated by a
  loop that gave up after a fixed number of tries. A field whose value
  JSON omits (`undefined`, a function) is measured as contributing nothing
  instead of throwing mid-reduction and turning the command into `status:
error`. A result that cannot be copied or serialized at all (a function
  value, a BigInt, a cycle, a graph too deep) yields the skeleton plus a
  warning naming the reason, keeping the command's real status instead of
  reporting `status: error`. `buildEnvelope` deep-copies `extra` before
  any reduction, so the caller's object, and for `doctor` the `-f text`
  rendering built from that same object, is never mutated by a
  shallow-spread aliasing bug. The full untruncated result is written
  under a file name carrying the run's own id, so two invocations sharing
  one log directory no longer overwrite each other's evidence.

- **CLI output and error mapping.** stdout is written and drained through
  the write callback before the process exits, instead of exiting right
  after `write()` returns, which could truncate output larger than the
  pipe buffer. The callback's own error argument is now honoured: a
  non-EPIPE write failure exits `2` with one line on stderr naming it,
  EPIPE keeps the command's own exit code and says nothing, and the
  stream's `'error'` listener stays as defense in depth. `-f text` output
  never exceeds `-m`: its truncation marker names the full length, and
  below the marker's own size the marker itself is cut short instead of
  overshooting the requested bound. Commander's usage errors are
  intercepted and emitted as a JSON `usage_error` result with exit `2`;
  a non-commander, non-usage error reports `status: "error"` through the
  exported `mapTopLevelError` (no test-only env seam in shipped code);
  `-C` at a missing or non-directory path is a usage error; `-f text` is
  one shared renderer with a pretty-JSON fallback for commands without
  one.

- **`doctor`.** `-r`/`-o` entries are rejected as a usage error when they
  are not a plain binary name, which blocks `../` traversal into an
  arbitrary `--version` execution. `version` is reported only when there
  is one, so a binary that runs but prints nothing no longer ships an
  undefined-valued property. A `--version` capture that times out is
  recorded as `versionCheck: "timed_out"` with a warning rather than read
  as silent, empty output, and all captures share one aggregate deadline
  (default 3000ms); once it is spent, remaining tools are still checked
  for presence but their capture is skipped
  (`versionCheck: "skipped_deadline"`) with one summary warning.

- **`exec`.** The log write stream carries an error listener and surfaces
  a failure as `logWriteFailed`/`logWriteError` on `ExecResult` instead of
  crashing on an unhandled `'error'` event. stdout/stderr decoding uses
  `StringDecoder`, so a multi-byte character split across two chunks no
  longer becomes a replacement character. A run that settles on the
  stream flush grace rather than on `close` (something the command left
  behind is still holding the stdio pipes) reports
  `outputMayBeIncomplete: true`, so output dropped at that moment is
  stated instead of silently missing; `probe` and `verify` both surface
  it as a warning.

- **`probe`: patches are applied without a shell.** All three `git apply`
  invocations (the `--numstat` path check, the dry run, and the real
  apply) run through a small argv-array runner instead of being built as
  `sh -c` strings. A `-p` path is caller-supplied, and `sh` expands
  `$(...)` and backticks inside double quotes, so no quoting of such a
  path into a shell string is safe. The `--numstat` check also reads the
  command's whole output rather than a tail, and refuses a listing that
  did not fit instead of checking the patch's paths against a fragment.

- **`probe`: an interrupted run is `inconclusive`/`aborted`.** In both the
  baseline and the mutant phase, a run stopped by `SIGINT`/`SIGTERM` or
  by a caller's abort classifies as `status: "inconclusive"`,
  `reason: "aborted"`, never `killed`/`survived` and never a plain
  `baseline_failed`: the interrupted test child exits non-zero, which
  under `--expect fail` is indistinguishable from a mutant the suite
  caught.

- **CLI signal handling.** `SIGINT`/`SIGTERM` are handled for every
  subcommand: the in-flight command is aborted (which `SIGKILL`s its whole
  process group), the CLI waits for that run to settle, and the process
  then exits `130`/`143`, instead of a Ctrl-C ending the CLI and orphaning
  the worker its check had spawned. `verify()` gains an optional `signal`
  threaded to `exec.ts`. `probe` owns the two signals for the duration of
  its call, since it also has a mutated file to restore before the process
  may end.

- **The emergency restore is the last write to the target.** On
  `SIGINT`/`SIGTERM`, `probe` no longer sends `SIGTERM` and exits: it
  `SIGKILL`s the in-flight child's whole process group outright, waits
  (bounded) for that run to settle, and only then restores, verifies the
  restore by hash, removes the marker and releases the lock. A test
  command that traps `SIGTERM` used to sit out the grace period, outlive
  the exit (the escalation timer died with the process that scheduled it),
  and write over the restored file; the same held for a descendant that
  put itself out of the group's reach. Both are covered by tests that let
  such a writer run and assert the target's content afterwards.
  `ExecOptions.signal` and the new `RunArgvOptions.signal` both kill with
  `SIGKILL` and no grace for this reason; the timeout path still sends
  `SIGTERM` first.

- **The emergency restore waits for true stdio closure, not just for the
  run's own promise to settle.** `exec`'s flush-grace shortcut lets that
  promise resolve while a descendant that left the process group still
  holds the command's stdio open, and `probe`'s signal handler used to
  await that same promise: a write landing after the shortcut but before
  the descendant actually closed its pipes could land after the restore,
  with the marker already gone. The handler now waits, bounded, for the
  pipes to genuinely close (`exec` and `runArgv` both expose this: an
  additive `stdioClosed` field on their result, and `exec` also takes an
  `onStdioClosed` callback fired exactly on that closure, independent of
  when its own promise settles). When the bound expires with the pipes
  still open, the target is still restored, but the marker and its
  backup are deliberately kept rather than removed: `doctor` reports the
  marker as stale, and the next `probe` on that target recovers from the
  hash-verified backup the same way it already does for any other
  in-flight marker, including when the target already matches the
  marker's own pre-mutation hash. Also fixed: the signal handler's own
  restore-then-exit no longer races the normal control flow's return.
  Every point where the normal flow detects that a run it started was
  aborted now checks whether the handler has already taken over; if so,
  it defers to the handler's own outcome instead of restoring a second
  time, and in the CLI it never returns at all, so the handler's own
  exit is always what ends the process. Before this, an aborted run
  could resolve fast enough that the CLI printed an inconclusive/aborted
  envelope and exited `2` instead of ending with `130`/`143` and no
  output, depending on how long the killed command took to actually die.

- **`probe`: every `git apply` is abortable and bounded by `--timeout`.**
  The path check, the dry run, and the real apply now take the probe's
  own signal, so an interrupted apply is killed rather than left to land
  on the target after the restore has already put the original back (with
  the marker gone). `--timeout` bounds them too; with no `--timeout` they
  keep the fixed ten-second bound they always had. An apply killed by that
  bound reports `reason: "git_apply_timeout"`, and one killed by the
  signal reports `reason: "aborted"`, instead of both being reported as a
  patch that failed to parse or to apply.

- **`verify`: an aborted run says so.** `options.signal` now stops the
  run instead of only killing the current command: the check that was
  running is reported as `status: "error"` with a failure naming the
  abort (never the failures invariant's synthesized `exit code null`
  entry), no further check is started, the ones that never ran are named
  in a warning, and the result carries `reason: "aborted"`.

- **`probe`: the lock is keyed on the repository.** An `inplace` probe
  mutates the one working tree that every probe in that repository builds
  and tests in, so two probes on different files in one repository are
  not independent; the second is now refused with
  `reason: "probe_in_progress"` the way a second probe on the same file
  always was. Outside a repository the target path remains the lock's
  identity. Markers stay keyed per target file.

- **`doctor`: the stale-marker hint applies probe's own recovery rule.**
  It hashes the recorded backup and compares the target before pointing
  at automatic recovery, instead of splitting on whether the backup file
  still exists. A marker whose backup no longer matches the pre-mutation
  hash it records, or whose target has moved on from the state it
  describes, is one the next probe refuses, and doctor now names the
  marker file and the manual delete for it rather than promising a
  recovery that will fail.

- **Tests.** The `O_EXCL` backup-name claim in `isolation.ts` is pinned
  through an injected `open`, which makes the name appear exactly in the
  window between choosing it and opening it: the session claims the next
  name and the other session's backup is left intact. `exec`'s
  flush-grace settle path is pinned by a command whose descendant puts
  itself in a process group of its own and holds the stdio pipes, and the
  library-mode signal path (including `exitOnSignal`'s default) by a
  spawned library caller that is sent `SIGTERM` mid-probe. Every CLI test
  spawns through one shared helper that hands
  the child a PATH of exactly four resolved binaries (node, npm, git, sh),
  a fixed temp directory, and no inherited environment, and that attaches
  its readers before returning rather than after a sleep. A spawned CLI's
  assertions are therefore about this CLI rather than about what the host
  happens to have installed or how fast it happens to be. The claim is
  about that environment and not about the whole suite: the exec tests
  drive commands through the shell and the EPIPE test reaches for `head`,
  so those additionally use POSIX utilities, through `sh` or by absolute
  path, and the shell loops they run are POSIX constructs rather than
  `seq`.

- `probe`: restore now runs in the pipeline's
  own `finally` as a backstop, so a thrown error mid-mutation (not just
  a normal return) still restores and hash-verifies the target before
  re-throwing; `--pre`/`-t` run in the invocation cwd instead of the
  containment root, so a probe from a subdirectory of a monorepo sees
  the same cwd its test command normally would; a non-zero `--pre` exit
  in either the baseline or the mutant run is `inconclusive`/
  `pre_failed`, never a verdict; a marker found under the lock is always
  treated as an unfinished probe regardless of its recorded pid (the
  lock already excludes a second live probe, and pids recycle);
  `--file`/`--link` are resolved with `realpath` before both the
  containment check and the lock/marker key, so an in-repo symlink to an
  outside file can no longer bypass containment; a `-p` patch that
  touches any path other than `--file` (checked via `git apply
--numstat` after the dry run) is `mutant_not_applicable` instead of
  silently mutating extra files with nothing to restore them; the lock
  directory is uid-scoped (`agent-primitives-<uid>/locks`) and created
  `0700`, and one that exists but is not owned by (or writable by) the
  current user is `inconclusive`/`lock_unavailable` instead of a raw
  filesystem error; `mutation_probe.result` now stays within
  `killed`/`survived`/`inconclusive` (the detail moved to `reason`); the
  baseline, test, and dry-run exec log paths are folded into the
  envelope's `logs`; a whole-line `-r, --replace` mutation preserves the
  target line's own CRLF terminator instead of silently downgrading that
  one line to LF; and `-p` combined with `--allow-outside` is now a
  usage error instead of a scratch-dir path that always fails.

- `probe`: the target is backed up (and the backup verified against its
  pre-mutation hash) immediately, before the baseline ever runs, instead
  of afterward; a target rewritten by the baseline itself (a formatter
  or codegen step) is caught by a post-baseline re-hash and reported as
  `inconclusive`/`target_changed_during_baseline` before any mutation or
  marker exists, leaving the target exactly as the baseline left it. A
  missing `--file` is `usage_error`/`file_not_found` (naming the path)
  instead of an uncaught filesystem error surfacing under an unknown
  command. `mutant_not_applicable` always carries a one-line reason
  (line out of range, substring not found, an identical replacement, or
  why a patch did not apply) and always returns its dry-run log paths,
  including the baseline's own `--pre` log; the mutant-phase `pre_failed`
  path now also reports `mutation_probe` with its real
  `restored_verified`. The `SIGINT`/`SIGTERM` handler now kills the
  in-flight `--pre`/`-t` child (via a new, additive `signal` option on
  `execCommand`) before restoring, instead of leaving it running after
  the process exits; the `finally` backstop's warning names the error
  that actually triggered it. The in-flight backup's name is now claimed
  atomically (`O_EXCL`) instead of via a check-then-copy that could race
  two sessions in the same log dir. The lock directory check now
  validates every level it had to create (not just the leaf) for
  ownership and permissive mode, since a level above the leaf sits
  directly under a shared, world-writable `/tmp`. `doctor`'s stale-marker
  hint, and the marker-recovery path itself, only promise auto-recovery
  when the backup still exists; when it is gone, both name the marker
  file for a manual delete instead. The baseline phase now reports its
  own `timedOut`, so a killed baseline is distinguishable from one that
  genuinely failed.
- `probe`: stale-marker recovery now hashes the recorded backup and
  requires it to match the marker's own pre-mutation hash BEFORE copying
  anything over the target. A corrupt, truncated, or foreign backup was
  previously written over the target first and only found out afterward,
  destroying the only remaining copy of the mutated file while reporting
  `stale_probe_marker` as though nothing had been touched; the refusal now
  names both the backup and the marker file and leaves the target alone.
  A failing baseline that also rewrote the target keeps its backup (named
  in a warning) instead of discarding the only copy of the pre-baseline
  content silently. A post-apply hash mismatch is
  `inconclusive`/`apply_hash_mismatch` carrying `mutation_probe` with its
  real `restored_verified`, instead of throwing out of `probe()` and
  surfacing as `status: "error"` under an unknown command. A `-p` patch
  that touches a second path is now diagnosed by `git apply --numstat`
  before the scratch dry run, so a patch modifying another file that
  exists in the repository is reported as touching paths other than
  `--file` rather than as a patch that did not apply. The exported
  `probe()` no longer ends the host process on `SIGINT`/`SIGTERM` unless
  the caller opts in with `exitOnSignal` (the CLI does); the emergency
  restore and lock release happen either way.

- `exec`: commands run in a process group of their own (`detached`), and
  both `--timeout` and `options.signal` signal that whole group (the
  timeout with `SIGTERM` then `SIGKILL` after a grace; the abort path with
  `SIGKILL`, see the entry above). A worker the command spawned no longer
  survives the kill while holding the run's stdout and stderr open, which
  stretched a bounded run to the descendant's own lifetime and left a
  process writing to a probe's target during the restore. Settling is
  driven by the command's own `exit` plus a bounded flush grace rather
  than unconditionally by `close`, so a descendant in a process group of
  its own cannot hold the call open either. `ExecResult` is unchanged
  apart from the additive `aborted`.

- `doctor`: the stale-probe-marker check resolves both the current
  repository's containment root and the marker's target path before
  comparing them, so a symlinked ancestor (`/tmp` against `/private/tmp`,
  a symlinked checkout) no longer reports "no stale probe markers" while
  one is sitting there.

### Added

- `verify` subcommand core: resolves each named check (`-x` override wins,
  else `package.json` `scripts[name]` as `npm run <name> --silent`, else
  `skipped`), runs `build, typecheck, lint, test` by default (or the `-c`
  list, deduplicated preserving the first occurrence, in order), through
  `exec.ts` with a per-check timeout and log file. Every resolved check
  name is validated against a conservative pattern before any command is
  built; an invalid name is `status: "usage_error"`, exit `2`, never run.
  Shell exit `126`/`127` maps to `status: "error"`, never `"fail"`.
  `--fail-fast` stops after the first check that fails or errors; a
  skipped check falls through instead of stopping the run. When every
  requested check resolves to `skipped`, the run is `status: "error"` with
  `reason: "nothing_verified"`, never a silent pass. Detector selection is
  by output shape first, command text only as a tiebreaker among shape
  matches, and only when it names exactly one of them; otherwise the
  generic detector is chosen and a warning lists the shapes seen. v0 wires
  the `generic` detector (parses no failures out of the text itself), with
  the selection seam left open for tool-specific detectors. The failures
  invariant is enforced once, centrally, for every detector and for both
  `fail` and `error` checks: a check with zero parsed failures always gets
  one synthetic failure entry (naming `timedOut`, or the exit code, plus
  output tail) instead of shipping an empty `failures` list, and an
  `error` check always reports at least one `summary.errors`. A detector's
  own warnings, and a log file the run could not write to, are merged into
  the top-level `warnings`, prefixed with the check name. `--max-failures`
  (a positive integer, default 20) caps each check's own `failures` list,
  failures-first; a cut is reported via `truncated: true` and the full,
  uncapped result is written to the log directory.

- `probe` subcommand (`inplace` isolation): the full mutation-probe
  pipeline (lock, containment, stale-marker recovery, baseline, apply,
  `--pre`/test, restore, hash verification, classify) for all three
  mutant forms (`-r, --replace`, `-M, --match` with `-w, --with`,
  `-p, --patch` via `git apply`). A per-target lock (`src/lock.ts`,
  `O_EXCL`, stale-pid reclaim) outside the repository serializes
  concurrent probes on the same file; an in-flight marker written before
  mutation lets the next invocation recover automatically from a
  `SIGKILL`/crash mid-mutation, or refuse with `stale_probe_marker`
  naming the backup path when it cannot prove that recovery is safe.
  Restore runs on normal completion, on any thrown error, and on
  `SIGINT`/`SIGTERM`; a failed restore is terminal (`restore_failed`,
  exit 2, never a `killed`/`survived` verdict). `doctor`'s `checks`
  gained a `stale-probe-marker` entry for the current repository.

- `probe`'s `worktree` isolation (now the default `-i`): the mutation
  runs inside a detached git worktree, never the working tree itself.
  Every git invocation this mode makes runs through an argv array with
  no shell involved (the same runner `-p, --patch` already used), so a
  `--file`, `--log-dir`, or `--link` value reaches `git` as one opaque
  argument regardless of its characters. Each run gets its own scratch
  subdirectory under `--log-dir` (`<log-dir>/wt-<random>/`), never a
  fixed name reused across invocations that happen to share `--log-dir`.
  The worktree is synced to the actual working tree state, not just
  `HEAD`: tracked modifications are captured with `git diff HEAD
--binary --output=<scratch file>` (written by git directly to that
  file, never through this process's own output capture) and replayed
  with `git -C <worktree> apply --allow-empty` -- run unconditionally,
  even against an empty diff, so a clean tree and a dirty one exercise
  the same steps; the file count reported in `isolation.syncedTrackedFiles`
  comes from a separate `git diff HEAD --numstat -z`, never from the
  diff's own text. Every untracked, non-ignored path (`git ls-files
--others --exclude-standard`) is synced by its own type: a regular
  file is copied, a symlink (dangling or not) is recreated as a
  symlink, a directory that is itself a git repository is skipped with
  a warning, any other entry is skipped with a warning naming it, and
  a path inside `--log-dir` itself is never treated as a source (decided
  by where the entry itself sits, so an untracked symlink that merely
  points into `--log-dir` is recreated like any other symlink).
  `isolation.syncedUntrackedFiles` counts the `ls-files` entries acted
  on, not the files that ended up on disk. A gitignored `--file` is
  never synced by either sync step, and probing one under `worktree`
  fails fast with `reason: "target_not_synced"`. `--allow-outside`
  combined with `-i worktree` is a usage error
  (`worktree_allow_outside_unsupported`) rather than a raw path or hash
  failure. Every `node_modules` directory or directory symlink (a
  hoisted or workspace-linked install included) up to 3 levels deep
  (never one nested inside another) is symlinked into the worktree at
  the same relative path, alongside every `--link` extra, reported in
  `isolation.linked`. Any non-zero exit while syncing, or a genuine
  filesystem failure while copying/linking, is
  `inconclusive`/`worktree_sync_failed`, exit 2, never a verdict. The
  whole sync runs under the probe's own abort signal and in-flight
  accounting: every git call it makes is killed when `SIGINT`/`SIGTERM`
  arrives and is waited for before anything removes the worktree
  underneath it, and the untracked-file copy checks the same abort
  between batches instead of running to the end of the listing. A sync
  stopped that way reports `inconclusive`/`aborted`, never
  `worktree_sync_failed`: it is a run that was stopped, not a sync that
  failed (on the CLI the signal handler ends the process first, so the
  result is what a library caller sees). The
  lock and the leftover-worktree marker are keyed on the repository
  root instead of `--file` (two probes on one repository serialize,
  covering the shared, linked node_modules caches, and matching
  `inplace`'s own key whenever `--cwd` is inside a repository); the
  file-keyed in-flight marker from `inplace` is not written at all for
  `worktree`, since nothing in the original tree is ever mutated -- the
  original target's hash is still checked before and after, and a
  mismatch is reported as `worktree_original_tree_modified` rather than
  silently trusted. The worktree is removed on normal completion, on
  any thrown error, and on `SIGINT`/`SIGTERM` (the signal handler and
  the pipeline's own cleanup share one in-flight promise, so neither
  can let the process exit while the other's removal is still running),
  including a signal that lands while the worktree is still being
  synced or while `git worktree add` itself is running: whatever is on
  disk at the path is deleted, then `git worktree remove --force
--force` runs (with the directory gone git accepts a missing
  worktree, and the second `--force` clears the `locked` registration
  an interrupted add leaves behind, which a single `--force` refuses
  and `git worktree prune` skips), then `git worktree prune`, with the
  outcome asserted against `git worktree list` and the disk rather than
  inferred from an exit code; a removal that did not take keeps the
  repository-keyed marker and adds a warning naming the path and the
  manual command. The one state git cannot recover from on its own, an
  entry the add left half-written (its `commondir` still empty, which
  makes every `git worktree` command in the repository fail), is
  cleared by removing that entry from the repository's `worktrees`
  administrative directory, only when it names the probe's own
  worktree. The marker is written before the add runs and records
  the `--log-dir`, so a `SIGKILL` or a crash at any point from there on
  leaves it, along with whatever git had registered by then; `doctor`
  reports a leftover from the marker and from `git worktree list` (a
  marker deleted by hand still leaves the registration reported), and
  the next `worktree` probe on that repository removes every leftover
  of the probe's own scratch shape before it starts, marker or not.
  Only a path of that shape (`<log-dir>/wt-<uuid>/wt`) that git reports
  as a worktree of the repository, or that sits under the recovering
  run's own `--log-dir`, is ever deleted; a marker naming anything else,
  or a leftover that cannot be removed, stops the run with
  `inconclusive`/`stale_worktree`, keeps the marker, and names the path
  and either the manual command or the marker file to delete. Outside a
  git work tree, `worktree` falls back to `inplace` with a warning
  naming the fallback. `doctor` gained a `stale-worktree` check
  reporting a leftover worktree for the current repository, from the
  marker and from `git worktree list`, naming the manual `git worktree
remove --force --force` command. Submodule contents are not synced by
  either sync step; a submodule directory is tracked as a gitlink, not
  walked into.

- Initial package scaffold: the shared envelope module (bounded
  serialization, status-to-exit-code mapping), an `exec` runner with fixed
  output tails, a `hash` helper, commander error interception (usage errors
  become a JSON `usage_error` result, exit 2), and a working `doctor`
  subcommand. `probe`, `verify`, and `init` exist as stubs returning
  `not_implemented`; later releases fill them in.
