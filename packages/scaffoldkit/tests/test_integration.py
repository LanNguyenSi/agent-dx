"""Integration tests - full generation pipeline with content verification."""

from pathlib import Path

from scaffoldkit.blueprint_loader import load_blueprint
from scaffoldkit.generator import generate
from scaffoldkit.models import GenerationContext

BLUEPRINTS_DIR = Path(__file__).resolve().parent.parent / "src" / "scaffoldkit" / "blueprints"


def _generate_saas_dashboard(tmp_path: Path, **variable_overrides) -> Path:
    """Helper: generate a saas-dashboard project and return output path."""
    bp_path = BLUEPRINTS_DIR / "saas-dashboard"
    bp = load_blueprint(bp_path)

    variables = {
        "project_name": "test-app",
        "display_name": "Test App",
        "description": "Integration test project",
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
    variables.update(variable_overrides)

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


class TestFullGeneration:
    def test_all_expected_files_exist(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path)

        expected_files = [
            "README.md",
            "package.json",
            "AI_CONTEXT.md",
            "docs/architecture.md",
            "docs/ways-of-working.md",
            "docs/adrs/0001-architecture.md",
            "docs/page-templates/dashboard-page.md",
            "docs/page-templates/detail-page.md",
            "docs/page-templates/settings-page.md",
            ".gitignore",
            ".editorconfig",
        ]
        for f in expected_files:
            assert (output / f).exists(), f"Missing: {f}"

    def test_all_expected_directories_exist(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path)

        expected_dirs = [
            "apps/web",
            "apps/api",
            "packages/ui",
            "packages/shared",
            "docs/adrs",
            "docs/page-templates",
        ]
        for d in expected_dirs:
            assert (output / d).is_dir(), f"Missing dir: {d}"

    def test_readme_contains_project_info(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path, display_name="Acme Dashboard")
        readme = (output / "README.md").read_text()
        assert "# Acme Dashboard" in readme
        assert "nextjs-fullstack" in readme
        assert "monorepo" in readme

    def test_ai_context_reflects_variables(self, tmp_path: Path):
        output = _generate_saas_dashboard(
            tmp_path,
            use_ddd=True,
            test_strategy="full-pyramid",
            design_style="corporate-professional",
        )
        ai_ctx = (output / "AI_CONTEXT.md").read_text()
        assert "DDD" in ai_ctx
        assert "full-pyramid" in ai_ctx
        assert "corporate-professional" in ai_ctx

    def test_architecture_doc_contains_stack(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path, stack="django-htmx")
        arch = (output / "docs" / "architecture.md").read_text()
        assert "django-htmx" in arch

    def test_ways_of_working_contains_test_strategy(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path, test_strategy="e2e-focused")
        wow = (output / "docs" / "ways-of-working.md").read_text()
        assert "e2e-focused" in wow
        assert "end-to-end" in wow.lower()

    def test_adr_reflects_architecture_style(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path, architecture_style="microservices")
        adr = (output / "docs" / "adrs" / "0001-architecture.md").read_text()
        assert "microservices" in adr.lower()
        assert "Independent deployment" in adr

    def test_no_ai_context_when_disabled(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path, ai_context=False)
        assert not (output / "AI_CONTEXT.md").exists()
        # Other files should still exist
        assert (output / "README.md").exists()

    def test_ddd_sections_present_when_enabled(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path, use_ddd=True)
        arch = (output / "docs" / "architecture.md").read_text()
        assert "Domain Model" in arch
        assert "bounded contexts" in arch.lower()

    def test_ddd_sections_absent_when_disabled(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path, use_ddd=False)
        arch = (output / "docs" / "architecture.md").read_text()
        assert "Domain Model" not in arch

    def test_docker_sections_conditional(self, tmp_path: Path):
        output_with = _generate_saas_dashboard(tmp_path, use_docker=True)
        arch_with = (output_with / "docs" / "architecture.md").read_text()
        assert "Docker" in arch_with

    def test_generates_docker_and_ci_contracts(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path, use_docker=True, use_ci=True)
        assert (output / ".dockerignore").exists()
        assert (output / "Dockerfile").exists()
        assert (output / "docker-compose.yml").exists()
        assert (output / ".github" / "workflows" / "ci.yml").exists()

        dockerfile = (output / "Dockerfile").read_text()
        compose = (output / "docker-compose.yml").read_text()
        workflow = (output / ".github" / "workflows" / "ci.yml").read_text()

        assert "apps/web && npm install" in dockerfile
        assert "APP_ROLE: web" in compose
        assert "APP_ROLE: api" in compose
        assert "Set up Node" in workflow

    def test_skips_docker_and_ci_contracts_when_disabled(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path, use_docker=False, use_ci=False)
        assert not (output / ".dockerignore").exists()
        assert not (output / "Dockerfile").exists()
        assert not (output / "docker-compose.yml").exists()
        assert not (output / ".github" / "workflows" / "ci.yml").exists()

    def test_page_templates_reference_design_style(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path, design_style="playful-modern")
        dashboard = (output / "docs" / "page-templates" / "dashboard-page.md").read_text()
        assert "playful-modern" in dashboard.lower() or "Colorful" in dashboard

    def test_static_files_are_valid(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path)

        gitignore = (output / ".gitignore").read_text()
        assert "node_modules" in gitignore

        editorconfig = (output / ".editorconfig").read_text()
        assert "root = true" in editorconfig

    def test_generated_files_are_nonempty(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path)
        for f in output.rglob("*"):
            if f.is_file():
                assert f.stat().st_size > 0, f"Empty file: {f.relative_to(output)}"


class TestDesignStyleVariations:
    """Verify all design style choices produce valid output."""

    def test_minimal_clean(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path, design_style="minimal-clean")
        dashboard = (output / "docs" / "page-templates" / "dashboard-page.md").read_text()
        assert "whitespace" in dashboard.lower() or "subtle" in dashboard.lower()

    def test_corporate_professional(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path, design_style="corporate-professional")
        dashboard = (output / "docs" / "page-templates" / "dashboard-page.md").read_text()
        assert len(dashboard) > 100

    def test_playful_modern(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path, design_style="playful-modern")
        dashboard = (output / "docs" / "page-templates" / "dashboard-page.md").read_text()
        assert len(dashboard) > 100


class TestStackVariations:
    """Verify all stack choices produce valid output."""

    def test_nextjs_fullstack(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path, stack="nextjs-fullstack")
        assert (output / "README.md").exists()
        assert (output / "package.json").exists()
        assert (output / "apps" / "web" / ".env.local.example").exists()
        assert (output / "apps" / "web" / "package.json").exists()
        assert (output / "apps" / "web" / "app" / "page.tsx").exists()
        assert (output / "apps" / "web" / "app" / "layout.tsx").exists()
        assert (output / "apps" / "api" / "package.json").exists()
        assert (output / "apps" / "api" / ".env.example").exists()
        assert (output / "apps" / "api" / "src" / "index.ts").exists()

        root_package = (output / "package.json").read_text()
        env_example = (output / "apps" / "api" / ".env.example").read_text()
        assert '"apps/web"' in root_package
        assert '"apps/api"' in root_package
        assert "DATABASE_URL=" in env_example

        dockerfile = (output / "Dockerfile").read_text()
        workflow = (output / ".github" / "workflows" / "ci.yml").read_text()
        assert "npm run dev -- --hostname 0.0.0.0" in dockerfile
        assert "Verify Next.js + Node bootstrap" in workflow

    def test_symfony_api_react(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path, stack="symfony-api-react")
        readme = (output / "README.md").read_text()
        assert "symfony-api-react" in readme
        assert (output / "package.json").exists()
        assert (output / "apps" / "web" / "package.json").exists()
        assert (output / "apps" / "web" / "index.html").exists()
        assert (output / "apps" / "web" / "src" / "main.tsx").exists()
        assert (output / "apps" / "api" / "composer.json").exists()
        assert (output / "apps" / "api" / ".env.example").exists()
        assert (output / "apps" / "api" / "public" / "index.php").exists()
        assert (output / "apps" / "api" / "src" / "Kernel.php").exists()

        composer = (output / "apps" / "api" / "composer.json").read_text()
        env_example = (output / "apps" / "api" / ".env.example").read_text()
        assert "symfony/framework-bundle" in composer
        assert "DATABASE_URL=" in env_example

        compose = (output / "docker-compose.yml").read_text()
        workflow = (output / ".github" / "workflows" / "ci.yml").read_text()
        assert '"5173:5173"' in compose
        assert "Set up PHP" in workflow
        assert "php -l apps/api/public/index.php" in workflow

    def test_django_htmx(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path, stack="django-htmx")
        readme = (output / "README.md").read_text()
        assert "django-htmx" in readme
        assert (output / "pyproject.toml").exists()
        assert (output / "apps" / "api" / ".env.example").exists()
        assert (output / "apps" / "api" / "manage.py").exists()
        assert (output / "apps" / "api" / "config" / "settings.py").exists()
        assert (output / "apps" / "web" / "templates" / "dashboard" / "index.html").exists()

        pyproject = (output / "pyproject.toml").read_text()
        settings = (output / "apps" / "api" / "config" / "settings.py").read_text()
        env_example = (output / "apps" / "api" / ".env.example").read_text()
        assert '"django>=' in pyproject or "django>=" in pyproject
        assert "INSTALLED_APPS" in settings
        assert "DJANGO_SETTINGS_MODULE=" in env_example

        compose = (output / "docker-compose.yml").read_text()
        workflow = (output / ".github" / "workflows" / "ci.yml").read_text()
        assert "app:" in compose
        assert "python -m py_compile" in workflow

    def test_rails_hotwire(self, tmp_path: Path):
        output = _generate_saas_dashboard(tmp_path, stack="rails-hotwire")
        readme = (output / "README.md").read_text()
        assert "rails-hotwire" in readme
        assert (output / "Gemfile").exists()
        assert (output / "apps" / "api" / ".env.example").exists()
        assert (output / "apps" / "api" / "config.ru").exists()
        assert (output / "apps" / "web" / "app" / "views" / "dashboard" / "index.html.erb").exists()

        gemfile = (output / "Gemfile").read_text()
        routes = (output / "apps" / "api" / "config" / "routes.rb").read_text()
        env_example = (output / "apps" / "api" / ".env.example").read_text()
        assert 'gem "rails"' in gemfile
        assert 'root "dashboard#index"' in routes
        assert "RAILS_ENV=development" in env_example

        dockerfile = (output / "Dockerfile").read_text()
        workflow = (output / ".github" / "workflows" / "ci.yml").read_text()
        assert "ruby -run -e httpd ../web -p 8000" in dockerfile
        assert "ruby -c apps/api/config/application.rb" in workflow
