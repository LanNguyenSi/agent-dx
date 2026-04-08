"""Scaffold a new blueprint directory with starter files."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path

_BLUEPRINT_YAML = """\
name: {name}
display_name: "{display_name}"
description: "TODO: Describe what this blueprint generates"
version: "1.0.0"
stack: ""

metadata: {{}}

variables:
  - name: project_name
    description: "Project slug (lowercase, hyphens)"
    type: string
    default: "my-project"
    required: true

  - name: display_name
    description: "Human-readable project name"
    type: string
    default: "My Project"
    required: true

  - name: description
    description: "Short project description"
    type: string
    default: "A new project"
    required: true

  # Add your own variables here. Supported types: string, boolean, choice
  #
  # - name: use_docker
  #   description: "Include Docker setup"
  #   type: boolean
  #   default: true
  #
  # - name: language
  #   description: "Primary language"
  #   type: choice
  #   choices:
  #     - python
  #     - typescript
  #     - go
  #   default: python

  - name: ai_context
    description: "Generate AI context file for agent workflows"
    type: boolean
    default: true

templates:
  - source: README.md.j2
    target: README.md

  - source: AI_CONTEXT.md.j2
    target: AI_CONTEXT.md
    condition: ai_context

  # Add more templates here:
  # - source: docs/architecture.md.j2
  #   target: docs/architecture.md

static_files: []
  # Add static files here (copied without rendering):
  # - source: .gitignore
  #   target: .gitignore

directories:
  - src
  - docs
  - tests
"""

_README_TEMPLATE = """\
# {{ display_name }}

{{ description }}

## Quick Start

```bash
# TODO: Add setup instructions
```

## Project Structure

```
{{ project_name }}/
├── src/
├── docs/
├── tests/
{% if ai_context %}
├── AI_CONTEXT.md
{% endif %}
└── README.md
```

{% if ai_context %}
## AI Context

See [AI_CONTEXT.md](AI_CONTEXT.md) for guidance when working with AI coding agents.
{% endif %}
"""

_AI_CONTEXT_TEMPLATE = """\
# AI Context: {{ display_name }}

> This file provides context for AI coding agents working on this project.
> Read this before making any changes.

## Project Overview

**{{ display_name }}** is a {{ description | lower }}.

## Repository Structure

```
{{ project_name }}/
├── src/          -> Source code
├── docs/         -> Documentation
├── tests/        -> Test suite
└── README.md
```

## Architecture Rules

1. TODO: Add architecture rules for this project.
2. TODO: Define patterns that AI agents should follow.
3. TODO: Specify quality expectations.

## Adding New Features

1. TODO: Describe the process for adding features.
2. TODO: Reference relevant patterns or templates.
3. TODO: Specify testing requirements.

## What NOT to Do

- TODO: List anti-patterns and constraints.
"""

_EDITORCONFIG = """\
root = true

[*]
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
charset = utf-8
indent_style = space
indent_size = 2

[*.md]
trim_trailing_whitespace = false
"""


def create_blueprint(target_dir: Path, name: str) -> list[str]:
    """Create a new blueprint scaffold. Returns list of created file paths."""
    created: list[str] = []

    display_name = name.replace("-", " ").replace("_", " ").title()

    # blueprint.yaml
    bp_file = target_dir / "blueprint.yaml"
    bp_file.write_text(
        _BLUEPRINT_YAML.format(name=name, display_name=display_name),
        encoding="utf-8",
    )
    created.append("blueprint.yaml")

    # templates/
    templates_dir = target_dir / "templates"
    templates_dir.mkdir(parents=True, exist_ok=True)

    readme_tpl = templates_dir / "README.md.j2"
    readme_tpl.write_text(_README_TEMPLATE, encoding="utf-8")
    created.append("templates/README.md.j2")

    ai_tpl = templates_dir / "AI_CONTEXT.md.j2"
    ai_tpl.write_text(_AI_CONTEXT_TEMPLATE, encoding="utf-8")
    created.append("templates/AI_CONTEXT.md.j2")

    # static/
    static_dir = target_dir / "static"
    static_dir.mkdir(parents=True, exist_ok=True)

    editorconfig = static_dir / ".editorconfig"
    editorconfig.write_text(_EDITORCONFIG, encoding="utf-8")
    created.append("static/.editorconfig")

    return created
