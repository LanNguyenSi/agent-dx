# Contributing to ScaffoldKit

Thank you for your interest in contributing to ScaffoldKit! This document explains how to get started.

## Development Setup

```bash
# Clone the repository
git clone <repo-url>
cd scaffoldkit

# Create virtual environment and install with dev dependencies
uv venv .venv --python 3.12
source .venv/bin/activate
uv pip install -e ".[dev]"
```

## Running Tests

```bash
# Run all tests
pytest tests/ -v

# Run with coverage
pytest tests/ --cov=scaffoldkit --cov-report=term-missing

# Run a specific test file
pytest tests/test_generator.py -v
```

## Code Quality

We use ruff for linting and formatting, and mypy for type checking.

```bash
# Lint
ruff check src/ tests/

# Format
ruff format src/ tests/

# Type check
mypy src/scaffoldkit/
```

All checks run automatically in CI on every pull request.

## Project Structure

```
src/scaffoldkit/
  cli.py              # Typer CLI entry point
  tui.py              # Interactive prompts (questionary + rich)
  generator.py        # Core generation engine
  blueprint_loader.py # Blueprint discovery and parsing
  renderer.py         # Jinja2 template rendering
  models.py           # Pydantic data models
  validators.py       # Input validation
  filesystem.py       # File system operations

blueprints/           # Built-in blueprint definitions
tests/                # Test suite
```

## Adding a New Blueprint

1. Create a new directory under `blueprints/`:
   ```
   blueprints/my-blueprint/
   ├── blueprint.yaml
   ├── templates/
   └── static/
   ```

2. Define the blueprint in `blueprint.yaml` (see existing blueprints for reference).

3. Add Jinja2 templates in `templates/` and static files in `static/`.

4. Add a test in `tests/test_blueprint_loader.py` to verify the blueprint loads correctly.

5. Run `scaffoldkit list` to verify discovery works.

## Pull Request Process

1. Fork the repository and create a feature branch from `main`.
2. Make your changes with clear, focused commits.
3. Add or update tests for your changes.
4. Run the full test suite and ensure it passes.
5. Run linting and type checks.
6. Open a pull request with a clear description of what and why.

### Commit Messages

Use conventional commit format:

```
feat(generator): add support for conditional directories
fix(tui): handle empty blueprint list gracefully
docs: update blueprint authoring guide
test: add edge case tests for renderer
```

## Design Principles

Keep these in mind when contributing:

- **Declarative over hard-coded**: Prefer YAML configuration and Jinja2 templates over Python logic.
- **Simple over clever**: Code should be easy to read and understand.
- **Tested**: New features need tests. Bug fixes need regression tests.
- **Separated concerns**: Blueprint logic, generation logic, and UI logic stay in their respective layers.

## Reporting Issues

When reporting a bug, please include:

- Python version (`python --version`)
- ScaffoldKit version (`scaffoldkit --help` or `pip show scaffoldkit`)
- Steps to reproduce the issue
- Expected vs actual behavior
- Any error output

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
