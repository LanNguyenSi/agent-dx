# Changelog

## Unreleased

- Note that `npm ci` exits 0 when an optional record fails its integrity check, so the registry comparison is the only check for optional platform binaries.
- Require registry metadata comparison, a cold-cache install, and two-sided npm 10 normalization when verifying hand-applied lockfile records; align the English and German review guidance.
