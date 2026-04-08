"""Tests for variable validation."""

from pathlib import Path

from scaffoldkit.blueprint_loader import load_blueprint
from scaffoldkit.validators import validate_variables

BLUEPRINTS_DIR = Path(__file__).resolve().parent.parent / "src" / "scaffoldkit" / "blueprints"


def _load_saas():
    return load_blueprint(BLUEPRINTS_DIR / "saas-dashboard")


def _load_rest_api():
    return load_blueprint(BLUEPRINTS_DIR / "rest-api")


def _valid_inputs():
    return {
        "project_name": "my-app",
        "display_name": "My App",
        "description": "Test app",
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


class TestValidateVariables:
    def test_valid_inputs_pass(self):
        bp = _load_saas()
        errors = validate_variables(bp, _valid_inputs())
        assert errors == []

    def test_missing_required_variable(self):
        bp = _load_saas()
        inputs = _valid_inputs()
        del inputs["project_name"]
        errors = validate_variables(bp, inputs)
        assert any("project_name" in e for e in errors)

    def test_invalid_choice(self):
        bp = _load_saas()
        inputs = _valid_inputs()
        inputs["stack"] = "invalid-stack"
        errors = validate_variables(bp, inputs)
        assert any("stack" in e for e in errors)

    def test_boolean_type_check(self):
        bp = _load_saas()
        inputs = _valid_inputs()
        inputs["use_auth"] = "not-a-bool"
        errors = validate_variables(bp, inputs)
        assert any("use_auth" in e for e in errors)

    def test_skips_inactive_conditional_variable_validation(self):
        bp = _load_rest_api()
        inputs = {
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
            "auth_strategy": "not-a-real-strategy",
        }
        errors = validate_variables(bp, inputs)
        assert all("auth_strategy" not in error for error in errors)
