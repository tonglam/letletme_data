#!/usr/bin/env bash
# Shared fail-closed deployment primitives.  Source this file from the local
# helper and the VPS workflow so recovery semantics cannot drift.

# Shared with the GraphQL VPS deploy workflow.  Data listens on 3000 and
# GraphQL on 4000, but both compose projects touch the same host resources.
deploy_lock_path=${DEPLOY_LOCK_PATH:-/var/lock/letletme-platform-deploy.lock}
deploy_lock_fd=''
DEPLOY_CONTENT_X_SCAN_ADMISSION_ATTEMPTED=${DEPLOY_CONTENT_X_SCAN_ADMISSION_ATTEMPTED:-false}

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

set_content_x_scan_admission() {
  local mode=${1:-}
  local output
  if [[ "$mode" != DRAIN_ONLY && "$mode" != OPEN ]]; then
    echo "deploy preflight: invalid content-x-scan admission mode=$mode" >&2
    return 1
  fi
  if ! output=$(
    APP_IMAGE="${APP_IMAGE:-}" compose run --rm -T --interactive=false api \
      bun scripts/set-content-x-scan-admission.ts --mode "$mode" 2>&1
  ); then
    printf '%s\n' "$output" >&2
    return 1
  fi
  printf '%s\n' "$output"
}

drain_content_x_scan_for_deploy() {
  if [[ "$DEPLOY_CONTENT_X_SCAN_ADMISSION_ATTEMPTED" = true ]]; then return 0; fi
  # Mark the attempt before Redis is touched.  The EXIT handler can then
  # safely ask the command to restore only a gate owned by this deployment,
  # even if the one-shot command dies after changing Redis but before it
  # prints its result.
  DEPLOY_CONTENT_X_SCAN_ADMISSION_ATTEMPTED=true
  local output
  if ! output=$(set_content_x_scan_admission DRAIN_ONLY); then
    printf '%s\n' "$output" >&2
    return 1
  fi
  printf '%s\n' "$output"
  if printf '%s\n' "$output" | grep -F '"changed":true' >/dev/null; then
    echo 'deploy preflight: content-x-scan admission is drain-only; waiting for active work to finish'
  elif printf '%s\n' "$output" | grep -F '"changed":false' >/dev/null; then
    echo 'deploy preflight: content-x-scan was already drain-only; preserving its existing operator gate'
  else
    echo 'deploy preflight: content-x-scan admission result was not machine-readable' >&2
    return 1
  fi
}

renew_content_x_scan_admission() {
  if [[ "$DEPLOY_CONTENT_X_SCAN_ADMISSION_ATTEMPTED" != true ]]; then return 0; fi
  local output
  if ! output=$(set_content_x_scan_admission DRAIN_ONLY); then
    printf '%s\n' "$output" >&2
    echo 'deploy admission: failed to renew content-x-scan drain-only gate' >&2
    return 1
  fi
  printf '%s\n' "$output"
  if printf '%s\n' "$output" | grep -F '"changed":true' >/dev/null; then
    echo 'deploy admission: content-x-scan drain-only gate renewed'
  elif printf '%s\n' "$output" | grep -F '"changed":false' >/dev/null; then
    echo 'deploy admission: external content-x-scan drain-only gate remains in force'
  else
    echo 'deploy admission: content-x-scan renewal result was not machine-readable' >&2
    return 1
  fi
}

restore_content_x_scan_admission() {
  if [[ "$DEPLOY_CONTENT_X_SCAN_ADMISSION_ATTEMPTED" != true ]]; then return 0; fi
  local output
  if ! output=$(set_content_x_scan_admission OPEN); then
    printf '%s\n' "$output" >&2
    echo 'deploy admission: failed to restore content-x-scan admission; its bounded gate remains in force' >&2
    return 1
  fi
  printf '%s\n' "$output"
  if printf '%s\n' "$output" | grep -F '"changed":false' >/dev/null; then
    DEPLOY_CONTENT_X_SCAN_ADMISSION_ATTEMPTED=false
    echo 'deploy admission: preserved an externally-owned content-x-scan drain-only gate'
    return 0
  fi
  if ! printf '%s\n' "$output" | grep -F '"changed":true' >/dev/null; then
    echo 'deploy admission: restore result was not machine-readable; leaving the gate state tracked' >&2
    return 1
  fi
  DEPLOY_CONTENT_X_SCAN_ADMISSION_ATTEMPTED=false
  echo 'deploy admission: content-x-scan admission restored'
}

wait_for_scoped_queue_quiescence() {
  local attempts=${1:-90}
  local delay_seconds=${2:-2}
  local output_file
  local attempt
  if ! [[ "$attempts" =~ ^[1-9][0-9]*$ && "$delay_seconds" =~ ^[0-9]+$ ]]; then
    echo 'deploy preflight: queue quiescence wait bounds are invalid' >&2
    return 1
  fi
  output_file=$(mktemp "${TMPDIR:-/tmp}/letletme-data-queue-quiescence.XXXXXX")
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if APP_IMAGE="${APP_IMAGE:-}" compose run --rm -T --interactive=false api \
      bun scripts/assert-queue-quiescence.ts --redis-only --scoped >"$output_file" 2>&1; then
      cat "$output_file"
      rm -f "$output_file"
      return 0
    fi
    if (( attempt < attempts )); then
      echo "deploy preflight: waiting for scoped queue work to drain (attempt $attempt/$attempts)"
      sleep "$delay_seconds"
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
  [[ -n "$previous_image" ]] || return 1
  if [[ ! "$previous_release_sha" =~ ^[0-9a-f]{40}$ ]]; then
    previous_release_sha=unknown
  fi
  if [[ "$previous_runner_release_sha" != unknown && \
    ! "$previous_runner_release_sha" =~ ^[0-9a-f]{7,128}$ ]]; then
    previous_runner_release_sha=unknown
  fi
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
  (
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
  )
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
    wait_for_port_3000_free 30 2
    compose up -d --remove-orphans --no-build api
  }
}
