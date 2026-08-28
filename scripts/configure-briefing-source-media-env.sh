#!/usr/bin/env bash

set -euo pipefail

mode=${1:-}
env_file=${2:-}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# shellcheck source=lib/managed-env.sh
source "$script_dir/lib/managed-env.sh"

case "$mode" in
  status | provision | enable | enable-retention | disable) ;;
  *)
    echo 'usage: configure-briefing-source-media-env.sh status|provision|enable|enable-retention|disable ENV_FILE' >&2
    exit 2
    ;;
esac

managed_env_capture_target "$env_file" 'source-media rollout refused: env file' || exit 1
target_mode=$MANAGED_ENV_TARGET_MODE

managed_keys=(
  CONTENT_MEDIA_WORKER_ENABLED
  CONTENT_MEDIA_RETENTION_ENABLED
)

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
  ' "$env_file"
}

boolean_setting() {
  local key=$1
  local value
  value=$(read_setting "$key")
  value=$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')
  case "$value" in
    1 | true | yes | on) printf true ;;
    '' | 0 | false | no | off) printf false ;;
    *)
      echo "source-media rollout refused: invalid boolean assignment for $key" >&2
      return 43
      ;;
  esac
}

consulted_keys=(
  "${managed_keys[@]}"
  CONTENT_MEDIA_SUPABASE_URL
  CONTENT_MEDIA_SUPABASE_SECRET_KEY
  CONTENT_MEDIA_BUCKET
  CONTENT_MEDIA_CONCURRENCY
)

for key in "${consulted_keys[@]}"; do
  set +e
  value=$(read_setting "$key")
  parse_status=$?
  set -e
  if [[ "$parse_status" -ne 0 ]]; then
    if [[ "$parse_status" -eq 42 ]]; then
      echo "source-media rollout refused: duplicate assignment for $key" >&2
    else
      echo "source-media rollout refused: could not parse assignment for $key" >&2
    fi
    exit "$parse_status"
  fi
  if [[ "$key" != CONTENT_MEDIA_WORKER_ENABLED && "$key" != CONTENT_MEDIA_RETENTION_ENABLED ]] \
    && [[ -z "$value" ]]; then
    echo "source-media rollout refused: $key is required" >&2
    exit 1
  fi
done

for key in "${managed_keys[@]}"; do
  boolean_setting "$key" >/dev/null
done

test "$(read_setting CONTENT_MEDIA_BUCKET)" = briefing-source-media
test "$(read_setting CONTENT_MEDIA_CONCURRENCY)" = 2
case "$(read_setting CONTENT_MEDIA_SUPABASE_URL)" in
  https://*) ;;
  *)
    echo 'source-media rollout refused: CONTENT_MEDIA_SUPABASE_URL must use HTTPS' >&2
    exit 1
    ;;
esac

changed=false
if [[ "$mode" != status && "$mode" != provision ]]; then
  case "$mode" in
    enable)
      enabled=true
      retention=false
      ;;
    enable-retention)
      enabled=true
      retention=true
      ;;
    disable)
      enabled=false
      retention=false
      ;;
  esac

  temporary_file=$(mktemp "${env_file}.source-media.XXXXXX")
  cleanup_temporary_file() {
    if [[ -n "${temporary_file:-}" && -f "$temporary_file" ]]; then
      rm -f -- "$temporary_file"
    fi
  }
  trap cleanup_temporary_file EXIT

  managed_pattern='^[[:space:]]*(export[[:space:]]+)?(CONTENT_MEDIA_WORKER_ENABLED|CONTENT_MEDIA_RETENTION_ENABLED)[[:space:]]*='
  awk -v pattern="$managed_pattern" '$0 !~ pattern { print }' "$env_file" >"$temporary_file"
  printf 'CONTENT_MEDIA_WORKER_ENABLED=%s\n' "$enabled" >>"$temporary_file"
  printf 'CONTENT_MEDIA_RETENTION_ENABLED=%s\n' "$retention" >>"$temporary_file"
  chmod "$target_mode" "$temporary_file"
  managed_env_assert_temp_metadata "$temporary_file" \
    'source-media rollout refused: replacement file'

  if cmp -s "$env_file" "$temporary_file"; then
    rm -f -- "$temporary_file"
  else
    managed_env_atomic_replace \
      "$temporary_file" \
      "$env_file" \
      'source-media rollout refused: env file'
    changed=true
  fi
  temporary_file=''
  trap - EXIT
fi

final_worker_enabled=$(boolean_setting CONTENT_MEDIA_WORKER_ENABLED)
final_retention_enabled=$(boolean_setting CONTENT_MEDIA_RETENTION_ENABLED)
if [[ "$final_retention_enabled" = true && "$final_worker_enabled" != true ]]; then
  echo 'source-media rollout refused: retention requires the media worker to be enabled' >&2
  exit 1
fi

printf '{"event":"briefing_source_media_config","mode":"%s","changed":%s,"workerEnabled":%s,"retentionEnabled":%s,"bucketFixed":true,"concurrency":2,"credentialsPresent":true,"secretValueExposed":false}\n' \
  "$mode" \
  "$changed" \
  "$final_worker_enabled" \
  "$final_retention_enabled"
