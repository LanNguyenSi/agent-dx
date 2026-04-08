"""File system operations - isolated for testability."""

from __future__ import annotations

import shutil
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path


def ensure_directory(path: Path) -> bool:
    """Create directory (and parents) if it doesn't exist. Returns True if created."""
    if path.exists():
        return False
    path.mkdir(parents=True, exist_ok=True)
    return True


def write_file(path: Path, content: str, overwrite: bool = False) -> bool:
    """Write content to a file. Returns True if written, False if skipped."""
    if path.exists() and not overwrite:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return True


def copy_file(source: Path, target: Path, overwrite: bool = False) -> bool:
    """Copy a file. Returns True if copied, False if skipped."""
    if target.exists() and not overwrite:
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    return True
