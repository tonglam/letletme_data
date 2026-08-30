#!/usr/bin/env bash
# Idempotent repository bootstrap: refresh Bun dependencies against the lockfile.
# Runtime services and migrations are handled per-boot by start.sh.
set -euo pipefail

export PATH="$HOME/.bun/bin:$PATH"

echo "[install] bun $(bun --version)"
bun install --frozen-lockfile
echo "[install] dependencies ready"
