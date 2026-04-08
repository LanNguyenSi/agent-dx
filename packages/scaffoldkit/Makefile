SHELL := /usr/bin/env bash

.PHONY: help install install-docker dev test lint typecheck check build docker-build clean

# Default target
help:
	@printf '%s\n' \
		'Available targets:' \
		'  make install        Install scaffoldkit via uv tool install' \
		'  make install-docker Build Docker image and install wrapper script' \
		'  make dev            Create .venv and install with dev dependencies' \
		'  make test           Run pytest' \
		'  make lint           Run ruff check + ruff format --check' \
		'  make typecheck      Run mypy' \
		'  make check          Run lint + typecheck + test (all quality checks)' \
		'  make build          Build the Python package with uv build' \
		'  make docker-build   Build the Docker image' \
		'  make clean          Remove build artifacts and caches'

# ---------------------------------------------------------------------------
# Installation
# ---------------------------------------------------------------------------

install:
	@bash install.sh

install-docker:
	@bash install.sh --docker

# ---------------------------------------------------------------------------
# Development environment
# ---------------------------------------------------------------------------

dev:
	uv venv .venv --python 3.12
	uv pip install --python .venv/bin/python -e ".[dev]"
	@echo ""
	@echo "Dev environment ready. Activate with:"
	@echo "  source .venv/bin/activate"

# ---------------------------------------------------------------------------
# Quality checks
# ---------------------------------------------------------------------------

test:
	pytest

lint:
	ruff check src/ tests/
	ruff format --check src/ tests/

typecheck:
	mypy src/scaffoldkit/

check: lint typecheck test

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

build:
	uv build

docker-build:
	docker build -t scaffoldkit:latest .

# ---------------------------------------------------------------------------
# Clean
# ---------------------------------------------------------------------------

clean:
	rm -rf .venv dist build
	find . -type d -name '__pycache__' -exec rm -rf {} +
	rm -rf .pytest_cache .mypy_cache .ruff_cache
