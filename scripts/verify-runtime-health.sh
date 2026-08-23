#!/usr/bin/env bash

set -euo pipefail

compose_bin=${COMPOSE_BIN:-docker compose}
compose_file=${COMPOSE_FILE:-docker-compose.yml}
project_dir=${PROJECT_DIR:-$(pwd)}
api_url=${API_HEALTH_URL:-http://127.0.0.1:3000}
attempts=${HEALTH_ATTEMPTS:-30}
delay_seconds=${HEALTH_DELAY_SECONDS:-2}
curl_timeout_seconds=${HEALTH_CURL_TIMEOUT_SECONDS:-5}

IFS=' ' read -r -a compose_cmd <<<"$compose_bin"
compose() { (cd "$project_dir" && "${compose_cmd[@]}" -f "$compose_file" "$@"); }

for attempt in $(seq 1 "$attempts"); do
  if curl --fail --silent --show-error --max-time "$curl_timeout_seconds" \
    "$api_url/health" >/dev/null \
    && curl --fail --silent --show-error --max-time "$curl_timeout_seconds" \
      "$api_url/ready" >/dev/null; then
    break
  fi
  if [ "$attempt" -eq "$attempts" ]; then
    compose ps
    compose logs --tail 100 api || true
    exit 1
  fi
  sleep "$delay_seconds"
done

for service in scheduler worker content-worker media-worker; do
  container=$(compose ps -q "$service" | head -n 1)
  test -n "$container"
  for attempt in $(seq 1 "$attempts"); do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")
    if [ "$status" = healthy ]; then
      break
    fi
    if [ "$attempt" -eq "$attempts" ]; then
      compose ps
      compose logs --tail 100 "$service" || true
      exit 1
    fi
    sleep "$delay_seconds"
  done
done

compose ps
printf '%s\n' '{"event":"runtime_health","outcome":"passed"}'
