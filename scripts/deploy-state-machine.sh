#!/usr/bin/env bash
# Shared fail-closed deployment primitives.  Source this file from the local
# helper and the VPS workflow so recovery semantics cannot drift.

# Shared with the GraphQL VPS deploy workflow.  Data listens on 3000 and
# GraphQL on 4000, but both compose projects touch the same host resources.
deploy_lock_path=${DEPLOY_LOCK_PATH:-/var/lock/letletme-platform-deploy.lock}
deploy_lock_fd=''
CONTENT_WORKER_CONSUMER_QUEUE_NAMES=(
  content-x-scan
  content-http-acquisition
  content-media-transcript
)
DEPLOY_CONTENT_WORKER_ADMISSION_ATTEMPTED_QUEUES=${DEPLOY_CONTENT_WORKER_ADMISSION_ATTEMPTED_QUEUES:-}
DEPLOY_CONTENT_WORKER_ADMISSION_OWNED_QUEUES=${DEPLOY_CONTENT_WORKER_ADMISSION_OWNED_QUEUES:-}
DEPLOY_CONTENT_WORKER_CONSUMER_PAUSE_ATTEMPTED=${DEPLOY_CONTENT_WORKER_CONSUMER_PAUSE_ATTEMPTED:-false}
DEPLOY_CONTENT_WORKER_PAUSED_QUEUES=${DEPLOY_CONTENT_WORKER_PAUSED_QUEUES:-}
DEPLOY_CONTENT_WORKER_OWNED_PAUSED_QUEUES=${DEPLOY_CONTENT_WORKER_OWNED_PAUSED_QUEUES:-}
DEPLOY_CONTENT_WORKER_PAUSE_OWNER_TOKEN=${DEPLOY_CONTENT_WORKER_PAUSE_OWNER_TOKEN:-}
DEPLOY_CONTENT_WORKER_CONSUMER_CONTROL_TIMEOUT_SECONDS=${DEPLOY_CONTENT_WORKER_CONSUMER_CONTROL_TIMEOUT_SECONDS:-10}
DEPLOY_CONTENT_WORKER_ADMISSION_CONTROL_TIMEOUT_SECONDS=${DEPLOY_CONTENT_WORKER_ADMISSION_CONTROL_TIMEOUT_SECONDS:-10}
# The Redis pause-owner marker expires after one hour.  Refresh well inside
# that window so backup, migration, seed, and recovery stages can be longer
# than the original control operation without losing release ownership.
DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_INTERVAL_SECONDS=${DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_INTERVAL_SECONDS:-300}
DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PID=${DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PID:-}
DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PARENT_PID=${DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PARENT_PID:-}
DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PREVIOUS_TERM_TRAP=${DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PREVIOUS_TERM_TRAP:-}
DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_TERM_TRAP_ACTIVE=${DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_TERM_TRAP_ACTIVE:-false}
DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_FAILURE_FILE=${DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_FAILURE_FILE:-}
DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_STAGE_PID=${DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_STAGE_PID:-}
DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_GUARD_ACTIVE=${DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_GUARD_ACTIVE:-false}
DEPLOY_CONTENT_WORKER_CONTROL_IMAGE=${DEPLOY_CONTENT_WORKER_CONTROL_IMAGE:-}
DEPLOY_CONTENT_WORKER_CONTROL_IMAGE_TEMP_TAG=${DEPLOY_CONTENT_WORKER_CONTROL_IMAGE_TEMP_TAG:-}

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

compose_project_name_for_cleanup() {
  local compose_config project
  # Ask the same Compose invocation used by the deployment for its resolved
  # project name.  Directory basenames and COMPOSE_PROJECT_NAME do not account
  # for an explicit `-p/--project-name` in COMPOSE_BIN.
  if ! compose_config=$(compose config --format json 2>/dev/null); then
    echo 'deploy preflight: could not resolve Compose configuration for API run cleanup' >&2
    return 1
  fi
  if [[ ! "$compose_config" =~ \"name\"[[:space:]]*:[[:space:]]*\"([a-z0-9][a-z0-9_-]*)\" ]]; then
    echo 'deploy preflight: could not resolve a safe Compose project name for API run cleanup' >&2
    return 1
  fi
  project=${BASH_REMATCH[1]}
  printf '%s\n' "$project"
}

remove_stale_api_run_containers() {
  local project container_id service oneoff state host_port container_name
  project=$(compose_project_name_for_cleanup)
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    service=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container_id" 2>/dev/null || true)
    oneoff=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.oneoff"}}' "$container_id" 2>/dev/null || true)
    [[ "$service" = api && "$oneoff" = True ]] || continue
    container_name=$(docker inspect --format '{{.Name}}' "$container_id" 2>/dev/null || printf '%s' "$container_id")
    host_port=$(docker inspect --format '{{range $port, $bindings := .HostConfig.PortBindings}}{{if eq $port "3000/tcp"}}{{range $binding := $bindings}}{{printf "%s\n" $binding.HostPort}}{{end}}{{end}}{{end}}' "$container_id" 2>/dev/null || true)
    [[ "$host_port" = 3000 ]] || continue
    state=$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)
    case "$state" in
      created|exited|dead)
        echo "removing exact stale API one-off $container_name $container_id (state=$state, host_port=3000)"
        docker rm "$container_id" >/dev/null
        ;;
      running|restarting|paused)
        # A `docker compose run --service-ports api ...` operation can be
        # legitimately active while its overridden command fails the API
        # healthcheck.  Health is not evidence that an operator-run one-off is
        # stale; never stop or remove a live process during deploy recovery.
        echo "deploy preflight: refusing to remove API one-off $container_name $container_id (state=$state, host_port=3000)" >&2
        return 1
        ;;
      *)
        echo "deploy preflight: unknown API one-off state=$state id=$container_id; refusing cleanup" >&2
        return 1
        ;;
    esac
  done < <(docker ps -aq \
    --filter "label=com.docker.compose.project=$project" \
    --filter 'label=com.docker.compose.service=api' 2>/dev/null || true)
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

set_content_worker_queue_admission() {
  local queue_name=${1:-}
  local mode=${2:-}
  local output_file output
  if [[ "$queue_name" != content-x-scan && "$queue_name" != content-http-acquisition &&
    "$queue_name" != content-media-transcript ]]; then
    echo "deploy preflight: invalid content worker admission queue=$queue_name" >&2
    return 1
  fi
  if [[ "$mode" != DRAIN_ONLY && "$mode" != OPEN ]]; then
    echo "deploy preflight: invalid content worker admission mode=$mode" >&2
    return 1
  fi
  output_file=$(mktemp "${TMPDIR:-/tmp}/letletme-data-admission-control.XXXXXX")
  if ! run_bounded_deploy_probe \
    "$output_file" "$DEPLOY_CONTENT_WORKER_ADMISSION_CONTROL_TIMEOUT_SECONDS" \
    admission "$queue_name" "$mode"; then
    cat "$output_file" >&2 || true
    rm -f "$output_file"
    return 1
  fi
  output=$(cat "$output_file")
  rm -f "$output_file"
  printf '%s\n' "$output"
  if ! printf '%s\n' "$output" | grep -F '"contractVersion":"queue-admission-v2"' >/dev/null ||
    ! printf '%s\n' "$output" | grep -F '"queueName":"'"$queue_name"'"' >/dev/null ||
    ! printf '%s\n' "$output" | grep -F '"mode":"'"$mode"'"' >/dev/null; then
    echo "deploy preflight: $queue_name admission result did not match the requested queue/mode" >&2
    return 1
  fi
}

content_worker_admission_queue_is_listed() {
  local queue_name=${1:-}
  local queue_list=${2:-}
  [[ " $queue_list " == *" $queue_name "* ]]
}

append_content_worker_admission_queue() {
  local queue_name=${1:-}
  if ! content_worker_admission_queue_is_listed "$queue_name" \
    "$DEPLOY_CONTENT_WORKER_ADMISSION_ATTEMPTED_QUEUES"; then
    DEPLOY_CONTENT_WORKER_ADMISSION_ATTEMPTED_QUEUES="${DEPLOY_CONTENT_WORKER_ADMISSION_ATTEMPTED_QUEUES:+$DEPLOY_CONTENT_WORKER_ADMISSION_ATTEMPTED_QUEUES }$queue_name"
  fi
}

