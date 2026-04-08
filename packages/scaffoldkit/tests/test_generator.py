"""Tests for the generation engine."""

from pathlib import Path

from scaffoldkit.blueprint_loader import load_blueprint
from scaffoldkit.generator import build_template_context, generate
from scaffoldkit.models import GenerationContext

BLUEPRINTS_DIR = Path(__file__).resolve().parent.parent / "src" / "scaffoldkit" / "blueprints"


def _context(tmp_path: Path, **overrides) -> GenerationContext:
    bp_path = BLUEPRINTS_DIR / "saas-dashboard"
    bp = load_blueprint(bp_path)
    variables = {
        "project_name": "test-project",
        "display_name": "Test Project",
        "description": "A test project",
        "stack": "nextjs-fullstack",
        "architecture_style": "monorepo",
        "use_ddd": False,
        "use_auth": True,
        "use_docker": True,
        "use_ci": True,
        "test_strategy": "unit-and-integration",
        "design_style": "minimal-clean",
        "ai_context": True,
    }
    defaults = dict(
        blueprint=bp,
        blueprint_path=bp_path,
        variables=variables,
        target_dir=tmp_path / "output",
        dry_run=False,
        overwrite=False,
    )
    defaults.update(overrides)
    return GenerationContext(**defaults)


class TestBuildTemplateContext:
    def test_includes_user_variables(self):
        ctx = _context(Path("/tmp"))
        tpl_ctx = build_template_context(ctx.blueprint, ctx.variables)
        assert tpl_ctx["project_name"] == "test-project"
        assert tpl_ctx["display_name"] == "Test Project"

    def test_includes_blueprint_metadata(self):
        ctx = _context(Path("/tmp"))
        tpl_ctx = build_template_context(ctx.blueprint, ctx.variables)
        assert tpl_ctx["blueprint_name"] == "saas-dashboard"


class TestGenerate:
    def test_creates_files(self, tmp_path):
        ctx = _context(tmp_path)
        result = generate(ctx)

        assert result.success
        assert len(result.files_created) > 0
        assert (tmp_path / "output" / "README.md").exists()
        assert (tmp_path / "output" / "AI_CONTEXT.md").exists()
        assert (tmp_path / "output" / "docs" / "architecture.md").exists()

    def test_creates_directories(self, tmp_path):
        ctx = _context(tmp_path)
        generate(ctx)

        assert (tmp_path / "output" / "apps" / "web").is_dir()
        assert (tmp_path / "output" / "apps" / "api").is_dir()
        assert (tmp_path / "output" / "packages" / "ui").is_dir()

    def test_dry_run_creates_no_files(self, tmp_path):
        ctx = _context(tmp_path, dry_run=True)
        result = generate(ctx)

        assert result.success
        assert len(result.files_created) > 0
        assert not (tmp_path / "output").exists()

    def test_skips_existing_without_overwrite(self, tmp_path):
        ctx = _context(tmp_path)
        generate(ctx)
        # Run again without overwrite
        result = generate(ctx)
        assert len(result.files_skipped) > 0

    def test_overwrites_with_flag(self, tmp_path):
        ctx = _context(tmp_path)
        generate(ctx)
        ctx2 = _context(tmp_path, overwrite=True)
        result = generate(ctx2)
        assert result.success
        assert len(result.files_skipped) == 0

    def test_conditional_ai_context_skipped(self, tmp_path):
        variables = {
            "project_name": "test-project",
            "display_name": "Test Project",
            "description": "A test project",
            "stack": "nextjs-fullstack",
            "architecture_style": "monorepo",
            "use_ddd": False,
            "use_auth": True,
            "use_docker": True,
            "use_ci": True,
            "test_strategy": "unit-and-integration",
            "design_style": "minimal-clean",
            "ai_context": False,
        }
        ctx = _context(tmp_path, variables=variables)
        result = generate(ctx)
        assert result.success
        assert not (tmp_path / "output" / "AI_CONTEXT.md").exists()
        assert "AI_CONTEXT.md" not in result.files_created

    def test_validation_error_for_missing_vars(self, tmp_path):
        ctx = _context(tmp_path, variables={})
        result = generate(ctx)
        assert not result.success
        assert len(result.errors) > 0

    def test_copies_static_files(self, tmp_path):
        ctx = _context(tmp_path)
        generate(ctx)
        assert (tmp_path / "output" / ".gitignore").exists()
        assert (tmp_path / "output" / ".editorconfig").exists()

    def test_rendered_content_is_correct(self, tmp_path):
        ctx = _context(tmp_path)
        generate(ctx)
        readme = (tmp_path / "output" / "README.md").read_text()
        assert "# Test Project" in readme
        assert "nextjs-fullstack" in readme
