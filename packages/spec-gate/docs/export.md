# Export

`spec-gate export` has two modes and no other behavior: it prints the
`ow` slicer briefing of a merged proposed spec, or it checks a slicer
return against a spec. It writes nothing, fetches nothing and runs no
commands. Exit codes: 0 for a result (a printed briefing, a complete
return), 1 for a checked return with missing ids, 2 for a usage error and
every refusal (`spec-gate: export: <code>: <message>` on stderr).

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

Every `file` and every `fixtures` entry of `bindings.yaml` must be in
canonical repo-relative form before the briefing is built: no leading
`./`, no `.` or `..` segment, no empty segment (so no `//`, no leading
`/` and no trailing `/`), no backslash, and unchanged by POSIX path
normalisation. An entry that is not is refused as
`binding-path-not-canonical` (exit 2), naming the TP id and the path.
The check reads the decoded document before `bindings.yaml` is validated
as a format, so the refusal names the spelling and not some other
problem the file may also have. The hint is built from these canonical
paths and from nothing else.

All file paths in the document are relative to the repository root, `/`
separated, `<spec-dir>` included. Fixed key order, fixed list order, byte
identical across runs:

| Key | Content |
|---|---|
| `spec_ref` | `<spec-dir>@<commit>`: the merged spec, pinned |
| `digest` | `sha256:<hex>` of the normative layer |
| `goal` | the text of the single `GOAL` line |
| `acceptance_criteria` | one string per AC line (`<spec-id>#AC-<n>: <text>`) in spec order, then one per test-plan row (`<spec-id>#TP-<n>: <claim>`) in plan order |
| `suggested_tests` | the test-plan rows, each with its fields in one fixed key order |
| `forbidden_changes` | the `paths` attributes of the Non-goals, plus the spec directory's `spec.md` and `testplan.yaml`, sorted and deduplicated |
| `constraints` | one string per Non-goal line without `paths` (`<spec-id>#NG-<n>: <text>`), then the line that every qualified AC and TP id of the spec must appear literally in at least one task |
| `relevant_docs` | the spec directory's `spec.md` and `testplan.yaml` |
| `allowed_changes_hint` | the `file` and `fixtures` paths of the bindings, plus the spec directory's `bindings.yaml`, `bindings.log` and `evidence/` directory, sorted and deduplicated, with every candidate the row above forbids dropped: a candidate is dropped when it is the spec directory's `spec.md` or `testplan.yaml` or when a Non-goal path covers it, meaning the candidate equals the Non-goal path, lies below it (the path is its prefix followed by `/`, which makes `dir/` a directory), or matches it when the Non-goal path holds a glob (a binding cannot move a forbidden path into the hint, in any spelling) |

The Non-goal `paths` that enter this document as globs (kept verbatim
in `forbidden_changes`, matched in the drop rule above) use one
semantics: `*` matches any characters except `/`, `**` matches any
characters including `/`, and every other character matches itself (`?`
is literal). A path covered by a Non-goal path is dropped from the hint
even when the binding spells it exactly; a glob that does not match the
path leaves it in (`src/*.gen.ts` covers `src/a.gen.ts` and not
`src/sub/a.gen.ts`).

Sort is plain code point order, applied where the order of the source file
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