append_content_worker_admission_owned_queue() {
  local queue_name=${1:-}
  if ! content_worker_admission_queue_is_listed "$queue_name" \
    "$DEPLOY_CONTENT_WORKER_ADMISSION_OWNED_QUEUES"; then
    DEPLOY_CONTENT_WORKER_ADMISSION_OWNED_QUEUES="${DEPLOY_CONTENT_WORKER_ADMISSION_OWNED_QUEUES:+$DEPLOY_CONTENT_WORKER_ADMISSION_OWNED_QUEUES }$queue_name"
  fi
}

remove_content_worker_admission_queue() {
  local queue_name=${1:-}
  local remaining=()
  local item
  for item in $DEPLOY_CONTENT_WORKER_ADMISSION_ATTEMPTED_QUEUES; do
    [[ "$item" = "$queue_name" ]] || remaining+=("$item")
  done
  DEPLOY_CONTENT_WORKER_ADMISSION_ATTEMPTED_QUEUES="${remaining[*]:-}"
  remaining=()
  for item in $DEPLOY_CONTENT_WORKER_ADMISSION_OWNED_QUEUES; do
    [[ "$item" = "$queue_name" ]] || remaining+=("$item")
  done
  DEPLOY_CONTENT_WORKER_ADMISSION_OWNED_QUEUES="${remaining[*]:-}"
}

drain_content_worker_queue_for_deploy() {
  local queue_name=${1:-}
  if content_worker_admission_queue_is_listed "$queue_name" \
    "$DEPLOY_CONTENT_WORKER_ADMISSION_ATTEMPTED_QUEUES"; then return 0; fi
  # Mark the attempt before Redis is touched.  The EXIT handler can then
  # safely ask the command to restore only a gate owned by this deployment,
  # even if the one-shot command dies after changing Redis but before it
  # prints its result.
  append_content_worker_admission_queue "$queue_name"
  local output
  if ! output=$(set_content_worker_queue_admission "$queue_name" DRAIN_ONLY); then
    printf '%s\n' "$output" >&2
    return 1
  fi
  printf '%s\n' "$output"
  if printf '%s\n' "$output" | grep -F '"changed":true' >/dev/null; then
    append_content_worker_admission_owned_queue "$queue_name"
    echo "deploy preflight: $queue_name admission is drain-only; waiting for active work to finish"
  elif printf '%s\n' "$output" | grep -F '"changed":false' >/dev/null; then
    echo "deploy preflight: $queue_name was already drain-only; preserving its existing operator gate"
  else
    echo "deploy preflight: $queue_name admission result was not machine-readable" >&2
    return 1
  fi
}

drain_content_worker_queues_for_deploy() {
  local queue_name
  for queue_name in "${CONTENT_WORKER_CONSUMER_QUEUE_NAMES[@]}"; do
    drain_content_worker_queue_for_deploy "$queue_name" || return 1
  done
}

prepare_content_worker_paused_runs_for_deploy() {
  # Use the runtime-configured API service so the short lease transition sees
  # the same Queue Redis endpoint as the pause probes.  The migration service
  # intentionally receives only the migration database credentials.
  APP_IMAGE="${APP_IMAGE:-}" compose run --rm -T --interactive=false api \
    bun scripts/assert-queue-quiescence.ts --prepare-paused-content-runs
}

renew_content_worker_queue_admission() {
  local queue_name=${1:-}
  if ! content_worker_admission_queue_is_listed "$queue_name" \
    "$DEPLOY_CONTENT_WORKER_ADMISSION_OWNED_QUEUES"; then return 0; fi
  local output
  if ! output=$(set_content_worker_queue_admission "$queue_name" DRAIN_ONLY); then
    printf '%s\n' "$output" >&2
    echo "deploy admission: failed to renew $queue_name drain-only gate" >&2
    return 1
  fi
  printf '%s\n' "$output"
  if printf '%s\n' "$output" | grep -F '"changed":true' >/dev/null; then
    echo "deploy admission: $queue_name drain-only gate renewed"
  elif printf '%s\n' "$output" | grep -F '"changed":false' >/dev/null; then
    remove_content_worker_admission_queue "$queue_name"
    echo "deploy admission: external $queue_name drain-only gate remains in force"
  else
    echo "deploy admission: $queue_name renewal result was not machine-readable" >&2
    return 1
  fi
}

renew_content_worker_admission() {
  local queue_name
  for queue_name in $DEPLOY_CONTENT_WORKER_ADMISSION_OWNED_QUEUES; do
    renew_content_worker_queue_admission "$queue_name" || return 1
  done
}

restore_content_worker_queue_admission() {
  local queue_name=${1:-}
  if ! content_worker_admission_queue_is_listed "$queue_name" \
    "$DEPLOY_CONTENT_WORKER_ADMISSION_ATTEMPTED_QUEUES"; then
    remove_content_worker_admission_queue "$queue_name"
    return 0
  fi
  local output
  if ! output=$(set_content_worker_queue_admission "$queue_name" OPEN); then
    printf '%s\n' "$output" >&2
    echo "deploy admission: failed to restore $queue_name admission; its bounded gate remains in force" >&2
    return 1
  fi
  printf '%s\n' "$output"
  if printf '%s\n' "$output" | grep -F '"changed":false' >/dev/null; then
    remove_content_worker_admission_queue "$queue_name"
    echo "deploy admission: preserved an externally-owned $queue_name drain-only gate"
    return 0
  fi
  if ! printf '%s\n' "$output" | grep -F '"changed":true' >/dev/null; then
    echo "deploy admission: $queue_name restore result was not machine-readable; leaving the gate state tracked" >&2
    return 1
  fi
  remove_content_worker_admission_queue "$queue_name"
  echo "deploy admission: $queue_name admission restored"
}

content_worker_queue_is_listed() {
  local queue_name=${1:-}
  local queue_list=${2:-}
  [[ " $queue_list " == *" $queue_name "* ]]
}

ensure_content_worker_pause_owner_token() {
  if [[ -n "$DEPLOY_CONTENT_WORKER_PAUSE_OWNER_TOKEN" ]]; then return 0; fi
  local token=''
  if command -v uuidgen >/dev/null 2>&1; then
    token=$(uuidgen | tr -d '[:space:]-' || true)
  fi
  if [[ -z "$token" ]] && command -v openssl >/dev/null 2>&1; then
    token=$(openssl rand -hex 16)
  fi
  if [[ -z "$token" ]]; then
    token="${DEPLOY_SHA:-unknown}-$$-$(date +%s)"
  fi
  [[ -n "$token" ]] || return 1
  DEPLOY_CONTENT_WORKER_PAUSE_OWNER_TOKEN="deployment-$token"
}

append_content_worker_paused_queue() {
  local queue_name=${1:-}
  if ! content_worker_queue_is_listed "$queue_name" "$DEPLOY_CONTENT_WORKER_PAUSED_QUEUES"; then
    DEPLOY_CONTENT_WORKER_PAUSED_QUEUES="${DEPLOY_CONTENT_WORKER_PAUSED_QUEUES:+$DEPLOY_CONTENT_WORKER_PAUSED_QUEUES }$queue_name"
  fi
}

append_content_worker_owned_queue() {
  local queue_name=${1:-}
  if ! content_worker_queue_is_listed "$queue_name" "$DEPLOY_CONTENT_WORKER_OWNED_PAUSED_QUEUES"; then
    DEPLOY_CONTENT_WORKER_OWNED_PAUSED_QUEUES="${DEPLOY_CONTENT_WORKER_OWNED_PAUSED_QUEUES:+$DEPLOY_CONTENT_WORKER_OWNED_PAUSED_QUEUES }$queue_name"
  fi
}

reconcile_failed_content_worker_pause() {
  local queue_name=${1:-}
  local status_output
  if ! status_output=$(set_content_worker_consumer_mode STATUS "$queue_name"); then
    return 1
  fi
  if printf '%s\n' "$status_output" | grep -F '"owned":true' >/dev/null; then
    append_content_worker_owned_queue "$queue_name"
  fi
  if printf '%s\n' "$status_output" | grep -F '"paused":true' >/dev/null; then
    append_content_worker_paused_queue "$queue_name"
  fi
  return 0
}

renew_content_worker_pause_ownership() {
  local queue_name output
  local renewal_failed=false
  for queue_name in $DEPLOY_CONTENT_WORKER_OWNED_PAUSED_QUEUES; do
    if ! output=$(set_content_worker_consumer_mode STATUS "$queue_name"); then
      printf '%s\n' "$output" >&2
      echo "deploy admission: failed to renew the $queue_name consumer pause ownership" >&2
      renewal_failed=true
      continue
    fi
    if ! printf '%s\n' "$output" | grep -F '"paused":true' >/dev/null ||
      ! printf '%s\n' "$output" | grep -F '"owned":true' >/dev/null; then
      printf '%s\n' "$output" >&2
      echo "deploy admission: $queue_name consumer pause ownership is no longer confirmed" >&2
      renewal_failed=true
    fi
  done
  if ! renew_content_worker_admission; then
    renewal_failed=true
  fi
  if [[ "$renewal_failed" = true ]]; then return 1; fi
  return 0
}

