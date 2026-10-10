# Changelog

All notable changes to `friction-log` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-10-10

First release published to npm (`npm i -g friction-log`). Earlier versions ran from a local build of this repository. The entries below cover everything since the 0.5.0 milestone tag.

### Added

- Opt-in `sync_export` config block and a `sync-export` command: a deterministic, atomic, no-op-skipping export of the local database, written through after each of the six mutating commands (`log`, `update`, `rm`, `file`, `import`, `scan`). Without the config block everything is an exact no-op. See [sync export](docs/sync-export.md).
- `digest --include-peers`: merges the exports of other machines into the digest, with origin-labeled sections, by replaying them into an in-memory database and reusing the regular digest query.
- The npm package ships `LICENSE`, `README.md`, and this changelog next to `dist/` and `templates/`.

### Changed

- `engines.node` is now `>=22`, matching `better-sqlite3` 13 (which declares `>=22` and ships prebuilt binaries inside its own package, so the install needs no compiler and no download step). Node 20 is no longer a supported runtime.

### Fixed

- `log --session <id>` no longer fails with a raw `FOREIGN KEY constraint failed` when the session id is not yet in the `sessions` table: the row is now created before the friction is inserted.
- `better-sqlite3` is bumped to `^13`, so the package installs on Node 26. `^11` has no prebuilt binary for that ABI and its source build fails against Node 26's V8 headers.

### Security

Runtime (shipped):

- The declared `yaml` floor is raised to `^2.8.3` so installs cannot resolve an older release. The lockfile already resolved 2.9.0, so only the declared range changes.
- `better-sqlite3` moves from 11.10.0 to 13.0.1 (see Changed and Fixed). Its install-time download chain (`prebuild-install`, `tar-fs`, `rc`, `minimist`, and related packages) is gone from the lockfile.

Development-only (not shipped, not part of the published package):

- `tsx` to `^4.22.4` (resolved 4.22.4), which pulls `esbuild` 0.28.1.
- `vitest` to `^4.1.6` (resolved 4.1.11) and `vite` to 8.3.0, now built on `rolldown` 1.2.8 instead of `rollup`.
- Lockfile bumps for `nanoid`, `postcss`, `source-map-js`, `picomatch`, and `tinyglobby`.

### Notes

Node 20 is unsupported: `better-sqlite3` 13 requires Node 22 or newer, and on Node 20 the process crashes with SIGSEGV on the first database command.
