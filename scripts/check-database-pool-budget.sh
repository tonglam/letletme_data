#!/usr/bin/env bash

set -euo pipefail

# Render the same Compose file used by deployment and verify that every
# long-lived service has an explicit pool ceiling.  The default 15-session
# Supavisor budget leaves 20% for migrations, probes and administrative
# connections; operators can override it for a project with a different
# documented budget.
compose_bin=${COMPOSE_BIN:-docker compose}
compose_file=${COMPOSE_FILE:-docker-compose.yml}
project_dir=${PROJECT_DIR:-$(pwd)}
connection_budget=${DATABASE_CONNECTION_BUDGET:-15}

if ! [[ "$connection_budget" =~ ^[0-9]+$ ]] || [ "$connection_budget" -lt 1 ]; then
  echo 'DATABASE_CONNECTION_BUDGET must be a positive integer' >&2
  exit 1
fi

IFS=' ' read -r -a compose_cmd <<<"$compose_bin"
compose() { (cd "$project_dir" && "${compose_cmd[@]}" -f "$compose_file" "$@"); }

config=$(compose config)
required_services=(api worker scheduler content-worker live-picks-worker official-h2h-worker)
services=$(compose config --services)
for service in "${required_services[@]}"; do
  if ! grep -Fxq "$service" <<<"$services"; then
    echo "Compose runtime inventory is missing required service: $service" >&2
    exit 1
  fi
done

pool_sum=$(awk '
  /^  [A-Za-z0-9_-]+:$/ {
    service=$1
    sub(/:$/, "", service)
    next
  }
  /^[[:space:]]+DATABASE_POOL_MAX:/ {
    value=$2
    gsub(/"/, "", value)
    if (value ~ /^[0-9]+$/) sum += value
  }
  END { print sum + 0 }
' <<<"$config")

allowed=$((connection_budget * 80 / 100))
if [ "$pool_sum" -gt "$allowed" ]; then
  echo "Compose database pool ceiling ${pool_sum} exceeds 80% budget ${allowed} (budget=${connection_budget})" >&2
  exit 1
fi

printf '%s\n' "{\"event\":\"database_pool_budget\",\"poolMax\":${pool_sum},\"allowed\":${allowed},\"budget\":${connection_budget},\"outcome\":\"passed\"}"
