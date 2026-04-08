"""Tests for non-interactive variable collection."""

from pathlib import Path

from scaffoldkit.blueprint_loader import load_blueprint
from scaffoldkit.tui import collect_variables

BLUEPRINTS_DIR = Path(__file__).resolve().parent.parent / "src" / "scaffoldkit" / "blueprints"


class TestCollectVariables:
    def test_skips_inactive_conditional_variables_in_non_interactive_mode(self):
        blueprint = load_blueprint(BLUEPRINTS_DIR / "rest-api")

        variables = collect_variables(
            blueprint,
            {
                "project_name": "test-api",
                "display_name": "Test API",
                "description": "A test API",
                "framework": "fastapi",
                "database": "postgresql",
                "use_auth": False,
                "use_docker": True,
                "use_ci": True,
                "use_openapi": True,
                "test_strategy": "unit-and-integration",
                "ai_context": True,
            },
            non_interactive=True,
        )

        assert variables is not None
        assert variables["use_auth"] is False
        assert "auth_strategy" not in variables
