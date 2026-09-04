#!/usr/bin/env bash

set -euo pipefail

compose_bin=${COMPOSE_BIN:-docker compose}
compose_file=${COMPOSE_FILE:-docker-compose.yml}
project_dir=${PROJECT_DIR:-$(pwd)}
api_url=${API_HEALTH_URL:-http://127.0.0.1:3000}
expected_deploy_sha=${EXPECTED_DEPLOY_SHA:-}
# A cold restart after migrations can take longer than the container health
# start period while Redis, the queue worker, and the content worker rebuild
# their connections.  Keep bounded per-check attempts for diagnostics, but
# share one elapsed deadline across API and service checks so the verifier
# cannot consume the deploy action's recovery budget in nested retry loops.
attempts=${HEALTH_ATTEMPTS:-90}
delay_seconds=${HEALTH_DELAY_SECONDS:-2}
curl_timeout_seconds=${HEALTH_CURL_TIMEOUT_SECONDS:-5}
deadline_seconds=${HEALTH_DEADLINE_SECONDS:-300}

deadline_at=$((SECONDS + deadline_seconds))

if [ -n "$expected_deploy_sha" ] && ! [[ "$expected_deploy_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "runtime health: EXPECTED_DEPLOY_SHA must be a 40-character lowercase git SHA" >&2
  exit 2
fi

api_payload_file=/dev/null
if [ -n "$expected_deploy_sha" ]; then
  api_payload_file=$(mktemp "${TMPDIR:-/tmp}/letletme-data-health.XXXXXX")
  cleanup_health_payload() { rm -f -- "$api_payload_file"; }
  trap cleanup_health_payload EXIT
fi

deadline_reached() {
  [ "$SECONDS" -ge "$deadline_at" ]
}

sleep_with_deadline() {
  local remaining=$((deadline_at - SECONDS))
  if [ "$remaining" -le 0 ]; then
    return 1
  fi
  sleep "$((remaining < delay_seconds ? remaining : delay_seconds))"
}

curl_timeout_with_deadline() {
  local remaining=$((deadline_at - SECONDS))
  if [ "$remaining" -le 0 ]; then
    return 1
  fi
  printf '%s\n' "$((remaining < curl_timeout_seconds ? remaining : curl_timeout_seconds))"
}

IFS=' ' read -r -a compose_cmd <<<"$compose_bin"
compose() { (cd "$project_dir" && "${compose_cmd[@]}" -f "$compose_file" "$@"); }

api_ready=false
for attempt in $(seq 1 "$attempts"); do
  timeout=$(curl_timeout_with_deadline) || break
  if curl --fail --silent --show-error --max-time "$timeout" \
    "$api_url/health/live" >/dev/null \
    && timeout=$(curl_timeout_with_deadline) \
    && curl --fail --silent --show-error --max-time "$timeout" \
      "$api_url/health/deploy" >"$api_payload_file"; then
    if [ -z "$expected_deploy_sha" ]; then
      api_ready=true
      break
    fi
    payload=$(tr -d '[:space:]' < "$api_payload_file")
    if printf '%s' "$payload" | grep -Fq '"status":"deploy_ready"' && \
      printf '%s' "$payload" | grep -Fq "\"deploySha\":\"$expected_deploy_sha\""; then
      api_ready=true
      break
    fi
    echo "runtime health: /health/deploy identity mismatch (expected=$expected_deploy_sha)" >&2
  fi
  if [ "$attempt" -lt "$attempts" ] && sleep_with_deadline; then
    continue
  fi
done

if [ "$api_ready" != true ]; then
  compose ps
  compose logs --tail 100 api || true
  exit 1
fi

for service in scheduler worker content-worker live-picks-worker official-h2h-worker media-worker; do
  container=$(compose ps -q "$service" | head -n 1)
  test -n "$container"
  service_ready=false
  for attempt in $(seq 1 "$attempts"); do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")
    if [ "$status" = healthy ]; then
      service_ready=true
      break
    fi
    if [ "$attempt" -lt "$attempts" ] && sleep_with_deadline; then
      continue
    fi
  done
  if [ "$service_ready" != true ]; then
    compose ps
    compose logs --tail 100 "$service" || true
    exit 1
  fi
done

compose ps
printf '%s\n' '{"event":"runtime_health","outcome":"passed"}'
