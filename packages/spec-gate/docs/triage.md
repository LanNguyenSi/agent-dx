# Triage class derivation

The discoverer writes six yes/no/unknown fields and a list of blocking
unknowns into `triage.json`. The `triage` verb derives one class from them
and writes `class` and `rule_version` back. This page holds that rule. The
table lives as data in `src/triage/rules.ts` (`TRIAGE_RULE_TABLE`); the
version is `TRIAGE_RULE_VERSION`.

## Rule version

The rule is version `1`. `rule_version` written into a file is the version
that derived the class, so a reader can tell which table produced it. Any
change to the table below bumps this number.

## The truth table

The first matching row wins, in this order.

| Order | Class            | Condition                                                 |
| ----- | ---------------- | --------------------------------------------------------- |
| 1     | `unsuitable`     | `code_related` is `no`, or `scope_within_request` is `no` |
| 2     | `decision`       | `core_is_decision` is `yes`                               |
| 3     | `split`          | `single_goal` is `no`, or `multiple_repos` is `yes`       |
| 4     | `clarify`        | `blocking_unknowns` is not empty                          |
| 5     | `no-spec-needed` | `trivial` is `yes`                                        |
| 6     | `actionable`     | otherwise                                                 |

`row` in the report is the order number of the row that decided.

## Unknown precedence

Rows 1 to 3 are read in order, and each is evaluated in two steps.

- A row fires when its condition is true with the known values; that class
  decides and the unknown fields are empty.
- A row that does not fire but would fire for some value of a field it reads
  (that field is `unknown`) forces `clarify`, and that row is the deciding
  row. An unknown in rows 1 to 3 never leads to `actionable` and never lets
  a later row decide. `unknown_fields` lists every `unknown` field among
  `code_related`, `scope_within_request`, `core_is_decision`, `single_goal`
  and `multiple_repos`, in that order, not only the fields of the deciding
  row; `row` stays the deciding row. For every other result `unknown_fields`
  is empty.

So `code_related` = `no` with `single_goal` = `unknown` is `unsuitable`: row
1 fires before row 3 is reached. And `code_related` = `unknown` with
everything else clear is `clarify` at row 1, with `unknown_fields`
`["code_related"]`. `core_is_decision` = `unknown` with `single_goal` = `no`
is `clarify` at row 2: the unknown sits in row 2, so row 3 never decides.
With `code_related` = `unknown` and `multiple_repos` = `unknown` the
deciding row is 1 and `unknown_fields` is
`["code_related", "multiple_repos"]`.

`trivial` = `unknown` counts as not trivial, so row 5 does not fire on it;
an unknown `trivial` forces nothing, and `actionable` results when no earlier
row applies.

## The profile each class leads to

`profileForClass` maps a class to the spec profile it leads to. The classes
that end with no spec have no profile.

| Class                                        | Profile |
| -------------------------------------------- | ------- |
| `no-spec-needed`                             | `light` |
| `actionable`                                 | `full`  |
| `unsuitable`, `decision`, `split`, `clarify` | none    |

## Writing triage.json

The verb never edits `triage.json` in place. It writes the new content to a
temporary file next to it, created exclusively, gives it the permission bits
of the original (setuid, setgid and sticky are dropped), and renames it over
`triage.json`. The rename replaces the file, so a hard link to the old
`triage.json` keeps the old content. A symlinked `triage.json` is refused. On
any failure the original stays unchanged, and the temporary file is removed
only if this run created it.
