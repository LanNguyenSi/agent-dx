"""Tests for the reference-php-app blueprint."""

from pathlib import Path

from scaffoldkit.blueprint_loader import load_blueprint
from scaffoldkit.generator import generate
from scaffoldkit.models import GenerationContext

BLUEPRINTS_DIR = Path(__file__).resolve().parent.parent / "src" / "scaffoldkit" / "blueprints"

_DEFAULTS = {
    "project_name": "demo-reference-app",
    "display_name": "Demo Reference App",
    "description": "A generated reference repository scaffold",
    "domain_suffix": "internal.test",
    "use_docker": True,
    "use_ci": True,
    "ai_context": True,
}


def _generate(tmp_path: Path, variables: dict) -> Path:
    bp_path = BLUEPRINTS_DIR / "reference-php-app"
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


class TestReferencePhpAppBlueprint:
    def test_loads(self):
        bp = load_blueprint(BLUEPRINTS_DIR / "reference-php-app")
        assert bp.name == "reference-php-app"
        assert any(var.name == "use_docker" for var in bp.variables)
        assert len(bp.static_files) >= 20

    def test_generates_reference_scaffold(self, tmp_path: Path):
        output = _generate(tmp_path, _DEFAULTS)

        assert (output / "README.md").exists()
        assert (output / "AI_CONTEXT.md").exists()
        assert (output / ".env.dist").exists()
        assert (output / ".github" / "workflows" / "pipeline.yml").exists()
        assert (output / ".github" / "actions" / "secret-scan" / "action.yml").exists()
        assert (output / "Makefile").exists()
        assert (output / "build" / "app" / "Dockerfile").exists()
        assert (output / "docs" / "img.png").exists()
        assert (output / "project" / "README.md").exists()
        assert (output / "tools" / "composer.json").exists()

        env_dist = (output / ".env.dist").read_text()
        assert "PROJECT_NAME=demo-reference-app" in env_dist
        assert "DOMAIN_SUFFIX=internal.test" in env_dist

        pipeline = (output / ".github" / "workflows" / "pipeline.yml").read_text()
        assert "uses: ./.github/actions/secret-scan" in pipeline
        assert "${{ github.event.repository.name }}" in pipeline
        assert (
            "REGISTRY_IMAGE: ghcr.io/${{ github.repository_owner }}/"
            "${{ github.event.repository.name }}"
        ) in pipeline
        assert "permissions:" in pipeline
        assert "packages: write" in pipeline
        assert "id-token: write" in pipeline
        assert "artifact-name: ${{ env.CI_ARTIFACT_NAME }}" in pipeline
        assert "artifact-name: ${{ env.PROD_ARTIFACT_NAME }}" in pipeline
        assert "startsWith(github.ref_name, 'release/')" in pipeline
        assert "startsWith(github.ref, 'refs/tags/')" in pipeline
        assert "uses: demo-reference-app/.github/actions/secret-scan" not in pipeline
        assert "github.ref_name == 'release/*'" not in pipeline
        assert "github.ref == 'refs/tags/*'" not in pipeline
        assert (
            "with:\n"
            "          image-name: ${{ env.CI_IMAGE_NAME }}\n"
            "          artifact-name: ${{ env.CI_ARTIFACT_NAME }}\n"
            "          dockerfile: build/app/Dockerfile\n"
            "          context: ."
        ) in pipeline
        assert "image-name: ${{ env.CI_IMAGE_NAME }}          dockerfile:" not in pipeline
        assert "#      target_overlay: test" in pipeline
        assert "#      target_overlay: stage" in pipeline
        assert "#      target_overlay: prod" in pipeline
        assert "needs: [ lint, test-unit, test-integration, license-check, cve-check ]" in pipeline

    def test_skips_optional_files_when_disabled(self, tmp_path: Path):
        output = _generate(
            tmp_path,
            {**_DEFAULTS, "use_docker": False, "use_ci": False, "ai_context": False},
        )
        assert not (output / ".github" / "workflows" / "pipeline.yml").exists()
        assert not (output / ".github" / "actions").exists()
        assert not (output / "docker-compose.yml").exists()
        assert not (output / "build" / "app" / "Dockerfile").exists()
        assert not (output / "build" / "nginx" / "Dockerfile").exists()
        assert not (output / "AI_CONTEXT.md").exists()
