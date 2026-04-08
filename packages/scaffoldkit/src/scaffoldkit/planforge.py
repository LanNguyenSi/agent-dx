"""Helpers for consuming scaffoldkit-input.json exports from agent-planforge."""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from scaffoldkit.models import Blueprint, BlueprintVariable, VariableType
from scaffoldkit.variable_conditions import prune_inactive_variables


class PlanforgeArchitecture(BaseModel):
    """Architecture slice from scaffoldkit-input.json."""

    model_config = ConfigDict(extra="ignore")

    shape: str = ""
    optionId: str | None = None
    phase: str | None = None
    path: str | None = None


class PlanforgeStack(BaseModel):
    """Stack slice from scaffoldkit-input.json."""

    model_config = ConfigDict(extra="ignore")

    hint: str = ""
    dataStore: str = "relational"
    integrations: list[str] = Field(default_factory=list)


class PlanforgeExport(BaseModel):
    """Contract exported by agent-planforge for scaffold selection."""

    model_config = ConfigDict(extra="ignore")

    version: str = ""
    exportedBy: str = ""
    projectName: str
    summary: str = ""
    blueprint: str
    blueprintCandidates: list[str] = Field(default_factory=list)
    blueprintReason: str = ""
    plannerProfile: str = ""
    architecture: PlanforgeArchitecture = Field(default_factory=PlanforgeArchitecture)
    stack: PlanforgeStack = Field(default_factory=PlanforgeStack)
    features: list[str] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)
    suggestedVariables: dict[str, Any] = Field(default_factory=dict)


