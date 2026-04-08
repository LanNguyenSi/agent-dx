"""Load and parse blueprint definitions from YAML files."""

from __future__ import annotations

import os
from pathlib import Path

import yaml

from scaffoldkit.models import Blueprint

_PACKAGED_BLUEPRINTS_DIR = Path(__file__).resolve().parent / "blueprints"


def _find_checkout_blueprints_dir() -> Path | None:
    """Return blueprints from a local scaffoldkit checkout when running inside one."""
    try:
        current = Path.cwd().resolve()
    except OSError:
        return None

    for base in [current, *current.parents]:
        candidate = base / "src" / "scaffoldkit" / "blueprints"
        if candidate.is_dir() and (base / "pyproject.toml").is_file():
            return candidate

    return None


def get_blueprints_dir() -> Path:
    """Return the default blueprints directory."""
    configured_dir = os.environ.get("SCAFFOLDKIT_BLUEPRINTS_DIR")
    if configured_dir:
        return Path(configured_dir).expanduser()

    checkout_dir = _find_checkout_blueprints_dir()
    if checkout_dir is not None:
        return checkout_dir

    return _PACKAGED_BLUEPRINTS_DIR


def discover_blueprints(blueprints_dir: Path | None = None) -> list[tuple[str, Path]]:
    """Find all available blueprints. Returns list of (name, path) tuples."""
    base = blueprints_dir or get_blueprints_dir()
    if not base.is_dir():
        return []

    results = []
    for child in sorted(base.iterdir()):
        blueprint_file = child / "blueprint.yaml"
        if child.is_dir() and blueprint_file.exists():
            results.append((child.name, child))
    return results


def load_blueprint(blueprint_path: Path) -> Blueprint:
    """Load a blueprint from a directory containing blueprint.yaml."""
    yaml_file = blueprint_path / "blueprint.yaml"
    if not yaml_file.exists():
        raise FileNotFoundError(f"Blueprint file not found: {yaml_file}")

    with open(yaml_file, encoding="utf-8") as f:
        data = yaml.safe_load(f)

    if not isinstance(data, dict):
        raise ValueError(f"Invalid blueprint format in {yaml_file}")

    return Blueprint(**data)
