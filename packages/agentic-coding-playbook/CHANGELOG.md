# Changelog

## Unreleased

- Note that `npm ci` exits 0 when an optional record fails its integrity check, so the registry comparison is the only check for optional platform binaries.
- Require registry metadata comparison, a cold-cache install, and two-sided npm 10 normalization when verifying hand-applied lockfile records; align the English and German review guidance.
- Replace the flat `brace-expansion`/`minimatch` override recipe with a scoped, consumer-keyed one: the target is `minimatch` 11.0.1 or newer scoped only under compatible consumers, `minimatch` 3.x consumers stay on `brace-expansion` 1.x at or above 1.1.21, and the result is verified with `npm ci`, a resolved-version walk, and one brace-pattern call per consumer line.
