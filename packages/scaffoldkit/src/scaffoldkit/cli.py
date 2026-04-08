"""CLI entry point using Typer."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Annotated, Any

import typer
from rich.console import Console

from scaffoldkit.blueprint_loader import discover_blueprints, get_blueprints_dir, load_blueprint
from scaffoldkit.generator import generate
from scaffoldkit.models import GenerationContext
from scaffoldkit.planforge import (
    blueprint_candidates,
    build_variables_from_planforge,
    default_target_name,
    ignored_suggested_variables,
    load_planforge_export,
    optional_section_warnings,
    resolve_blueprint_path,
)
from scaffoldkit.scaffold_blueprint import create_blueprint
from scaffoldkit.tui import (
    collect_variables,
    confirm_generation,
    print_result,
    prompt_target_dir,
    select_blueprint,
)

app = typer.Typer(
    name="scaffoldkit",
    help="AI-aided project scaffolding tool.",
    no_args_is_help=True,
)
console = Console()


def _run_npm_install(target: Path) -> None:
    """Run npm install for generated projects when applicable."""
    console.print("\n[bold cyan]Running npm install...[/bold cyan]")
    try:
        subprocess.run(
            ["npm", "install"],
            cwd=target,
            check=True,
            capture_output=False,
        )
        console.print("[green]✓ npm install completed[/green]")
    except subprocess.CalledProcessError as error:
        msg = f"npm install failed with exit code {error.returncode}"
        console.print(f"[yellow]Warning: {msg}[/yellow]")
    except FileNotFoundError:
        console.print("[yellow]Warning: npm not found in PATH, skipping install[/yellow]")


@app.command()
def new(
    blueprint_name: Annotated[
        str | None, typer.Argument(help="Blueprint name (interactive if omitted)")
    ] = None,
    target: Annotated[Path | None, typer.Option("--target", "-t", help="Target directory")] = None,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", "-n", help="Preview without writing files")
    ] = False,
    overwrite: Annotated[
        bool, typer.Option("--overwrite", help="Overwrite existing files")
    ] = False,
    no_install: Annotated[
        bool, typer.Option("--no-install", help="Skip npm install after generation")
    ] = False,
    blueprints_dir: Annotated[
        Path | None, typer.Option("--blueprints-dir", "-b", help="Custom blueprints dir")
    ] = None,
    var: Annotated[
        list[str] | None, typer.Option("--var", help="Variable in key=value format (repeatable)")
    ] = None,
    non_interactive: Annotated[
        bool, typer.Option("--non-interactive", help="Non-interactive mode (use defaults)")
    ] = False,
) -> None:
    """Generate a new project from a blueprint."""
    bp_dir = blueprints_dir or get_blueprints_dir()

    # Select blueprint
    if blueprint_name:
        bp_path = bp_dir / blueprint_name
        if not (bp_path / "blueprint.yaml").exists():
            console.print(f"[red]Blueprint '{blueprint_name}' not found in {bp_dir}[/red]")
            raise typer.Exit(1)
        blueprint = load_blueprint(bp_path)
    else:
        result = select_blueprint(bp_dir)
        if result is None:
            raise typer.Exit(1)
        blueprint, bp_path = result

    # Parse --var flags into dict
    var_dict: dict[str, Any] = {}
    if var:
        for v in var:
            if "=" not in v:
                console.print(f"[red]Invalid --var format: '{v}' (expected key=value)[/red]")
                raise typer.Exit(1)
            key, value = v.split("=", 1)
            # Convert common boolean strings
            if value.lower() in ("true", "yes", "1"):
                var_dict[key] = True
            elif value.lower() in ("false", "no", "0"):
                var_dict[key] = False
            else:
                var_dict[key] = value

    # Collect variables (interactive or non-interactive)
    variables = collect_variables(blueprint, var_dict, non_interactive)
    if variables is None:
        raise typer.Exit(1)

    # Determine target directory
    project_name = variables.get("project_name", blueprint.name)
    if target is None:
        target = prompt_target_dir(project_name)
        if target is None:
            raise typer.Exit(1)
    else:
        target = target.resolve()

    # Build context
    context = GenerationContext(
        blueprint=blueprint,
        blueprint_path=bp_path,
        variables=variables,
        target_dir=target,
        dry_run=dry_run,
        overwrite=overwrite,
    )

    # Confirm
    if not confirm_generation(context):
        console.print("[yellow]Aborted.[/yellow]")
        raise typer.Exit(0)

    # Generate
    gen_result = generate(context)
    print_result(gen_result)

    if not gen_result.success:
        raise typer.Exit(1)

    # Run npm install if package.json exists and not skipped
    if not dry_run and not no_install and (target / "package.json").exists():
        _run_npm_install(target)


@app.command(name="from-planforge")
def from_planforge(
    planforge_input: Annotated[
        Path,
        typer.Argument(help="Path to scaffoldkit-input.json generated by agent-planforge"),
    ],
    target: Annotated[Path | None, typer.Option("--target", "-t", help="Target directory")] = None,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", "-n", help="Preview without writing files")
    ] = False,
    overwrite: Annotated[
        bool, typer.Option("--overwrite", help="Overwrite existing files")
    ] = False,
    no_install: Annotated[
        bool, typer.Option("--no-install", help="Skip npm install after generation")
    ] = False,
    blueprints_dir: Annotated[
        Path | None, typer.Option("--blueprints-dir", "-b", help="Custom blueprints dir")
    ] = None,
) -> None:
    """Generate a project from an agent-planforge scaffold recommendation."""
    try:
        export_data = load_planforge_export(planforge_input.resolve())
    except ValueError as error:
        console.print(f"[red]{error}[/red]")
        raise typer.Exit(1) from error

    bp_dir = blueprints_dir or get_blueprints_dir()
    bp_path, fallback_from = resolve_blueprint_path(bp_dir, export_data)
    if bp_path is None:
        console.print(f"[red]No compatible blueprint from planforge input found in {bp_dir}[/red]")
        console.print(
            "[yellow]Imported candidates: "
            f"{', '.join(blueprint_candidates(export_data)) or '(none)'}[/yellow]"
        )
        if export_data.blueprintReason:
            console.print(f"[yellow]Planforge reason: {export_data.blueprintReason}[/yellow]")
        available_names = [name for name, _ in discover_blueprints(bp_dir)]
        console.print(
            f"[yellow]Local blueprints: {', '.join(available_names) or '(none found)'}[/yellow]"
        )
        raise typer.Exit(1)

    blueprint = load_blueprint(bp_path)
    if fallback_from:
        console.print(
            f"[yellow]Primary blueprint '{fallback_from}' unavailable; using "
            f"fallback '{blueprint.name}' instead.[/yellow]"
        )

    ignored_variables = ignored_suggested_variables(export_data, blueprint)
    if ignored_variables:
        console.print(
            "[yellow]Ignoring unsupported suggested variables for this blueprint: "
            f"{', '.join(ignored_variables)}[/yellow]"
        )

    for warning in optional_section_warnings(export_data):
        console.print(f"[yellow]Planforge input warning: {warning}[/yellow]")

    variables = build_variables_from_planforge(export_data, blueprint)

    resolved_target = (
        target.resolve() if target else (Path.cwd() / default_target_name(export_data)).resolve()
    )

    context = GenerationContext(
        blueprint=blueprint,
        blueprint_path=bp_path,
        variables=variables,
        target_dir=resolved_target,
        dry_run=dry_run,
        overwrite=overwrite,
    )

    gen_result = generate(context)
    print_result(gen_result)

    if not gen_result.success:
        raise typer.Exit(1)

    if not dry_run and not no_install and (resolved_target / "package.json").exists():
        _run_npm_install(resolved_target)


@app.command(name="init-blueprint")
def init_blueprint(
    name: Annotated[str, typer.Argument(help="Blueprint name (e.g. my-custom-stack)")],
    blueprints_dir: Annotated[
        Path | None, typer.Option("--blueprints-dir", "-b", help="Custom blueprints dir")
    ] = None,
) -> None:
    """Scaffold a new blueprint with starter files."""
    bp_dir = blueprints_dir or get_blueprints_dir()
    target = bp_dir / name

    if target.exists():
        console.print(f"[red]Directory already exists: {target}[/red]")
        raise typer.Exit(1)

    target.mkdir(parents=True)
    created = create_blueprint(target, name)

    console.print(f"[green bold]Blueprint '{name}' created at {target}[/green bold]\n")
    for f in created:
        console.print(f"  [green]✓[/green] {f}")

    console.print("\n[bold]Next steps:[/bold]")
    console.print(f"  1. Edit [cyan]{target / 'blueprint.yaml'}[/cyan] to add variables")
    console.print(f"  2. Add templates in [cyan]{target / 'templates'}[/cyan]")
    console.print(f"  3. Add static files in [cyan]{target / 'static'}[/cyan]")
    console.print("  4. Run [cyan]scaffoldkit list[/cyan] to verify")
    console.print(f"  5. Run [cyan]scaffoldkit new {name}[/cyan] to test")


@app.command(name="list")
def list_blueprints(
    blueprints_dir: Annotated[Path | None, typer.Option("--blueprints-dir", "-b")] = None,
) -> None:
    """List available blueprints."""
    bp_dir = blueprints_dir or get_blueprints_dir()
    available = discover_blueprints(bp_dir)

    if not available:
        console.print("[yellow]No blueprints found.[/yellow]")
        raise typer.Exit(0)

    console.print("[bold]Available blueprints:[/bold]\n")
    for name, path in available:
        bp = load_blueprint(path)
        console.print(f"  [cyan]{name}[/cyan] - {bp.display_name}")
        if bp.description:
            console.print(f"    {bp.description}")
        console.print()


if __name__ == "__main__":
    app()
