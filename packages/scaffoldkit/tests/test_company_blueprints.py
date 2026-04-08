"""Tests for symfony-backend, nextjs-frontend, and symfony-nextjs blueprints."""

from pathlib import Path

import pytest

from scaffoldkit.blueprint_loader import load_blueprint
from scaffoldkit.generator import generate
from scaffoldkit.models import GenerationContext
from scaffoldkit.planforge import PlanforgeExport, build_variables_from_planforge

BLUEPRINTS_DIR = Path(__file__).resolve().parent.parent / "src" / "scaffoldkit" / "blueprints"


def _generate(tmp_path: Path, blueprint_name: str, variables: dict) -> Path:
    bp_path = BLUEPRINTS_DIR / blueprint_name
    bp = load_blueprint(bp_path)
    output = tmp_path / "output"
    ctx = GenerationContext(
        blueprint=bp, blueprint_path=bp_path, variables=variables, target_dir=output
    )
    result = generate(ctx)
    assert result.success, f"Generation failed for {blueprint_name}: {result.errors}"
    return output


# ---------------------------------------------------------------------------
# symfony-backend
# ---------------------------------------------------------------------------

_SYMFONY_DEFAULTS = {
    "project_name": "test-api",
    "display_name": "Test API",
    "description": "Test Symfony API",
    "php_version": "8.3",
    "symfony_version": "7.2",
    "api_style": "api-platform",
    "database": "postgresql",
    "use_ddd": False,
    "use_cqrs": False,
    "use_auth": True,
    "auth_method": "jwt",
    "use_docker": True,
    "use_ci": True,
    "use_rabbitmq": False,
    "use_redis": False,
    "test_strategy": "phpunit-only",
    "ai_context": True,
}


class TestSymfonyBackend:
    def test_loads(self):
        bp = load_blueprint(BLUEPRINTS_DIR / "symfony-backend")
        assert bp.name == "symfony-backend"
        assert len(bp.variables) >= 15

    def test_generates_all_files(self, tmp_path: Path):
        output = _generate(tmp_path, "symfony-backend", _SYMFONY_DEFAULTS)
        assert (output / "README.md").exists()
        assert (output / "composer.json").exists()
        assert (output / "AI_CONTEXT.md").exists()
        assert (output / "docs" / "architecture.md").exists()
        assert (output / "docs" / "api-conventions.md").exists()
        assert (output / "docs" / "ways-of-working.md").exists()
        assert (output / ".gitignore").exists()

    def test_creates_symfony_directories(self, tmp_path: Path):
        output = _generate(tmp_path, "symfony-backend", _SYMFONY_DEFAULTS)
        assert (output / "src" / "Entity").is_dir()
        assert (output / "src" / "Repository").is_dir()
        assert (output / "src" / "Controller").is_dir()
        assert (output / "migrations").is_dir()
        assert (output / "tests").is_dir()

    def test_ddd_content_when_enabled(self, tmp_path: Path):
        output = _generate(tmp_path, "symfony-backend", {**_SYMFONY_DEFAULTS, "use_ddd": True})
        arch = (output / "docs" / "architecture.md").read_text()
        assert "domain" in arch.lower()

    def test_cqrs_content_when_enabled(self, tmp_path: Path):
        output = _generate(tmp_path, "symfony-backend", {**_SYMFONY_DEFAULTS, "use_cqrs": True})
        arch = (output / "docs" / "architecture.md").read_text()
        assert "cqrs" in arch.lower() or "command" in arch.lower()

    def test_rabbitmq_content_when_enabled(self, tmp_path: Path):
        output = _generate(tmp_path, "symfony-backend", {**_SYMFONY_DEFAULTS, "use_rabbitmq": True})
        arch = (output / "docs" / "architecture.md").read_text()
        assert "rabbit" in arch.lower() or "messenger" in arch.lower()

    @pytest.mark.parametrize("api_style", ["api-platform", "custom-controllers", "fos-rest"])
    def test_all_api_styles(self, tmp_path: Path, api_style: str):
        output = _generate(
            tmp_path, "symfony-backend", {**_SYMFONY_DEFAULTS, "api_style": api_style}
        )
        assert (output / "README.md").read_text()

    @pytest.mark.parametrize("auth_method", ["jwt", "oauth2", "api-key"])
    def test_all_auth_methods(self, tmp_path: Path, auth_method: str):
        output = _generate(
            tmp_path, "symfony-backend", {**_SYMFONY_DEFAULTS, "auth_method": auth_method}
        )
        ai_ctx = (output / "AI_CONTEXT.md").read_text()
        assert len(ai_ctx) > 500

    @pytest.mark.parametrize("test_strategy", ["phpunit-only", "phpunit-and-behat", "pest"])
    def test_all_test_strategies(self, tmp_path: Path, test_strategy: str):
        output = _generate(
            tmp_path, "symfony-backend", {**_SYMFONY_DEFAULTS, "test_strategy": test_strategy}
        )
        wow = (output / "docs" / "ways-of-working.md").read_text()
        assert len(wow) > 500

    def test_no_ai_context_when_disabled(self, tmp_path: Path):
        output = _generate(tmp_path, "symfony-backend", {**_SYMFONY_DEFAULTS, "ai_context": False})
        assert not (output / "AI_CONTEXT.md").exists()

    def test_files_are_nonempty(self, tmp_path: Path):
        output = _generate(tmp_path, "symfony-backend", _SYMFONY_DEFAULTS)
        for f in output.rglob("*"):
            if f.is_file():
                assert f.stat().st_size > 0, f"Empty: {f.relative_to(output)}"


