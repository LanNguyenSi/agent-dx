/**
 * Compiles a `--pass-regex` / `passWhen.regex` source string into the
 * `RegExp` both `cli.ts`'s `parsePassRegex` and `probe/plan.ts`'s
 * `validatePlan` use, so the two parsers can never drift into two
 * independently-maintained compiles of the same option.
 *
 * Always applies the `m` flag, and only that flag: `^`/`$` then anchor
 * to each LINE of the combined stdout+stderr buffer this pattern is
 * matched against (`exec.ts`'s `combinedOutput`), not only to the whole
 * buffer's very first/last character. That is what a recipe like
 * `^OK \(` needs against a real runner that prints an unrelated line
 * first -- phpunit's own version banner ahead of its green summary, the
 * motivating shape -- since without `m` a leading banner line puts `^`
 * out of reach of the summary line entirely. There is still no flags
 * syntax on this option beyond that: fold `i`/`s` into the pattern
 * itself, and `(?m)` is redundant (the flag is already always on) --
 * neither is JS `RegExp` flags syntax in the first place. This
 * deliberately differs from `--require-baseline-evidence`, which stays
 * flagless (no `m`): that option gates whether a run may proceed at
 * all, not what a test-runner-shaped success line looks like, so it has
 * no equivalent per-line-anchoring need.
 *
 * An unparseable pattern throws the same `SyntaxError` a plain `new
 * RegExp(...)` would; each caller wraps that into its own usage-error
 * shape (`InvalidArgumentError` for the CLI option, `plan_invalid` for
 * the plan-file field).
 */
export function compilePassRegex(source: string): RegExp {
  return new RegExp(source, "m");
}
