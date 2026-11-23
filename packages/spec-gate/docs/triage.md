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

| Order | Class | Condition |
|---|---|---|
| 1 | `unsuitable` | `code_related` is `no`, or `scope_within_request` is `no` |
| 2 | `decision` | `core_is_decision` is `yes` |
| 3 | `split` | `single_goal` is `no`, or `multiple_repos` is `yes` |
| 4 | `clarify` | `blocking_unknowns` is not empty |
| 5 | `no-spec-needed` | `trivial` is `yes` |
| 6 | `actionable` | otherwise |

`row` in the report is the order number of the row that decided.

## Unknown precedence

Rows 1 to 3 are read in order, and each is evaluated in two steps.

- A row fires when its condition is true with the known values; that class
  decides and the unknown fields are empty.
- A row that does not fire but would fire for some value of a field it reads
  (that field is `unknown`) forces `clarify`. An unknown in rows 1 to 3 never
  leads to `actionable` and never lets a later row decide. `unknown_fields`
  lists, in condition order, the `unknown` fields of that row.

So `code_related` = `no` with `single_goal` = `unknown` is `unsuitable`: row
1 fires before row 3 is reached. And `code_related` = `unknown` with
everything else clear is `clarify` at row 1, with `unknown_fields`
`["code_related"]`.

`trivial` = `unknown` counts as not trivial, so row 5 does not fire on it;
an unknown `trivial` forces nothing, and `actionable` results when no earlier
row applies.

## The profile each class leads to

`profileForClass` maps a class to the spec profile it leads to. The classes
that end with no spec have no profile.

| Class | Profile |
|---|---|
| `no-spec-needed` | `light` |
| `actionable` | `full` |
| `unsuitable`, `decision`, `split`, `clarify` | none |
