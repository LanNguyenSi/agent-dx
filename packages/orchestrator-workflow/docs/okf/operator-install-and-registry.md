---
type: module
title: Operator install and target registry
description: The operator-level home, manifest schema, locked write API, target registry, and the setup/apply/doctor/adopt commands built on top of it.
tags: [operator, manifest, registry, lock, doctor, adopt, pin, cli]
timestamp: 2026-09-05T05:57:53Z
sources:
  - packages/orchestrator-workflow/src/operator-manifest.ts
  - packages/orchestrator-workflow/src/routing.ts
  - packages/orchestrator-workflow/src/routing-state.ts
  - packages/orchestrator-workflow/src/doctor.ts
  - packages/orchestrator-workflow/src/cli.ts
  - packages/orchestrator-workflow/src/init.ts
  - packages/orchestrator-workflow/src/cli-inputs.ts
  - packages/orchestrator-workflow/src/uninstall.ts
  - packages/orchestrator-workflow/test/operator-manifest.test.ts
  - packages/orchestrator-workflow/test/adopt.test.ts
  - packages/orchestrator-workflow/test/routing.test.ts
---

# Operator install and target registry

Distinct from a repo's own `.ai/workflow/manifest.json` (see
[install fence mechanics](install-fence-mechanics.md)), one operator can hold a
single operator-level home that records its own install defaults plus a
registry of every repository it has applied the kit to. Four commands sit on
top of it: `setup` writes the defaults, `apply` projects them onto one target
and registers it, `doctor` reports every registered target's status, and
`adopt` registers an already-installed target verbatim. Every write to the
operator manifest, from any of the four, funnels through one locked
read-modify-write entry point.

## Operator home: resolution order

