#!/usr/bin/env bash
set -euo pipefail

retired=(
  REDIS_HOST
  REDIS_PORT
  REDIS_PASSWORD
  RATE_LIMIT_REDIS_HOST
  RATE_LIMIT_REDIS_PORT
  RATE_LIMIT_REDIS_PASSWORD
  GRAPHQL_BROWSER_INGRESS_RATE_LIMIT
  GRAPHQL_AUTHENTICATED_RATE_LIMIT
  GRAPHQL_ANONYMOUS_RATE_LIMIT
  MY_FPL_SNAPSHOT_READ_ENABLED
  DATA_API_URL
  DATA_API_KEY
  DATA_URL
  DATA_AUTH_HEADER
  LETLETME_GRAPHQL_REDIS_HOST
  LETLETME_GRAPHQL_REDIS_PORT
  LETLETME_GRAPHQL_REDIS_PASSWORD
)

retired_pattern=$(IFS='|'; printf '%s' "${retired[*]}")
set +e
matches=$(git grep -l -I -P \
  -e "(?<![A-Z0-9_])(${retired_pattern})(?![A-Z0-9_])" \
  -- . ':(exclude)scripts/check-retired-config.sh')
grep_status=$?
set -e

case "$grep_status" in
  0)
    echo 'Retired configuration names remain in tracked files:' >&2
    printf '%s\n' "$matches" >&2
    exit 1
    ;;
  1)
    echo 'Retired configuration hard-cut check passed.'
    ;;
  *)
    echo 'Retired configuration scan failed.' >&2
    exit "$grep_status"
    ;;
esac
