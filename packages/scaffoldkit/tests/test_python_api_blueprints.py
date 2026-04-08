"""Tests for FastAPI and Django DRF blueprints."""

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
        blueprint=bp,
        blueprint_path=bp_path,
        variables=variables,
        target_dir=output,
    )
    result = generate(ctx)
    assert result.success, f"Generation failed for {blueprint_name}: {result.errors}"
    return output


_FASTAPI_DEFAULTS = {
    "project_name": "test-fastapi-service",
    "display_name": "Test FastAPI Service",
    "description": "A test FastAPI backend",
    "python_version": "3.12",
    "package_manager": "uv",
    "db_provider": "postgresql",
    "auth_strategy": "jwt",
    "use_docker": True,
    "use_redis": False,
    "use_background_jobs": False,
    "api_docs": True,
    "test_strategy": "pytest-and-integration",
    "ai_context": True,
}


class TestFastapiBackendBlueprint:
    def test_loads(self):
        bp = load_blueprint(BLUEPRINTS_DIR / "fastapi-backend")
        assert bp.name == "fastapi-backend"
        assert len(bp.variables) >= 10

    def test_generates_all_files(self, tmp_path: Path):
        output = _generate(tmp_path, "fastapi-backend", _FASTAPI_DEFAULTS)
        assert (output / "README.md").exists()
        assert (output / "pyproject.toml").exists()
        assert (output / "requirements.txt").exists()
        assert (output / "requirements-dev.txt").exists()
        assert (output / "AI_CONTEXT.md").exists()
        assert (output / "docs" / "architecture.md").exists()
        assert (output / "docs" / "api-conventions.md").exists()
        assert (output / "docs" / "ways-of-working.md").exists()

    def test_creates_expected_directories(self, tmp_path: Path):
        output = _generate(tmp_path, "fastapi-backend", _FASTAPI_DEFAULTS)
        assert (output / "app" / "api" / "routes").is_dir()
        assert (output / "app" / "repositories").is_dir()
        assert (output / "alembic" / "versions").is_dir()
        assert (output / "tests" / "integration").is_dir()

    @pytest.mark.parametrize("auth_strategy", ["jwt", "oauth2", "api-key", "none"])
    def test_all_auth_strategies(self, tmp_path: Path, auth_strategy: str):
        output = _generate(
            tmp_path, "fastapi-backend", {**_FASTAPI_DEFAULTS, "auth_strategy": auth_strategy}
        )
        readme = (output / "README.md").read_text()
        assert len(readme) > 200

    @pytest.mark.parametrize("package_manager", ["uv", "poetry", "pip-tools"])
    def test_all_package_managers(self, tmp_path: Path, package_manager: str):
        output = _generate(
            tmp_path,
            "fastapi-backend",
            {**_FASTAPI_DEFAULTS, "package_manager": package_manager},
        )
        readme = (output / "README.md").read_text()
        assert package_manager in readme

    def test_background_jobs_in_architecture_when_enabled(self, tmp_path: Path):
        output = _generate(
            tmp_path,
            "fastapi-backend",
            {**_FASTAPI_DEFAULTS, "use_background_jobs": True, "use_redis": True},
        )
        arch = (output / "docs" / "architecture.md").read_text()
        assert "background" in arch.lower() or "workers" in arch.lower()

    def test_generates_docker_contracts(self, tmp_path: Path):
        output = _generate(tmp_path, "fastapi-backend", _FASTAPI_DEFAULTS)
        assert (output / ".dockerignore").exists()
        assert (output / "Dockerfile").exists()
        assert (output / "docker-compose.yml").exists()

        compose = (output / "docker-compose.yml").read_text()
        assert "dockerfile: Dockerfile" in compose
        assert "db:" in compose

    def test_skips_docker_contracts_when_disabled(self, tmp_path: Path):
        output = _generate(tmp_path, "fastapi-backend", {**_FASTAPI_DEFAULTS, "use_docker": False})
        assert not (output / ".dockerignore").exists()
        assert not (output / "Dockerfile").exists()
        assert not (output / "docker-compose.yml").exists()


_DJANGO_DEFAULTS = {
    "project_name": "test-django-api",
    "display_name": "Test Django API",
    "description": "A test Django REST backend",
    "python_version": "3.12",
    "package_manager": "uv",
    "database": "postgresql",
    "auth_strategy": "jwt",
    "use_docker": True,
    "use_celery": False,
    "use_channels": False,
    "use_drf_spectacular": True,
    "test_strategy": "pytest-django-and-integration",
    "ai_context": True,
}


