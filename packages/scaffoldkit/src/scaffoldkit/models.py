"""Data models for blueprints and generation context."""

from __future__ import annotations

from enum import StrEnum
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field


class VariableType(StrEnum):
    STRING = "string"
    BOOLEAN = "boolean"
    CHOICE = "choice"


class BlueprintVariable(BaseModel):
    """A single variable/prompt defined in a blueprint."""

    name: str
    description: str = ""
    type: VariableType = VariableType.STRING
    default: Any = None
    choices: list[str] = Field(default_factory=list)
    required: bool = True
    condition: str | None = None


class FileEntry(BaseModel):
    """A file to generate - either from a template or static."""

    source: str  # relative path inside blueprint templates/ or static/
    target: str  # relative path in generated project (supports Jinja2 vars)
    condition: str | None = None  # optional variable name that must be truthy


class Blueprint(BaseModel):
    """Full blueprint definition loaded from blueprint.yaml."""

    name: str
    display_name: str
    description: str = ""
    version: str = "1.0.0"
    stack: str = ""
    variables: list[BlueprintVariable] = Field(default_factory=list)
    templates: list[FileEntry] = Field(default_factory=list)
    static_files: list[FileEntry] = Field(default_factory=list)
    directories: list[str] = Field(default_factory=list)

    # metadata carried into templates
    metadata: dict[str, Any] = Field(default_factory=dict)


class GenerationContext(BaseModel):
    """Resolved context passed to the generator."""

    blueprint: Blueprint
    blueprint_path: Path
    variables: dict[str, Any]  # resolved user inputs
    target_dir: Path
    dry_run: bool = False
    overwrite: bool = False


class GenerationResult(BaseModel):
    """Summary returned after generation."""

    files_created: list[str] = Field(default_factory=list)
    directories_created: list[str] = Field(default_factory=list)
    files_skipped: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)

    @property
    def success(self) -> bool:
        return len(self.errors) == 0
