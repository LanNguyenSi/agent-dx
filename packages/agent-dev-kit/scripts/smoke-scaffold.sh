#!/usr/bin/env bash
# Scaffold smoke test: run the built CLI into a temp dir and assert the
# expected files exist. Run from packages/agent-dev-kit after `npm run build`.
# CLI_PATH overrides the CLI entry point (default dist/cli.js).
set -euo pipefail

cli="${CLI_PATH:-dist/cli.js}"
cli="$(cd "$(dirname "${cli}")" && pwd)/$(basename "${cli}")"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

(cd "${tmp}" && node "${cli}" create ci-smoke-agent --features=memory,skills --no-git --no-install)

missing=0
for f in package.json .ai/AGENTS.md src/index.ts; do
  if [ ! -f "${tmp}/ci-smoke-agent/${f}" ]; then
    echo "::error title=Scaffold smoke test::missing expected file ci-smoke-agent/${f}"
    missing=1
  fi
done
if [ "${missing}" -ne 0 ]; then
  exit 1
fi
echo "Scaffold smoke test OK"