# ---------------------------------------------------------------------------
# nextjs-frontend
# ---------------------------------------------------------------------------

_NEXTJS_DEFAULTS = {
    "project_name": "test-web",
    "display_name": "Test Web",
    "description": "Test Next.js frontend",
    "nextjs_version": "15",
    "router": "app-router",
    "language": "typescript",
    "styling": "tailwind",
    "ui_library": "shadcn-ui",
    "state_management": "zustand",
    "api_client": "tanstack-query",
    "use_auth": True,
    "auth_provider": "next-auth",
    "use_i18n": False,
    "use_storybook": False,
    "use_docker": True,
    "use_ci": True,
    "test_strategy": "vitest-only",
    "design_style": "minimal-clean",
    "ai_context": True,
}


class TestNextjsFrontend:
    def test_loads(self):
        bp = load_blueprint(BLUEPRINTS_DIR / "nextjs-frontend")
        assert bp.name == "nextjs-frontend"
        assert len(bp.variables) >= 18

    def test_generates_all_files(self, tmp_path: Path):
        output = _generate(tmp_path, "nextjs-frontend", _NEXTJS_DEFAULTS)
        assert (output / "README.md").exists()
        assert (output / "package.json").exists()
        assert (output / "tsconfig.json").exists()
        assert (output / "AI_CONTEXT.md").exists()
        assert (output / "docs" / "architecture.md").exists()
        assert (output / "docs" / "component-guide.md").exists()
        assert (output / "docs" / "page-templates" / "dashboard.md").exists()
        assert (output / "docs" / "page-templates" / "form.md").exists()

    def test_creates_nextjs_directories(self, tmp_path: Path):
        output = _generate(tmp_path, "nextjs-frontend", _NEXTJS_DEFAULTS)
        assert (output / "src" / "components" / "ui").is_dir()
        assert (output / "src" / "hooks").is_dir()
        assert (output / "src" / "services").is_dir()
        assert (output / "src" / "types").is_dir()

    @pytest.mark.parametrize("styling", ["tailwind", "css-modules", "styled-components", "scss"])
    def test_all_styling_options(self, tmp_path: Path, styling: str):
        output = _generate(tmp_path, "nextjs-frontend", {**_NEXTJS_DEFAULTS, "styling": styling})
        arch = (output / "docs" / "architecture.md").read_text()
        assert len(arch) > 500

    @pytest.mark.parametrize("auth_provider", ["next-auth", "custom-jwt", "clerk"])
    def test_all_auth_providers(self, tmp_path: Path, auth_provider: str):
        output = _generate(
            tmp_path, "nextjs-frontend", {**_NEXTJS_DEFAULTS, "auth_provider": auth_provider}
        )
        assert (output / "README.md").exists()

    @pytest.mark.parametrize(
        "state_management", ["zustand", "react-query-only", "jotai", "redux-toolkit"]
    )
    def test_all_state_management(self, tmp_path: Path, state_management: str):
        output = _generate(
            tmp_path, "nextjs-frontend", {**_NEXTJS_DEFAULTS, "state_management": state_management}
        )
        arch = (output / "docs" / "architecture.md").read_text()
        assert len(arch) > 500

    @pytest.mark.parametrize(
        "design_style", ["minimal-clean", "corporate-professional", "playful-modern"]
    )
    def test_all_design_styles(self, tmp_path: Path, design_style: str):
        output = _generate(
            tmp_path, "nextjs-frontend", {**_NEXTJS_DEFAULTS, "design_style": design_style}
        )
        dashboard = (output / "docs" / "page-templates" / "dashboard.md").read_text()
        assert len(dashboard) > 200

    def test_storybook_content_when_enabled(self, tmp_path: Path):
        output = _generate(tmp_path, "nextjs-frontend", {**_NEXTJS_DEFAULTS, "use_storybook": True})
        readme = (output / "README.md").read_text()
        assert "storybook" in readme.lower()

    def test_pages_router_variant(self, tmp_path: Path):
        output = _generate(
            tmp_path, "nextjs-frontend", {**_NEXTJS_DEFAULTS, "router": "pages-router"}
        )
        arch = (output / "docs" / "architecture.md").read_text()
        assert "pages" in arch.lower()

    def test_no_ai_context_when_disabled(self, tmp_path: Path):
        output = _generate(tmp_path, "nextjs-frontend", {**_NEXTJS_DEFAULTS, "ai_context": False})
        assert not (output / "AI_CONTEXT.md").exists()

    def test_files_are_nonempty(self, tmp_path: Path):
        output = _generate(tmp_path, "nextjs-frontend", _NEXTJS_DEFAULTS)
        for f in output.rglob("*"):
            if f.is_file():
                assert f.stat().st_size > 0, f"Empty: {f.relative_to(output)}"

    def test_ai_context_preserves_code_block_line_breaks(self, tmp_path: Path):
        output = _generate(tmp_path, "nextjs-frontend", _NEXTJS_DEFAULTS)
        ai_ctx = (output / "AI_CONTEXT.md").read_text()
        assert '<div style={{ borderRadius: "8px", background: "white" }}>\n```' in ai_ctx
        assert '<div style={{ borderRadius: "8px", background: "white" }}>```' not in ai_ctx

    def test_generates_docker_and_ci_contracts(self, tmp_path: Path):
        output = _generate(tmp_path, "nextjs-frontend", _NEXTJS_DEFAULTS)
        assert (output / ".dockerignore").exists()
        assert (output / "Dockerfile").exists()
        assert (output / "docker-compose.yml").exists()
        assert (output / "docker-compose.prod.yml").exists()
        assert (output / ".github" / "workflows" / "ci.yml").exists()

        readme = (output / "README.md").read_text()
        workflow = (output / ".github" / "workflows" / "ci.yml").read_text()

        assert "docker-compose.prod.yml" in readme
        assert "uses: actions/setup-node@v4" in workflow
        assert "Add the Next.js bootstrap to enable CI verification." in workflow
        assert "docker build -t test-web:ci ." in workflow

    def test_skips_docker_and_ci_contracts_when_disabled(self, tmp_path: Path):
        output = _generate(
            tmp_path,
            "nextjs-frontend",
            {**_NEXTJS_DEFAULTS, "use_docker": False, "use_ci": False},
        )
        assert not (output / ".dockerignore").exists()
        assert not (output / "Dockerfile").exists()
        assert not (output / "docker-compose.yml").exists()
        assert not (output / "docker-compose.prod.yml").exists()
        assert not (output / ".github" / "workflows" / "ci.yml").exists()


