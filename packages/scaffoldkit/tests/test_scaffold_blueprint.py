"""Tests for the init-blueprint command and scaffold_blueprint module."""

from pathlib import Path

import yaml
from typer.testing import CliRunner

from scaffoldkit.blueprint_loader import load_blueprint
from scaffoldkit.cli import app
from scaffoldkit.generator import generate
from scaffoldkit.models import GenerationContext
from scaffoldkit.scaffold_blueprint import create_blueprint

runner = CliRunner()


class TestCreateBlueprint:
    def test_creates_all_files(self, tmp_path: Path):
        target = tmp_path / "my-blueprint"
        target.mkdir()
        created = create_blueprint(target, "my-blueprint")

        assert "blueprint.yaml" in created
        assert "templates/README.md.j2" in created
        assert "templates/AI_CONTEXT.md.j2" in created
        assert "static/.editorconfig" in created

    def test_blueprint_yaml_is_valid(self, tmp_path: Path):
        target = tmp_path / "test-bp"
        target.mkdir()
        create_blueprint(target, "test-bp")

        with open(target / "blueprint.yaml") as f:
            data = yaml.safe_load(f)

        assert data["name"] == "test-bp"
        assert data["display_name"] == "Test Bp"
        assert len(data["variables"]) >= 3
        assert len(data["templates"]) >= 1

    def test_blueprint_loads_with_loader(self, tmp_path: Path):
        target = tmp_path / "loadable"
        target.mkdir()
        create_blueprint(target, "loadable")

        bp = load_blueprint(target)
        assert bp.name == "loadable"
        assert bp.display_name == "Loadable"

    def test_generated_blueprint_produces_output(self, tmp_path: Path):
        """The scaffolded blueprint should be immediately usable."""
        bp_dir = tmp_path / "my-stack"
        bp_dir.mkdir()
        create_blueprint(bp_dir, "my-stack")

        bp = load_blueprint(bp_dir)
        output = tmp_path / "output"

        ctx = GenerationContext(
            blueprint=bp,
            blueprint_path=bp_dir,
            variables={
                "project_name": "demo",
                "display_name": "Demo",
                "description": "A demo project",
                "ai_context": True,
            },
            target_dir=output,
        )
        result = generate(ctx)

        assert result.success
        assert (output / "README.md").exists()
        assert (output / "AI_CONTEXT.md").exists()

        readme = (output / "README.md").read_text()
        assert "# Demo" in readme

    def test_ai_context_conditional(self, tmp_path: Path):
        bp_dir = tmp_path / "cond"
        bp_dir.mkdir()
        create_blueprint(bp_dir, "cond")

        bp = load_blueprint(bp_dir)
        output = tmp_path / "output"

        ctx = GenerationContext(
            blueprint=bp,
            blueprint_path=bp_dir,
            variables={
                "project_name": "demo",
                "display_name": "Demo",
                "description": "Test",
                "ai_context": False,
            },
            target_dir=output,
        )
        result = generate(ctx)

        assert result.success
        assert not (output / "AI_CONTEXT.md").exists()

    def test_name_to_display_name_conversion(self, tmp_path: Path):
        target = tmp_path / "my-cool-stack"
        target.mkdir()
        create_blueprint(target, "my-cool-stack")

        with open(target / "blueprint.yaml") as f:
            data = yaml.safe_load(f)

        assert data["display_name"] == "My Cool Stack"

    def test_directories_created(self, tmp_path: Path):
        target = tmp_path / "bp"
        target.mkdir()
        create_blueprint(target, "bp")

        assert (target / "templates").is_dir()
        assert (target / "static").is_dir()


class TestInitBlueprintCommand:
    def test_creates_blueprint_via_cli(self, tmp_path: Path):
        result = runner.invoke(
            app, ["init-blueprint", "test-cli-bp", "--blueprints-dir", str(tmp_path)]
        )
        assert result.exit_code == 0
        assert "created" in result.output.lower()
        assert (tmp_path / "test-cli-bp" / "blueprint.yaml").exists()

    def test_fails_if_directory_exists(self, tmp_path: Path):
        (tmp_path / "existing").mkdir()
        result = runner.invoke(
            app, ["init-blueprint", "existing", "--blueprints-dir", str(tmp_path)]
        )
        assert result.exit_code == 1
        assert "already exists" in result.output.lower()

    def test_shows_next_steps(self, tmp_path: Path):
        result = runner.invoke(app, ["init-blueprint", "my-bp", "--blueprints-dir", str(tmp_path)])
        assert "Next steps" in result.output
        assert "scaffoldkit list" in result.output
        assert "scaffoldkit new my-bp" in result.output
