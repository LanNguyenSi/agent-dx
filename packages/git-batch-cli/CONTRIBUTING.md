# Contributing

## Development Setup

```bash
npm ci
npm test
```

The project currently has no runtime dependencies, but the test suite runs on the devDependency `vitest`, so install the dependencies with `npm ci` before running `npm test`.

## Pull Request Guidelines

- keep changes focused and easy to review
- add or update tests for behavioral changes
- update the README when CLI behavior or output changes
- prefer additive changes over breaking CLI changes

## Code Style

- use ASCII by default
- keep output deterministic for automation and agent use
- preserve the CLI's non-interactive default behavior

## Reporting Issues

When opening an issue, include:

- the command you ran
- the operating system and Node.js version
- the Git version
- the relevant output, ideally with `--json` when applicable
