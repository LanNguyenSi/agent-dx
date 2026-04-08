"""Helpers for resolving conditional blueprint variables."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Mapping

    from scaffoldkit.models import Blueprint, BlueprintVariable


def variable_is_active(
    variable: BlueprintVariable,
    values: Mapping[str, Any],
    definitions: Mapping[str, BlueprintVariable],
    seen: set[str] | None = None,
) -> bool:
    """Return whether a variable should be active for the current values."""
    if not variable.condition:
        return True

    condition_name = variable.condition
    if seen and condition_name in seen:
        return False

    controller = definitions.get(condition_name)
    next_seen = (seen or set()) | {variable.name}

    if controller and not variable_is_active(controller, values, definitions, next_seen):
        return False

    if condition_name in values:
        return _is_truthy(values[condition_name])

    if controller is None:
        return False

    return _is_truthy(controller.default)


def prune_inactive_variables(blueprint: Blueprint, values: Mapping[str, Any]) -> dict[str, Any]:
    """Drop variables whose conditions are currently inactive."""
    definitions = {variable.name: variable for variable in blueprint.variables}
    pruned = dict(values)

    for variable in blueprint.variables:
        if not variable_is_active(variable, values, definitions):
            pruned.pop(variable.name, None)

    return pruned


def _is_truthy(value: Any) -> bool:
    """Interpret common CLI-style boolean values consistently."""
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "yes", "1", "on"}:
            return True
        if lowered in {"false", "no", "0", "off", ""}:
            return False
    return bool(value)
