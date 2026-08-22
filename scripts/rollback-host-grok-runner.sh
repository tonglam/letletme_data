#!/usr/bin/env bash

set -euo pipefail

release_root=${1:-/home/workspace/letletme-grok-runner}
previous_target=${2:-}
previous_release=${3:-}

test "$release_root" = /home/workspace/letletme-grok-runner
if [[ -n "$previous_target" ]]; then
  case "$previous_target" in
    "$release_root"/releases/*) test -x "$previous_target" ;;
    *) echo 'refusing to restore a runner target outside the release root' >&2; exit 1 ;;
  esac
  test "$previous_release" != ''
  test "$previous_release" = unknown || [[ "$previous_release" =~ ^[0-9a-f]{7,128}$ ]]
  ln -sfn "$previous_target" "$release_root/current"
  printf '%s\n' "$previous_release" >"$release_root/current.release"
  chmod 0640 "$release_root/current.release"
  sudo systemctl restart letletme-grok-runner.service
else
  rm -f -- "$release_root/current" "$release_root/current.release"
  sudo systemctl stop letletme-grok-runner.service || true
fi

printf '%s\n' '{"event":"host_grok_runner_rollback","outcome":"passed"}'
