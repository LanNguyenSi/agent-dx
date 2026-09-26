# `validate-review-report` CLI reference

See the [package README](../README.md) for the rest of the CLI surface.

```bash
orchestrator-workflow validate-review-report path/to/return.yaml
orchestrator-workflow validate-review-report - < path/to/return.yaml
orchestrator-workflow validate-review-report path/to/return.yaml --format json
```

Checks a reviewer return's YAML against the reviewer output contract's
required fields and enums (see the "Reviewer output contract" section of
`assets/skill/references/contracts.md`, byte-identical to the contract in
`assets/agents/reviewer.md`), whether the return is fenced in a code
block (any language tag, or none) or given unfenced, and prints one
diagnostic per missing or invalid field. Every element of a string-array
field (`summary`, `missing_tests`, `residual_risks`) must itself be a
string; a non-string element (a number, a mapping, a boolean, or `null`
, written as a bare or `~` bullet) is its own diagnostic at
`<field>[<index>]`. A fenced return ends at the first closing fence that
starts at column 0, repeats at least as many backticks as the opening
fence, and carries nothing but whitespace after that run, so neither a
reviewer quoting a fenced snippet inside a value (a `description` block
scalar, which YAML indents) nor one wrapping a return in four backticks
around a snippet fenced at column 0 truncates the return. A return
with no closing fence satisfying all three is not fenced at all, so its
whole text reaches the parser; that includes one whose opener is longer
than every closing run present. When the return carries more than one
fenced block, the first one whose fence tag's first word is `yaml` or
`yml` is validated, case-insensitively and counting whitespace-separated
attributes (`yaml title=x` counts; `yaml,title=x` does not, its first
word being the whole string), falling back to the first fence only when
none carries that word; a warning names any earlier fence skipped this
way. This preference can validate a later worked example instead of an
earlier, real but unfenced return: a reviewer who leaves their own return
unfenced and then quotes a `yaml`-tagged example afterward has that
example validated instead, which the emitted warning also names.
`--format json` prints the same diagnostics as a single JSON object
instead of human-readable text. It exits `0` when the return is
structurally valid, `1` when it is structurally invalid (a required field
is missing or its value falls outside its enum, or the input is
unparsable, empty, or not a mapping), and `2` for a usage error (an
unreadable file, an unrecognized `--format` value, a missing `<file>`
argument, an unknown option, or an excess positional argument).
`--format json` governs the validation verdict only: a commander parsing
error (missing argument, unknown option, excess arguments) or an
unrecognized `--format` value itself still prints plain text to stderr
with nothing on stdout, regardless of `--format`; the one exception is an
unreadable file, which does emit the JSON envelope on stdout. This check
is structural only: it never judges semantic adequacy, cannot waive a
finding, and passing it is never orchestrator acceptance. The
required-field set it checks is hand-maintained in `src/review-report.ts`
and pinned against the contract block itself by
`test/docs-consistency.test.ts`, so a contract edit without a matching
schema edit fails the suite instead of drifting silently; every field
listed there is dispatched to its own checker, so an entry added to the
list without a checker fails to typecheck rather than passing unchecked.
