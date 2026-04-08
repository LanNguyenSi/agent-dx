# ScaffoldKit

AI-aided project scaffolding tool with declarative blueprints.

## Vision

ScaffoldKit generates complete project skeletons from declarative blueprints - including project structure, documentation, ways-of-working guides, page templates, design references, and AI context files for downstream agent workflows.

## Installation

No Python installation required. Choose whichever method fits your setup.

### Option A: One-line installer (recommended)

```bash
git clone <repo-url> scaffoldkit && cd scaffoldkit
./install.sh
```

This installs [uv](https://docs.astral.sh/uv/) (if not present), which then handles Python and all dependencies automatically. The `scaffoldkit` command is placed in `~/.local/bin`.

### Option B: Docker (no Python needed at all)

```bash
git clone <repo-url> scaffoldkit && cd scaffoldkit
./install.sh --docker
```

This builds a Docker image and installs a thin wrapper. Only Docker and Bash are required.

Or use the wrapper script directly:

```bash
# Build once
docker build -t scaffoldkit:latest .

# Run via wrapper
./scaffoldkit-docker --output ./my-projects -- new
./scaffoldkit-docker -- list
```

### Option C: Makefile shortcuts

```bash
make install          # same as ./install.sh
make install-docker   # same as ./install.sh --docker
make dev              # create .venv with dev dependencies
```

### Option D: pipx (isolated installation)

```bash
# Install pipx if not already installed
python3 -m pip install --user pipx
python3 -m pipx ensurepath

# Install scaffoldkit
git clone <repo-url> scaffoldkit
cd scaffoldkit
pipx install .

# Now available globally
scaffoldkit --help
```

**Benefits:**
- ✅ Isolated from system Python
- ✅ No virtualenv activation needed
- ✅ Global command available
- ✅ Easy to uninstall: `pipx uninstall scaffoldkit`

### Option E: venv (development setup)

```bash
# Clone repository
git clone <repo-url> scaffoldkit
cd scaffoldkit

# Create virtual environment
python3 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install with dev dependencies
pip install -e ".[dev]"

# Run scaffoldkit
scaffoldkit --help
```

**Use when:**
- Contributing to scaffoldkit
- Need dev dependencies (ruff, mypy, pytest)
- Want editable installation

**Note:** If you get "externally-managed-environment" error on Debian/Ubuntu:
```bash
# Use venv instead of system pip
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

### Option F: Manual (if you already have Python 3.11+)

```bash
pip install .
# or for development:
uv venv .venv --python 3.12
source .venv/bin/activate
uv pip install -e ".[dev]"
```

## Usage

### Interactive Mode

```bash
scaffoldkit new
```

This launches the interactive TUI:

1. **Select a blueprint:** Choose from available blueprints
2. **Configure variables:** Answer prompts for project name, stack, features, etc.
3. **Choose target directory:** Where to generate the project
4. **Review and confirm:** See a summary before generation
5. **Generate:** Files are created and a summary is printed

### Direct Mode

```bash
scaffoldkit new saas-dashboard --target ./my-project
```

### Non-Interactive Mode

You can scaffold without the TUI by passing variables explicitly:

```bash
scaffoldkit new symfony-backend \
  --target ./my-symfony-app \
  --non-interactive \
  --var project_name=my-symfony-app \
  --var display_name="My Symfony App" \
  --var description="A Symfony-based API backend" \
  --var php_version=8.3 \
  --var symfony_version=7.2 \
  --var api_style=api-platform \
  --var database=postgresql \
  --var use_ddd=true \
  --var use_cqrs=true \
  --var use_auth=false \
  --var use_docker=true \
  --var use_ci=true \
  --var use_rabbitmq=false \
  --var use_redis=false \
  --var test_strategy=phpunit-only \
  --var ai_context=true
```

Notes:

- `--non-interactive` fills in omitted values from blueprint defaults
- required variables without defaults still fail fast
- conditional variables are skipped automatically when their parent flag is disabled
- boolean values accept `true` / `false`, `yes` / `no`, and `1` / `0`

### From agent-planforge

If you already have a `scaffoldkit-input.json` export from `agent-planforge`, generate directly from it:

```bash
scaffoldkit from-planforge ./scaffoldkit-input.json --target ./my-project
```

This uses the recommended blueprint from the export and applies planforge-provided variable hints before generation.

### Options

```bash
scaffoldkit new [BLUEPRINT] [OPTIONS]

Options:
  -t, --target PATH        Target directory
  -n, --dry-run            Preview without writing files
  --overwrite              Overwrite existing files
  --var KEY=VALUE          Set blueprint variable (repeatable)
  --non-interactive        Use provided values and blueprint defaults without prompting
  -b, --blueprints-dir     Custom blueprints directory
```

### List Blueprints

```bash
scaffoldkit list
```

Current notable blueprints include `fastapi-backend`, `django-drf`, `rest-api`, `express-api`, `nextjs-fullstack`, `nextjs-frontend`, `symfony-backend`, `symfony-nextjs`, `springboot-backend`, `static-site`, and `cli-tool`.

### Docker Usage

```bash
# Interactive
scaffoldkit-docker --output ./projects -- new

# List blueprints
scaffoldkit-docker -- list

# Show docker command without running
scaffoldkit-docker --print -- new saas-dashboard

# Rebuild image before running
scaffoldkit-docker --build --output ./projects -- new
```

## Example Workflow

```bash
$ scaffoldkit new

? Select a blueprint: SaaS Dashboard (saas-dashboard) - Full-stack SaaS dashboard
? project_name: my-saas-app
? display_name: My SaaS App
? description: A modern SaaS dashboard
? stack: nextjs-fullstack
? architecture_style: monorepo
? use_ddd: No
? use_auth: Yes
? use_docker: Yes
? use_ci: Yes
? test_strategy: unit-and-integration
? design_style: minimal-clean
? ai_context: Yes
? Target directory: ./my-saas-app

? Proceed with generation? Yes

Generation completed successfully!

Files created (10):
  ✓ README.md
  ✓ AI_CONTEXT.md
  ✓ docs/architecture.md
  ✓ docs/ways-of-working.md
  ✓ docs/adrs/0001-architecture.md
  ✓ docs/page-templates/dashboard-page.md
  ✓ docs/page-templates/detail-page.md
  ✓ docs/page-templates/settings-page.md
  ✓ .gitignore
  ✓ .editorconfig

Directories (6):
  apps/web
  apps/api
  packages/ui
  packages/shared
```

## Architecture

Three-layer architecture:

```
┌─────────────────────────────────┐
│  TUI / CLI Layer                │  Interactive prompts, display
│  (cli.py, tui.py)               │
├─────────────────────────────────┤
│  Generator / Rendering Layer    │  Template rendering, file I/O
│  (generator.py, renderer.py,    │
│   filesystem.py)                │
├─────────────────────────────────┤
│  Blueprint / Data Layer         │  Models, loading, validation
│  (models.py, blueprint_loader.py│
│   validators.py)                │
└─────────────────────────────────┘
```

### Design Principles

- **Declarative over hard-coded:** Blueprints are YAML, templates are Jinja2
- **Extensible over perfect:** Add a new blueprint by adding a folder
- **Locally runnable:** No external services required
- **AI-friendly by design:** Generates context files for AI agents

## Project Structure

```
scaffoldkit/
├── install.sh             # One-line installer (uv or Docker)
├── Makefile               # Build, test, install shortcuts
├── Dockerfile             # Container build
├── scaffoldkit-docker     # Docker wrapper script
├── pyproject.toml
├── src/
│   └── scaffoldkit/
│       ├── cli.py              # Typer CLI entry point
│       ├── tui.py              # Interactive prompts (questionary + rich)
│       ├── generator.py        # Core generation engine
│       ├── blueprint_loader.py # Blueprint discovery and parsing
│       ├── renderer.py         # Jinja2 template rendering
│       ├── models.py           # Pydantic data models
│       ├── validators.py       # Input validation
│       └── filesystem.py       # File system operations
├── blueprints/
│   └── saas-dashboard/
│       ├── blueprint.yaml      # Blueprint definition
│       ├── templates/          # Jinja2 templates
│       └── static/             # Static files (copied as-is)
├── tests/
├── .github/workflows/ci.yml
├── CONTRIBUTING.md
└── LICENSE
```

## Technologies

| Component | Technology |
|-----------|-----------|
| Language | Python 3.11+ |
| CLI | [Typer](https://typer.tiangolo.com/) |
| TUI Prompts | [questionary](https://github.com/tmbo/questionary) + [Rich](https://rich.readthedocs.io/) |
| Templating | [Jinja2](https://jinja.palletsprojects.com/) |
| YAML | [PyYAML](https://pyyaml.org/) |
| Models | [Pydantic](https://docs.pydantic.dev/) |
| Packaging | [Hatch](https://hatch.pypa.io/) + [uv](https://docs.astral.sh/uv/) |
| Container | Docker (optional) |

## Blueprint Concept

A blueprint is a folder containing:

```
blueprints/<name>/
├── blueprint.yaml    # Definition: metadata, variables, file mappings
├── templates/        # Jinja2 templates (rendered with variables)
└── static/           # Static files (copied as-is)
```

### blueprint.yaml Structure

```yaml
name: my-blueprint
display_name: "My Blueprint"
description: "What this blueprint generates"
version: "1.0.0"
stack: "nextjs"

variables:
  - name: project_name
    description: "Project slug"
    type: string          # string | boolean | choice
    default: "my-project"
    required: true

  - name: use_docker
    type: boolean
    default: true

  - name: stack
    type: choice
    choices: ["nextjs", "remix", "astro"]
    default: "nextjs"

templates:
  - source: README.md.j2        # Path inside templates/
    target: README.md            # Path in generated project
    condition: null              # Optional: variable that must be truthy

static_files:
  - source: .gitignore
    target: .gitignore

directories:
  - src
  - docs
```

### Template Variables

Templates use Jinja2 syntax. All user variables plus blueprint metadata are available:

```jinja
# {{ display_name }}

Stack: {{ stack }}
{% if use_auth %}
Authentication is enabled.
{% endif %}
```

## Adding a New Blueprint

1. Create a folder under `blueprints/`:
   ```
   blueprints/my-new-blueprint/
   ```

2. Create `blueprint.yaml` with metadata, variables, and file mappings.

3. Add Jinja2 templates in `templates/`.

4. Add static files in `static/` (optional).

5. Run `scaffoldkit list` to verify it's discovered.

## Development

```bash
make dev              # create .venv with dev deps
source .venv/bin/activate
make check            # run lint + typecheck + test
```

Or manually:

```bash
pytest                                            # tests
pytest --cov=scaffoldkit --cov-report=term-missing # coverage
ruff check src/ tests/                            # lint
ruff format src/ tests/                           # format
mypy src/scaffoldkit/                             # type check
```

### Test Suite

78 tests covering:

- **Models**: data model construction and validation
- **Blueprint loading**: discovery, parsing, error handling
- **Validators**: required fields, type checks, choice validation
- **Renderer**: string rendering, template rendering, missing variable errors
- **Filesystem**: directory creation, file writing, copy, overwrite protection
- **Generator**: full pipeline, dry-run, conditions, overwrite, static files
- **CLI**: command help, blueprint listing, error paths
- **Integration**: end-to-end generation with all stack/style/feature variations

### CI Pipeline

GitHub Actions runs on every push and PR to `main`:

- **Lint** - ruff check + format verification
- **Type Check** - mypy strict mode
- **Test** - pytest on Python 3.11, 3.12, 3.13
- **Build** - package build + install verification

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and PR process.

## Assumptions

- Python 3.11+ (managed automatically via uv if using the installer)
- Blueprints live alongside the source code (no remote registry yet)
- Single-user local execution (no concurrency handling)
- Blueprint variables are flat (no nested objects)

## License

MIT - see [LICENSE](LICENSE)
