# `init`

Installs this package's own skill document into a harness's skill directory. Part of the [agent-primitives](../README.md) CLI.

Installs this package's own skill document into a harness's skill
directory, so an agent working in the target repository is told when to
reach for `probe`, `verify`, and `doctor` (see `assets/skill/SKILL.md`).

```bash
agent-primitives init
agent-primitives init -H claude,codex -t /path/to/some/repo
agent-primitives init -H all --force
```

- `-H, --harness <list>`: comma-separated `claude`, `codex`, `opencode`,
  or the single value `all` (default: `claude`). Writes to
  `<target>/.claude/skills/agent-primitives/SKILL.md`,
  `<target>/.agents/skills/agent-primitives/SKILL.md`, and
  `<target>/.opencode/skills/agent-primitives/SKILL.md` respectively.
  `init` never writes anywhere under `.claude/agents/`: that directory
  belongs to a different installer (orchestrator-workflow) and carries
  its own role prompts and manifest hashes.
- `-t, --target-dir <dir>`: the directory the harness-specific paths
  above are resolved under (defaults to `-C`/`--cwd`, itself defaulting
  to the process cwd). Any missing directory on the way to the target
  (`-t` itself included, and the harness's own skill subdirectory on a
  first run) is created rather than treated as an error.
- `--force`: overwrite a conflicting or outdated existing file instead of
  reporting it as `conflicted`/`outdated`.

Semantics mirror a standard kit installer's write-if-new-or-unedited
convention: a target that does not exist yet, or exists with
byte-identical content, is written (or reported `unchanged`) with no
further action, exit `0`. A target that exists with different content is
reported `conflicted`, exit `1`, and left untouched, unless `--force` is
given, in which case it is overwritten and reported `written`, exit `0`.

A target whose differing bytes are byte-identical to an *earlier*
released copy of the skill asset, per the checked-in digest ledger
(`assets/skill-ledger.json`, see below), is reported `outdated` instead
of `conflicted`, also exit `1`, and also left untouched by default: the
distinction is informational only, telling a caller "this is a known
release you simply haven't upgraded to yet, not a local edit" without
changing what gets written. Report-only was chosen over an automatic
upgrade so `init`'s write behavior stays a single rule with no exception:
nothing is ever written to an existing, differing target without
`--force`, known-safe or not. `--force` overwrites an `outdated` target
exactly like a `conflicted` one and reports it `written`; the two are
never distinguished once `--force` authorizes the overwrite.
`InitTargetResult` carries `matchedVersion` (the ledger version the
digest matched) only when `status` is `outdated`, so a caller can decide
`--force` is safe without comparing bytes by hand. The lookup is
first-match: when two ledger entries ever carried the same digest (they
should not; the completeness test pins adjacent entries to differ),
`matchedVersion` would name the earlier, lower-versioned one.
`InitTargetStatus` is additive: `outdated` sits alongside the original
three, none of which changed meaning or exit code, and the aggregate
`status` (see "Output beside the envelope" below) treats it as one notch
less severe than `conflicted` and one more severe than `written`. A
missing, unreadable, unparsable, or malformed digest ledger never fails
`init`: it degrades to treating the ledger as empty (or as missing just
the malformed entries), so an affected target simply reads `conflicted`
instead of `outdated`, and `InitResult.warnings` names the cause.

Every requested harness's target is validated against
`--target-dir` before anything is written: containment, a symlink, a
directory or another entry that is not a regular file already sitting
at the target file path, and, under `--force`, write access to a target
whose content differs from the skill being installed are all checked up
front, so a condition of that kind on one harness (for example a
pre-existing symlink, or `.claude` itself pointing outside
`--target-dir`) refuses the whole invocation, exit `2`, with nothing
written for any harness. Write access is checked only where a write is
actually due: a read-only target that already holds exactly this skill
needs no write and is reported `unchanged`, exit `0`, under `--force`
as well, and the other requested harnesses are installed alongside it.
A condition that only shows up during the write itself, such as a
symlink planted in the gap between validation and the write, can still
leave a prefix of the requested harnesses written; the envelope's own
`targets` field then lists whatever was written or found unchanged
before the failure. A symlink at the target file path itself is
refused the same way, whether it dangles, resolves inside or outside
`--target-dir`, and whether or not `--force` is given: a target is
never written through a symlink. This containment guarantee is about
symbolic links specifically; a hard link at the target path is
indistinguishable from a plain regular file and is written through like
one. An entry that is neither a regular file nor a directory (a FIFO, a
socket, a device node) is refused by its type instead of being read or
written, so a FIFO at the target path cannot block the run. `-t` naming
a file instead of a directory, a directory sitting at the target file
path, an entry there that is not a regular file, an existing target
that is not writable, a symlink at the target file path, a resolved
target that escapes `--target-dir`, and a platform whose `fs.constants`
offers no usable `O_NOFOLLOW` for the write's symlink guard are each
reported as `status: "usage_error"`, exit `2`, with a `reason` naming
which one it was (`target_not_a_directory`,
`target_path_is_a_directory`, `target_not_a_regular_file`,
`target_not_readable`, `target_not_writable`, `target_write_failed`,
`target_is_a_symlink`, `target_escapes_directory`, `platform_unsupported`)
instead of a raw
filesystem error message. `target_not_readable` covers both permission
denials while reading and read failures that have no portable errno mapping,
so even an oversized target retains an `init`-specific envelope. Before
reporting an existing file `unchanged`, `init` re-stats and re-reads it; a
target removed or rewritten after validation is therefore written again or
reported conflicted rather than accepted from stale data. Writes account for
the byte count returned by each filesystem call and continue after a short
write; a zero-progress write is `target_write_failed`, never an unbounded
loop. An absent final path is claimed with `O_EXCL`; if another process creates
it first, `init` revalidates and applies the normal unchanged/conflict rules
instead of truncating it. Truncation remains limited to an explicitly forced
replacement of a differing regular file. The platform check is scoped to
`init` and runs when `init` is called, so `probe`, `verify`, and `doctor` stay
usable on such a platform.