def load_planforge_export(file_path: Path) -> PlanforgeExport:
    """Load and validate a planforge export file."""
    try:
        payload = json.loads(file_path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError(f"Planforge input not found: {file_path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid JSON in {file_path}: {error}") from error

    try:
        return PlanforgeExport.model_validate(payload)
    except Exception as error:  # pydantic raises ValidationError
        raise ValueError(f"Invalid planforge export in {file_path}: {error}") from error


def default_target_name(export_data: PlanforgeExport) -> str:
    """Return the default target directory name for a planforge import."""
    return slugify(export_data.projectName) or "generated-project"


def build_variables_from_planforge(
    export_data: PlanforgeExport, blueprint: Blueprint
) -> dict[str, Any]:
    """Map a planforge export to scaffoldkit blueprint variables."""
    variables = default_variables_for_blueprint(blueprint)
    blueprint_defaults = default_variables_for_blueprint(blueprint)
    available_names = {variable.name for variable in blueprint.variables}

    variables["project_name"] = slugify(export_data.projectName) or blueprint.name
    if "display_name" in available_names:
        variables["display_name"] = export_data.projectName
    if "description" in available_names:
        variables["description"] = (
            export_data.summary or variables.get("description") or export_data.projectName
        )
    if "ai_context" in available_names:
        variables["ai_context"] = True

    for name, value in export_data.suggestedVariables.items():
        if name in available_names:
            variables[name] = value

    combined_text = " ".join(
        [
            export_data.projectName,
            export_data.summary,
            *export_data.features,
            *export_data.constraints,
            export_data.architecture.shape,
            export_data.stack.hint,
        ]
    ).lower()

    def should_infer(name: str) -> bool:
        return name in available_names and (
            name not in export_data.suggestedVariables
            and variables.get(name) == blueprint_defaults.get(name)
        )

    has_docker_signal = bool(re.search(r"docker|container|kubernetes|compose", combined_text))
    has_queue_signal = bool(
        re.search(r"background jobs|queue|workflow|notification", combined_text)
    )
    has_public_signal = bool(re.search(r"public-only|anonymous|no auth", combined_text))

    if should_infer("use_docker") and has_docker_signal:
        variables["use_docker"] = True
    if should_infer("language"):
        if re.search(r"typescript", combined_text):
            variables["language"] = "typescript"
        elif re.search(r"\bgo\b", combined_text):
            variables["language"] = "go"
        elif re.search(r"rust", combined_text):
            variables["language"] = "rust"
        else:
            variables["language"] = "python"
    if should_infer("cli_framework"):
        language = str(variables.get("language", "")).lower()
        framework_defaults = {
            "python": "typer",
            "go": "cobra",
            "rust": "clap",
            "typescript": "commander",
        }
        if language in framework_defaults:
            variables["cli_framework"] = framework_defaults[language]
    if should_infer("distribution"):
        language = str(variables.get("language", "")).lower()
        is_compiled = language in {"go", "rust", "typescript"}
        variables["distribution"] = "binary" if is_compiled else "pip-package"
    if should_infer("test_strategy"):
        variables["test_strategy"] = (
            "integration-tests"
            if re.search(r"git|sync|filesystem|queue|workflow|remote", combined_text)
            else "unit-tests"
        )
    if should_infer("use_analytics") and re.search(r"analytics|dashboard|report", combined_text):
        variables["use_analytics"] = True
    if should_infer("use_email") and re.search(r"email|notification|invite", combined_text):
        variables["use_email"] = True
    if should_infer("use_queue") and has_queue_signal:
        variables["use_queue"] = True
    if should_infer("use_auth") and has_public_signal:
        variables["use_auth"] = False
    if should_infer("use_openapi"):
        variables["use_openapi"] = True

    if should_infer("db_provider"):
        variables["db_provider"] = infer_database_choice(export_data, "db_provider")
    if should_infer("database"):
        variables["database"] = infer_database_choice(export_data, "database")
    if should_infer("framework"):
        ts_hint = "typescript service stack" in export_data.stack.hint.lower()
        variables["framework"] = "express" if ts_hint else "fastapi"
    if blueprint.name == "fastapi-backend":
        if should_infer("db_provider"):
            variables["db_provider"] = infer_database_choice(export_data, "db_provider")
        if should_infer("package_manager"):
            variables["package_manager"] = "uv"
        if should_infer("api_docs"):
            variables["api_docs"] = True
        if should_infer("auth_strategy"):
            variables["auth_strategy"] = infer_auth_strategy(export_data, blueprint.name)
        if should_infer("use_background_jobs") and bool(
            re.search(r"background jobs|queue|workflow|worker", combined_text)
        ):
            variables["use_background_jobs"] = True
        if should_infer("use_redis") and bool(re.search(r"redis|cache|queue", combined_text)):
            variables["use_redis"] = True
        if should_infer("test_strategy"):
            variables["test_strategy"] = "pytest-and-integration"
    if blueprint.name == "django-drf":
        if should_infer("database"):
            variables["database"] = infer_database_choice(export_data, "database")
        if should_infer("package_manager"):
            variables["package_manager"] = "uv"
        if should_infer("use_drf_spectacular"):
            variables["use_drf_spectacular"] = True
        if should_infer("auth_strategy"):
            variables["auth_strategy"] = infer_auth_strategy(export_data, blueprint.name)
        if should_infer("use_celery") and bool(
            re.search(r"background jobs|queue|workflow|celery", combined_text)
        ):
            variables["use_celery"] = True
        if should_infer("use_channels") and bool(
            re.search(r"websocket|real-time|realtime|channels", combined_text)
        ):
            variables["use_channels"] = True
        if should_infer("test_strategy"):
            variables["test_strategy"] = "pytest-django-and-integration"
    if should_infer("auth_strategy"):
        variables["auth_strategy"] = infer_auth_strategy(export_data, blueprint.name)

    return normalize_variables_for_blueprint(blueprint, variables)


def resolve_blueprint_path(
    blueprints_dir: Path, export_data: PlanforgeExport
) -> tuple[Path | None, str | None]:
    """Resolve the first available blueprint from the preferred and fallback candidates."""
    primary = export_data.blueprint
    for candidate in blueprint_candidates(export_data):
        candidate_path = blueprints_dir / candidate
        if (candidate_path / "blueprint.yaml").exists():
            fallback_from = primary if candidate != primary else None
            return candidate_path, fallback_from
    return None, None


def inferred_blueprint_candidates(export_data: PlanforgeExport) -> list[str]:
    """Add local blueprint fallbacks when planforge emits a generic Python API choice."""
    combined_text = " ".join(
        [
            export_data.projectName,
            export_data.summary,
            *export_data.features,
            *export_data.constraints,
            export_data.architecture.shape,
            export_data.stack.hint,
            export_data.stack.dataStore,
        ]
    ).lower()

    base_candidates = [export_data.blueprint, *export_data.blueprintCandidates]
    references_generic_api = any(candidate == "rest-api" for candidate in base_candidates)
    if not references_generic_api:
        return []

    inferred: list[str] = []
    if re.search(r"django|drf|django rest|serializer|viewset|admin", combined_text):
        inferred.append("django-drf")
    elif re.search(r"fastapi|pydantic|uvicorn|asgi|python", combined_text):
        inferred.append("fastapi-backend")

    return inferred


def blueprint_candidates(export_data: PlanforgeExport) -> list[str]:
    """Return the ordered list of preferred blueprint candidates without duplicates."""
    ordered: list[str] = []
    for candidate in [
        *inferred_blueprint_candidates(export_data),
        export_data.blueprint,
        *export_data.blueprintCandidates,
    ]:
        if candidate and candidate not in ordered:
            ordered.append(candidate)
    return ordered


def ignored_suggested_variables(export_data: PlanforgeExport, blueprint: Blueprint) -> list[str]:
    """List suggested variable names that do not exist on the selected blueprint."""
    available_names = {variable.name for variable in blueprint.variables}
    ignored = [name for name in export_data.suggestedVariables if name not in available_names]
    return sorted(ignored)


def optional_section_warnings(export_data: PlanforgeExport) -> list[str]:
    """Describe optional planforge sections that are missing or empty."""
    warnings: list[str] = []
    if not export_data.summary:
        warnings.append("summary missing; using blueprint defaults for description where needed")
    if not export_data.features:
        warnings.append("features missing; feature-specific hints will stay at blueprint defaults")
    if not export_data.constraints:
        warnings.append("constraints missing; deployment and database hints may stay at defaults")
    if not export_data.architecture.shape:
        warnings.append(
            "architecture.shape missing; architecture-specific hints may stay at defaults"
        )
    return warnings


def default_variables_for_blueprint(blueprint: Blueprint) -> dict[str, Any]:
    """Collect declared blueprint defaults into a variable map."""
    values: dict[str, Any] = {}
    for variable in blueprint.variables:
        if variable.default is not None:
            values[variable.name] = variable.default
    return values


def normalize_variables_for_blueprint(
    blueprint: Blueprint, variables: dict[str, Any]
) -> dict[str, Any]:
    """Clamp variable values to the blueprint contract where possible."""
    normalized = dict(variables)

    for variable in blueprint.variables:
        if variable.name not in normalized:
            continue
        normalized[variable.name] = normalize_variable_value(variable, normalized[variable.name])

    return prune_inactive_variables(blueprint, normalized)


def normalize_variable_value(variable: BlueprintVariable, value: Any) -> Any:
    """Normalize a single variable to the blueprint's type and choices."""
    if variable.type == VariableType.BOOLEAN:
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            lowered = value.strip().lower()
            if lowered in {"true", "yes", "1"}:
                return True
            if lowered in {"false", "no", "0"}:
                return False
        return bool(value)

    if variable.type == VariableType.STRING:
        return str(value)

    if variable.type == VariableType.CHOICE:
        if value in variable.choices:
            return value
        if variable.default in variable.choices:
            return variable.default
        return variable.choices[0] if variable.choices else value

    return value


def infer_database_choice(export_data: PlanforgeExport, variable_name: str) -> str:
    """Infer a database choice from planforge signals."""
    combined_text = " ".join(
        [
            export_data.stack.dataStore,
            *export_data.constraints,
            *export_data.features,
            export_data.summary,
        ]
    ).lower()

    if "sqlite" in combined_text:
        return "sqlite"
    if "mysql" in combined_text:
        return "mysql"
    if "mongo" in combined_text and variable_name == "database":
        return "mongodb"
    return "postgresql"


def infer_auth_strategy(export_data: PlanforgeExport, blueprint_name: str) -> str:
    """Infer an auth strategy from planforge summary and constraints."""
    combined_text = " ".join(
        [
            export_data.summary,
            *export_data.features,
            *export_data.constraints,
        ]
    ).lower()

    if "public-only" in combined_text or "anonymous" in combined_text:
        return "none"
    if "api key" in combined_text or "api-key" in combined_text:
        if blueprint_name == "django-drf":
            return "token"
        return "api-key"
    if "session" in combined_text and blueprint_name == "django-drf":
        return "session"
    if "oauth2" in combined_text:
        return "oauth2"
    if (
        "sso" in combined_text or "next-auth" in combined_text
    ) and blueprint_name == "nextjs-fullstack":
        return "next-auth"
    return "jwt"


def slugify(value: str) -> str:
    """Convert a display name into a filesystem-friendly slug."""
    return re.sub(r"(^-|-$)", "", re.sub(r"[^a-z0-9]+", "-", value.lower()))
