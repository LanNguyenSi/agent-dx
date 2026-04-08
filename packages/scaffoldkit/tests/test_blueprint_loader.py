"""Tests for blueprint loading and discovery."""

from pathlib import Path

import pytest

from scaffoldkit.blueprint_loader import discover_blueprints, get_blueprints_dir, load_blueprint
from scaffoldkit.models import Blueprint

FIXTURES_DIR = Path(__file__).parent / "fixtures"
BLUEPRINTS_DIR = Path(__file__).resolve().parent.parent / "src" / "scaffoldkit" / "blueprints"


class TestDiscoverBlueprints:
    def test_discovers_saas_dashboard(self):
        results = discover_blueprints(BLUEPRINTS_DIR)
        names = [name for name, _ in results]
        assert "saas-dashboard" in names

    def test_returns_empty_for_nonexistent_dir(self, tmp_path):
        results = discover_blueprints(tmp_path / "nonexistent")
        assert results == []

    def test_ignores_dirs_without_blueprint_yaml(self, tmp_path):
        (tmp_path / "not-a-blueprint").mkdir()
        (tmp_path / "not-a-blueprint" / "random.txt").write_text("hi")
        results = discover_blueprints(tmp_path)
        assert results == []

    def test_prefers_checkout_blueprints_when_running_inside_repo(self, tmp_path, monkeypatch):
        repo_root = tmp_path / "scaffoldkit-checkout"
        blueprints_dir = repo_root / "src" / "scaffoldkit" / "blueprints"
        (blueprints_dir / "sample").mkdir(parents=True)
        (blueprints_dir / "sample" / "blueprint.yaml").write_text(
            "name: sample\ndisplay_name: Sample\n",
            encoding="utf-8",
        )
        (repo_root / "pyproject.toml").write_text('[project]\nname = "scaffoldkit"\n')

        monkeypatch.chdir(repo_root)
        monkeypatch.delenv("SCAFFOLDKIT_BLUEPRINTS_DIR", raising=False)

        assert get_blueprints_dir() == blueprints_dir


class TestLoadBlueprint:
    def test_loads_saas_dashboard(self):
        bp_path = BLUEPRINTS_DIR / "saas-dashboard"
        bp = load_blueprint(bp_path)
        assert isinstance(bp, Blueprint)
        assert bp.name == "saas-dashboard"
        assert bp.display_name == "SaaS Dashboard"
        assert len(bp.variables) > 0
        assert len(bp.templates) > 0

    def test_raises_on_missing_file(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            load_blueprint(tmp_path / "nonexistent")

    def test_raises_on_invalid_yaml(self, tmp_path):
        bp_dir = tmp_path / "bad"
        bp_dir.mkdir()
        (bp_dir / "blueprint.yaml").write_text("not_a_mapping")
        with pytest.raises(ValueError, match="Invalid blueprint format"):
            load_blueprint(bp_dir)

    def test_variable_types_parsed(self):
        bp = load_blueprint(BLUEPRINTS_DIR / "saas-dashboard")
        var_map = {v.name: v for v in bp.variables}
        assert var_map["project_name"].type.value == "string"
        assert var_map["use_auth"].type.value == "boolean"
        assert var_map["stack"].type.value == "choice"
        assert len(var_map["stack"].choices) > 0