Output beside the envelope: `status` (the worst outcome across every
requested harness, most to least severe: `conflicted`, `outdated`,
`written`, `unchanged`) and `targets: [{ harness, path, status,
matchedVersion? }]`, one entry per requested harness (`matchedVersion`
present only when that target's own `status` is `outdated`). `conflicted`
and `outdated` both map to the envelope's `finding` class (exit `1`);
`written` and `unchanged` map to `ok` (exit `0`), unchanged from before
`outdated` existed. A usage-error envelope from a filesystem condition at
the target also carries `targets`, naming whatever harness or harnesses
were already installed before the error (empty when the error was caught
by validation before any write).

### The skill digest ledger

`assets/skill-ledger.json` is a checked-in list of `{ version, sha256 }`
entries: one per published release of `assets/skill/SKILL.md`, plus at
most one trailing pending entry for the version being prepared, each
`sha256` the SHA-256 hex digest of that version's copy of the file. `init`
reads it to tell a byte-identical copy of an earlier release (`outdated`)
apart from bytes that match no release at all (`conflicted`, e.g. a local
edit). It carries no other purpose and is never fetched or written at
`init` time: `init` performs no network access. `init` never fails
because of this file: a missing, unreadable, unparsable, or malformed
ledger degrades to empty (or drops just the malformed entries), so an
affected target reads the pre-existing, safe `conflicted` default instead
of `outdated`, and the run's `warnings` names the cause (in the JSON
envelope and under `warnings:` in the text format).

The ledger is maintained by hand, not generated at build time, and its
primary case is an in-progress change: whenever a change edits
`assets/skill/SKILL.md`, that SAME change appends one `{ version, sha256 }`
entry to `assets/skill-ledger.json`, labelled with the version being
prepared for the next release (`package.json`'s version bumped by the
semver class of the `[Unreleased]` changes), digest computed with
`shasum -a 256` against the edited asset. If the release is then cut at a
different version, the release commit relabels the pending entry to the
version actually shipped before tagging, since a shipped label is what
`matchedVersion` reports to consumers from then on. If the asset changes
again before that version ships, the pending entry is replaced in place
rather than joined by a second one: at most the ledger's last entry may
ever be rewritten, and only while its own version is still unreleased.
Outside a release commit, the last entry is pending exactly when its
version is above `package.json`'s (inside the release commit the
relabel step is what settles it); a release that does not touch the
asset leaves the ledger untouched, so the last entry may legitimately
sit below `package.json`'s version. A pending entry is never what `init` reports:
its digest is the current asset's, and the ledger is only consulted for
a target that differs from the current asset. An entry for a version
that has already shipped is immutable; if it is ever recomputed, that is
done from that version's own release tag, or, for a release with no tag,
from its published package (`npm pack <name>@<version>`, then hash the
unpacked `package/assets/skill/SKILL.md`). A test fails whenever the
digest of the asset actually in the tree is not the ledger's last entry,
and another pins the entries to strictly ascending version order with
differing adjacent digests, so a release that changes the asset without
appending or replacing that last entry is caught before it ships, rather
than silently making every existing installation `conflicted` again.
One rule stays with the maintainer: whether a published release that has
no reachable tag belongs in the explicit untagged-release allowlist. The
release-coverage test compares every reachable tag to its own ledger
digest, or, for a release that left the asset unchanged, to the nearest
earlier entry's (in a local shallow clone it skips, with the reason in verbose output; on GitHub Actions a shallow checkout fails it),
rejects a second untagged entry unless it is the trailing pending entry,
and rejects a tagged release whose pending label was not relabelled.
None of these rules can cause a write (nothing is written without
`--force`); a wrong allowlist entry can make `matchedVersion` name the
wrong version.

