"""Tests for CLI commands."""

import json

from typer.testing import CliRunner

from scaffoldkit.cli import app

runner = CliRunner()


class TestListCommand:
    def test_lists_blueprints(self):
        result = runner.invoke(app, ["list"])
        assert result.exit_code == 0
        assert "saas-dashboard" in result.output
        assert "SaaS Dashboard" in result.output

    def test_lists_with_custom_dir_empty(self, tmp_path):
        result = runner.invoke(app, ["list", "--blueprints-dir", str(tmp_path)])
        assert result.exit_code == 0
        assert "No blueprints found" in result.output


class TestNewCommand:
    def test_invalid_blueprint_name(self, tmp_path):
        result = runner.invoke(app, ["new", "nonexistent", "--target", str(tmp_path)])
        assert result.exit_code == 1
        assert "not found" in result.output

    def test_help(self):
        result = runner.invoke(app, ["new", "--help"])
        assert result.exit_code == 0
        assert "blueprint" in result.output.lower()


class TestFromPlanforgeCommand:
    def test_generates_project_from_planforge_export(self, tmp_path):
        export_path = tmp_path / "scaffoldkit-input.json"
        target = tmp_path / "generated-app"
        export_path.write_text(
            json.dumps(
                {
                    "version": "1.1",
                    "exportedBy": "agent-planforge",
                    "projectName": "Ops Console",
                    "summary": "Internal operations dashboard with audit-aware workflows.",
                    "blueprint": "nextjs-fullstack",
                    "blueprintCandidates": ["nextjs-fullstack", "saas-dashboard"],
                    "features": ["analytics dashboard", "user authentication"],
                    "constraints": ["must be dockerized", "prefer TypeScript"],
                    "architecture": {"shape": "modular monolith"},
                    "stack": {"hint": "TypeScript web application", "dataStore": "relational"},
                    "suggestedVariables": {
                        "db_provider": "sqlite",
                        "use_docker": True,
                        "use_analytics": True,
                        "auth_strategy": "jwt",
                    },
                }
            ),
            encoding="utf-8",
        )

        result = runner.invoke(
            app,
            ["from-planforge", str(export_path), "--target", str(target), "--no-install"],
        )

        assert result.exit_code == 0
        assert (target / "README.md").exists()
        assert (target / "package.json").exists()
        assert (target / ".ai" / "AGENTS.md").exists()

    def test_falls_back_to_candidate_blueprint_when_primary_is_missing(self, tmp_path):
        export_path = tmp_path / "scaffoldkit-input.json"
        target = tmp_path / "generated-app"
        export_path.write_text(
            json.dumps(
                {
                    "projectName": "Worker API",
                    "summary": "Backend worker with queued jobs.",
                    "blueprint": "missing-blueprint",
                    "blueprintCandidates": ["express-api", "rest-api"],
                    "features": ["workflow queue processing"],
                    "stack": {"hint": "TypeScript service stack"},
                    "suggestedVariables": {"use_queue": True},
                }
            ),
            encoding="utf-8",
        )

        result = runner.invoke(
            app,
            ["from-planforge", str(export_path), "--target", str(target), "--no-install"],
        )

        assert result.exit_code == 0
        assert "using fallback 'express-api'" in result.output
        assert (target / "README.md").exists()

    def test_prefers_fastapi_backend_for_generic_python_api_exports(self, tmp_path):
        export_path = tmp_path / "scaffoldkit-input.json"
        target = tmp_path / "generated-fastapi"
        export_path.write_text(
            json.dumps(
                {
                    "projectName": "Workflow Service",
                    "summary": "Python API for asynchronous workflow orchestration.",
                    "blueprint": "rest-api",
                    "blueprintCandidates": ["rest-api"],
                    "features": ["background workflow processing", "redis-backed coordination"],
                    "constraints": ["docker deployment", "JWT auth"],
                    "stack": {"hint": "Python application stack", "dataStore": "relational"},
                }
            ),
            encoding="utf-8",
        )

        result = runner.invoke(
            app,
            ["from-planforge", str(export_path), "--target", str(target), "--no-install"],
        )

        assert result.exit_code == 0
        assert "fallback 'fastapi-backend'" in result.output
        assert (target / "app" / "api" / "routes").is_dir()
        assert not (target / "src" / "routes").exists()

    def test_prefers_django_drf_for_generic_python_api_exports(self, tmp_path):
        export_path = tmp_path / "scaffoldkit-input.json"
        target = tmp_path / "generated-django"
        export_path.write_text(
            json.dumps(
                {
                    "projectName": "Case Management",
                    "summary": "Django REST API for internal case administration.",
                    "blueprint": "rest-api",
                    "blueprintCandidates": ["rest-api"],
                    "features": ["DRF serializers", "admin workflows"],
                    "constraints": ["session auth for internal operators"],
                    "stack": {"hint": "Python application stack", "dataStore": "relational"},
                }
            ),
            encoding="utf-8",
        )

        result = runner.invoke(
            app,
            ["from-planforge", str(export_path), "--target", str(target), "--no-install"],
        )

        assert result.exit_code == 0
        assert "fallback 'django-drf'" in result.output
        assert (target / "config" / "settings").is_dir()
        assert not (target / "src" / "routes").exists()

    def test_generates_runnable_typescript_cli_from_planforge_export(self, tmp_path):
        export_path = tmp_path / "scaffoldkit-input.json"
        target = tmp_path / "generated-cli"
        export_path.write_text(
            json.dumps(
                {
                    "version": "1.1",
                    "exportedBy": "agent-planforge",
                    "projectName": "agent-memory-sync",
                    "summary": "CLI tool to sync memory files through a central git repository.",
                    "blueprint": "cli-tool",
                    "blueprintCandidates": ["cli-tool", "express-api"],
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
            ),
            encoding="utf-8",
        )

        result = runner.invoke(
            app,
            ["from-planforge", str(export_path), "--target", str(target), "--no-install"],
        )

        assert result.exit_code == 0
        assert (target / "package.json").exists()
        assert (target / "tsconfig.json").exists()
        assert (target / "src" / "main.ts").exists()
        assert (target / "src" / "commands" / "run.ts").exists()
        assert (target / "tests" / "run.test.ts").exists()

    def test_reports_ignored_suggested_variables_without_failing(self, tmp_path):
        export_path = tmp_path / "scaffoldkit-input.json"
        target = tmp_path / "generated-app"
        export_path.write_text(
            json.dumps(
                {
                    "projectName": "Ops Console",
                    "summary": "Internal operations dashboard.",
                    "blueprint": "nextjs-fullstack",
                    "suggestedVariables": {
                        "db_provider": "sqlite",
                        "nonexistent_flag": True,
                    },
                }
            ),
            encoding="utf-8",
        )

        result = runner.invoke(
            app,
            ["from-planforge", str(export_path), "--target", str(target), "--no-install"],
        )

        assert result.exit_code == 0
        assert "Ignoring unsupported suggested variables" in result.output
        assert "nonexistent_flag" in result.output

    def test_partial_planforge_payload_uses_defaults_with_warning(self, tmp_path):
        export_path = tmp_path / "scaffoldkit-input.json"
        target = tmp_path / "generated-app"
        export_path.write_text(
            json.dumps(
                {
                    "projectName": "Minimal Export",
                    "blueprint": "rest-api",
                }
            ),
            encoding="utf-8",
        )

        result = runner.invoke(
            app,
            ["from-planforge", str(export_path), "--target", str(target), "--no-install"],
        )

        assert result.exit_code == 0
        assert "Planforge input warning" in result.output
        assert (target / "README.md").exists()

    def test_invalid_blueprint_in_planforge_export_fails_cleanly(self, tmp_path):
        export_path = tmp_path / "scaffoldkit-input.json"
        export_path.write_text(
            json.dumps(
                {
                    "projectName": "Broken Export",
                    "summary": "Invalid blueprint reference.",
                    "blueprint": "missing-blueprint",
                }
            ),
            encoding="utf-8",
        )

        result = runner.invoke(app, ["from-planforge", str(export_path), "--no-install"])

        assert result.exit_code == 1
        assert "No compatible blueprint" in result.output
        assert "missing-blueprint" in result.output
