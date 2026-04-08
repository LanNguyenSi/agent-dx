"""Jinja2-based template rendering."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from jinja2 import Environment, FileSystemLoader, StrictUndefined

if TYPE_CHECKING:
    from pathlib import Path


def create_jinja_env(template_dir: Path) -> Environment:
    """Create a Jinja2 environment for a blueprint's template directory."""
    return Environment(
        loader=FileSystemLoader(str(template_dir)),
        undefined=StrictUndefined,
        keep_trailing_newline=True,
        trim_blocks=True,
        lstrip_blocks=True,
    )


def render_template(env: Environment, template_name: str, context: dict[str, Any]) -> str:
    """Render a single template file with the given context."""
    template = env.get_template(template_name)
    return template.render(**context)


def render_string(text: str, context: dict[str, Any]) -> str:
    """Render a Jinja2 string (e.g. for target paths)."""
    env = Environment(undefined=StrictUndefined)
    template = env.from_string(text)
    return template.render(**context)
