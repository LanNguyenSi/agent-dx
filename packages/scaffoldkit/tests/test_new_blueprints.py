"""Tests for rest-api, cli-tool, and static-site blueprints."""

from pathlib import Path

import pytest

from scaffoldkit.blueprint_loader import load_blueprint
from scaffoldkit.generator import generate
from scaffoldkit.models import GenerationContext
from scaffoldkit.planforge import PlanforgeExport, build_variables_from_planforge

BLUEPRINTS_DIR = Path(__file__).resolve().parent.parent / "src" / "scaffoldkit" / "blueprints"


def _generate(tmp_path: Path, blueprint_name: str, variables: dict) -> Path:
    """Generate a project from a blueprint and return the output path."""
    bp_path = BLUEPRINTS_DIR / blueprint_name
    bp = load_blueprint(bp_path)
    output = tmp_path / "output"
    ctx = GenerationContext(
        blueprint=bp,
        blueprint_path=bp_path,
        variables=variables,
        target_dir=output,
    )
    result = generate(ctx)
    assert result.success, f"Generation failed for {blueprint_name}: {result.errors}"
    return output


# ---------------------------------------------------------------------------
# rest-api blueprint
# ---------------------------------------------------------------------------

_REST_API_DEFAULTS = {
    "project_name": "test-api",
    "display_name": "Test API",
    "description": "A test API",
    "framework": "fastapi",
    "database": "postgresql",
    "use_auth": True,
    "auth_strategy": "jwt",
    "use_docker": True,
    "use_ci": True,
    "use_openapi": True,
    "test_strategy": "unit-and-integration",
    "ai_context": True,
}


class TestRestApiBlueprint:
    def test_loads(self):
        bp = load_blueprint(BLUEPRINTS_DIR / "rest-api")
        assert bp.name == "rest-api"
        assert len(bp.variables) > 0

    def test_generates_all_files(self, tmp_path: Path):
        output = _generate(tmp_path, "rest-api", _REST_API_DEFAULTS)
        assert (output / "README.md").exists()
        assert (output / "pyproject.toml").exists()
        assert (output / "requirements.txt").exists()
        assert (output / "requirements-dev.txt").exists()
        assert (output / "AI_CONTEXT.md").exists()
        assert (output / "docs" / "architecture.md").exists()
        assert (output / "docs" / "api-design.md").exists()
        assert (output / "docs" / "ways-of-working.md").exists()
        assert (output / ".gitignore").exists()

    def test_creates_directories(self, tmp_path: Path):
        output = _generate(tmp_path, "rest-api", _REST_API_DEFAULTS)
        assert (output / "src" / "routes").is_dir()
        assert (output / "src" / "models").is_dir()
        assert (output / "tests").is_dir()

    def test_readme_contains_framework(self, tmp_path: Path):
        output = _generate(tmp_path, "rest-api", {**_REST_API_DEFAULTS, "framework": "express"})
        readme = (output / "README.md").read_text()
        assert "express" in readme.lower()

    def test_no_ai_context_when_disabled(self, tmp_path: Path):
        output = _generate(tmp_path, "rest-api", {**_REST_API_DEFAULTS, "ai_context": False})
        assert not (output / "AI_CONTEXT.md").exists()

    @pytest.mark.parametrize("framework", ["fastapi", "express", "django-rest", "spring-boot"])
    def test_all_frameworks(self, tmp_path: Path, framework: str):
        output = _generate(tmp_path, "rest-api", {**_REST_API_DEFAULTS, "framework": framework})
        readme = (output / "README.md").read_text()
        assert len(readme) > 100

    @pytest.mark.parametrize("database", ["postgresql", "mysql", "mongodb", "sqlite"])
    def test_all_databases(self, tmp_path: Path, database: str):
        output = _generate(tmp_path, "rest-api", {**_REST_API_DEFAULTS, "database": database})
        arch = (output / "docs" / "architecture.md").read_text()
        assert len(arch) > 100

    def test_auth_strategy_in_context(self, tmp_path: Path):
        output = _generate(tmp_path, "rest-api", {**_REST_API_DEFAULTS, "auth_strategy": "oauth2"})
        ai_ctx = (output / "AI_CONTEXT.md").read_text()
        assert "oauth2" in ai_ctx.lower() or "OAuth" in ai_ctx

    def test_can_disable_auth_without_auth_strategy(self, tmp_path: Path):
        variables = {**_REST_API_DEFAULTS, "use_auth": False}
        del variables["auth_strategy"]

        output = _generate(tmp_path, "rest-api", variables)
        readme = (output / "README.md").read_text()

        assert "oauth2" not in readme.lower()

    def test_planforge_drops_auth_strategy_when_auth_is_disabled(self):
        export_data = PlanforgeExport.model_validate(
            {
                "projectName": "Public Status API",
                "summary": "Anonymous public-only API for status pages.",
                "blueprint": "rest-api",
                "constraints": ["public-only", "no auth"],
                "suggestedVariables": {"auth_strategy": "jwt"},
            }
        )
        blueprint = load_blueprint(BLUEPRINTS_DIR / "rest-api")

        variables = build_variables_from_planforge(export_data, blueprint)

        assert variables["use_auth"] is False
        assert "auth_strategy" not in variables

    def test_files_are_nonempty(self, tmp_path: Path):
        output = _generate(tmp_path, "rest-api", _REST_API_DEFAULTS)
        for f in output.rglob("*"):
            if f.is_file():
                assert f.stat().st_size > 0, f"Empty: {f.relative_to(output)}"

    def test_generates_docker_and_ci_contracts(self, tmp_path: Path):
        output = _generate(tmp_path, "rest-api", _REST_API_DEFAULTS)
        assert (output / ".dockerignore").exists()
        assert (output / "Dockerfile").exists()
        assert (output / "docker-compose.yml").exists()
        assert (output / ".github" / "workflows" / "ci.yml").exists()

        compose = (output / "docker-compose.yml").read_text()
        workflow = (output / ".github" / "workflows" / "ci.yml").read_text()

        assert "dockerfile: Dockerfile" in compose
        assert "db:" in compose
        assert "postgres:15" in compose
        assert "actions/setup-python@v5" in workflow
        assert "docker build -t test-api:ci ." in workflow

    def test_skips_docker_and_ci_contracts_when_disabled(self, tmp_path: Path):
        output = _generate(
            tmp_path, "rest-api", {**_REST_API_DEFAULTS, "use_docker": False, "use_ci": False}
        )
        assert not (output / ".dockerignore").exists()
        assert not (output / "Dockerfile").exists()
        assert not (output / "docker-compose.yml").exists()
        assert not (output / ".github" / "workflows" / "ci.yml").exists()


