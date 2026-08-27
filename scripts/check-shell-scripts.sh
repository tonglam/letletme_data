#!/usr/bin/env bash

set -euo pipefail

script_root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
shell_scripts=()

while IFS= read -r -d '' script; do
  shell_scripts+=("$script")
  bash -n "$script"
done < <(find "$script_root" -type f -name '*.sh' -print0 | sort -z)

if ! command -v shellcheck >/dev/null 2>&1; then
  echo 'shellcheck is required for shell-script validation' >&2
  exit 1
fi

# SC2097/SC2098 are pre-existing, intentional environment scoping in
# deploy.sh; keep the check strict for all other warnings.
shellcheck \
  --shell=bash \
  --severity=warning \
  --exclude=SC2097,SC2098 \
  "${shell_scripts[@]}"
