"""Tests for data models."""

from pathlib import Path

from scaffoldkit.models import (
    Blueprint,
    BlueprintVariable,
    FileEntry,
    GenerationContext,
    GenerationResult,
    VariableType,
)


class TestVariableType:
    def test_string_type(self):
        assert VariableType.STRING == "string"

    def test_boolean_type(self):
        assert VariableType.BOOLEAN == "boolean"

    def test_choice_type(self):
        assert VariableType.CHOICE == "choice"


class TestBlueprintVariable:
    def test_minimal_variable(self):
        var = BlueprintVariable(name="test")
        assert var.name == "test"
        assert var.type == VariableType.STRING
        assert var.default is None
        assert var.required is True
        assert var.choices == []
        assert var.condition is None

    def test_choice_variable(self):
        var = BlueprintVariable(
            name="stack",
            type=VariableType.CHOICE,
            choices=["a", "b", "c"],
            default="a",
        )
        assert var.choices == ["a", "b", "c"]

    def test_boolean_variable(self):
        var = BlueprintVariable(
            name="flag",
            type=VariableType.BOOLEAN,
            default=False,
        )
        assert var.type == VariableType.BOOLEAN

    def test_conditional_variable(self):
        var = BlueprintVariable(
            name="auth_strategy",
            type=VariableType.CHOICE,
            choices=["jwt", "oauth2"],
            default="jwt",
            condition="use_auth",
        )
        assert var.condition == "use_auth"


class TestFileEntry:
    def test_basic_entry(self):
        entry = FileEntry(source="README.md.j2", target="README.md")
        assert entry.condition is None

    def test_conditional_entry(self):
        entry = FileEntry(
            source="AI_CONTEXT.md.j2",
            target="AI_CONTEXT.md",
            condition="ai_context",
        )
        assert entry.condition == "ai_context"


class TestBlueprint:
    def test_minimal_blueprint(self):
        bp = Blueprint(name="test", display_name="Test")
        assert bp.name == "test"
        assert bp.variables == []
        assert bp.templates == []
        assert bp.static_files == []
        assert bp.directories == []
        assert bp.metadata == {}

    def test_full_blueprint(self):
        bp = Blueprint(
            name="test",
            display_name="Test Blueprint",
            description="A test",
            version="2.0.0",
            stack="python",
            variables=[BlueprintVariable(name="project_name")],
            templates=[FileEntry(source="a.j2", target="a")],
            static_files=[FileEntry(source="b", target="b")],
            directories=["src", "tests"],
            metadata={"key": "value"},
        )
        assert len(bp.variables) == 1
        assert len(bp.templates) == 1
        assert bp.metadata["key"] == "value"


class TestGenerationResult:
    def test_success_when_no_errors(self):
        result = GenerationResult()
        assert result.success is True

    def test_failure_when_errors(self):
        result = GenerationResult(errors=["something went wrong"])
        assert result.success is False

    def test_tracks_files(self):
        result = GenerationResult(
            files_created=["a.md", "b.md"],
            files_skipped=["c.md"],
            directories_created=["src"],
        )
        assert len(result.files_created) == 2
        assert len(result.files_skipped) == 1
        assert len(result.directories_created) == 1


class TestGenerationContext:
    def test_defaults(self):
        bp = Blueprint(name="test", display_name="Test")
        ctx = GenerationContext(
            blueprint=bp,
            blueprint_path=Path("/tmp/test"),
            variables={},
            target_dir=Path("/tmp/output"),
        )
        assert ctx.dry_run is False
        assert ctx.overwrite is False
