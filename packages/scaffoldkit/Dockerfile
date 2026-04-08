# syntax=docker/dockerfile:1

# ---- build stage ----
FROM python:3.12-slim AS builder

WORKDIR /app

COPY pyproject.toml README.md LICENSE ./
COPY src/ src/

RUN pip install --no-cache-dir .

# ---- runtime stage ----
FROM python:3.12-slim

COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin/scaffoldkit /usr/local/bin/scaffoldkit

# Blueprints at a well-known location, referenced via env var
COPY src/scaffoldkit/blueprints/ /opt/scaffoldkit/blueprints/
ENV SCAFFOLDKIT_BLUEPRINTS_DIR=/opt/scaffoldkit/blueprints

WORKDIR /workspace

ENTRYPOINT ["scaffoldkit"]