content_worker_pause_renewal_term_handler() {
  local stage_pid=${DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_STAGE_PID:-}
  local failure_file=${DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_FAILURE_FILE:-}
  local renewal_failed=false
  if [[ -s "$failure_file" ]]; then renewal_failed=true; fi
  DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_STAGE_PID=''
  if [[ -n "$stage_pid" ]]; then
    terminate_scoped_queue_probe "$stage_pid" '' 2 true || true
  fi
  # The renewal child is still alive when it signals this shell. Stop it
  # explicitly before exiting; otherwise it can continue issuing probes after
  # the deployment shell has left and may outlive the deployment lock.
  stop_content_worker_pause_renewal
  if [[ "$renewal_failed" = true ]]; then exit 1; fi
  exit 143
}

start_content_worker_pause_renewal() {
  if [[ -n "$DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PID" ]]; then return 0; fi
  if [[ -z "$DEPLOY_CONTENT_WORKER_OWNED_PAUSED_QUEUES" &&
    -z "$DEPLOY_CONTENT_WORKER_ADMISSION_OWNED_QUEUES" ]]; then return 0; fi
  if ! [[ "$DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]] ||
    (( DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_INTERVAL_SECONDS > 300 )); then
    # Admission records live for 900 seconds.  Keep a 600-second margin for
    # the bounded consumer-status and admission-renewal probes themselves.
    echo 'deploy admission: pause ownership renewal interval must be a positive value no greater than 5 minutes' >&2
    return 1
  fi
  if [[ "$DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_TERM_TRAP_ACTIVE" != true ]]; then
    DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PREVIOUS_TERM_TRAP=$(trap -p TERM || true)
    trap 'content_worker_pause_renewal_term_handler' TERM
    DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_TERM_TRAP_ACTIVE=true
  fi
  local failure_file
  failure_file=$(mktemp "${TMPDIR:-/tmp}/letletme-data-pause-renewal.XXXXXX")
  DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_FAILURE_FILE=$failure_file
  DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PARENT_PID=$$
  (
    renewal_stop_requested=false
    trap 'renewal_stop_requested=true; exit 0' TERM INT
    trap 'if [[ "$renewal_stop_requested" != true ]]; then
      printf "%s\\n" pause-renewal-failed >"$DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_FAILURE_FILE"
      kill -TERM "$DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PARENT_PID" 2>/dev/null || true
    fi' EXIT
    while :; do
      if ! sleep "$DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_INTERVAL_SECONDS"; then
        [[ "$renewal_stop_requested" = true ]] && exit 0
        exit 1
      fi
      renew_content_worker_pause_ownership || exit 1
    done
  ) &
  DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PID=$!
  if ! kill -0 "$DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PID" 2>/dev/null; then
    DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PID=''
    rm -f "$failure_file"
    DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_FAILURE_FILE=''
    echo 'deploy admission: could not start pause ownership renewal' >&2
    return 1
  fi
  return 0
}

stop_content_worker_pause_renewal() {
  local renewal_pid=$DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PID
  local failure_file=$DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_FAILURE_FILE
  DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PID=''
  if [[ -n "$renewal_pid" ]]; then
    terminate_scoped_queue_probe "$renewal_pid" '' 2 true
  fi
  if [[ -n "$failure_file" ]]; then rm -f "$failure_file"; fi
  DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_FAILURE_FILE=''
  DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_STAGE_PID=''
  if [[ "$DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_TERM_TRAP_ACTIVE" = true ]]; then
    if [[ -n "$DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PREVIOUS_TERM_TRAP" ]]; then
      eval "$DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PREVIOUS_TERM_TRAP"
    else
      trap - TERM
    fi
    DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PREVIOUS_TERM_TRAP=''
    DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_TERM_TRAP_ACTIVE=false
  fi
  DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PARENT_PID=''
  return 0
}

remove_content_worker_owned_queue() {
  local queue_name=${1:-}
  local remaining=()
  local item
  for item in $DEPLOY_CONTENT_WORKER_OWNED_PAUSED_QUEUES; do
    [[ "$item" = "$queue_name" ]] || remaining+=("$item")
  done
  DEPLOY_CONTENT_WORKER_OWNED_PAUSED_QUEUES="${remaining[*]:-}"
}

set_content_worker_consumer_mode() {
  local mode=${1:-}
  local queue_name=${2:-}
  local output_file output
  ensure_content_worker_pause_owner_token
  if [[ "$mode" != STATUS && "$mode" != PAUSE && "$mode" != RESUME ]]; then
    echo "deploy preflight: invalid content worker consumer mode=$mode" >&2
    return 1
  fi
  if ! content_worker_queue_is_listed "$queue_name" "${CONTENT_WORKER_CONSUMER_QUEUE_NAMES[*]}"; then
    echo "deploy preflight: invalid content worker consumer queue=$queue_name" >&2
    return 1
  fi
  output_file=$(mktemp "${TMPDIR:-/tmp}/letletme-data-consumer-control.XXXXXX")
  if ! run_bounded_deploy_probe \
    "$output_file" "$DEPLOY_CONTENT_WORKER_CONSUMER_CONTROL_TIMEOUT_SECONDS" \
    consumer "$queue_name" "$mode"; then
    cat "$output_file" >&2 || true
    rm -f "$output_file"
    return 1
  fi
  output=$(cat "$output_file")
  rm -f "$output_file"
  printf '%s\n' "$output"
  if ! printf '%s\n' "$output" | grep -F '"contractVersion":"content-worker-consumer-v1"' >/dev/null ||
    ! printf '%s\n' "$output" | grep -F '"queueName":"'"$queue_name"'"' >/dev/null; then
    echo 'deploy preflight: content worker consumer result was not machine-readable' >&2
    return 1
  fi
}

pause_content_worker_consumers_for_deploy() {
  if [[ "$DEPLOY_CONTENT_WORKER_CONSUMER_PAUSE_ATTEMPTED" = true ]]; then return 0; fi
  DEPLOY_CONTENT_WORKER_CONSUMER_PAUSE_ATTEMPTED=true
  ensure_content_worker_pause_owner_token

  local queue_name status_output output
  for queue_name in "${CONTENT_WORKER_CONSUMER_QUEUE_NAMES[@]}"; do
    if ! status_output=$(set_content_worker_consumer_mode STATUS "$queue_name"); then
      printf '%s\n' "$status_output" >&2
      return 1
    fi
    if printf '%s\n' "$status_output" | grep -F '"paused":true' >/dev/null; then
      append_content_worker_paused_queue "$queue_name"
      if printf '%s\n' "$status_output" | grep -F '"owned":true' >/dev/null; then
        append_content_worker_owned_queue "$queue_name"
      fi
      continue
    fi
    if ! printf '%s\n' "$status_output" | grep -F '"paused":false' >/dev/null; then
      echo "deploy preflight: $queue_name consumer status was not machine-readable" >&2
      return 1
    fi

    if ! output=$(set_content_worker_consumer_mode PAUSE "$queue_name"); then
      printf '%s\n' "$output" >&2
      if reconcile_failed_content_worker_pause "$queue_name"; then
        echo "deploy preflight: reconciled $queue_name consumer pause after control failure"
      fi
      return 1
    fi
    if ! printf '%s\n' "$output" | grep -F '"paused":true' >/dev/null; then
      echo "deploy preflight: $queue_name consumer did not remain paused" >&2
      return 1
    fi
    append_content_worker_paused_queue "$queue_name"
    # The mutating command establishes ownership from its own
    # previousPaused/changed result. If an operator paused the queue after
    # STATUS but before PAUSE, changed=false and the deployment must not resume
    # that operator-owned pause during cleanup. A failed mutating command is
    # reconciled through bounded STATUS above so a pause marker created before
    # the failure remains recoverable by the EXIT cleanup.
    if printf '%s\n' "$output" | grep -F '"owned":true' >/dev/null; then
      append_content_worker_owned_queue "$queue_name"
    elif printf '%s\n' "$output" | grep -F '"owned":false' >/dev/null; then
      echo "deploy preflight: $queue_name was paused concurrently; preserving the external pause"
    else
      echo "deploy preflight: $queue_name consumer pause result was not machine-readable" >&2
      return 1
    fi
  done
  echo 'deploy preflight: content-worker consumers paused; active work can drain without new claims'
}

run_content_worker_consumer_status_probe() {
  run_bounded_deploy_probe "$1" "$2" consumer "$3" STATUS
}

assert_content_worker_consumers_paused() {
  local timeout_seconds=${1:-10}
  local deadline_at=$(( $(date +%s) + timeout_seconds ))
  local queue_name output_file remaining_seconds
  for queue_name in $DEPLOY_CONTENT_WORKER_PAUSED_QUEUES; do
    remaining_seconds=$((deadline_at - $(date +%s)))
    if (( remaining_seconds <= 0 )); then
      echo 'deploy preflight: content-worker consumer status deadline exceeded' >&2
      return 124
    fi
    output_file=$(mktemp "${TMPDIR:-/tmp}/letletme-data-consumer-status.XXXXXX")
    if ! run_content_worker_consumer_status_probe "$output_file" "$remaining_seconds" "$queue_name"; then
      cat "$output_file" >&2 || true
      rm -f "$output_file"
      echo "deploy preflight: could not verify the $queue_name consumer pause" >&2
      return 1
    fi
    if ! grep -F '"paused":true' "$output_file" >/dev/null; then
      cat "$output_file" >&2 || true
      rm -f "$output_file"
      echo "deploy preflight: $queue_name consumer pause was lost while draining" >&2
      return 1
    fi
    if content_worker_queue_is_listed "$queue_name" "$DEPLOY_CONTENT_WORKER_OWNED_PAUSED_QUEUES" &&
      ! grep -F '"owned":true' "$output_file" >/dev/null; then
      cat "$output_file" >&2 || true
      rm -f "$output_file"
      echo "deploy preflight: $queue_name consumer pause ownership was lost while draining" >&2
      return 1
    fi
    rm -f "$output_file"
  done
}

resume_content_worker_consumers_for_deploy() {
  local queue_name output
  ensure_content_worker_pause_owner_token
  for queue_name in $DEPLOY_CONTENT_WORKER_OWNED_PAUSED_QUEUES; do
    if ! output=$(set_content_worker_consumer_mode RESUME "$queue_name"); then
      printf '%s\n' "$output" >&2
      echo "deploy admission: failed to resume the deployment-owned $queue_name consumer pause" >&2
      return 1
    fi
    if printf '%s\n' "$output" | grep -F '"owned":false' >/dev/null &&
      printf '%s\n' "$output" | grep -F '"released":false' >/dev/null; then
      remove_content_worker_owned_queue "$queue_name"
      echo "deploy admission: preserved the externally-owned $queue_name consumer pause"
      continue
    fi
    if ! printf '%s\n' "$output" | grep -F '"paused":false' >/dev/null ||
      ! printf '%s\n' "$output" | grep -F '"owned":true' >/dev/null ||
      ! printf '%s\n' "$output" | grep -F '"released":true' >/dev/null; then
      echo "deploy admission: $queue_name consumer resume result was not machine-readable" >&2
      return 1
    fi
    remove_content_worker_owned_queue "$queue_name"
    echo "deploy admission: deployment-owned $queue_name consumer pause released"
  done
  if [[ -z "$DEPLOY_CONTENT_WORKER_OWNED_PAUSED_QUEUES" ]]; then
    DEPLOY_CONTENT_WORKER_CONSUMER_PAUSE_ATTEMPTED=false
  fi
}

restore_content_deploy_controls() {
  # Stop ownership renewal before changing either control. Resume consumers
  # while producer admission is still closed; if a resume fails, no producer
  # can add work to the remaining paused queues.
  DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_GUARD_ACTIVE=false
  stop_content_worker_pause_renewal
  if ! resume_content_worker_consumers_for_deploy; then
    # The content worker owns both the direct formal scheduler and the
    # acquisition outbox dispatcher. If a consumer cannot be resumed, stop
    # that producer before returning; the Redis admission gate is TTL-bound
    # and must not be the only protection during forward recovery.
    stop_content_worker_for_forward_recovery || true
    echo 'deploy admission: deployment-owned content-worker consumers remain paused for forward recovery' >&2
    return 1
  fi
  local queue_name
  for queue_name in $DEPLOY_CONTENT_WORKER_ADMISSION_ATTEMPTED_QUEUES; do
    local status_output
    if ! status_output=$(set_content_worker_consumer_mode STATUS "$queue_name"); then
      printf '%s\n' "$status_output" >&2
      echo "deploy admission: could not verify that $queue_name consumer is open; keeping its producer admission closed" >&2
      stop_content_worker_for_forward_recovery || true
      return 1
    fi
    if ! printf '%s\n' "$status_output" | grep -F '"paused":false' >/dev/null; then
      printf '%s\n' "$status_output" >&2
      echo "deploy admission: $queue_name consumer remains paused; keeping its producer admission closed" >&2
      stop_content_worker_for_forward_recovery || true
      return 1
    fi
    if ! restore_content_worker_queue_admission "$queue_name"; then
      echo "deploy admission: $queue_name producer admission remains closed for forward recovery" >&2
      stop_content_worker_for_forward_recovery || true
      return 1
    fi
  done
}

stop_content_worker_for_forward_recovery() {
  if ! compose stop -t 45 content-worker; then
    echo 'deploy admission: content-worker could not be stopped for forward recovery; manual producer shutdown is required' >&2
    return 1
  fi
  echo 'deploy admission: content-worker producer stopped for forward recovery'
}

cleanup_content_worker_control_image() {
  local temporary_tag=${DEPLOY_CONTENT_WORKER_CONTROL_IMAGE_TEMP_TAG:-}
  [[ -n "$temporary_tag" ]] || return 0
  if ! docker image rm "$temporary_tag" >/dev/null 2>&1; then
    echo "deploy admission: could not remove temporary control image tag $temporary_tag" >&2
    return 1
  fi
  DEPLOY_CONTENT_WORKER_CONTROL_IMAGE_TEMP_TAG=''
  if [[ "$DEPLOY_CONTENT_WORKER_CONTROL_IMAGE" = "$temporary_tag" ]]; then
    DEPLOY_CONTENT_WORKER_CONTROL_IMAGE=''
  fi
}

run_deploy_probe_command() {
  case "${DEPLOY_PROBE_KIND:-}" in
    queue)
      DEPLOY_QUIESCENCE_ALLOW_PAUSED_QUEUES="${DEPLOY_PROBE_ALLOW_PAUSED_QUEUES:-}" \
        APP_IMAGE="${DEPLOY_PROBE_APP_IMAGE:-}" compose run --rm -T --interactive=false api \
        bun scripts/assert-queue-quiescence.ts --redis-only --scoped
      ;;
    consumer)
      APP_IMAGE="${DEPLOY_PROBE_APP_IMAGE:-}" compose run --rm -T --interactive=false \
        -e "DEPLOY_CONTENT_WORKER_PAUSE_OWNER_TOKEN=${DEPLOY_PROBE_CONSUMER_OWNER_TOKEN:-}" api \
        bun scripts/assert-queue-quiescence.ts --consumer-mode "${DEPLOY_PROBE_MODE:-STATUS}" \
        --consumer-queue "${DEPLOY_PROBE_QUEUE:-}"
      ;;
    admission)
      local admission_args=(--admission-mode "${DEPLOY_PROBE_MODE:-}")
      if [[ -n "${DEPLOY_PROBE_QUEUE:-}" ]]; then
        admission_args+=(--admission-queue "${DEPLOY_PROBE_QUEUE}")
      fi
      APP_IMAGE="${DEPLOY_PROBE_APP_IMAGE:-}" compose run --rm -T --interactive=false api \
        bun scripts/assert-queue-quiescence.ts "${admission_args[@]}"
      ;;
    *)
      echo "deploy preflight: invalid probe kind=${DEPLOY_PROBE_KIND:-}" >&2
      return 2
      ;;
  esac
}

