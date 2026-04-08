"""Interactive TUI for blueprint selection and variable input."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import questionary
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from scaffoldkit.blueprint_loader import discover_blueprints, load_blueprint
from scaffoldkit.models import Blueprint, BlueprintVariable, GenerationContext, VariableType
from scaffoldkit.variable_conditions import variable_is_active

console = Console()


def select_blueprint(blueprints_dir: Path | None = None) -> tuple[Blueprint, Path] | None:
    """Show blueprint selection prompt. Returns (blueprint, path) or None."""
    available = discover_blueprints(blueprints_dir)

    if not available:
        console.print("[red]No blueprints found.[/red]")
        return None

    choices = []
    for name, path in available:
        bp = load_blueprint(path)
        choices.append(
            questionary.Choice(
                title=f"{bp.display_name} ({name}) - {bp.description}",
                value=(bp, path),
            )
        )

    result: tuple[Blueprint, Path] | None = questionary.select(
        "Select a blueprint:",
        choices=choices,
    ).ask()

    return result


def collect_variables(
    blueprint: Blueprint, provided_vars: dict[str, Any] | None = None, non_interactive: bool = False
) -> dict[str, Any] | None:
    """Prompt the user for each blueprint variable. Returns dict or None on cancel.

    Args:
        blueprint: Blueprint with variable definitions
        provided_vars: Variables provided via --var flags
        non_interactive: If True, use defaults for missing variables
    """
    variables: dict[str, Any] = {}
    provided = provided_vars or {}

    if not blueprint.variables:
        return variables

    if not non_interactive:
        console.print(Panel(f"[bold]{blueprint.display_name}[/bold] - configure your project"))

    definitions = {var.name: var for var in blueprint.variables}

    for var in blueprint.variables:
        current_values = {**provided, **variables}
        if not variable_is_active(var, current_values, definitions):
            continue

        # Use provided value if available
        if var.name in provided:
            variables[var.name] = provided[var.name]
            continue

        # In non-interactive mode, use default or fail for required vars
        if non_interactive:
            if var.default is not None:
                variables[var.name] = var.default
            elif var.required:
                console.print(f"[red]Error: Required variable '{var.name}' not provided[/red]")
                return None
            continue

        # Interactive prompt
        value = _prompt_variable(var)
        if value is None and var.required:
            console.print("[red]Cancelled.[/red]")
            return None
        variables[var.name] = value

    return variables


def _prompt_variable(var: BlueprintVariable) -> Any:
    """Prompt for a single variable based on its type."""
    hint = f" ({var.description})" if var.description else ""

    if var.type == VariableType.BOOLEAN:
        return questionary.confirm(
            f"{var.name}{hint}",
            default=var.default if isinstance(var.default, bool) else True,
        ).ask()

    if var.type == VariableType.CHOICE:
        return questionary.select(
            f"{var.name}{hint}",
            choices=var.choices,
            default=var.default,
        ).ask()

    # string
    return questionary.text(
        f"{var.name}{hint}",
        default=str(var.default) if var.default is not None else "",
    ).ask()


def prompt_target_dir(project_name: str) -> Path | None:
    """Ask for the target directory."""
    default = f"./{project_name}"
    answer = questionary.text(
        "Target directory:",
        default=default,
    ).ask()
    if answer is None:
        return None
    return Path(answer).resolve()


def confirm_generation(context: GenerationContext) -> bool:
    """Show a summary and ask for confirmation."""
    table = Table(title="Generation Summary", show_header=False)
    table.add_column("Key", style="bold cyan")
    table.add_column("Value")

    table.add_row("Blueprint", context.blueprint.display_name)
    table.add_row("Target", str(context.target_dir))
    table.add_row("Dry Run", "Yes" if context.dry_run else "No")
    table.add_row("Overwrite", "Yes" if context.overwrite else "No")

    for key, val in context.variables.items():
        table.add_row(f"  {key}", str(val))

    console.print()
    console.print(table)
    console.print()

    return questionary.confirm("Proceed with generation?", default=True).ask() or False


def print_result(result: Any) -> None:
    """Print the generation result summary."""
    console.print()

    if result.errors:
        console.print("[red bold]Generation completed with errors:[/red bold]")
        for err in result.errors:
            console.print(f"  [red]✗[/red] {err}")
    else:
        console.print("[green bold]Generation completed successfully![/green bold]")

    if result.files_created:
        console.print(f"\n[green]Files created ({len(result.files_created)}):[/green]")
        for f in result.files_created:
            console.print(f"  [green]✓[/green] {f}")

    if result.directories_created:
        console.print(f"\n[blue]Directories ({len(result.directories_created)}):[/blue]")
        for d in result.directories_created:
            console.print(f"  [blue]📁[/blue] {d}")

    if result.files_skipped:
        console.print(f"\n[yellow]Skipped ({len(result.files_skipped)}):[/yellow]")
        for f in result.files_skipped:
            console.print(f"  [yellow]⏭[/yellow]  {f}")
