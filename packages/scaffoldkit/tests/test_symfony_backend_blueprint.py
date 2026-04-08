"""Tests for the symfony-backend blueprint."""

from pathlib import Path

from scaffoldkit.blueprint_loader import load_blueprint
from scaffoldkit.generator import generate
from scaffoldkit.models import GenerationContext

BLUEPRINTS_DIR = Path(__file__).resolve().parent.parent / "src" / "scaffoldkit" / "blueprints"

_DEFAULTS = {
    "project_name": "my-symfony-app",
    "display_name": "My Symfony App",
    "description": "A Symfony-based API backend",
    "php_version": "8.3",
    "symfony_version": "7.2",
    "api_style": "api-platform",
    "database": "postgresql",
    "use_ddd": True,
    "use_cqrs": True,
    "use_auth": False,
    "auth_method": "jwt",
    "use_docker": True,
    "use_ci": True,
    "use_rabbitmq": False,
    "use_redis": False,
    "test_strategy": "phpunit-only",
    "ai_context": True,
}


def _generate(tmp_path: Path, variables: dict) -> Path:
    bp_path = BLUEPRINTS_DIR / "symfony-backend"
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


class TestSymfonyBackendBlueprint:
    def test_generates_docker_and_ci_files_when_enabled(self, tmp_path: Path):
        output = _generate(tmp_path, _DEFAULTS)

        assert (output / "composer.json").exists()
        assert (output / ".env").exists()
        assert (output / "bin" / "console").exists()
        assert (output / "public" / "index.php").exists()
        assert (output / "docker-compose.yml").exists()
        assert (output / ".dockerignore").exists()
        assert (output / "docker" / "php" / "Dockerfile").exists()
        assert (output / ".github" / "workflows" / "ci.yml").exists()

        compose = (output / "docker-compose.yml").read_text()
        workflow = (output / ".github" / "workflows" / "ci.yml").read_text()

        assert "dockerfile: docker/php/Dockerfile" in compose
        assert "postgres:" in compose
        assert "DATABASE_URL: postgresql://app:password@postgres:5432/my-symfony-app" in compose
        assert "shivammathur/setup-php@v2" in workflow
        assert 'php-version: "8.3"' in workflow
        assert "composer install --no-interaction --prefer-dist --no-progress" in workflow
        assert "docker build -f docker/php/Dockerfile -t my-symfony-app:ci ." in workflow

    def test_skips_docker_and_ci_files_when_disabled(self, tmp_path: Path):
        output = _generate(tmp_path, {**_DEFAULTS, "use_docker": False, "use_ci": False})

        assert not (output / "docker-compose.yml").exists()
        assert not (output / ".dockerignore").exists()
        assert not (output / "docker" / "php" / "Dockerfile").exists()
        assert not (output / ".github" / "workflows" / "ci.yml").exists()
