"""Validation logic for blueprints and user inputs."""

from __future__ import annotations

from scaffoldkit.models import Blueprint, BlueprintVariable, VariableType
from scaffoldkit.variable_conditions import variable_is_active


def validate_variables(blueprint: Blueprint, user_inputs: dict[str, object]) -> list[str]:
    """Validate user inputs against blueprint variable definitions.

    Returns a list of error messages (empty = valid).
    """
    errors: list[str] = []
    definitions = {var.name: var for var in blueprint.variables}

    for var in blueprint.variables:
        if not variable_is_active(var, user_inputs, definitions):
            continue

        value = user_inputs.get(var.name)

        if var.required and (value is None or value == ""):
            errors.append(f"Required variable '{var.name}' is missing.")
            continue

        if value is None:
            continue

        errors.extend(_validate_single(var, value))

    return errors


def _validate_single(var: BlueprintVariable, value: object) -> list[str]:
    """Validate a single variable value."""
    errors: list[str] = []

    if var.type == VariableType.BOOLEAN and not isinstance(value, bool):
        errors.append(f"Variable '{var.name}' must be a boolean.")

    if var.type == VariableType.CHOICE and var.choices and value not in var.choices:
        errors.append(f"Variable '{var.name}' must be one of {var.choices}, got '{value}'.")

    if var.type == VariableType.STRING and not isinstance(value, str):
        errors.append(f"Variable '{var.name}' must be a string.")

    return errors
