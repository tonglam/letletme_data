#!/usr/bin/env bash

set -euo pipefail

mode=${1:-}
env_file=${2:-}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# shellcheck source=lib/managed-env.sh
source "$script_dir/lib/managed-env.sh"

case "$mode" in
  status | shadow-http | host-shadow | disabled) ;;
  *)
    echo 'usage: configure-briefing-acquisition-env.sh status|shadow-http|host-shadow|disabled ENV_FILE' >&2
    exit 2
    ;;
esac

managed_env_capture_target "$env_file" 'briefing rollout refused: env file' || exit 1
target_mode=$MANAGED_ENV_TARGET_MODE

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
  CONTENT_X_ACCOUNT_PROVIDER
  TIKHUB_API_KEY
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

x_account_provider=$(read_setting CONTENT_X_ACCOUNT_PROVIDER)
x_account_provider=${x_account_provider:-GROK_BUILD}
case "$x_account_provider" in
  GROK_BUILD | TIKHUB) ;;
  *)
    echo 'briefing rollout refused: CONTENT_X_ACCOUNT_PROVIDER must be GROK_BUILD or TIKHUB' >&2
    exit 1
    ;;
esac
tikhub_ready=false
if [[ "$x_account_provider" == TIKHUB ]] && nonempty_setting TIKHUB_API_KEY; then
  tikhub_ready=true
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
      if [[ "$x_account_provider" == TIKHUB && "$tikhub_ready" != true ]]; then
        echo 'briefing rollout refused: TikHub X provider requires TIKHUB_API_KEY' >&2
        exit 1
      fi
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
  managed_env_assert_temp_metadata "$temporary_file" \
    'briefing rollout refused: replacement file'

  if cmp -s "$env_file" "$temporary_file"; then
    rm -f -- "$temporary_file"
  else
    managed_env_atomic_replace \
      "$temporary_file" \
      "$env_file" \
      'briefing rollout refused: env file'
    changed=true
  fi
  temporary_file=''
  trap - EXIT
fi

printf '{"event":"briefing_acquisition_config","mode":"%s","changed":%s,"pipeline":%s,"shadow":%s,"x":%s,"xBackstop":%s,"xAccountProvider":"%s","tikhubReady":%s,"http":%s,"podcast":%s,"youtubeDiscovery":%s,"youtubeNative":%s,"youtubeGenerated":%s,"publication":%s,"public":%s,"hermesReady":%s,"youtubeNativeReady":%s,"secretValueExposed":false}\n' \
  "$mode" \
  "$changed" \
  "$(boolean_setting CONTENT_PIPELINE_ENABLED)" \
  "$(boolean_setting CONTENT_ACQUISITION_SHADOW_MODE)" \
  "$(boolean_setting CONTENT_X_SCAN_ENABLED)" \
  "$(boolean_setting CONTENT_X_BACKSTOP_ENABLED)" \
  "$x_account_provider" \
  "$tikhub_ready" \
  "$(boolean_setting CONTENT_HTTP_ACQUISITION_ENABLED)" \
  "$(boolean_setting CONTENT_PODCAST_TRANSCRIPT_ENABLED)" \
  "$(boolean_setting CONTENT_YOUTUBE_DISCOVERY_ENABLED)" \
  "$(boolean_setting CONTENT_YOUTUBE_NATIVE_ENABLED)" \
  "$(boolean_setting CONTENT_YOUTUBE_GENERATED_ENABLED)" \
  "$(boolean_setting CONTENT_PUBLICATION_ENABLED)" \
  "$(boolean_setting BRIEFING_PUBLIC_ENABLED)" \
  "$hermes_ready" \
  "$youtube_native_ready"
