# Contributing

## Development Setup

```bash
npm test
```

The project currently has no runtime dependencies, so cloning the repository and running the test suite is enough for local development.

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