run_bounded_deploy_probe() {
  local output_file=$1
  local timeout_seconds=$2
  local probe_kind=${3:-queue}
  local probe_queue=${4:-}
  local probe_mode=${5:-STATUS}
  local probe_pid
  local probe_group_pid=''
  local probe_deadline
  local probe_status
  local probe_project_dir=${PROJECT_DIR:-$PWD}
  local probe_compose_file=${COMPOSE_FILE:-docker-compose.yml}
  local probe_compose_bin=${COMPOSE_BIN:-docker compose}
  local probe_allow_paused_queues=${DEPLOY_CONTENT_WORKER_PAUSED_QUEUES// /,}
  local probe_app_image=${DEPLOY_CONTENT_WORKER_CONTROL_IMAGE:-${APP_IMAGE:-}}
  local probe_consumer_owner_token=${DEPLOY_CONTENT_WORKER_PAUSE_OWNER_TOKEN:-}

  if [[ "$probe_kind" != queue && "$probe_kind" != consumer && "$probe_kind" != admission ]]; then
    echo "deploy preflight: invalid deploy probe kind=$probe_kind" >&2
    return 1
  fi
  if [[ "$probe_kind" = consumer ]] &&
    [[ "$probe_mode" != STATUS && "$probe_mode" != PAUSE &&
      "$probe_mode" != RESUME ]]; then
    echo "deploy preflight: invalid deploy consumer mode=$probe_mode" >&2
    return 1
  fi
  if [[ "$probe_kind" = admission ]] &&
    [[ "$probe_mode" != DRAIN_ONLY && "$probe_mode" != OPEN ]]; then
    echo "deploy preflight: invalid deploy admission mode=$probe_mode" >&2
    return 1
  fi
  if ! [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
    echo "deploy preflight: invalid deploy probe timeout=$timeout_seconds" >&2
    return 1
  fi
  if [[ "$probe_kind" = consumer ]]; then
    ensure_content_worker_pause_owner_token
    probe_consumer_owner_token=$DEPLOY_CONTENT_WORKER_PAUSE_OWNER_TOKEN
  fi

  # Keep the exact Compose probe in its own process group when `setsid` is
  # available. The fallback tracks descendants explicitly for macOS/local
  # shells that do not ship `setsid`. Either way, a hung Docker/Redis startup
  # cannot consume the whole deployment deadline or the deployment shell.
  if command -v setsid >/dev/null 2>&1; then
    (
      # Do not run the caller's deployment EXIT handler from the probe child.
      # It owns restoration and lock release for the parent deployment and
      # must never race a short-lived Compose/Redis check.
      trap - EXIT
      export -f compose compose_direct run_deploy_probe_command run_deploy_command_with_pause_renewal 2>/dev/null || true
      export DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_GUARD_ACTIVE=false
      export DEPLOY_PROBE_PROJECT_DIR="$probe_project_dir"
      export DEPLOY_PROBE_COMPOSE_FILE="$probe_compose_file"
      export DEPLOY_PROBE_COMPOSE_BIN="$probe_compose_bin"
      export DEPLOY_PROBE_APP_IMAGE="$probe_app_image"
      export DEPLOY_PROBE_KIND="$probe_kind"
      export DEPLOY_PROBE_QUEUE="$probe_queue"
      export DEPLOY_PROBE_MODE="$probe_mode"
      export DEPLOY_PROBE_ALLOW_PAUSED_QUEUES="$probe_allow_paused_queues"
      export DEPLOY_PROBE_CONSUMER_OWNER_TOKEN="$probe_consumer_owner_token"
      exec setsid bash -c '
        # Bash functions and arrays are not enough to carry the local deploy
        # context across `bash -c`: PROJECT_DIR/COMPOSE_FILE/COMPOSE_BIN are
        # shell locals in deploy.sh and COMPOSE_CMD is an unexportable array.
        # Rehydrate the same values before invoking the exported compose
        # function so Linux and local/manual deployments probe the intended
        # Compose project.
        PROJECT_DIR="$DEPLOY_PROBE_PROJECT_DIR"
        COMPOSE_FILE="$DEPLOY_PROBE_COMPOSE_FILE"
        COMPOSE_BIN="$DEPLOY_PROBE_COMPOSE_BIN"
        IFS=" " read -r -a COMPOSE_CMD <<<"$COMPOSE_BIN"
        run_deploy_probe_command
      '
    ) >"$output_file" 2>&1 &
    probe_pid=$!
    probe_group_pid=$probe_pid
  else
    (
      # Match the setsid branch: a probe child must not inherit deployment
      # cleanup, queue restoration, or lock-release traps.
      trap - EXIT
      DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_GUARD_ACTIVE=false
      export DEPLOY_PROBE_KIND="$probe_kind"
      export DEPLOY_PROBE_QUEUE="$probe_queue"
      export DEPLOY_PROBE_MODE="$probe_mode"
      export DEPLOY_PROBE_APP_IMAGE="$probe_app_image"
      export DEPLOY_PROBE_ALLOW_PAUSED_QUEUES="$probe_allow_paused_queues"
      export DEPLOY_PROBE_CONSUMER_OWNER_TOKEN="$probe_consumer_owner_token"
      run_deploy_probe_command >"$output_file" 2>&1
    ) &
    probe_pid=$!
  fi
  probe_deadline=$(( $(date +%s) + timeout_seconds ))
  while kill -0 "$probe_pid" 2>/dev/null; do
    if (( $(date +%s) >= probe_deadline )); then
      terminate_scoped_queue_probe "$probe_pid" "$probe_group_pid" 2
      printf '%s\n' "deploy preflight: ${probe_kind} probe timed out after ${timeout_seconds}s" >>"$output_file"
      return 124
    fi
    # The control probes are intentionally short-lived.  A one-second poll
    # interval makes a three-queue pause/resume sequence exceed Bun's focused
    # test deadline and adds avoidable latency to the deployment path.
    sleep 0.1
  done
  if wait "$probe_pid"; then
    return 0
  else
    probe_status=$?
    return "$probe_status"
  fi
}

run_scoped_queue_quiescence_probe() {
  run_bounded_deploy_probe "$1" "$2" queue
}

probe_process_descendants() {
  local parent_pid=$1
  local child_pid
  while IFS= read -r child_pid; do
    [[ -n "$child_pid" ]] || continue
    probe_process_descendants "$child_pid"
    printf '%s\n' "$child_pid"
  done < <(pgrep -P "$parent_pid" 2>/dev/null || true)
}

signal_scoped_queue_probe() {
  local signal=$1
  local probe_pid=$2
  local probe_group_pid=${3:-}
  local known_descendants=${4:-}
  local root_first=${5:-false}
  local child_pid
  if [[ -n "$probe_group_pid" ]]; then
    kill "-$signal" -- "-$probe_group_pid" 2>/dev/null || true
    return 0
  fi
  if [[ "$root_first" = true ]]; then
    kill "-$signal" "$probe_pid" 2>/dev/null || true
  fi
  local live_descendants=''
  if kill -0 "$probe_pid" 2>/dev/null; then
    live_descendants=$(probe_process_descendants "$probe_pid")
  fi
  while IFS= read -r child_pid; do
    [[ -n "$child_pid" ]] || continue
    kill "-$signal" "$child_pid" 2>/dev/null || true
  done < <(
    printf '%s\n' "$live_descendants"
    printf '%s\n' "$known_descendants"
  )
  if [[ "$root_first" != true ]]; then
    kill "-$signal" "$probe_pid" 2>/dev/null || true
  fi
}

scoped_queue_probe_is_alive() {
  local probe_pid=$1
  local probe_group_pid=${2:-}
  local known_descendants=${3:-}
  local child_pid
  if [[ -n "$probe_group_pid" ]] && kill -0 -- "-$probe_group_pid" 2>/dev/null; then
    return 0
  fi
  if kill -0 "$probe_pid" 2>/dev/null; then return 0; fi
  while IFS= read -r child_pid; do
    [[ -n "$child_pid" ]] || continue
    if kill -0 "$child_pid" 2>/dev/null; then return 0; fi
  done <<<"$known_descendants"
  return 1
}

terminate_scoped_queue_probe() {
  local probe_pid=$1
  local probe_group_pid=${2:-}
  local grace_seconds=${3:-2}
  local root_first=${4:-false}
  local known_descendants
  local grace_deadline
  # Capture the tree before TERM.  A shell leader can exit immediately while
  # a Docker/Compose child ignores TERM and gets reparented, so walking only
  # the live root after that exit cannot find the surviving child.
  known_descendants=$(probe_process_descendants "$probe_pid")
  signal_scoped_queue_probe TERM "$probe_pid" "$probe_group_pid" "$known_descendants" "$root_first"
  grace_deadline=$(( $(date +%s) + grace_seconds ))
  while scoped_queue_probe_is_alive "$probe_pid" "$probe_group_pid" "$known_descendants"; do
    if (( $(date +%s) >= grace_deadline )); then
      # Always send the final signal to the saved descendants, even when the
      # root was already reaped or no longer owns them in the process tree.
      signal_scoped_queue_probe KILL "$probe_pid" "$probe_group_pid" "$known_descendants" "$root_first"
      wait "$probe_pid" 2>/dev/null || true
      return 0
    fi
    sleep 0.1
  done
  wait "$probe_pid" 2>/dev/null || true
}

run_deploy_command_with_pause_renewal() {
  if [[ "${DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_GUARD_ACTIVE:-false}" != true ||
    -z "${DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_PID:-}" ||
    -z "${DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_FAILURE_FILE:-}" ]]; then
    if "$@"; then
      return 0
    else
      return $?
    fi
  fi

  local stage_pid status
  "$@" &
  stage_pid=$!
  DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_STAGE_PID=$stage_pid
  while scoped_queue_probe_is_alive "$stage_pid"; do
    if [[ -s "$DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_FAILURE_FILE" ]]; then
      terminate_scoped_queue_probe "$stage_pid" '' 2 true || true
      wait "$stage_pid" 2>/dev/null || true
      DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_STAGE_PID=''
      return 1
    fi
    sleep 0.1
  done
  if wait "$stage_pid"; then
    status=0
  else
    status=$?
  fi
  DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_STAGE_PID=''
  if [[ -s "$DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_FAILURE_FILE" ]]; then return 1; fi
  return "$status"
}

wait_for_scoped_queue_quiescence() {
  local attempts=${1:-90}
  local delay_seconds=${2:-2}
  local deadline_seconds=${3:-300}
  local probe_timeout_seconds=${4:-10}
  local output_file
  local attempt
  local deadline_at
  local now_seconds
  local remaining_seconds
  local effective_probe_timeout
  local effective_status_timeout
  local sleep_seconds
  if ! [[
    "$attempts" =~ ^[1-9][0-9]*$ &&
    "$delay_seconds" =~ ^[0-9]+$ &&
    "$deadline_seconds" =~ ^[1-9][0-9]*$ &&
    "$probe_timeout_seconds" =~ ^[1-9][0-9]*$
  ]]; then
    echo 'deploy preflight: queue quiescence wait bounds are invalid' >&2
    return 1
  fi
  output_file=$(mktemp "${TMPDIR:-/tmp}/letletme-data-queue-quiescence.XXXXXX")
  deadline_at=$(( $(date +%s) + deadline_seconds ))
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    now_seconds=$(date +%s)
    if (( now_seconds >= deadline_at )); then
      printf '%s\n' "deploy preflight: scoped queue quiescence deadline exceeded (${deadline_seconds}s)" >>"$output_file"
      break
    fi
    remaining_seconds=$((deadline_at - now_seconds))
    effective_status_timeout=$probe_timeout_seconds
    if (( effective_status_timeout > remaining_seconds )); then
      effective_status_timeout=$remaining_seconds
    fi
    if ! assert_content_worker_consumers_paused "$effective_status_timeout"; then
      rm -f "$output_file"
      return 1
    fi
    now_seconds=$(date +%s)
    if (( now_seconds >= deadline_at )); then
      printf '%s\n' "deploy preflight: scoped queue quiescence deadline exceeded (${deadline_seconds}s)" >>"$output_file"
      break
    fi
    remaining_seconds=$((deadline_at - now_seconds))
    effective_probe_timeout=$probe_timeout_seconds
    if (( effective_probe_timeout > remaining_seconds )); then
      effective_probe_timeout=$remaining_seconds
    fi
    if run_scoped_queue_quiescence_probe "$output_file" "$effective_probe_timeout"; then
      now_seconds=$(date +%s)
      if (( now_seconds >= deadline_at )); then
        printf '%s\n' "deploy preflight: scoped queue quiescence deadline exceeded (${deadline_seconds}s)" >>"$output_file"
        break
      fi
      remaining_seconds=$((deadline_at - now_seconds))
      effective_status_timeout=$probe_timeout_seconds
      if (( effective_status_timeout > remaining_seconds )); then
        effective_status_timeout=$remaining_seconds
      fi
      if ! assert_content_worker_consumers_paused "$effective_status_timeout"; then
        cat "$output_file" >&2 || true
        rm -f "$output_file"
        return 1
      fi
      cat "$output_file"
      rm -f "$output_file"
      return 0
    fi
    now_seconds=$(date +%s)
    if (( now_seconds >= deadline_at )); then
      printf '%s\n' "deploy preflight: scoped queue quiescence deadline exceeded (${deadline_seconds}s)" >>"$output_file"
      break
    fi
    if (( attempt < attempts )); then
      echo "deploy preflight: waiting for scoped queue work to drain (attempt $attempt/$attempts)"
      remaining_seconds=$((deadline_at - now_seconds))
      sleep_seconds=$delay_seconds
      if (( sleep_seconds > remaining_seconds )); then
        sleep_seconds=$remaining_seconds
      fi
      if (( sleep_seconds > 0 )); then sleep "$sleep_seconds"; fi
    fi
  done
  cat "$output_file" >&2
  rm -f "$output_file"
  return 1
}

migration_ledger_fingerprint() {
  # --plan is read-only and emits a JSON ledger fingerprint.  Keep parsing
  # deliberately dependency-light for VPS images that do not ship jq.
  # Callers may execute this state machine from an SSH `bash -s` stream, so
  # Compose must not attach to the shell's stdin.
  local plan_output
  plan_output=$(compose run --rm -T --interactive=false migration bun scripts/apply-sql-migrations.ts --plan)
  printf '%s\n' "$plan_output" | awk -F'"' '/"ledgerFingerprint"[[:space:]]*:/ { print $4; exit }'
}

release_sha_for_image() {
  local image=${1:-}
  local release_sha
  [[ -n "$image" ]] || { printf '%s\n' unknown; return 0; }
  release_sha=$(docker image inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$image" 2>/dev/null || true)
  if [[ "$release_sha" =~ ^[0-9a-f]{40}$ ]]; then
    printf '%s\n' "$release_sha"
  else
    echo "rollback image has no valid exact revision label; using release identity unknown" >&2
    printf '%s\n' unknown
  fi
}

release_sha_for_container() {
  local container_id=${1:-}
  local release_sha container_env_release_sha
  [[ -n "$container_id" ]] || {
    printf '%s\n' unknown
    return 0
  }
  release_sha=$(docker inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$container_id" 2>/dev/null || true)
  if [[ "$release_sha" =~ ^[0-9a-f]{40}$ ]]; then
    printf '%s\n' "$release_sha"
    return 0
  fi
  # Local images may not carry OCI labels, but every runtime started by the
  # compose contract receives DEPLOY_SHA. Read only that controlled dimension;
  # never dump the complete container environment into deploy logs.
  container_env_release_sha=$(docker inspect \
    --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" \
    2>/dev/null | awk -F= '$1 == "DEPLOY_SHA" { print substr($0, index($0, "=") + 1); exit }' || true)
  if [[ "$container_env_release_sha" =~ ^[0-9a-f]{40}$ ]]; then
    printf '%s\n' "$container_env_release_sha"
    return 0
  fi
  echo 'running container has no valid exact release identity; rollback is ineligible' >&2
  printf '%s\n' unknown
}

rollback_runtime_is_eligible() {
  local container_id=${1:-}
  local previous_image=${2:-}
  local previous_revision=${3:-}
  local previous_release_sha=${4:-unknown}
  local previous_image_id=${5:-}
  local container_image_id container_release_sha container_state container_health
  [[ -n "$container_id" && -n "$previous_image" ]] || {
    echo 'rollback target is ineligible: API container or image is missing' >&2
    return 1
  }
  [[ "$previous_release_sha" =~ ^[0-9a-f]{40}$ ]] || {
    echo 'rollback target is ineligible: image release identity is invalid' >&2
    return 1
  }
  [[ "$previous_revision" = "$previous_release_sha" ]] || {
    echo 'rollback target is ineligible: checkout and image revisions differ' >&2
    return 1
  }
  if [[ -z "$previous_image_id" ]]; then
    previous_image_id=$(docker image inspect --format '{{.Id}}' "$previous_image" 2>/dev/null || true)
  fi
  container_image_id=$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null || true)
  container_release_sha=$(release_sha_for_container "$container_id")
  container_state=$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)
  container_health=$(docker inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$container_id" 2>/dev/null || true)
  [[ -n "$previous_image_id" && "$container_image_id" = "$previous_image_id" && \
    "$container_release_sha" = "$previous_release_sha" ]] || {
    echo 'rollback target is ineligible: immutable container image identity is inconsistent' >&2
    return 1
  }
  [[ "$container_state" = running && "$container_health" = healthy ]] || {
    echo 'rollback target is ineligible: API container is not running and healthy' >&2
    return 1
  }
  if ! docker exec \
    -e "EXPECTED_DEPLOY_SHA=$previous_release_sha" \
    "$container_id" bun -e '
      const expected = process.env.EXPECTED_DEPLOY_SHA;
      const response = await fetch("http://127.0.0.1:3000/health/deploy", {
        signal: AbortSignal.timeout(5000),
      });
      const payload = await response.json();
      if (!response.ok || payload?.success !== true ||
          payload?.status !== "deploy_ready" || payload?.deploySha !== expected) {
        process.exit(1);
      }
    ' >/dev/null 2>&1; then
    echo 'rollback target is ineligible: strict deploy health or release identity failed' >&2
    return 1
  fi
  echo "rollback target eligible at $previous_release_sha"
}

restore_runtime_services() {
  local previous_image=${1:-}
  local previous_release_sha=${2:-unknown}
  local previous_runner_release_sha=${3:-unknown}
  local previous_media_present=${4:-auto}
  local previous_image_id=${5:-}
  local resolved_image_id
  local control_image=${DEPLOY_CONTENT_WORKER_CONTROL_IMAGE:-${APP_IMAGE:-letletme-data:local}}
  local control_image_id=''
  local control_image_temp_tag=''
  [[ -n "$previous_image" ]] || return 1
  if [[ ! "$previous_release_sha" =~ ^[0-9a-f]{40}$ ]]; then
    previous_release_sha=unknown
  fi
  if [[ "$previous_runner_release_sha" != unknown && \
    ! "$previous_runner_release_sha" =~ ^[0-9a-f]{7,128}$ ]]; then
    previous_runner_release_sha=unknown
  fi
  # A default local deploy builds and rolls back through the same mutable tag.
  # Preserve the new image before repinning that tag to the old image so the
  # new control protocol remains available during recovery cleanup.
  if [[ "$control_image" = "$previous_image" ]]; then
    control_image_id=$(docker image inspect --format '{{.Id}}' "$control_image" 2>/dev/null || true)
    if [[ -n "$control_image_id" && "$control_image_id" != "$previous_image_id" ]]; then
      control_image_temp_tag="letletme-data:deploy-control-${BASHPID:-$$}"
      if ! docker tag "$control_image_id" "$control_image_temp_tag"; then
        echo 'could not preserve the target image for deployment control cleanup' >&2
        return 1
      fi
      control_image="$control_image_temp_tag"
      DEPLOY_CONTENT_WORKER_CONTROL_IMAGE_TEMP_TAG="$control_image_temp_tag"
    fi
  fi
  DEPLOY_CONTENT_WORKER_CONTROL_IMAGE="$control_image"
  if [[ -n "$previous_image_id" ]]; then
    resolved_image_id=$(docker image inspect --format '{{.Id}}' "$previous_image" 2>/dev/null || true)
    if [[ "$resolved_image_id" != "$previous_image_id" ]]; then
      # A local build may have moved a mutable tag to the new image. Restore
      # that tag to the exact old image ID before Compose recreates services;
      # digest references are immutable and must never be retagged.
      if [[ "$previous_image" == *@sha256:* ]]; then
        echo 'rollback image reference no longer resolves to its captured immutable image' >&2
        return 1
      fi
      docker tag "$previous_image_id" "$previous_image" || {
        echo 'could not repin the previous local image tag to its captured image ID' >&2
        return 1
      }
    fi
  fi
  if ! (
    export APP_IMAGE="$previous_image"
    export DEPLOY_SHA="$previous_release_sha"
    export CONTENT_MANIFEST_GIT_REVISION="$previous_release_sha"
    export CONTENT_GROK_RUNNER_RELEASE_SHA="$previous_runner_release_sha"
    export RUNTIME_INCLUDE_MEDIA_WORKER="$previous_media_present"
    # The rollback image may predate the new provider-heavy lane entrypoints.
    # Filter only services whose executable is actually present in that image;
    # otherwise a pre-migration failure would restore the old API alongside
    # crash-looping containers that never existed in the old runtime.
    export RUNTIME_ROLLBACK=true
    start_all_runtime_services
  ); then
    return 1
  fi
  return 0
}

restore_last_known_healthy_if_ledger_unchanged() {
  local previous_image=${1:-}
  local ledger_before=${2:-}
  local previous_revision=${3:-}
  local previous_release_sha=${4:-unknown}
  local previous_runner_release_sha=${5:-unknown}
  local previous_media_present=${6:-auto}
  local rollback_eligible=${7:-false}
  local previous_image_id=${8:-}
  local ledger_after
  if [[ "$rollback_eligible" != true ]]; then
    echo 'rollback target was not proven healthy before deployment; forward-only recovery required' >&2
    return 1
  fi
  [[ -n "$previous_image" && -n "$ledger_before" ]] || return 1
  ledger_after=$(migration_ledger_fingerprint 2>/dev/null || true)
  if [[ -n "$ledger_after" && "$ledger_after" = "$ledger_before" ]]; then
    echo 'migration failed without changing the ledger; restoring last-known-healthy release' >&2
    if [[ -n "$previous_revision" ]]; then
      git reset --hard "$previous_revision"
    fi
    restore_runtime_services \
      "$previous_image" "$previous_release_sha" "$previous_runner_release_sha" \
      "$previous_media_present" "$previous_image_id"
    return 0
  fi
  echo 'migration ledger changed or could not be proven unchanged; forward-only recovery required' >&2
  return 1
}

runtime_worker_entrypoint() {
  case "$1" in
    scheduler) printf '%s\n' scheduler.js ;;
    worker) printf '%s\n' worker.js ;;
    content-worker) printf '%s\n' content-worker.js ;;
    live-picks-worker) printf '%s\n' live-picks-worker.js ;;
    official-h2h-worker) printf '%s\n' official-h2h-worker.js ;;
    media-worker) printf '%s\n' media-worker.js ;;
    *) return 1 ;;
  esac
}

