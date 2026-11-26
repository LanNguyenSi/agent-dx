# Export

`spec-gate export` has two modes and no other behavior: it prints the
`ow` slicer briefing of a merged proposed spec, or it checks a slicer
return against a spec. It writes nothing, fetches nothing and runs no
commands. Exit codes: 0 for a result (a printed briefing, a complete
return), 1 for a checked return with missing ids, 2 for a usage error and
every refusal (`spec-gate: export: <code>: <message>` on stderr). A usage
error the option parser finds itself (an unknown option, a `--format` value
other than `ow`, a missing argument) also exits 2, with the parser's own
`error: ...` line instead.

## `export <spec-dir> --format ow --repo <dir> --default-ref <ref>`

Prints one YAML document on stdout: a deterministic briefing for the agent
that slices the work. `--format` accepts `ow` only; any other value, and
the absence of `--repo` or `--default-ref` with `--format`, exits 2.

Before printing anything the command refuses (`not-merged`) unless the
work tree of `<spec-dir>` holds `spec.md`, `testplan.yaml` and
`bindings.yaml` byte-equal to the copies in the tree of the commit
`--default-ref` resolves to, each of them a regular file on both sides (a
symbolic link, a submodule entry or a directory is refused, `not-regular`
and `not-utf8` name what they find), and `status` is `proposed`
(`not-proposed`). The git reads are the hardened, offline, read-only ones
the lint reference rules use: `--repo` is the trusted checkout root (never
discovered from the spec directory), `--default-ref` must be a full ref
name under `refs/` resolved to one full commit id (`ref-invalid`,
`ref-unresolvable`), and the spec directory must lie inside the
repository (`spec-dir-invalid`). The briefing then carries `digest`, the
digest of the normative layer as `digest` prints it (read at the
`commands_ref` commit of `--repo`).

Export prints a briefing only when it can judge every path in it. What it
cannot judge is refused with a named error (exit 2), never guessed and
never rewritten. Paths are compared as git compares them, byte for byte,
so both sides must spell a path in the one canonical repo-relative form:
`/` separated segments, none of them empty, `.` or `..` (so no leading
`./`, no `//` and no leading `/`), and no backslash. An entry that may
name a directory, which is a Non-goal `paths` entry or a `fixtures` entry,
may end in one `/`; a `file` may not.

| Refusal | Input |
|---|---|
| `binding-path-not-canonical` | a `file` or `fixtures` entry of `bindings.yaml` that is not canonical; the message names the TP id, the field and the path |
| `binding-path-glob` | a `file` or `fixtures` entry that holds `*` or `?`: a binding names one path, and a hint entry is never a pattern |
| `nongoal-path-not-canonical` | a Non-goal `paths` entry that is not canonical; the message names the NG id and the entry |
| `nongoal-glob-unsupported` | a Non-goal `paths` entry that holds `?`, `[`, `]`, `{` or `}`: the glob syntax of a Non-goal path is `*` and `**` and nothing else |

The binding check reads the decoded document before `bindings.yaml` is
validated as a format, so the refusal names the spelling and not some
other problem the file may also have. The format parsers and `lint` accept
spellings this verb refuses, so a spec can pass both and still be refused
here until the path is spelled canonically.

All file paths in the document are relative to the repository root, `/`
separated, `<spec-dir>` included. Fixed key order, fixed list order, byte
identical across runs:

| Key | Content |
|---|---|
| `spec_ref` | `<spec-dir>@<commit>`: the merged spec, pinned |
| `digest` | `sha256:<hex>` of the normative layer |
| `goal` | the text of the single `GOAL` line |
| `acceptance_criteria` | one string per AC line (`<spec-id>#AC-<n>: <text>`) in spec order, then one per test-plan row (`<spec-id>#TP-<n>: <claim>`) in plan order |
| `suggested_tests` | the test-plan rows in plan order, each with the fields it carries in this key order: `id`, `covers`, `kind`, `claim`, `input`, `expected`, `oracle`, `level`, `seam`, `red_reason`, `fail_match`, `baseline`, `threshold`, `runs`, `check_command_ref`, `verifier`, `evidence_location`, `check`, `environment`, `steps`, `control`, `method`, `probe_hint`, `notes` |
| `forbidden_changes` | the `paths` attributes of the Non-goals, plus the spec directory's `spec.md` and `testplan.yaml`, sorted and deduplicated |
| `constraints` | one string per Non-goal line without `paths` (`<spec-id>#NG-<n>: <text>`), then the line that every qualified AC and TP id of the spec must appear literally in at least one task |
| `relevant_docs` | the spec directory's `spec.md` and `testplan.yaml` |
| `allowed_changes_hint` | the `file` and `fixtures` paths of the bindings as written, plus the spec directory's `bindings.yaml`, `bindings.log` and `evidence/` directory, sorted and deduplicated, without any candidate an entry of `forbidden_changes` covers (below) |

No entry of `allowed_changes_hint` is covered by an entry of
`forbidden_changes`. An entry of `forbidden_changes` covers a candidate
when it matches the candidate itself or one of the directories above it.
A Non-goal path therefore covers the path it names and everything below
it, with or without the trailing `/`, and a glob that matches a directory
covers everything below that directory: `src/leg*` covers
`src/legacy/a.test.ts`. A path that only shares a prefix is not covered:
`src/legacy` does not cover `src/legacy-x/a.test.ts`. The spec directory's
`spec.md` and `testplan.yaml` are entries of `forbidden_changes` like the
Non-goal paths, so a binding that names one of them never reaches the
hint.

A Non-goal `paths` entry is matched with one glob semantics: `*` matches
any run of characters except `/`, `**` matches any run of characters
including `/`, either run may be empty, and every other character matches
itself (parentheses, `!`, `+` and `.` included). A segment that is exactly
`**` also matches no segment at all: `a/**/b` covers `a/b`, `**/b` covers
`b` and `a/**` covers `a`, so the entry covers what either common reading
of `**` covers. `src/*.gen.ts` covers `src/a.gen.ts` and not
`src/sub/a.gen.ts`. The entries are printed in `forbidden_changes` as the
spec spells them.

Two limits. The rule judges a hint entry and the directories above it,
not what lies below it: a hint entry that is a directory (the `evidence/`
directory, a fixtures directory) stays in the hint when a Non-goal names a
path inside it, and `forbidden_changes` is the list that counts. And paths
are git paths: two spellings git tells apart (`src/Legacy` and
`src/legacy`) are two paths here, also on a file system that folds case or
Unicode normal forms.

Sort is UTF-16 code unit order (the default order of JavaScript strings,
as in `docs/digest.md`), applied where the order of the source file
carries no meaning (binding paths, Non-goal paths); a list that follows
file order (`acceptance_criteria`, `constraints`) is never reordered. A
sorted list must read the same whatever order its source file listed its
entries in.

## `export <spec-dir> --check <slicer-return.yaml>`

Checks the slicer return against the ids of `<spec-dir>`: every AC line of
`spec.md` and every row of `testplan.yaml`, qualified as
`<spec-id>#AC-<n>` and `<spec-id>#TP-<n>` (`docs/formats.md`, "Stable
IDs"). Reads no git and needs neither `--repo` nor `--default-ref`; giving
either with `--check` is a usage error.

The return is one YAML mapping with a `tasks` list of mappings (a missing
or malformed list is `return-shape`, invalid YAML is `return-parse`, exit
code 2). An id counts when it appears in a string value of at least one
task, at any nesting depth, as a whole token: neither of its two
neighbouring characters (its ends count as neighbours) may be a letter, a
digit, `-` or `_`. So `tiny-valid#AC-1` is matched by `(tiny-valid#AC-1)`
and by a line ending in it, but never by `tiny-valid#AC-10` and never by
`x-tiny-valid#AC-1`.

Exit code 0 when every id counts. Exit code 1 with one line per missing id
(`missing <qualified-id>` on stdout) in the order the ids were read: AC
lines in spec order, then test-plan rows in plan order. The check is a
name check only; the evidence rules for what a task must show per id are
part of the evidence layer, not of this verb.
