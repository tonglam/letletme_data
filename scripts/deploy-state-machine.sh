#!/usr/bin/env bash
# Shared fail-closed deployment primitives.  Source this file from the local
# helper and the VPS workflow so recovery semantics cannot drift.

# Shared with the GraphQL VPS deploy workflow.  Data listens on 3000 and
# GraphQL on 4000, but both compose projects touch the same host resources.
deploy_lock_path=${DEPLOY_LOCK_PATH:-/var/lock/letletme-platform-deploy.lock}
deploy_lock_fd=''

acquire_deploy_lock() {
  mkdir -p "$(dirname "$deploy_lock_path")"
  exec {deploy_lock_fd}>"$deploy_lock_path"
  if ! flock -n "$deploy_lock_fd"; then
    echo "deploy lock is already held: $deploy_lock_path" >&2
    return 1
  fi
  echo "deploy lock acquired: $deploy_lock_path"
}

release_deploy_lock() {
  if [[ -n "$deploy_lock_fd" ]]; then
    flock -u "$deploy_lock_fd" || true
    exec {deploy_lock_fd}>&- || true
    deploy_lock_fd=''
  fi
}

port_3000_owner() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp '( sport = :3000 )' 2>/dev/null || true
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:3000 -sTCP:LISTEN 2>/dev/null || true
  fi
}

assert_port_3000_free() {
  if port_3000_owner | grep -q ':3000'; then
    echo 'deploy preflight: port 3000 is owned by an unknown listener; refusing to kill it' >&2
    port_3000_owner >&2
    return 1
  fi
}

remove_exact_stopped_container() {
  local container_id state
  container_id=$(compose ps -aq "$1" | head -n 1)
  [[ -z "$container_id" ]] && return 0
  state=$(docker inspect --format '{{.State.Status}}' "$container_id")
  case "$state" in
    created|exited|dead)
      echo "removing exact stopped $1 container $container_id (state=$state)"
      docker rm "$container_id" >/dev/null
      ;;
    running|restarting|paused)
      ;;
    *)
      echo "unknown $1 container state=$state id=$container_id; refusing cleanup" >&2
      return 1
      ;;
  esac
}

wait_for_port_3000_free() {
  local attempts=${1:-30}
  local delay=${2:-2}
  for attempt in $(seq 1 "$attempts"); do
    if ! port_3000_owner | grep -q ':3000'; then return 0; fi
    echo "waiting for expected API listener to release 3000 (attempt $attempt/$attempts)"
    sleep "$delay"
  done
  assert_port_3000_free
}

migration_ledger_fingerprint() {
  # --plan is read-only and emits a JSON ledger fingerprint.  Keep parsing
  # deliberately dependency-light for VPS images that do not ship jq.
  local plan_output
  plan_output=$(compose run --rm -T migration bun scripts/apply-sql-migrations.ts --plan)
  printf '%s\n' "$plan_output" | awk -F'"' '/"ledgerFingerprint"[[:space:]]*:/ { print $4; exit }'
}

restore_last_known_healthy_if_ledger_unchanged() {
  local previous_image=${1:-}
  local ledger_before=${2:-}
  local previous_revision=${3:-}
  local ledger_after
  [[ -n "$previous_image" && -n "$ledger_before" ]] || return 1
  ledger_after=$(migration_ledger_fingerprint 2>/dev/null || true)
  if [[ -n "$ledger_after" && "$ledger_after" = "$ledger_before" ]]; then
    echo 'migration failed without changing the ledger; restoring last-known-healthy release' >&2
    if [[ -n "$previous_revision" ]]; then
      git reset --hard "$previous_revision"
    fi
    APP_IMAGE="$previous_image" compose up -d --remove-orphans --no-build scheduler worker content-worker api
    return 0
  fi
  echo 'migration ledger changed or could not be proven unchanged; forward-only recovery required' >&2
  return 1
}

run_migration_plan() {
  compose run --rm -T migration bun scripts/apply-sql-migrations.ts --plan
}

start_runtime_services() {
  # Scheduler and workers have no host port and must be healthy before API
  # startup.  An API bind failure may be retried once, but never tears down a
  # healthy worker that is already processing queued work.
  compose up -d --remove-orphans --no-build scheduler worker content-worker
  compose up -d --remove-orphans --no-build api || {
    echo 'API start failed; preserving scheduler/worker/content-worker for recovery' >&2
    port_3000_owner >&2
    assert_port_3000_free
    remove_exact_stopped_container api
    wait_for_port_3000_free 30 2
    compose up -d --remove-orphans --no-build api
  }
}
