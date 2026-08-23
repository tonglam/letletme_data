#!/usr/bin/env bash

set -euo pipefail

mode=${1:-}
env_file=${2:-}

case "$mode" in
  status | provision | enable | enable-retention | disable) ;;
  *)
    echo 'usage: configure-briefing-source-media-env.sh status|provision|enable|enable-retention|disable ENV_FILE' >&2
    exit 2
    ;;
esac

if [[ -z "$env_file" || ! -f "$env_file" || -L "$env_file" ]]; then
  echo 'source-media rollout refused: env file must be an existing regular file' >&2
  exit 1
fi

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

file_uid() {
  stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"
}

file_gid() {
  stat -c '%g' "$1" 2>/dev/null || stat -f '%g' "$1"
}

file_links() {
  stat -c '%h' "$1" 2>/dev/null || stat -f '%l' "$1"
}

target_mode=$(file_mode "$env_file")
target_uid=$(file_uid "$env_file")
target_gid=$(file_gid "$env_file")
target_mode_value=$((8#$target_mode))
test $((target_mode_value & 077)) -eq 0
test "$(file_links "$env_file")" -eq 1
test "$target_uid" -eq "$(id -u)"
test "$target_gid" -eq "$(id -g)"

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
  test "$(file_mode "$temporary_file")" = "$target_mode"
  test "$(file_uid "$temporary_file")" -eq "$target_uid"
  test "$(file_gid "$temporary_file")" -eq "$target_gid"

  if cmp -s "$env_file" "$temporary_file"; then
    rm -f -- "$temporary_file"
  else
    mv "$temporary_file" "$env_file"
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
