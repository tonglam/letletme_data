#!/usr/bin/env bash

set -euo pipefail

deploy_env_file=${1:-}
media_env_file=${2:-}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# shellcheck source=lib/managed-env.sh
source "$script_dir/lib/managed-env.sh"

if [[ -z "$deploy_env_file" || -z "$media_env_file" ]]; then
  echo 'usage: bootstrap-briefing-source-media-env.sh DEPLOY_ENV_FILE MEDIA_ENV_FILE' >&2
  exit 2
fi

managed_env_require_regular_file \
  "$deploy_env_file" \
  'source-media env bootstrap refused: deploy env' || exit 1

if [[ -e "$media_env_file" || -L "$media_env_file" ]]; then
  managed_env_require_regular_file \
    "$media_env_file" \
    'source-media env bootstrap refused: media env target' || exit 1
  "$script_dir/configure-briefing-source-media-env.sh" status "$media_env_file" >/dev/null
  printf '%s\n' \
    '{"event":"briefing_source_media_env_bootstrap","created":false,"credentialsPresent":true,"secretValueExposed":false}'
  exit 0
fi

read_setting() {
  local key=$1
  awk -v key="$key" '
    $0 ~ "^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=" {
      count += 1
      value = $0
      sub("^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=", "", value)
      sub("^[[:space:]]+", "", value)
      sub("[[:space:]]+$", "", value)
      if (value ~ /^\".*\"$/ || value ~ /^\047.*\047$/) {
        value = substr(value, 2, length(value) - 2)
      }
    }
    END {
      if (count > 1) exit 42
      if (count == 1) print value
    }
  ' "$deploy_env_file"
}

read_required_setting() {
  local key=$1
  local value
  set +e
  value=$(read_setting "$key")
  local status=$?
  set -e
  if [[ "$status" -eq 42 ]]; then
    echo "source-media env bootstrap refused: duplicate assignment for $key" >&2
    exit 1
  fi
  if [[ "$status" -ne 0 || -z "$value" ]]; then
    echo "source-media env bootstrap refused: $key is required" >&2
    exit 1
  fi
  printf '%s' "$value"
}

supabase_url=$(read_required_setting BUG_REPORT_SCREENSHOT_SUPABASE_URL)
supabase_secret=$(read_required_setting BUG_REPORT_SCREENSHOT_SUPABASE_SECRET_KEY)

case "$supabase_url" in
  https://*) ;;
  *)
    echo 'source-media env bootstrap refused: source Supabase URL must use HTTPS' >&2
    exit 1
    ;;
esac
if [[ "$supabase_url" =~ [[:space:]] || "$supabase_secret" =~ [[:space:]] ]]; then
  echo 'source-media env bootstrap refused: source credentials contain whitespace' >&2
  exit 1
fi

umask 077
temporary_file=$(mktemp "${media_env_file}.bootstrap.XXXXXX")
cleanup_temporary_file() {
  if [[ -n "${temporary_file:-}" && -f "$temporary_file" ]]; then
    rm -f -- "$temporary_file"
  fi
}
trap cleanup_temporary_file EXIT

printf '%s\n' \
  'CONTENT_MEDIA_WORKER_ENABLED=false' \
  "CONTENT_MEDIA_SUPABASE_URL=$supabase_url" \
  "CONTENT_MEDIA_SUPABASE_SECRET_KEY=$supabase_secret" \
  'CONTENT_MEDIA_BUCKET=briefing-source-media' \
  'CONTENT_MEDIA_CONCURRENCY=2' \
  'CONTENT_MEDIA_RETENTION_ENABLED=false' \
  >"$temporary_file"
chmod 600 "$temporary_file"
"$script_dir/configure-briefing-source-media-env.sh" status "$temporary_file" >/dev/null
managed_env_atomic_create \
  "$temporary_file" \
  "$media_env_file" \
  'source-media env bootstrap refused: media env' || exit 1
temporary_file=''
trap - EXIT

printf '%s\n' \
  '{"event":"briefing_source_media_env_bootstrap","created":true,"workerEnabled":false,"retentionEnabled":false,"credentialsPresent":true,"secretValueExposed":false}'