`resolveOperatorHome` resolves, in order: an explicit argument, then the
`ORCHESTRATOR_WORKFLOW_HOME` environment variable
(operator-manifest.ts:29-30#"export const OPERATOR_HOME_ENV ="), then
`~/.orchestrator-workflow/`
(operator-manifest.ts:74-83#"return join(homedir(), OPERATOR_HOME_DIRNAME);").
Both the explicit argument and the env var are made absolute via `node:path`'s
`resolve`, relative to `process.cwd()`. The manifest itself lives at
`<home>/manifest.json`
(operator-manifest.ts:29-31#"export const OPERATOR_MANIFEST_FILENAME =").

## The operator manifest: schema and read states

`OperatorManifest` (`schemaVersion: 1`) carries `kit`, `schemaVersion`,
`defaults`, `targets`, `createdAt`, `updatedAt`
(operator-manifest.ts:57-63#"updatedAt: string;"). `defaults`
(`OperatorManifestDefaults`) carries `harnesses`, `profile`, `tiers`, legacy
`models`, optional sparse `routing`, and optional `opencodeModels` and
`opencodeClassModels` compatibility maps for supported bare legacy opencode
ids (`operator-manifest.ts:41-47#"routing?: HarnessRouting;"`). `models` is a
`Partial<Record<Role, string>>`, not a full record, so a
hand-written or legacy operator manifest can carry only some roles and let the
rest fall back to the shipped defaults at the call site)
(operator-manifest.ts:39-47#"routing?: HarnessRouting;"). Routing is parsed
strictly: an invalid map makes the operator manifest unreadable because
silently dropping it could change native Codex agents. Each
entry of `targets` (`OperatorTarget`) stores exactly `path`,
`lastAppliedVersion`, `lastAppliedAt`
(operator-manifest.ts:51-54#"lastAppliedAt: string;").

`readOperatorManifest` degrades every field independently rather than failing
whole, the same posture `readInstalledManifest` takes for a repo manifest: an
invalid harness, model id, profile, or tiers value is dropped or replaced with
its shipped default instead of throwing. Only the envelope is a hard
requirement: a `kit` that is not `"orchestrator-workflow"`
(operator-manifest.ts:111-124#"if (candidate.kit !==") or a `schemaVersion`
that is not `1` (operator-manifest.ts:111-125#"if (candidate.schemaVersion !==")
makes the whole read return `undefined` (not a manifest this kit recognizes),
rather than guessing.

A read lands in exactly one of three states, `OperatorManifestState`: `absent`
(no file at all, the fresh-operator case), `unreadable` (a file exists but did
not parse or validate, e.g. corrupt JSON or a foreign envelope), or `ok` (with
`manifest` set)
(operator-manifest.ts:534-537#"manifest: OperatorManifest };",
operator-manifest.ts:539-543#"return manifest ? { kind:"). This distinction
matters operationally: `absent` says "run `setup`", `unreadable` says "back it
up and repair it, or remove it and run `setup` again"; re-running `setup`
blindly over an unreadable file would silently wipe whatever registry data
survives next to the damaged envelope.

## The locked write API

The manifest is never written directly outside of one function,
`updateOperatorManifest`
(operator-manifest.ts:577#"export function updateOperatorManifest("): every
write from `setup`, `apply`, `doctor --prune`, and `adopt` goes through it, so
no command can bypass the lock and race another's read-modify-write. It runs
the whole re-read, `mutate`, and write inside one locked critical section: the
manifest handed to `mutate` is re-read *inside* the lock, not whatever the
caller read earlier (which can already be stale by the time the lock is
granted). Returning `undefined` from `mutate` means "write nothing" and yields
`written: false`
(operator-manifest.ts:576-596#"return { state, written: false };"); returning
a manifest writes it inside the lock via the internal, unlocked writer
(operator-manifest.ts:577-623#"writeOperatorManifestUnlocked(home, toWrite);").

The lock itself, `withOperatorManifestLock`
(operator-manifest.ts:424-431#"const pollMs = options.pollMs ?? DEFAULT_LOCK_POLL_MS;"),
is a same-machine, advisory mutex built on `mkdirSync(<home>/.manifest.lock)`
(operator-manifest.ts:250#"const OPERATOR_MANIFEST_LOCK_DIRNAME ="): directory
creation is atomic on every filesystem Node targets, so a second concurrent
`mkdirSync` for the same path fails with `EEXIST` rather than silently
succeeding. Right after acquiring the lock directory, a fresh random token is
written to `<lockPath>/owner`
(operator-manifest.ts:443#"writeFileSync(ownerPath, ownToken,"); the lock is
released in `finally` only when that owner file still holds this call's own
token (operator-manifest.ts:506#"if (currentOwner === ownToken) {"), so a
call whose lock was reclaimed out from under it (see below) never tears down
the new owner's critical section.

A caller that finds the lock held retries with a short synchronous sleep until
either it acquires the lock or the default 40-second timeout elapses, in which
case it throws `OperatorManifestLockTimeoutError` without ever calling `fn`
(operator-manifest.ts:495#"throw new OperatorManifestLockTimeoutError(lockPath);",
operator-manifest.ts:258#"export const DEFAULT_LOCK_TIMEOUT_MS = 40_000;").
On every failed attempt, a lock directory older than the default 30-second
staleness window (checked via its mtime) is treated as abandoned, most likely
left behind by a process that crashed between acquiring and releasing it, and
reclaim is attempted by renaming it aside
(operator-manifest.ts:262#"export const DEFAULT_LOCK_STALE_MS = 30_000;",
operator-manifest.ts:450#"const staleRenamePath ="). The staleness check and
the rename are two separate syscalls, so age is re-checked a second time on
the renamed copy before it is actually destroyed
(operator-manifest.ts:341#"export function shouldDestroyReclaimedLock(",
operator-manifest.ts:341-345#"return postAgeMs !== undefined && postAgeMs > staleMs;");
a lock that turns out fresh on that second check is handed back to its real
owner instead of destroyed. The 40-second timeout is deliberately kept above
the 30-second staleness window, and pinned as such by a dedicated test
(test/operator-manifest.test.ts:606-613#"expect(DEFAULT_LOCK_TIMEOUT_MS).toBeGreaterThan(DEFAULT_LOCK_STALE_MS);"):
a waiter that starts anywhere from 0ms up to the staleness window after a
killed holder left its lock behind must still be alive, polling, when that
lock crosses the staleness threshold, rather than timing out first.

## The target registry

Registering a target is `upsertOperatorTarget`
(operator-manifest.ts:683#"export function upsertOperatorTarget("): it
dedupes by realpath, not raw string equality
(operator-manifest.ts:682-691#"(target) => safeRealpath(target.path) === resolvedPath,"),
via a realpath helper that never throws
(operator-manifest.ts:659#"export function safeRealpath(candidate: string): string {"),
so the same directory reached via a symlink or a differently-cased path
updates the existing entry in place instead of appending a duplicate. Both
`apply` and `adopt` call it inside their own `updateOperatorManifest`
mutation; a brand-new operator manifest otherwise starts with an empty
`targets` array
(operator-manifest.ts:87-98#"updatedAt: timestamp,"). Nothing removes a
well-formed registry entry except `doctor --prune` (below); a row that
fails `readOperatorManifest`'s own per-entry shape check is silently
dropped on read instead, before any command ever sees it, since every
write path rewrites the manifest from that same validated read
(operator-manifest.ts:178-187#"typeof t.lastAppliedAt ==="). An `uninstall` on the
target repository never touches the registry either way (see "Uninstall"
below).

## `setup`: operator-level defaults

`setup` writes or refreshes only `<home>/manifest.json`'s `defaults`; it
touches no repository (cli.ts:312-314#"touches no repository",
cli.ts:452#"const result = updateOperatorManifest(home, (current, state) => {",
the action's only write call, targeting the operator manifest rather than
any repository). A plain re-run that resolves to the same
`harnesses`/`profile`/`tiers`/`models`/`routing`
values as already stored is a no-op write, decided by an
order/completeness-insensitive comparison, `defaultsEqual`
(cli.ts:139-152#"return normalize(a) === normalize(b);"); the newly-resolved
values are otherwise assembled into `defaults` verbatim
(cli.ts:426#"const newDefaults: OperatorManifestDefaults = {") and passed
through `updateOperatorManifest`.

## `apply`: project the operator's install onto one target

`apply --target <repo>` installs the kit into `<repo>` and registers it
(cli.ts:695-697#"registers the target in the operator manifest",
cli.ts:1023#"const upserted = upsertOperatorTarget("). Its
harnesses/profile/tiers/models/routing precedence is layered:

1. An explicit CLI flag always wins, the same override-vs-persist rule
   `resolveInitInputs` already applies to a plain `init` re-run: for
   example `--tiers`/`--no-tiers` always overrides whatever `previous`
   (the synthetic manifest built below) carries
   (cli-inputs.ts:386#"const tiers = opts.tiers ?? previous?.tiers ?? false;").
2. Absent an explicit `--harness`, harnesses fall back to the target's own
   recorded harnesses, else the operator defaults, else detection
   (cli.ts:705-707#"else the operator defaults, else detected",
   cli.ts:619-631#"return detected.length > 0 ? detected :").
3. Absent an explicit flag, `profile`/`tiers`/`models`/`routing` fall back to the
   target's own recorded manifest, UNLESS `--sync` is passed, in which case
   the operator defaults override the target's recording instead
   (cli.ts:734-736#"override the target's own recorded values",
   cli.ts:650-668#": (repoManifest?.tiers ?? operatorDefaults.tiers);").
   `--sync` only affects profile/tiers/models/routing; harnesses are never widened by
   the operator defaults once the target has its own recorded set.
4. An explicit `--routing <json-file>` is parsed before target writes and is
   applied as the final deep patch, so omitted leaves retain the resolved
   baseline. `--codex-catalog <json-file>` validates the selected installed
   Codex leaves offline before kit-owned writes.

Doctor compares normalized effective routing. When a legacy opencode leaf has
neither a recorded concrete model nor an explicit session-inheritance choice,
it returns `routingComparisonGaps` and the
human report says `Routing comparison incomplete`. Such a gap does not alone
set `divergent` or `unverifiable`; it prevents an unresolved alias from
producing a false mismatch.

### Pin gate and `--pin`/`--unpin`/`--force-pin`

A repo manifest can carry a kit-version pin. A plain `apply` is skipped with
no changes when the repo's recorded pin differs from the running operator
install's version (cli.ts:868-874#"Repository is pinned at"), unless the
operator explicitly overrides the gate: `--force-pin` advances an *existing*
pin to the current kit version, with no effect on a target that has no pin
recorded at all (cli.ts:738-740#"has no effect on a target with no pin recorded",
cli.ts:958-963#"? PACKAGE_VERSION"); `--pin <version>` sets or replaces the
pin regardless of any existing one
(cli.ts:742-744#"regardless of any existing pin"); `--unpin` clears it
(cli.ts:746-748#"clear the target's recorded kit-version pin",
cli.ts:958-959#"? null"). `--pin` and `--unpin` are mutually exclusive at the
CLI layer, a usage error rather than an implicit precedence rule
(cli.ts:783#"if (opts.pin !== undefined && opts.unpin) {"). `runInit` itself
resolves the final stored pin the same way for both `init` and `apply`: a
`string` sets it, `null` clears it, `undefined` (the default, no flag passed)
carries the previous manifest's pin forward unchanged
(init.ts:560-567#"normalizedPin === null ? undefined : (normalizedPin ?? previous?.pin);").

Registration happens even when local edits left some files `conflicted` (the
apply itself still ran). The pin gate returns before the install is ever
attempted: it sits above `runInit`'s own call site
(cli.ts:868-874#"Repository is pinned at", cli.ts:966#"const report = runInit({"),
so nothing runs when it fires. The same is true of every other early return:
`--pin` and `--unpin` together (cli.ts:783-784#"cannot be used together") or
a malformed `--pin` value
(cli.ts:789-793#"must be non-empty with no internal whitespace") are usage
errors at exit code 2; an unreadable
(cli.ts:811#"back it up and repair it, or remove it and run") or absent
(cli.ts:818#"No operator setup found") operator manifest, and a target
that is not a directory (cli.ts:76-79#"Target is not a directory"), are
precondition failures at exit code 1; none of these install anything either.

Once the install has actually run, registration can still fail without a
second install attempt. If the operator-manifest lock cannot be acquired,
the kit is installed in the target but not registered, and the operator is
told to re-run `apply` to register it
(cli.ts:1033-1037#"the kit was installed but the target was not registered").
The same outcome follows if the operator manifest turns unreadable or absent
between this command's own top-of-run read and this later locked write:
`applyRegistrationFailureMessage` reports it and the command exits 1 with
the kit already installed but the target unregistered
(cli.ts:1048#"applyRegistrationFailureMessage(").

## `doctor`: report every registered target's status

`doctor` walks every entry in the operator manifest's registry and reports
each target's status against the operator's defaults; the citation below is
the plain path, and under `--prune` the same per-target walk runs inside
the locked read-modify-write described further down
(cli.ts:1067-1068#"Report each operator-registered target's status",
doctor.ts:608-610#"inspectTarget(target, state.manifest, PACKAGE_VERSION),").
The vocabulary is a seven-member union, `TargetStatus`
(doctor.ts:42#"export type TargetStatus ="): `clean`, `divergent`,
`version-lag`, `drift`, `missing`, `no-manifest`, `unverifiable`.
Precedence is fixed: `drift` outranks `divergent`, which outranks
`version-lag`, which outranks `clean`
(doctor.ts:401-406#"else if (versionLag) {"); `unverifiable` is a distinct
case from both `missing` and `no-manifest`: it means the target directory or
its repo manifest could not even be *checked* (a stat failure other than
ENOENT, or a manifest file present but unreadable), so nothing is actually
known about that target's real state
(doctor.ts:25-40#"that basis would be an unrecoverable guess."). Only a
subset of `TargetReport`'s fields is part of the `--json` contract,
`TargetReportJson`
(doctor.ts:113-121#"reason: string | null;",
doctor.ts:127-136#"reason: report.reason,"); the fields outside that
contract exist only for the human-output printer in `cli.ts`, to render
detail lines without recomputing values `inspectTarget` already worked out
(doctor.ts:59-64#"render detail lines without recomputing values").

Exit codes: `2` when no operator manifest exists at all (nothing else is
evaluated), whether the file is simply absent or present-but-unreadable
(doctor.ts:495-506#"a possibly-fine targets array sitting next to the unreadable");
also `2`, via a separate path in `cli.ts` rather than in `runDoctor` itself,
when a `--prune` run's locked read-modify-write throws instead of returning
a report (a foreign lock held past its timeout, or any other error
acquiring or writing the lock, e.g. `EACCES` in a read-only operator home):
the manifest is left untouched and `cli.ts`'s own `catch` block prints a
differently-shaped JSON object with `error: "operator-manifest-locked"` or
`"operator-manifest-write-failed"` plus a `message` string, carrying no
`unvalidatedDropped` field at all (cli.ts:1094-1122#"error: doctorError,").
Otherwise: `1` if any remaining target (after an optional prune) is
`drift`, `missing`, `no-manifest`, or `unverifiable`; else `0`
(doctor.ts:614-622#": 0;"). Outside that thrown-lock-error path, `--json`
prints the `DoctorReport` as one JSON object with each target projected to
its `TargetReportJson` subset
(cli.ts:1142#"targets: report.targets.map(targetReportToJson),"), including the
report-level `unvalidatedDropped`
(doctor.ts:202#"unvalidatedDropped: number;") and `pruned`
(doctor.ts:188#"pruned: string[];")
(cli.ts:1137-1146#"report.error ? { error: report.error }"); within that
object, `error` is set only when no manifest was evaluated, distinguishing
"never ran `setup`" from "manifest exists but does not parse or validate"
(doctor.ts:203-208#"(corrupt JSON, or an envelope that does not match this kit)."). That
lock-failure JSON object above is assembled directly by `cli.ts`'s `catch`
block, not by `runDoctor`, and carries its own, differently-named `error`
values outside `DoctorReport`'s error contract entirely.

`--prune` removes exactly the `missing` and `no-manifest` targets from the
registry before reporting, rewriting the whole manifest file in normalized
form; `unverifiable` targets are never removed by it, since an unreadable
target might still be perfectly fine and dropping its row on that basis would
be an unrecoverable guess
(cli.ts:1074-1076#"remove missing and no-manifest targets from the operator registry",
doctor.ts:432#"const REMOVE_ON_PRUNE: ReadonlySet<TargetStatus> = new Set<TargetStatus>([").
The prune's own re-read, recompute, and write run inside
`updateOperatorManifest`'s single locked section, the same as every other
registry write.

## `adopt`: register an already-installed target verbatim

`adopt [dir]` registers a repository that already has the kit installed,
touching nothing in the repository itself
(cli.ts:1334-1335#"touching nothing in the repository",
cli.ts:1484-1495#"bootstrapped = !current;", the action's only write call,
targeting the operator manifest and never the target repository). When no
operator manifest exists yet at all, it bootstraps one from the target's own
recorded
settings (harnesses/profile/tiers/models/routing) instead of falling back to the
shipped defaults `setup` would use
(cli.ts:1334-1335#"bootstraps the operator manifest from the repository's own recorded settings",
cli.ts:1290-1297#"models: { ...repoManifest.models },",
cli.ts:1484-1495#"bootstrapped = !current;"). It then prints the one
target's doctor report and exits with `adoptExitCodeForStatus`'s own
single-target mapping, a function scoped to `adopt`'s contract
(doctor.ts:140-141#"single-target exit-code") and not something `doctor`'s
own multi-target exit code is built from: `0` for
`clean`/`divergent`/`version-lag`, `1` for `drift`, `2` for
`missing`/`no-manifest`/`unverifiable`
(doctor.ts:152-163#"return 0;",
test/adopt.test.ts:564-565#"maps all seven TargetStatus values to adopt").
This three-way, per-status split is deliberately finer than `doctor`'s own
two-way `0`/`1` aggregate exit code over all registered targets (above),
which never derives a `2` from any individual target's status
(doctor.ts:614-622#": 0;"). The same `adoptExitCodeForStatus` mapping also
drives whether the success line is suppressed
(doctor.ts:180-181#"return adoptExitCodeForStatus(status) === 2;") and
whether the `--json` output carries an `unexpected-target-status` error key
(doctor.ts:648-651#"return adoptExitCodeForStatus(status) === 2"), both
wired into `adopt`'s own action
(cli.ts:1566-1567#"const unexpectedStatus = suppressSuccessLine(targetReport.status);").
Every failure `adopt` can report before it has a target report to return
(not a directory, no repo manifest, a foreign or unreadable repo manifest, a
lock failure) is a usage/precondition error at exit code 2, unlike `apply`
above: only `apply`'s unreadable/absent operator manifest and its own
not-a-directory check land on exit code 1, while `apply`'s own
`--pin`/`--unpin` usage errors exit at 2, the same code as every one of
`adopt`'s failures here.

## The pin rule

A repo manifest's optional `pin` field
(init.ts:120-140#"pin?: string;") records a kit-version an operator wants that
repo to stay at, independent of `version` (the actually-installed kit
version); `InitOptions.pin` is how a caller sets it: a `string` to set, `null`
to clear, `undefined` to carry the previous value forward unchanged
(init.ts:104-112#"pin?: string | null;"). A stored pin that is empty or
whitespace-only is treated as no pin at all, both on write and on read back
(init.ts:278-282#"? { pin: candidate.pin.trim() }"). `doctor`'s `versionLag`
computation applies the pin rule precisely: a recorded pin suppresses
`version-lag` only when the pin equals the repo's own *installed* version;
that is the expected, deliberate-stay state. When the pin and the installed
version differ (someone changed the pin without reapplying, or the installed
version drifted some other way), the target is still reported `version-lag`
even though it carries a pin; with no pin at all, `version-lag` compares the
installed version against the running kit version instead
(doctor.ts:382-394#": manifest.version !== kitVersion;").

## Uninstall does not touch the registry

`runUninstall` takes only a target directory and a force flag; it has no
operator-home parameter, takes no lock, and never reads or writes the
operator manifest at all
(uninstall.ts:119-122#"}): UninstallReport {"). A target that is uninstalled
therefore stays registered until a `doctor` run reclassifies it: once its
`.ai/workflow/manifest.json` is gone, `inspectTarget` reports it
`no-manifest`, and only `doctor --prune` actually removes that row from the
registry (doctor.ts:432#"const REMOVE_ON_PRUNE: ReadonlySet<TargetStatus> = new Set<TargetStatus>(["). A target directory removed outright reports `missing`
instead, pruned by the exact same mechanism.

See [index.md](index.md) for the rest of this bundle.
