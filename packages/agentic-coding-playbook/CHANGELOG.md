# Changelog

## Unreleased

- Note that `npm ci` exits 0 when an optional record fails its integrity check, so the registry comparison is the only check for optional platform binaries.
- Require registry metadata comparison, a cold-cache install, and two-sided npm 10 normalization when verifying hand-applied lockfile records; align the English and German review guidance.
- Replace the flat `brace-expansion`/`minimatch` override recipe with a scoped, consumer-keyed one: the override is a range at or above the highest floor the listed consumers declare, never an exact pin below a consumer's floor, consumers on lines the advisory does not cover keep their fixed in-major pair with `minimatch` 3.x staying on `brace-expansion` 1.x at 1.1.21 or newer, a consumer on a 7.x-10.x line that cannot take 11 is deferred as its own major with the advisory recorded open, and the result is verified with `npm ci`, a resolved-version walk that also checks overridden copies against consumer ranges, and one brace-pattern call per consumer line with the copy resolved from the consumer.