rollback_image_has_service() {
  local service=${1:-}
  local image=${APP_IMAGE:-}
  local entrypoint
  [[ -n "$image" ]] || return 1
  entrypoint=$(runtime_worker_entrypoint "$service") || return 1
  docker image inspect "$image" >/dev/null 2>&1 || return 1
  docker run --rm --entrypoint sh "$image" -c "test -f /app/dist/$entrypoint" >/dev/null 2>&1
}

runtime_worker_services() {
  # Every long-lived consumer is part of the runtime inventory. Keeping the
  # provider-heavy lanes in this list makes start/restore/health paths
  # symmetric; otherwise a successful deploy could silently leave a queue
  # without a consumer.
  local services=(scheduler worker content-worker live-picks-worker official-h2h-worker)
  if [[ "${RUNTIME_ROLLBACK:-false}" == true ]]; then
    local filtered=()
    local service
    for service in "${services[@]}"; do
      if [[ "$service" == live-picks-worker || "$service" == official-h2h-worker ]]; then
        if ! rollback_image_has_service "$service"; then
          echo "rollback image does not contain $service; leaving it out of restore" >&2
          continue
        fi
      fi
      filtered+=("$service")
    done
    services=("${filtered[@]}")
  fi
  # Do not use grep -q here: with pipefail, an early grep exit can turn the
  # compose producer's SIGPIPE into a false negative and omit this consumer.
  if [[ "${RUNTIME_INCLUDE_MEDIA_WORKER:-auto}" != false ]] \
    && compose config --services | grep -x 'media-worker' >/dev/null; then
    services+=(media-worker)
  fi
  printf '%s\n' "${services[@]}"
}