class TestDjangoDrfBlueprint:
    def test_loads(self):
        bp = load_blueprint(BLUEPRINTS_DIR / "django-drf")
        assert bp.name == "django-drf"
        assert len(bp.variables) >= 10

    def test_generates_all_files(self, tmp_path: Path):
        output = _generate(tmp_path, "django-drf", _DJANGO_DEFAULTS)
        assert (output / "README.md").exists()
        assert (output / "pyproject.toml").exists()
        assert (output / "requirements.txt").exists()
        assert (output / "requirements-dev.txt").exists()
        assert (output / "AI_CONTEXT.md").exists()
        assert (output / "docs" / "architecture.md").exists()
        assert (output / "docs" / "api-conventions.md").exists()
        assert (output / "docs" / "ways-of-working.md").exists()

    def test_creates_expected_directories(self, tmp_path: Path):
        output = _generate(tmp_path, "django-drf", _DJANGO_DEFAULTS)
        assert (output / "config" / "settings").is_dir()
        assert (output / "apps" / "api").is_dir()
        assert (output / "apps" / "users").is_dir()
        assert (output / "tests" / "integration").is_dir()

    @pytest.mark.parametrize("auth_strategy", ["session", "jwt", "token", "oauth2", "none"])
    def test_all_auth_strategies(self, tmp_path: Path, auth_strategy: str):
        output = _generate(
            tmp_path, "django-drf", {**_DJANGO_DEFAULTS, "auth_strategy": auth_strategy}
        )
        readme = (output / "README.md").read_text()
        assert len(readme) > 200

    def test_celery_and_channels_content_when_enabled(self, tmp_path: Path):
        output = _generate(
            tmp_path,
            "django-drf",
            {**_DJANGO_DEFAULTS, "use_celery": True, "use_channels": True},
        )
        arch = (output / "docs" / "architecture.md").read_text()
        assert "celery" in arch.lower() or "channels" in arch.lower()

    def test_generates_docker_contracts(self, tmp_path: Path):
        output = _generate(tmp_path, "django-drf", _DJANGO_DEFAULTS)
        assert (output / ".dockerignore").exists()
        assert (output / "Dockerfile").exists()
        assert (output / "docker-compose.yml").exists()

        compose = (output / "docker-compose.yml").read_text()
        assert "dockerfile: Dockerfile" in compose
        assert "db:" in compose or "DATABASE_URL: sqlite" in compose

    def test_skips_docker_contracts_when_disabled(self, tmp_path: Path):
        output = _generate(tmp_path, "django-drf", {**_DJANGO_DEFAULTS, "use_docker": False})
        assert not (output / ".dockerignore").exists()
        assert not (output / "Dockerfile").exists()
        assert not (output / "docker-compose.yml").exists()


class TestPlanforgeImportHintsForPythonBackends:
    def test_fastapi_backend_respects_planforge_hints(self, tmp_path: Path):
        export_data = PlanforgeExport.model_validate(
            {
                "projectName": "workflow-orchestrator",
                "summary": (
                    "Python backend service with queued workflows and Redis-backed coordination."
                ),
                "blueprint": "fastapi-backend",
                "features": ["background job orchestration", "workflow API"],
                "constraints": ["must run in Docker", "JWT authentication required"],
                "stack": {"hint": "Python application stack"},
                "suggestedVariables": {"use_background_jobs": True, "use_redis": True},
            }
        )
        blueprint = load_blueprint(BLUEPRINTS_DIR / "fastapi-backend")
        variables = build_variables_from_planforge(export_data, blueprint)

        assert variables["db_provider"] == "postgresql"
        assert variables["auth_strategy"] == "jwt"
        assert variables["use_background_jobs"] is True
        assert variables["use_redis"] is True

        output = _generate(tmp_path, "fastapi-backend", variables)
        assert (output / "README.md").exists()

    def test_django_drf_maps_planforge_auth_and_docs_hints(self, tmp_path: Path):
        export_data = PlanforgeExport.model_validate(
            {
                "projectName": "case-management-api",
                "summary": "Django REST backend with OAuth2 and documented API schema.",
                "blueprint": "django-drf",
                "features": ["case management API", "admin workflows"],
                "constraints": ["OAuth2 login", "docker deployment"],
                "stack": {"hint": "Python application stack"},
                "suggestedVariables": {"use_drf_spectacular": True, "use_celery": True},
            }
        )
        blueprint = load_blueprint(BLUEPRINTS_DIR / "django-drf")
        variables = build_variables_from_planforge(export_data, blueprint)

        assert variables["auth_strategy"] == "oauth2"
        assert variables["use_drf_spectacular"] is True
        assert variables["use_celery"] is True

        output = _generate(tmp_path, "django-drf", variables)
        assert (output / "AI_CONTEXT.md").exists()
