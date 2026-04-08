"""Audit tests for blueprint feature flags that promise concrete generated files."""

from __future__ import annotations

from pathlib import Path

import yaml

BLUEPRINTS_DIR = Path(__file__).resolve().parent.parent / "src" / "scaffoldkit" / "blueprints"

# These flags imply concrete scaffold output, not just conditional prose in README/docs.
_FLAG_CONTRACTS = {
    "use_docker": ("docker", "dockerfile"),
    "use_ci": (".github/workflows/",),
}

_PRIMARY_MANIFEST_CONTRACTS = {
    "cli-tool": ("Cargo.toml", "go.mod", "package.json", "pyproject.toml"),
    "django-drf": ("pyproject.toml", "requirements.txt", "requirements-dev.txt"),
    "express-api": ("package.json", "tsconfig.json"),
    "fastapi-backend": ("pyproject.toml", "requirements.txt", "requirements-dev.txt"),
    "nextjs-frontend": ("package.json",),
    "nextjs-fullstack": ("package.json",),
    "reference-php-app": ("tools/composer.json",),
    "rest-api": ("package.json", "pom.xml", "pyproject.toml"),
    "saas-dashboard": (
        "package.json",
        "apps/web/package.json",
        "apps/api/composer.json",
        "pyproject.toml",
        "apps/api/manage.py",
        "Gemfile",
    ),
    "springboot-backend": ("pom.xml", "src/main/resources/application.yml"),
    "static-site": ("package.json",),
    "symfony-backend": ("composer.json", "public/index.php", "bin/console"),
    "symfony-nextjs": (
        "package.json",
        "pnpm-workspace.yaml",
        "apps/web/package.json",
        "apps/api/composer.json",
    ),
}

_KNOWN_GAPS: set[tuple[str, str]] = set()
_KNOWN_UNUSED_VARIABLES: set[tuple[str, str]] = set()


def _manifest_entries_for_flag(blueprint_dir: Path, flag: str) -> list[str]:
    data = yaml.safe_load((blueprint_dir / "blueprint.yaml").read_text())
    entries: list[str] = []
    for section in ("templates", "static_files"):
        for entry in data.get(section, []):
            if entry.get("condition") == flag:
                entries.append(str(entry.get("target", "")))
    return entries


def _audit_flag_contract_gaps() -> set[tuple[str, str]]:
    gaps: set[tuple[str, str]] = set()
    for blueprint_dir in sorted(p for p in BLUEPRINTS_DIR.iterdir() if p.is_dir()):
        data = yaml.safe_load((blueprint_dir / "blueprint.yaml").read_text())
        variables = {var["name"] for var in data.get("variables", [])}

        for flag, required_markers in _FLAG_CONTRACTS.items():
            if flag not in variables:
                continue

            targets = _manifest_entries_for_flag(blueprint_dir, flag)
            has_matching_target = any(
                any(marker in target.lower() for marker in required_markers) for target in targets
            )
            if not has_matching_target:
                gaps.add((blueprint_dir.name, flag))

    return gaps


def _audit_unused_variable_gaps() -> set[tuple[str, str]]:
    gaps: set[tuple[str, str]] = set()
    for blueprint_dir in sorted(p for p in BLUEPRINTS_DIR.iterdir() if p.is_dir()):
        data = yaml.safe_load((blueprint_dir / "blueprint.yaml").read_text())
        variables = [var["name"] for var in data.get("variables", [])]

        corpus_parts: list[str] = []
        for root in ("templates", "static"):
            directory = blueprint_dir / root
            if not directory.exists():
                continue
            for file_path in directory.rglob("*"):
                if not file_path.is_file():
                    continue
                try:
                    corpus_parts.append(file_path.read_text())
                except Exception:
                    continue

        corpus = "\n".join(corpus_parts)
        conditioned_variables = {
            entry.get("condition")
            for section in ("templates", "static_files")
            for entry in data.get(section, [])
            if entry.get("condition")
        }

        for variable in variables:
            if variable in conditioned_variables:
                continue
            if variable not in corpus:
                gaps.add((blueprint_dir.name, variable))

    return gaps


def _audit_primary_manifest_contract_gaps() -> set[tuple[str, str]]:
    gaps: set[tuple[str, str]] = set()
    for blueprint_name, required_targets in _PRIMARY_MANIFEST_CONTRACTS.items():
        blueprint_dir = BLUEPRINTS_DIR / blueprint_name
        data = yaml.safe_load((blueprint_dir / "blueprint.yaml").read_text())
        targets = {
            str(entry.get("target", ""))
            for section in ("templates", "static_files")
            for entry in data.get(section, [])
        }

        for required_target in required_targets:
            if required_target not in targets:
                gaps.add((blueprint_name, required_target))

    return gaps


class TestBlueprintContractAudit:
    def test_primary_manifest_contracts(self):
        """Runnable blueprints should declare their primary manifest/bootstrap files."""
        assert _audit_primary_manifest_contract_gaps() == set()

    def test_known_infra_contract_gaps_snapshot(self):
        """Track blueprints whose docker/CI flags do not generate matching files yet."""
        assert _audit_flag_contract_gaps() == _KNOWN_GAPS

    def test_known_unused_variable_gaps_snapshot(self):
        """Track variables that are declared in blueprints but not referenced anywhere."""
        assert _audit_unused_variable_gaps() == _KNOWN_UNUSED_VARIABLES