start_all_runtime_services() {
  local services=()
  while IFS= read -r service; do
    [[ -n "$service" ]] && services+=("$service")
  done < <(runtime_worker_services)
  compose up -d --remove-orphans --no-build "${services[@]}" api
}

run_migration_plan() {
  compose run --rm -T --interactive=false migration bun scripts/apply-sql-migrations.ts --plan
}

review_backfill_marker_pending() {
  local runtime_database_url=${1:-${DATA_RUNTIME_DATABASE_URL:-}}
  if [[ -z "$runtime_database_url" ]]; then
    echo 'deploy review backfill: Data runtime DATABASE_URL is required to inspect the durable marker' >&2
    return 2
  fi
  local marker_output marker_state
  if ! marker_output=$(DATABASE_URL="$runtime_database_url" \
    compose run --rm -T --interactive=false \
    -e DATABASE_URL migration bun -e '
      import postgres from "postgres";
      const db = postgres(process.env.DATABASE_URL, { max: 1 });
      const current = await db`SELECT season_id FROM fpl.seasons WHERE is_current ORDER BY season_id DESC LIMIT 1`;
      if (current.length === 0) {
        process.stdout.write("complete");
      } else {
        const rows = await db`SELECT backfill_completed_at FROM ops.tournament_review_v2_1_backup_manifest WHERE season_id = ${current[0].season_id} ORDER BY created_at DESC LIMIT 1`;
        process.stdout.write(rows.length === 0 ? "pending" : rows[0].backfill_completed_at === null ? "pending" : "complete");
      }
      await db.end();
    ' 2>/dev/null); then
    echo 'deploy review backfill: durable marker probe failed; refusing to skip the backfill' >&2
    return 2
  fi
  marker_state=$(printf '%s\n' "$marker_output" | tail -n 1)
  case "$marker_state" in
    pending|missing) return 0 ;;
    complete) return 1 ;;
    *)
      echo "deploy review backfill: unexpected durable marker state '$marker_state'" >&2
      return 2
      ;;
  esac
}

