#!/usr/bin/env bash

set -euo pipefail

mode=${1:-}
env_file=${2:-}

case "$mode" in
  status | shadow-http | host-shadow | disabled) ;;
  *)
    echo 'usage: configure-briefing-acquisition-env.sh status|shadow-http|host-shadow|disabled ENV_FILE' >&2
    exit 2
    ;;
esac

if [[ -z "$env_file" || ! -f "$env_file" || -L "$env_file" ]]; then
  echo 'briefing rollout refused: env file must be an existing regular file' >&2
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
  CONTENT_PIPELINE_ENABLED
  CONTENT_ACQUISITION_SHADOW_MODE
  CONTENT_X_SCAN_ENABLED
  CONTENT_X_BACKSTOP_ENABLED
  CONTENT_HTTP_ACQUISITION_ENABLED
  CONTENT_PODCAST_TRANSCRIPT_ENABLED
  CONTENT_YOUTUBE_DISCOVERY_ENABLED
  CONTENT_YOUTUBE_NATIVE_ENABLED
  CONTENT_YOUTUBE_GENERATED_ENABLED
  CONTENT_REAL_GROK_ENABLED
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
      echo "briefing rollout refused: invalid boolean assignment for $key" >&2
      return 43
      ;;
  esac
}

positive_integer_setting() {
  local value
  value=$(read_setting "$1")
  [[ "$value" =~ ^[1-9][0-9]*$ ]]
}

nonempty_setting() {
  [[ -n "$(read_setting "$1")" ]]
}

consulted_keys=(
  "${managed_keys[@]}"
  CONTENT_PUBLICATION_ENABLED
  BRIEFING_PUBLIC_ENABLED
  HERMES_TRANSCRIPT_URL
  HERMES_TRANSCRIPT_TOKEN
  CONTENT_HERMES_DAILY_AUDIO_MINUTES
  YOUTUBE_DATA_API_KEY
  SUPADATA_API_KEY
  CONTENT_SUPADATA_DAILY_CREDIT_LIMIT
)

for key in "${consulted_keys[@]}"; do
  set +e
  read_setting "$key" >/dev/null
  status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    if [[ "$status" -eq 42 ]]; then
      echo "briefing rollout refused: duplicate assignment for $key" >&2
    else
      echo "briefing rollout refused: could not parse assignment for $key" >&2
    fi
    exit "$status"
  fi
done

for key in "${managed_keys[@]}" CONTENT_PUBLICATION_ENABLED BRIEFING_PUBLIC_ENABLED; do
  boolean_setting "$key" >/dev/null
done

hermes_ready=false
if nonempty_setting HERMES_TRANSCRIPT_URL \
  && nonempty_setting HERMES_TRANSCRIPT_TOKEN \
  && positive_integer_setting CONTENT_HERMES_DAILY_AUDIO_MINUTES; then
  hermes_ready=true
fi

youtube_native_ready=false
if nonempty_setting YOUTUBE_DATA_API_KEY \
  && nonempty_setting SUPADATA_API_KEY \
  && positive_integer_setting CONTENT_SUPADATA_DAILY_CREDIT_LIMIT; then
  youtube_native_ready=true
fi