# ---------------------------------------------------------------------------
# cli-tool blueprint
# ---------------------------------------------------------------------------

_CLI_TOOL_DEFAULTS = {
    "project_name": "test-cli",
    "display_name": "Test CLI",
    "description": "A test CLI",
    "language": "python",
    "cli_framework": "typer",
    "distribution": "pip-package",
    "use_config_file": True,
    "config_format": "yaml",
    "use_ci": True,
    "test_strategy": "unit-tests",
    "ai_context": True,
}


class TestCliToolBlueprint:
    def test_loads(self):
        bp = load_blueprint(BLUEPRINTS_DIR / "cli-tool")
        assert bp.name == "cli-tool"

    def test_generates_all_files(self, tmp_path: Path):
        output = _generate(tmp_path, "cli-tool", _CLI_TOOL_DEFAULTS)
        assert (output / "README.md").exists()
        assert (output / "pyproject.toml").exists()
        assert (output / "AI_CONTEXT.md").exists()
        assert (output / "docs" / "architecture.md").exists()
        assert (output / "docs" / "ways-of-working.md").exists()

    def test_creates_directories(self, tmp_path: Path):
        output = _generate(tmp_path, "cli-tool", _CLI_TOOL_DEFAULTS)
        assert (output / "src" / "commands").is_dir()
        assert (output / "tests").is_dir()

    @pytest.mark.parametrize("language", ["python", "go", "rust", "typescript"])
    def test_all_languages(self, tmp_path: Path, language: str):
        frameworks = {"python": "typer", "go": "cobra", "rust": "clap", "typescript": "commander"}
        output = _generate(
            tmp_path,
            "cli-tool",
            {**_CLI_TOOL_DEFAULTS, "language": language, "cli_framework": frameworks[language]},
        )
        readme = (output / "README.md").read_text()
        assert len(readme) > 100

    def test_no_ai_context_when_disabled(self, tmp_path: Path):
        output = _generate(tmp_path, "cli-tool", {**_CLI_TOOL_DEFAULTS, "ai_context": False})
        assert not (output / "AI_CONTEXT.md").exists()

    def test_config_format_in_readme(self, tmp_path: Path):
        output = _generate(tmp_path, "cli-tool", {**_CLI_TOOL_DEFAULTS, "config_format": "toml"})
        readme = (output / "README.md").read_text()
        assert "toml" in readme.lower()

    def test_files_are_nonempty(self, tmp_path: Path):
        output = _generate(tmp_path, "cli-tool", _CLI_TOOL_DEFAULTS)
        for f in output.rglob("*"):
            if f.is_file():
                assert f.stat().st_size > 0, f"Empty: {f.relative_to(output)}"

    def test_typescript_cli_includes_runnable_baseline(self, tmp_path: Path):
        output = _generate(
            tmp_path,
            "cli-tool",
            {
                **_CLI_TOOL_DEFAULTS,
                "language": "typescript",
                "cli_framework": "commander",
                "distribution": "binary",
                "config_format": "json",
                "test_strategy": "integration-tests",
            },
        )

        assert (output / "package.json").exists()
        assert (output / "tsconfig.json").exists()
        assert (output / "src" / "main.ts").exists()
        assert (output / "src" / "commands" / "run.ts").exists()
        assert (output / "src" / "commands" / "config.ts").exists()
        assert (output / "src" / "config" / "loader.ts").exists()
        assert (output / "tests" / "run.test.ts").exists()

    def test_generates_ci_contract_when_enabled(self, tmp_path: Path):
        output = _generate(tmp_path, "cli-tool", _CLI_TOOL_DEFAULTS)
        assert (output / ".github" / "workflows" / "ci.yml").exists()
        workflow = (output / ".github" / "workflows" / "ci.yml").read_text()
        assert ".github/workflows/ci.yml" in workflow or "name: CI" in workflow

    def test_skips_ci_contract_when_disabled(self, tmp_path: Path):
        output = _generate(tmp_path, "cli-tool", {**_CLI_TOOL_DEFAULTS, "use_ci": False})
        assert not (output / ".github" / "workflows" / "ci.yml").exists()


