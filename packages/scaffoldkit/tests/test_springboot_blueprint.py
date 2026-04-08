"""Tests for the springboot-backend blueprint."""

from pathlib import Path

import pytest

from scaffoldkit.blueprint_loader import load_blueprint
from scaffoldkit.generator import generate
from scaffoldkit.models import GenerationContext

BLUEPRINTS_DIR = Path(__file__).resolve().parent.parent / "src" / "scaffoldkit" / "blueprints"

_DEFAULTS = {
    "project_name": "billing-service",
    "display_name": "Billing Service",
    "description": "Billing and invoice backend",
    "base_package": "com.acme.billing",
    "java_version": "21",
    "spring_boot_version": "3.4",
    "build_tool": "maven",
    "api_style": "spring-mvc",
    "database": "postgresql",
    "use_ddd": False,
    "use_auth": True,
    "auth_method": "jwt",
    "use_docker": True,
    "use_ci": True,
    "use_kafka": False,
    "use_redis": False,
    "test_strategy": "junit-and-testcontainers",
    "ai_context": True,
}


def _generate(tmp_path: Path, variables: dict) -> Path:
    bp_path = BLUEPRINTS_DIR / "springboot-backend"
    bp = load_blueprint(bp_path)
    output = tmp_path / "output"
    ctx = GenerationContext(
        blueprint=bp,
        blueprint_path=bp_path,
        variables=variables,
        target_dir=output,
    )
    result = generate(ctx)
    assert result.success, f"Generation failed: {result.errors}"
    return output


class TestSpringbootBackendBlueprint:
    def test_loads(self):
        bp = load_blueprint(BLUEPRINTS_DIR / "springboot-backend")
        assert bp.name == "springboot-backend"
        assert len(bp.variables) >= 15

    def test_generates_expected_files(self, tmp_path: Path):
        output = _generate(tmp_path, _DEFAULTS)

        assert (output / "README.md").exists()
        assert (output / "pom.xml").exists()
        assert (output / "src" / "main" / "resources" / "application.yml").exists()
        assert (
            output / "src" / "main" / "java" / "com" / "acme" / "billing" / "Application.java"
        ).exists()
        assert (output / "AI_CONTEXT.md").exists()
        assert (output / "docs" / "architecture.md").exists()
        assert (output / "docs" / "ways-of-working.md").exists()
        assert (output / "docs" / "api-conventions.md").exists()
        assert (output / "docs" / "adrs" / "0001-architecture.md").exists()
        assert (output / ".editorconfig").exists()
        assert (output / ".gitignore").exists()
        assert (output / ".dockerignore").exists()
        assert (output / "Dockerfile").exists()
        assert (output / "docker-compose.yml").exists()
        assert (output / ".github" / "workflows" / "ci.yml").exists()

    def test_generates_docker_and_ci_contracts(self, tmp_path: Path):
        output = _generate(tmp_path, _DEFAULTS)
        compose = (output / "docker-compose.yml").read_text()
        workflow = (output / ".github" / "workflows" / "ci.yml").read_text()

        assert "dockerfile: Dockerfile" in compose
        assert "postgres:" in compose
        assert "SPRING_DATASOURCE_URL: jdbc:postgresql://postgres:5432/billing-service" in compose
        assert "uses: actions/setup-java@v4" in workflow
        assert 'java-version: "21"' in workflow
        assert "Add the Spring Boot bootstrap to enable CI verification." in workflow
        assert "docker build -t billing-service:ci ." in workflow

    def test_skips_docker_and_ci_contracts_when_disabled(self, tmp_path: Path):
        output = _generate(tmp_path, {**_DEFAULTS, "use_docker": False, "use_ci": False})
        assert not (output / ".dockerignore").exists()
        assert not (output / "Dockerfile").exists()
        assert not (output / "docker-compose.yml").exists()
        assert not (output / ".github" / "workflows" / "ci.yml").exists()

    def test_creates_java_package_directories(self, tmp_path: Path):
        output = _generate(tmp_path, _DEFAULTS)
        package_dir = output / "src" / "main" / "java" / "com" / "acme" / "billing"
        test_dir = output / "src" / "test" / "java" / "com" / "acme" / "billing"

        assert package_dir.is_dir()
        assert (package_dir / "web").is_dir()
        assert (package_dir / "service").is_dir()
        assert (package_dir / "repository").is_dir()
        assert (package_dir / "security").is_dir()
        assert test_dir.is_dir()

    def test_ddd_content_when_enabled(self, tmp_path: Path):
        output = _generate(tmp_path, {**_DEFAULTS, "use_ddd": True})
        arch = (output / "docs" / "architecture.md").read_text()
        assert "DDD" in arch or "domain-driven" in arch.lower()

    @pytest.mark.parametrize("api_style", ["spring-mvc", "webflux"])
    def test_api_style_variants(self, tmp_path: Path, api_style: str):
        output = _generate(tmp_path, {**_DEFAULTS, "api_style": api_style})
        arch = (output / "docs" / "architecture.md").read_text()
        assert api_style in arch

    @pytest.mark.parametrize("build_tool", ["maven", "gradle"])
    def test_build_tool_variants(self, tmp_path: Path, build_tool: str):
        output = _generate(tmp_path, {**_DEFAULTS, "build_tool": build_tool})
        readme = (output / "README.md").read_text()
        assert build_tool in readme

    @pytest.mark.parametrize("auth_method", ["jwt", "oauth2", "api-key"])
    def test_auth_variants_show_in_ai_context(self, tmp_path: Path, auth_method: str):
        output = _generate(tmp_path, {**_DEFAULTS, "auth_method": auth_method})
        ai_ctx = (output / "AI_CONTEXT.md").read_text()
        assert auth_method in ai_ctx.lower() or auth_method in ai_ctx

    def test_no_ai_context_when_disabled(self, tmp_path: Path):
        output = _generate(tmp_path, {**_DEFAULTS, "ai_context": False})
        assert not (output / "AI_CONTEXT.md").exists()

    def test_files_are_nonempty(self, tmp_path: Path):
        output = _generate(tmp_path, _DEFAULTS)
        for file_path in output.rglob("*"):
            if file_path.is_file():
                assert file_path.stat().st_size > 0, f"Empty: {file_path.relative_to(output)}"