changed=false
if [[ "$mode" != status ]]; then
  publication_enabled=$(boolean_setting CONTENT_PUBLICATION_ENABLED)
  public_enabled=$(boolean_setting BRIEFING_PUBLIC_ENABLED)
  if [[ ("$mode" == shadow-http || "$mode" == host-shadow) \
    && ("$publication_enabled" == true || "$public_enabled" == true) ]]; then
    echo 'briefing rollout refused: shadow acquisition cannot alter a public publication runtime' >&2
    exit 1
  fi

  if [[ "$mode" == shadow-http || "$mode" == host-shadow ]]; then
    backstop_enabled=false
    if [[ "$mode" == host-shadow ]]; then
      backstop_enabled=$(boolean_setting CONTENT_X_BACKSTOP_ENABLED)
    fi
    settings=(
      CONTENT_PIPELINE_ENABLED=true
      CONTENT_ACQUISITION_SHADOW_MODE=true
      "CONTENT_X_SCAN_ENABLED=$([[ "$mode" == host-shadow ]] && printf true || printf false)"
      "CONTENT_X_BACKSTOP_ENABLED=$backstop_enabled"
      CONTENT_HTTP_ACQUISITION_ENABLED=true
      "CONTENT_PODCAST_TRANSCRIPT_ENABLED=$hermes_ready"
      CONTENT_YOUTUBE_DISCOVERY_ENABLED=true
      "CONTENT_YOUTUBE_NATIVE_ENABLED=$youtube_native_ready"
      CONTENT_YOUTUBE_GENERATED_ENABLED=false
      "CONTENT_REAL_GROK_ENABLED=$([[ "$mode" == host-shadow ]] && printf true || printf false)"
    )
  else
    pipeline_after_disable=false
    if [[ "$publication_enabled" == true || "$public_enabled" == true ]]; then
      pipeline_after_disable=true
    fi
    settings=(
      "CONTENT_PIPELINE_ENABLED=$pipeline_after_disable"
      CONTENT_ACQUISITION_SHADOW_MODE=false
      CONTENT_X_SCAN_ENABLED=false
      CONTENT_X_BACKSTOP_ENABLED=false
      CONTENT_HTTP_ACQUISITION_ENABLED=false
      CONTENT_PODCAST_TRANSCRIPT_ENABLED=false
      CONTENT_YOUTUBE_DISCOVERY_ENABLED=false
      CONTENT_YOUTUBE_NATIVE_ENABLED=false
      CONTENT_YOUTUBE_GENERATED_ENABLED=false
      CONTENT_REAL_GROK_ENABLED=false
    )
  fi

  temporary_file=$(mktemp "${env_file}.briefing.XXXXXX")
  cleanup_temporary_file() {
    if [[ -n "${temporary_file:-}" && -f "$temporary_file" ]]; then
      rm -f -- "$temporary_file"
    fi
  }
  trap cleanup_temporary_file EXIT

  managed_pattern='^[[:space:]]*(export[[:space:]]+)?(CONTENT_PIPELINE_ENABLED|CONTENT_ACQUISITION_SHADOW_MODE|CONTENT_X_SCAN_ENABLED|CONTENT_X_BACKSTOP_ENABLED|CONTENT_HTTP_ACQUISITION_ENABLED|CONTENT_PODCAST_TRANSCRIPT_ENABLED|CONTENT_YOUTUBE_DISCOVERY_ENABLED|CONTENT_YOUTUBE_NATIVE_ENABLED|CONTENT_YOUTUBE_GENERATED_ENABLED|CONTENT_REAL_GROK_ENABLED)[[:space:]]*='
  awk -v pattern="$managed_pattern" '$0 !~ pattern { print }' "$env_file" >"$temporary_file"
  for setting in "${settings[@]}"; do
    printf '%s\n' "$setting" >>"$temporary_file"
  done
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

printf '{"event":"briefing_acquisition_config","mode":"%s","changed":%s,"pipeline":%s,"shadow":%s,"x":%s,"xBackstop":%s,"http":%s,"podcast":%s,"youtubeDiscovery":%s,"youtubeNative":%s,"youtubeGenerated":%s,"publication":%s,"public":%s,"hermesReady":%s,"youtubeNativeReady":%s,"secretValueExposed":false}\n' \
  "$mode" \
  "$changed" \
  "$(boolean_setting CONTENT_PIPELINE_ENABLED)" \
  "$(boolean_setting CONTENT_ACQUISITION_SHADOW_MODE)" \
  "$(boolean_setting CONTENT_X_SCAN_ENABLED)" \
  "$(boolean_setting CONTENT_X_BACKSTOP_ENABLED)" \
  "$(boolean_setting CONTENT_HTTP_ACQUISITION_ENABLED)" \
  "$(boolean_setting CONTENT_PODCAST_TRANSCRIPT_ENABLED)" \
  "$(boolean_setting CONTENT_YOUTUBE_DISCOVERY_ENABLED)" \
  "$(boolean_setting CONTENT_YOUTUBE_NATIVE_ENABLED)" \
  "$(boolean_setting CONTENT_YOUTUBE_GENERATED_ENABLED)" \
  "$(boolean_setting CONTENT_PUBLICATION_ENABLED)" \
  "$(boolean_setting BRIEFING_PUBLIC_ENABLED)" \
  "$hermes_ready" \
  "$youtube_native_ready"