run_tournament_review_restore_rehearsal() {
  local rehearsal_url=${1:-${DATABASE_RESTORE_REHEARSAL_URL:-}}
  local source_url=${2:-${MIGRATION_DATABASE_URL:-}}
  if [[ -z "$rehearsal_url" ]]; then
    echo 'deploy review restore rehearsal: DATABASE_RESTORE_REHEARSAL_URL is required for migration 0090' >&2
    return 1
  fi
  if [[ -z "$source_url" ]]; then
    echo 'deploy review restore rehearsal: source database URL is required for identity verification' >&2
    return 1
  fi
  local dump_path
  dump_path=$(find "$DATABASE_BACKUP_DIR" -maxdepth 1 -type f -name 'letletme-data-*.dump' \
    -printf '%T@ %p\n' 2>/dev/null | sort -nr | awk 'NR == 1 { sub(/^[^ ]+ /, ""); print; exit }')
  if [[ -z "$dump_path" || ! -s "$dump_path" ]]; then
    echo 'deploy review restore rehearsal: no complete pre-migration dump found' >&2
    return 1
  fi
  local dump_base=${dump_path%.dump}
  if [[ ! -s "${dump_base}.sha256" || ! -s "${dump_base}.manifest.json" ]]; then
    echo 'deploy review restore rehearsal: dump sidecars are missing' >&2
    return 1
  fi
  local container_dump_path
  container_dump_path="/var/backups/letletme-data/$(basename -- "$dump_path")"
  echo 'deploy review restore rehearsal: restoring the verified pre-migration dump into disposable infrastructure'
  DATABASE_RESTORE_REHEARSAL_URL="$rehearsal_url" \
    DATABASE_RESTORE_SOURCE_URL="$source_url" \
    DATABASE_RESTORE_DUMP_PATH="$container_dump_path" \
    compose --profile migration run --rm -T --interactive=false --no-deps \
    -e DATABASE_RESTORE_REHEARSAL_URL -e DATABASE_RESTORE_DUMP_PATH \
    -e DATABASE_RESTORE_SOURCE_URL \
    --entrypoint sh backup -euc '
      exec bash /app/scripts/verify-backup-restore.sh \
        "$DATABASE_RESTORE_DUMP_PATH" "$DATABASE_RESTORE_REHEARSAL_URL" "$DATABASE_RESTORE_SOURCE_URL"
    '
}