# ---------------------------------------------------------------------------
# symfony-nextjs (fullstack)
# ---------------------------------------------------------------------------

_FULLSTACK_DEFAULTS = {
    "project_name": "test-app",
    "display_name": "Test App",
    "description": "Test fullstack app",
    "php_version": "8.3",
    "node_version": "22",
    "api_style": "api-platform",
    "database": "postgresql",
    "use_ddd": False,
    "use_auth": True,
    "auth_method": "jwt",
    "styling": "tailwind",
    "ui_library": "shadcn-ui",
    "use_docker": True,
    "use_ci": True,
    "use_rabbitmq": False,
    "use_redis": False,
    "test_strategy": "unit-and-integration",
    "design_style": "minimal-clean",
    "ai_context": True,
}


class TestSymfonyNextjsFullstack:
    def test_loads(self):
        bp = load_blueprint(BLUEPRINTS_DIR / "symfony-nextjs")
        assert bp.name == "symfony-nextjs"
        assert len(bp.variables) >= 17

    def test_generates_all_files(self, tmp_path: Path):
        output = _generate(tmp_path, "symfony-nextjs", _FULLSTACK_DEFAULTS)
        assert (output / "README.md").exists()
        assert (output / "package.json").exists()
        assert (output / "pnpm-workspace.yaml").exists()
        assert (output / "apps" / "web" / "package.json").exists()
        assert (output / "apps" / "api" / "composer.json").exists()
        assert (output / "AI_CONTEXT.md").exists()
        assert (output / "docs" / "architecture.md").exists()
        assert (output / "docs" / "api-contract.md").exists()
        assert (output / "docs" / "page-templates" / "dashboard.md").exists()
        assert (output / "docs" / "page-templates" / "form.md").exists()

    def test_creates_monorepo_directories(self, tmp_path: Path):
        output = _generate(tmp_path, "symfony-nextjs", _FULLSTACK_DEFAULTS)
        assert (output / "apps" / "api" / "src").is_dir()
        assert (output / "apps" / "web" / "src").is_dir()
        assert (output / "packages" / "shared-types").is_dir()
        assert (output / "docker").is_dir()

    def test_api_contract_has_substance(self, tmp_path: Path):
        output = _generate(tmp_path, "symfony-nextjs", _FULLSTACK_DEFAULTS)
        contract = (output / "docs" / "api-contract.md").read_text()
        assert "endpoint" in contract.lower() or "api" in contract.lower()
        assert len(contract) > 1000

    def test_ddd_in_fullstack(self, tmp_path: Path):
        output = _generate(tmp_path, "symfony-nextjs", {**_FULLSTACK_DEFAULTS, "use_ddd": True})
        arch = (output / "docs" / "architecture.md").read_text()
        assert "domain" in arch.lower()

    def test_full_pyramid_test_strategy(self, tmp_path: Path):
        output = _generate(
            tmp_path, "symfony-nextjs", {**_FULLSTACK_DEFAULTS, "test_strategy": "full-pyramid"}
        )
        wow = (output / "docs" / "ways-of-working.md").read_text()
        assert "full-pyramid" in wow or "e2e" in wow.lower() or "end-to-end" in wow.lower()

    def test_redis_rabbitmq_in_fullstack(self, tmp_path: Path):
        output = _generate(
            tmp_path,
            "symfony-nextjs",
            {**_FULLSTACK_DEFAULTS, "use_rabbitmq": True, "use_redis": True},
        )
        arch = (output / "docs" / "architecture.md").read_text()
        assert "redis" in arch.lower() or "rabbit" in arch.lower()

    def test_custom_controllers_variant(self, tmp_path: Path):
        output = _generate(
            tmp_path,
            "symfony-nextjs",
            {**_FULLSTACK_DEFAULTS, "api_style": "custom-controllers"},
        )
        assert (output / "README.md").exists()

    def test_no_ai_context_when_disabled(self, tmp_path: Path):
        output = _generate(tmp_path, "symfony-nextjs", {**_FULLSTACK_DEFAULTS, "ai_context": False})
        assert not (output / "AI_CONTEXT.md").exists()

    def test_files_are_nonempty(self, tmp_path: Path):
        output = _generate(tmp_path, "symfony-nextjs", _FULLSTACK_DEFAULTS)
        for f in output.rglob("*"):
            if f.is_file():
                assert f.stat().st_size > 0, f"Empty: {f.relative_to(output)}"

    def test_generates_docker_and_ci_contracts(self, tmp_path: Path):
        output = _generate(tmp_path, "symfony-nextjs", _FULLSTACK_DEFAULTS)
        assert (output / ".dockerignore").exists()
        assert (output / "docker-compose.yml").exists()
        assert (output / "docker" / "php" / "Dockerfile").exists()
        assert (output / "docker" / "node" / "Dockerfile").exists()
        assert (output / "docker" / "nginx" / "nginx.conf").exists()
        assert (output / ".github" / "workflows" / "api.yml").exists()
        assert (output / ".github" / "workflows" / "web.yml").exists()

    def test_skips_docker_and_ci_contracts_when_disabled(self, tmp_path: Path):
        output = _generate(
            tmp_path,
            "symfony-nextjs",
            {**_FULLSTACK_DEFAULTS, "use_docker": False, "use_ci": False},
        )
        assert not (output / ".dockerignore").exists()
        assert not (output / "docker-compose.yml").exists()
        assert not (output / "docker" / "php" / "Dockerfile").exists()
        assert not (output / ".github" / "workflows" / "api.yml").exists()
        assert not (output / ".github" / "workflows" / "web.yml").exists()