# ---------------------------------------------------------------------------
# static-site blueprint
# ---------------------------------------------------------------------------

_STATIC_SITE_DEFAULTS = {
    "project_name": "test-site",
    "display_name": "Test Site",
    "description": "A test site",
    "site_type": "docs",
    "framework": "astro",
    "styling": "tailwind",
    "use_cms": False,
    "cms_type": "markdown-files",
    "use_i18n": False,
    "use_analytics": False,
    "use_ci": True,
    "deploy_target": "vercel",
    "ai_context": True,
}


class TestStaticSiteBlueprint:
    def test_loads(self):
        bp = load_blueprint(BLUEPRINTS_DIR / "static-site")
        assert bp.name == "static-site"

    def test_generates_all_files(self, tmp_path: Path):
        output = _generate(tmp_path, "static-site", _STATIC_SITE_DEFAULTS)
        assert (output / "README.md").exists()
        assert (output / "package.json").exists()
        assert (output / "AI_CONTEXT.md").exists()
        assert (output / "docs" / "content-guide.md").exists()
        assert (output / "docs" / "architecture.md").exists()

    def test_creates_directories(self, tmp_path: Path):
        output = _generate(tmp_path, "static-site", _STATIC_SITE_DEFAULTS)
        assert (output / "src" / "pages").is_dir()
        assert (output / "src" / "components").is_dir()
        assert (output / "src" / "content").is_dir()
        assert (output / "public").is_dir()

    @pytest.mark.parametrize("framework", ["astro", "nextjs-static", "hugo", "eleventy"])
    def test_all_frameworks(self, tmp_path: Path, framework: str):
        output = _generate(
            tmp_path, "static-site", {**_STATIC_SITE_DEFAULTS, "framework": framework}
        )
        readme = (output / "README.md").read_text()
        assert len(readme) > 100

    @pytest.mark.parametrize("site_type", ["docs", "blog", "landing-page", "portfolio"])
    def test_all_site_types(self, tmp_path: Path, site_type: str):
        output = _generate(
            tmp_path, "static-site", {**_STATIC_SITE_DEFAULTS, "site_type": site_type}
        )
        assert (output / "README.md").exists()

    @pytest.mark.parametrize(
        "deploy_target", ["vercel", "netlify", "github-pages", "cloudflare-pages"]
    )
    def test_all_deploy_targets(self, tmp_path: Path, deploy_target: str):
        output = _generate(
            tmp_path, "static-site", {**_STATIC_SITE_DEFAULTS, "deploy_target": deploy_target}
        )
        readme = (output / "README.md").read_text()
        assert len(readme) > 100

    def test_no_ai_context_when_disabled(self, tmp_path: Path):
        output = _generate(tmp_path, "static-site", {**_STATIC_SITE_DEFAULTS, "ai_context": False})
        assert not (output / "AI_CONTEXT.md").exists()

    def test_hugo_shortcodes_render(self, tmp_path: Path):
        """Hugo shortcodes use {{ which must be escaped for Jinja2."""
        output = _generate(tmp_path, "static-site", {**_STATIC_SITE_DEFAULTS, "framework": "hugo"})
        guide = (output / "docs" / "content-guide.md").read_text()
        assert "{{<" in guide  # Hugo shortcodes preserved in output

    def test_i18n_sections_when_enabled(self, tmp_path: Path):
        output = _generate(tmp_path, "static-site", {**_STATIC_SITE_DEFAULTS, "use_i18n": True})
        arch = (output / "docs" / "architecture.md").read_text()
        assert "i18n" in arch.lower() or "internation" in arch.lower()

    def test_files_are_nonempty(self, tmp_path: Path):
        output = _generate(tmp_path, "static-site", _STATIC_SITE_DEFAULTS)
        for f in output.rglob("*"):
            if f.is_file():
                assert f.stat().st_size > 0, f"Empty: {f.relative_to(output)}"

    def test_generates_ci_contract_when_enabled(self, tmp_path: Path):
        output = _generate(tmp_path, "static-site", _STATIC_SITE_DEFAULTS)
        assert (output / ".github" / "workflows" / "deploy.yml").exists()
        workflow = (output / ".github" / "workflows" / "deploy.yml").read_text()
        assert "name: Site Pipeline" in workflow

    def test_skips_ci_contract_when_disabled(self, tmp_path: Path):
        output = _generate(tmp_path, "static-site", {**_STATIC_SITE_DEFAULTS, "use_ci": False})
        assert not (output / ".github" / "workflows" / "deploy.yml").exists()
