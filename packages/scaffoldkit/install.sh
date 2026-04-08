#!/usr/bin/env bash
# install.sh - Installer for scaffoldkit
#
# Usage:
#   ./install.sh             Install via uv tool install (recommended)
#   ./install.sh --docker    Build Docker image and install a wrapper script
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="$HOME/.local/bin"
DOCKER_MODE=false
DOCKER_IMAGE="scaffoldkit:latest"
DOCKER_WRAPPER="$TARGET_DIR/scaffoldkit"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --docker)
      DOCKER_MODE=true
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 [--docker]"
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Helper: detect and optionally add ~/.local/bin to PATH in shell rc
# ---------------------------------------------------------------------------
ensure_local_bin_in_path() {
  local shell_rc=""

  case "${SHELL:-}" in
    */zsh)
      shell_rc="$HOME/.zshrc"
      ;;
    */bash)
      if [ -f "$HOME/.bashrc" ]; then
        shell_rc="$HOME/.bashrc"
      else
        shell_rc="$HOME/.profile"
      fi
      ;;
    *)
      if [ -f "$HOME/.bashrc" ]; then
        shell_rc="$HOME/.bashrc"
      elif [ -f "$HOME/.zshrc" ]; then
        shell_rc="$HOME/.zshrc"
      else
        shell_rc="$HOME/.profile"
      fi
      ;;
  esac

  local path_line='export PATH="$HOME/.local/bin:$PATH"'

  case ":$PATH:" in
    *":$HOME/.local/bin:"*)
      echo "PATH already contains ~/.local/bin"
      ;;
    *)
      mkdir -p "$TARGET_DIR"
      touch "$shell_rc"
      if grep -Fqx "$path_line" "$shell_rc"; then
        echo "PATH entry already present in $shell_rc"
      else
        printf '\n%s\n' "$path_line" >> "$shell_rc"
        echo "Added PATH entry to $shell_rc"
      fi
      echo ""
      echo "Reload your shell to pick up the new PATH:"
      echo "  source $shell_rc"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Docker installation path
# ---------------------------------------------------------------------------
install_docker() {
  echo "==> Building Docker image: $DOCKER_IMAGE"
  docker build -t "$DOCKER_IMAGE" "$SCRIPT_DIR"

  echo ""
  echo "==> Installing Docker wrapper to $DOCKER_WRAPPER"
  mkdir -p "$TARGET_DIR"

  # Write a wrapper script that forwards all arguments to the container.
  # Mounts the current working directory so scaffoldkit can write output there.
  cat > "$DOCKER_WRAPPER" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
exec docker run --rm -it \
  -v "$(pwd):/workspace" \
  -w /workspace \
  -e "TERM=${TERM:-xterm-256color}" \
  scaffoldkit:latest \
  "$@"
WRAPPER

  chmod 0755 "$DOCKER_WRAPPER"
  echo "Installed Docker wrapper: $DOCKER_WRAPPER"

  ensure_local_bin_in_path

  echo ""
  echo "scaffoldkit (Docker) is ready. Usage:"
  echo "  scaffoldkit new"
  echo "  scaffoldkit list"
}

# ---------------------------------------------------------------------------
# Native uv tool installation path
# ---------------------------------------------------------------------------
install_native() {
  # -- Ensure uv is available ------------------------------------------------
  if ! command -v uv >/dev/null 2>&1; then
    echo "==> uv not found. Installing uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh

    # The uv installer places the binary in ~/.local/bin (or ~/.cargo/bin on
    # some systems). Refresh PATH so we can use it immediately.
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

    if ! command -v uv >/dev/null 2>&1; then
      echo "Error: uv installation succeeded but 'uv' is still not in PATH."
      echo "Please open a new shell and re-run this installer."
      exit 1
    fi
    echo "uv installed: $(uv --version)"
  else
    echo "uv found: $(uv --version)"
  fi

  # -- Install scaffoldkit as an isolated uv tool ----------------------------
  # uv tool install creates an isolated virtual environment automatically and
  # makes the 'scaffoldkit' entry-point available in ~/.local/bin.
  # Python is downloaded automatically by uv if not already present.
  echo ""
  echo "==> Installing scaffoldkit via uv tool install..."
  uv tool install --reinstall "$SCRIPT_DIR"

  ensure_local_bin_in_path

  echo ""
  echo "scaffoldkit is ready. Usage:"
  echo "  scaffoldkit new"
  echo "  scaffoldkit list"
  echo "  scaffoldkit new saas-dashboard --target ./my-project"
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if [ "$DOCKER_MODE" = true ]; then
  install_docker
else
  install_native
fi
