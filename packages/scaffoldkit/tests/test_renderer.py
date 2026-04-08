"""Tests for template rendering."""

from pathlib import Path

import pytest
from jinja2 import UndefinedError

from scaffoldkit.renderer import create_jinja_env, render_string, render_template

TEMPLATE_DIR = (
    Path(__file__).resolve().parent.parent
    / "src"
    / "scaffoldkit"
    / "blueprints"
    / "saas-dashboard"
    / "templates"
)


class TestRenderString:
    def test_renders_simple_variable(self):
        result = render_string("Hello {{ name }}", {"name": "World"})
        assert result == "Hello World"

    def test_renders_path_variable(self):
        result = render_string("apps/{{ project_name }}/src", {"project_name": "my-app"})
        assert result == "apps/my-app/src"

    def test_raises_on_missing_variable(self):
        with pytest.raises(UndefinedError):
            render_string("{{ missing }}", {})


class TestRenderTemplate:
    def test_renders_readme(self):
        env = create_jinja_env(TEMPLATE_DIR)
        context = {
            "display_name": "Test App",
            "description": "A test application",
            "project_name": "test-app",
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
        result = render_template(env, "README.md.j2", context)
        assert "# Test App" in result
        assert "nextjs-fullstack" in result
        assert "monorepo" in result

    def test_renders_ai_context(self):
        env = create_jinja_env(TEMPLATE_DIR)
        context = {
            "display_name": "Test App",
            "description": "A test application",
            "project_name": "test-app",
            "stack": "nextjs-fullstack",
            "architecture_style": "monorepo",
            "use_ddd": True,
            "use_auth": True,
            "use_docker": True,
            "use_ci": True,
            "test_strategy": "full-pyramid",
            "design_style": "corporate-professional",
            "ai_context": True,
        }
        result = render_template(env, "AI_CONTEXT.md.j2", context)
        assert "AI Context" in result
        assert "Domain-Driven Design" in result or "DDD" in result
        assert "full-pyramid" in result