class TestPlanforgeImportHints:
    def test_express_api_respects_queue_hints_from_planforge(self, tmp_path: Path):
        export_data = PlanforgeExport.model_validate(
            {
                "projectName": "Worker API",
                "summary": "Backend worker with queued jobs.",
                "blueprint": "express-api",
                "features": ["workflow queue processing"],
                "constraints": ["must run in Docker"],
                "stack": {"hint": "TypeScript service stack"},
                "suggestedVariables": {
                    "use_queue": True,
                    "use_docker": True,
                    "db_provider": "sqlite",
                    "auth_strategy": "jwt",
                },
            }
        )
        bp_path = BLUEPRINTS_DIR / "express-api"
        blueprint = load_blueprint(bp_path)
        variables = build_variables_from_planforge(export_data, blueprint)

        output = _generate(tmp_path, "express-api", variables)
        readme = (output / "README.md").read_text()

        assert "BullMQ + Redis" in readme
        assert "Docker + docker-compose" in readme
        assert "Sqlite via Prisma ORM" in readme

    def test_cli_tool_infers_typescript_runtime_hints_from_planforge(self, tmp_path: Path):
        export_data = PlanforgeExport.model_validate(
            {
                "projectName": "agent-memory-sync",
                "summary": "CLI tool to sync memory files through a git repository.",
                "blueprint": "cli-tool",
                "features": [
                    "push local memory files to remote git repo",
                    "dry-run mode to preview changes before sync",
                ],
                "constraints": [
                    "TypeScript only",
                    "no external databases, git is the source of truth",
                ],
                "stack": {"hint": "TypeScript CLI tool", "dataStore": "git"},
            }
        )
        bp_path = BLUEPRINTS_DIR / "cli-tool"
        blueprint = load_blueprint(bp_path)
        variables = build_variables_from_planforge(export_data, blueprint)

        assert variables["language"] == "typescript"
        assert variables["cli_framework"] == "commander"
        assert variables["distribution"] == "binary"
        assert variables["test_strategy"] == "integration-tests"