run_tournament_review_hard_cut_backfill() {
  local season=${1:-}
  local runtime_database_url=${2:-${DATA_RUNTIME_DATABASE_URL:-}}
  if ! [[ "$season" =~ ^[0-9]{4}$ ]]; then
    echo 'deploy review backfill: season must be YYYY' >&2
    return 1
  fi
  if [[ -z "$runtime_database_url" ]]; then
    echo 'deploy review backfill: Data runtime DATABASE_URL is required' >&2
    return 1
  fi
  echo "deploy review backfill: draining current-season V2.1 scopes for $season"
  if ! DATABASE_URL="$runtime_database_url" \
    MY_TOURNAMENT_REVIEW_BACKFILL_CONFIRM=YES \
    compose run --rm -T --interactive=false \
    -e DATABASE_URL -e MY_TOURNAMENT_REVIEW_BACKFILL_CONFIRM \
    migration bun run db:backfill-tournament-review-v2 -- \
    --season "$season" --batch-size 100 --max-batches 10000; then
    echo 'deploy review backfill: bounded V2.1 gate failed; services remain stopped' >&2
    return 1
  fi
}

retire_expired_core_staging_publications() {
  local repair_publication_ids=${RETIRE_EXPIRED_CORE_STAGING_PUBLICATION_IDS:-}
  local repair_season_id=${RETIRE_EXPIRED_CORE_STAGING_SEASON_ID:-}
  local repair_active_publication_id=${RETIRE_EXPIRED_CORE_STAGING_ACTIVE_PUBLICATION_ID:-}
  local repair_active_revision=${RETIRE_EXPIRED_CORE_STAGING_ACTIVE_REVISION:-}
  if [[ -z "$repair_publication_ids" ]]; then
    if [[ -n "$repair_season_id" || -n "$repair_active_publication_id" || -n "$repair_active_revision" ]]; then
      echo 'deploy repair: all repair inputs must be empty when no publication UUIDs are supplied' >&2
      return 1
    fi
    echo 'deploy repair: no exact staging publication repair requested'
    return 0
  fi

  if ! [[ "$repair_season_id" =~ ^[1-9][0-9]*$ ]]; then
    echo 'deploy repair: season id must be a positive integer' >&2
    return 1
  fi
  if ! [[ "$repair_active_publication_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
    echo 'deploy repair: expected active publication must be an RFC UUID' >&2
    return 1
  fi
  if ! [[ "$repair_active_revision" =~ ^[1-9][0-9]*$ ]]; then
    echo 'deploy repair: expected active revision must be a positive integer' >&2
    return 1
  fi

  local repair_ids=()
  IFS=',' read -r -a repair_ids <<< "$repair_publication_ids"
  if [[ "${#repair_ids[@]}" -lt 1 || "${#repair_ids[@]}" -gt 8 ]]; then
    echo 'deploy repair: provide between one and eight exact publication UUIDs' >&2
    return 1
  fi

  local raw_repair_id repair_id
  for raw_repair_id in "${repair_ids[@]}"; do
    repair_id=$(printf '%s' "$raw_repair_id" | tr -d '[:space:]')
    if ! [[ "$repair_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
      echo 'deploy repair: every staging publication value must be an RFC UUID' >&2
      return 1
    fi
    echo "deploy repair: validating and retiring exact expired core staging publication $repair_id"
    if ! APP_IMAGE="${APP_IMAGE:-}" compose --profile migration run --rm -T --interactive=false \
        -e DATA_STAGING_REPAIR_CONFIRM=YES migration \
        bun scripts/retire-superseded-core-staging-publication.ts \
        --action retire \
        --publication-id "$repair_id" \
        --season-id "$repair_season_id" \
        --expected-active-publication-id "$repair_active_publication_id" \
        --expected-active-revision "$repair_active_revision" \
        --reason 'operator-confirmed expired superseded core staging repair'; then
      echo "deploy repair: publication $repair_id was not retired; stopping the repair list" >&2
      return 1
    fi
  done
}

start_runtime_services() {
  # Scheduler and workers have no host port and must be healthy before API
  # startup.  An API bind failure may be retried once, but never tears down a
  # healthy worker that is already processing queued work.
  local services=()
  while IFS= read -r service; do
    [[ -n "$service" ]] && services+=("$service")
  done < <(runtime_worker_services)
  compose up -d --remove-orphans --no-build "${services[@]}"
  compose up -d --remove-orphans --no-build api || {
    echo 'API start failed; preserving scheduler/worker/content-worker/live-picks-worker/official-h2h-worker/media-worker for recovery' >&2
    port_3000_owner >&2
    # A failed Docker bind can leave the exact Compose API container in
    # `created` state while its network namespace/port proxy is being torn
    # down. Remove that recoverable container before deciding that a listener
    # is external; otherwise the safety check prevents the retry from ever
    # recreating the required host port mapping.
    remove_exact_stopped_container api
    remove_stale_api_run_containers
    wait_for_port_3000_free 30 2
    compose up -d --remove-orphans --no-build api
  }
}
