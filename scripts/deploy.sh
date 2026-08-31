#!/usr/bin/env bash
# Helper for local/remote deployments via Docker Compose

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

COMPOSE_BIN=${COMPOSE_BIN:-"docker compose"}
COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.yml}
ENV_FILE=${ENV_FILE:-.env.deploy}
MIGRATION_ENV_FILE=${MIGRATION_ENV_FILE:-.env.migrate}
CONTENT_MEDIA_ENV_FILE=${CONTENT_MEDIA_ENV_FILE:-.env.media}
PROJECT_DIR=${PROJECT_DIR:-$(pwd)}
DEPLOY_SHA=${DEPLOY_SHA:-$(git -C "${PROJECT_DIR}" rev-parse HEAD 2>/dev/null || printf unknown)}
export MIGRATION_ENV_FILE
export CONTENT_MEDIA_ENV_FILE
export DEPLOY_SHA
export CONTENT_MANIFEST_GIT_REVISION="$DEPLOY_SHA"
export CONTENT_GROK_RUNNER_RELEASE_SHA="$DEPLOY_SHA"

IFS=' ' read -r -a COMPOSE_CMD <<<"${COMPOSE_BIN}"

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Read only the non-secret backup settings from the deployment env file.  Do
# not source the file: it also contains credentials and must never be treated
# as shell code.  Explicit process environment values still take precedence.
read_env_setting() {
  local key=$1
  local file=$2
  local value
  value=$(awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      sub("^[[:space:]]*" key "[[:space:]]*=", "", $0)
      print
      exit
    }
  ' "$file")
  value=${value#\"}
  value=${value%\"}
  value=${value#\'}
  value=${value%\'}
  printf '%s' "$value"
}

load_backup_settings() {
  local value
  if [[ -z "${DATABASE_BACKUP_DIR:-}" ]]; then
    value=$(read_env_setting DATABASE_BACKUP_DIR "$ENV_FILE")
    DATABASE_BACKUP_DIR=${value:-/var/backups/letletme-data}
  fi
  if [[ -z "${DATABASE_BACKUP_KEEP:-}" ]]; then
    value=$(read_env_setting DATABASE_BACKUP_KEEP "$ENV_FILE")
    DATABASE_BACKUP_KEEP=${value:-7}
  fi
  if [[ -z "${DATABASE_BACKUP_PG_MAJOR:-}" ]]; then
    value=$(read_env_setting DATABASE_BACKUP_PG_MAJOR "$ENV_FILE")
    DATABASE_BACKUP_PG_MAJOR=${value:-15}
  fi
  export DATABASE_BACKUP_DIR DATABASE_BACKUP_KEEP DATABASE_BACKUP_PG_MAJOR
}

load_v2_seed_scope() {
  local value
  if [[ -z "${LIVE_POINTS_V2_SEED_SEASON:-}" ]]; then
    value=$(read_env_setting LIVE_POINTS_V2_SEED_SEASON "$ENV_FILE")
    LIVE_POINTS_V2_SEED_SEASON=$value
  fi
  if [[ -z "${LIVE_POINTS_V2_SEED_EVENT_ID:-}" ]]; then
    value=$(read_env_setting LIVE_POINTS_V2_SEED_EVENT_ID "$ENV_FILE")
    LIVE_POINTS_V2_SEED_EVENT_ID=$value
  fi
  if ! [[ "${LIVE_POINTS_V2_SEED_SEASON:-}" =~ ^[0-9]{4}$ ]]; then
    log_error "LIVE_POINTS_V2_SEED_SEASON must be YYYY"
    return 1
  fi
  if ! [[ "${LIVE_POINTS_V2_SEED_EVENT_ID:-}" =~ ^[1-9][0-9]*$ ]]; then
    log_error "LIVE_POINTS_V2_SEED_EVENT_ID must be a positive integer"
    return 1
  fi
  export LIVE_POINTS_V2_SEED_SEASON LIVE_POINTS_V2_SEED_EVENT_ID
}

ACTIVE_DEPLOY_STAGE=''
DEPLOY_STAGE_STARTED_AT=0
DEPLOY_MIGRATION_STARTED=false
DEPLOY_COMMITTED=false
DEPLOY_OLD_IMAGE=''
DEPLOY_OLD_IMAGE_ID=''
DEPLOY_OLD_REVISION=''
DEPLOY_OLD_RELEASE_SHA=unknown
DEPLOY_OLD_RUNNER_RELEASE_SHA=unknown
DEPLOY_ROLLBACK_ELIGIBLE=false
DEPLOY_LEDGER_BEFORE=''
DEPLOY_RUNNER_UPDATED=false
DEPLOY_RUNNER_PROBE_SUCCEEDED=false
DEPLOY_RUNNER_PREVIOUS_TARGET=''
DEPLOY_RUNNER_PREVIOUS_RELEASE=''
DEPLOY_OLD_MEDIA_PRESENT=false
DEPLOY_SERVICES_STOPPED=false
DEPLOY_CONTENT_X_SCAN_PRODUCER_FENCED=false

start_stage() {
  ACTIVE_DEPLOY_STAGE=$1
  DEPLOY_STAGE_STARTED_AT=$(date +%s)
}

finish_stage() {
  local outcome
  local finished_at duration_ms
  outcome=${1:-passed}
  finished_at=$(date +%s)
  duration_ms=$(((finished_at - DEPLOY_STAGE_STARTED_AT) * 1000))
  printf '{"event":"deploy_stage_timing","stage":"%s","outcome":"%s","durationMs":%s}\n' \
    "${ACTIVE_DEPLOY_STAGE}" "$outcome" "${duration_ms}"
  ACTIVE_DEPLOY_STAGE=''
}

require_compose() {
  if ! command -v "${COMPOSE_CMD[0]}" >/dev/null 2>&1; then
    log_error "${COMPOSE_BIN} is not available. Install Docker + compose plugin first."
    exit 1
  fi
}

require_files() {
  if [[ ! -f "${COMPOSE_FILE}" ]]; then
    log_error "${COMPOSE_FILE} not found. Run from the repository root or set COMPOSE_FILE."
    exit 1
  fi
  if [[ ! -f "${ENV_FILE}" ]]; then
    log_error "${ENV_FILE} not found. Copy .env.deploy.example -> ${ENV_FILE} and fill secrets."
    exit 1
  fi
  if [[ ! -f "${MIGRATION_ENV_FILE}" ]]; then
    log_error "${MIGRATION_ENV_FILE} not found. Copy .env.migrate.example and add a direct or session-mode Supabase postgres URL."
    exit 1
  fi
  if grep -q '^[[:space:]]*CONTENT_MEDIA_SUPABASE_SECRET_KEY[[:space:]]*=' "${ENV_FILE}"; then
    log_error "CONTENT_MEDIA_SUPABASE_SECRET_KEY must exist only in ${CONTENT_MEDIA_ENV_FILE}, not ${ENV_FILE}."
    exit 1
  fi
  load_backup_settings
}

compose() {
  (cd "${PROJECT_DIR}" && "${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" "$@")
}

# Keep local/manual deploys on the same host lock, migration plan and staged
# startup state machine as the GitHub workflow.
source "${PROJECT_DIR}/scripts/deploy-state-machine.sh"

restore_stopped_services() {
  local restored=false
  if ! restore_content_deploy_controls; then
    log_error "Deployment controls could not be restored; leaving services in forward recovery."
    return 1
  fi
  if [[ "$DEPLOY_ROLLBACK_ELIGIBLE" != true ]]; then
    log_error "Previous runtime was not proven rollback-eligible; leaving services stopped for forward recovery."
    return 1
  fi
  log_warn "Restoring existing services because migration has not started"
  # The API container is deliberately removed after it stops so a delayed
  # listener cannot retain port 3000.  `compose start` cannot recreate that
  # exact container, therefore recovery must use `up`; pin the last image when
  # one was captured so a pre-migration failure never boots the new release.
  if [[ -n "${DEPLOY_OLD_IMAGE:-}" ]]; then
    if restore_runtime_services \
      "$DEPLOY_OLD_IMAGE" "$DEPLOY_OLD_RELEASE_SHA" "$DEPLOY_OLD_RUNNER_RELEASE_SHA" \
      "$DEPLOY_OLD_MEDIA_PRESENT" "$DEPLOY_OLD_IMAGE_ID"; then
      restored=true
    else
      log_error "Last-known-healthy services could not be restored; manual recovery is required."
    fi
  elif start_all_runtime_services; then
    restored=true
  else
    log_error "Existing services could not be restored; manual recovery is required."
  fi
  if [[ "$restored" = true ]]; then
    DEPLOY_SERVICES_STOPPED=false
    DEPLOY_CONTENT_X_SCAN_PRODUCER_FENCED=false
  fi
}

deploy() {
  acquire_deploy_lock
  deploy_on_exit() {
    local status=$?
    trap - EXIT
    set +e
    local controls_restored=true
    if ! restore_content_deploy_controls; then controls_restored=false; fi
    if [[ "$status" -ne 0 ]]; then
      if [[ "$DEPLOY_COMMITTED" = false && "$DEPLOY_RUNNER_UPDATED" = true ]]; then
        export CONTENT_GROK_RUNNER_RELEASE_SHA="${DEPLOY_RUNNER_PREVIOUS_RELEASE:-unknown}"
        "${PROJECT_DIR}/scripts/rollback-host-grok-runner.sh" \
          /home/workspace/letletme-grok-runner \
          "$DEPLOY_RUNNER_PREVIOUS_TARGET" "$DEPLOY_RUNNER_PREVIOUS_RELEASE" || true
      fi
      if [[ "$DEPLOY_COMMITTED" = false && "$DEPLOY_MIGRATION_STARTED" = true &&
        "$controls_restored" = true ]]; then
        if ! restore_last_known_healthy_if_ledger_unchanged \
          "$DEPLOY_OLD_IMAGE" "$DEPLOY_LEDGER_BEFORE" "$DEPLOY_OLD_REVISION" \
          "$DEPLOY_OLD_RELEASE_SHA" "$DEPLOY_OLD_RUNNER_RELEASE_SHA" \
          "$DEPLOY_OLD_MEDIA_PRESENT" "$DEPLOY_ROLLBACK_ELIGIBLE" \
          "$DEPLOY_OLD_IMAGE_ID"; then
          log_error "Rollback eligibility or migration ledger proof failed; leaving the deployment in forward recovery."
        fi
      elif [[ "$DEPLOY_COMMITTED" = false &&
        ( "$DEPLOY_SERVICES_STOPPED" = true ||
          "$DEPLOY_CONTENT_X_SCAN_PRODUCER_FENCED" = true ) &&
        "$controls_restored" = true ]]; then
        restore_stopped_services || true
      elif [[ "$controls_restored" != true ]]; then
        log_error "Deployment controls remain closed; skipping runtime restoration until forward recovery releases them."
      fi
    fi
    release_deploy_lock || true
    exit "$status"
  }
  trap deploy_on_exit EXIT
  require_compose
  require_files
  # Validate the immutable V2 seed scope while services are still serving the
  # old release. A missing deployment variable must never stop a healthy
  # stack and discover the error only after migration has started.
  if ! load_v2_seed_scope; then
    log_error "Live Points V2 seed scope is invalid; services were not stopped."
    exit 1
  fi
  if ! DATABASE_CONNECTION_BUDGET="${DATABASE_CONNECTION_BUDGET:-15}" \
    COMPOSE_BIN="$COMPOSE_BIN" COMPOSE_FILE="$COMPOSE_FILE" PROJECT_DIR="$PROJECT_DIR" \
    "${PROJECT_DIR}/scripts/check-database-pool-budget.sh"; then
    log_error "Compose runtime pool budget or worker inventory check failed; services were not stopped."
    exit 1
  fi
  DEPLOY_OLD_RUNNER_RELEASE_SHA=$(cat \
    /home/workspace/letletme-grok-runner/current.release 2>/dev/null || printf unknown)
  DEPLOY_OLD_RUNNER_RELEASE_SHA=${DEPLOY_OLD_RUNNER_RELEASE_SHA:-unknown}
  old_container=$(compose ps -aq api | head -n 1)
  if [[ -n "$old_container" ]]; then
    # Capture the image ID and release identity from the serving container
    # before a local build can retag `letletme-data:local`. Never use the
    # current checkout as the rollback revision: callers commonly check out
    # the target commit before invoking this helper.
    DEPLOY_OLD_IMAGE=$(docker inspect --format '{{.Config.Image}}' "$old_container")
    DEPLOY_OLD_IMAGE_ID=$(docker inspect --format '{{.Image}}' "$old_container")
    DEPLOY_OLD_RELEASE_SHA=$(release_sha_for_container "$old_container")
    DEPLOY_OLD_REVISION=''
    if [[ "$DEPLOY_OLD_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
      resolved_old_revision=$(git -C "${PROJECT_DIR}" rev-parse \
        --verify "${DEPLOY_OLD_RELEASE_SHA}^{commit}" 2>/dev/null || true)
      if [[ "$resolved_old_revision" = "$DEPLOY_OLD_RELEASE_SHA" ]]; then
        DEPLOY_OLD_REVISION=$resolved_old_revision
      else
        log_warn "Serving release ${DEPLOY_OLD_RELEASE_SHA} is not available in the local checkout; rollback is ineligible"
      fi
    fi
  fi
  old_media_container=$(compose ps -aq media-worker 2>/dev/null | head -n 1)
  if [[ -n "$old_media_container" ]]; then DEPLOY_OLD_MEDIA_PRESENT=true; fi
  start_stage pull
  if [[ -n "${APP_IMAGE:-}" ]]; then
    export APP_IMAGE
    log_info "Pulling the configured application image"
    compose --profile migration pull api scheduler worker content-worker live-picks-worker official-h2h-worker media-worker migration backup
  else
    log_info "Building containers"
    compose build --pull
  fi
  finish_stage
  migration_database_url=$(sed -n 's/^DATABASE_URL=//p' "${MIGRATION_ENV_FILE}" | sed -e 's/^"//' -e 's/"$//')
  if [[ -z "${migration_database_url}" ]]; then
    log_error "DATABASE_URL missing from ${MIGRATION_ENV_FILE}"
    exit 1
  fi
  data_runtime_database_url=$(sed -n 's/^DATABASE_URL=//p' "${ENV_FILE}" | sed -e 's/^"//' -e 's/"$//')
  if [[ -z "${data_runtime_database_url}" ]]; then
    log_error "DATABASE_URL missing from ${ENV_FILE}"
    exit 1
  fi
  start_stage preflight
  log_info "Using the configured Data runtime URL without rewriting it"
  log_info "Validating the application environment"
  if ! compose run --rm -T --interactive=false api bun run env:check; then
    log_error "Application environment contract failed; services were not stopped."
    exit 1
  fi
  log_info "Probing the private bug-report screenshot bucket"
  if ! compose run --rm -T --interactive=false api bun validate-env.ts --probe-bug-report-storage; then
    log_error "Bug-report screenshot storage contract failed; services were not stopped."
    exit 1
  fi
  log_info "Provisioning and probing the immutable FPL raw snapshot bucket"
  if ! compose run --rm -T --interactive=false api bun validate-env.ts --probe-fpl-raw-snapshot-storage; then
    log_error "FPL raw snapshot storage contract failed; services were not stopped."
    exit 1
  fi
  if ! "${PROJECT_DIR}/scripts/bootstrap-briefing-source-media-env.sh" \
    "${ENV_FILE}" "${CONTENT_MEDIA_ENV_FILE}"; then
    log_error "Could not establish the private source-media environment file."
    exit 1
  fi
  media_worker_setting=false
  if [[ -f "${CONTENT_MEDIA_ENV_FILE}" ]]; then
    media_worker_setting=$(read_env_setting CONTENT_MEDIA_WORKER_ENABLED "$CONTENT_MEDIA_ENV_FILE" | tr '[:upper:]' '[:lower:]' || true)
  fi
  if [[ "$media_worker_setting" =~ ^(1|true|yes|on)$ ]]; then
    log_info "Provisioning and probing the private Briefing source-media bucket"
    if ! compose run --rm -T --interactive=false media-worker bun dist/media-worker.js --provision-and-probe; then
      log_error "Briefing source-media Storage contract failed; services were not stopped."
      exit 1
    fi
  else
    log_info "Briefing source-media worker is disabled; Storage provisioning is not required"
  fi
  log_info "Probing the migration LOGIN for at most 120 seconds"
  if ! compose run --rm -T --interactive=false migration bun scripts/wait-for-migration-login.ts; then
    log_error "Migration LOGIN identity contract failed; services were not stopped."
    exit 1
  fi
  finish_stage
  start_stage stagingRepair
  if ! retire_expired_core_staging_publications; then
    log_error "Exact staging publication repair failed; services were not stopped."
    exit 1
  fi
  finish_stage
  if ! pause_content_worker_consumers_for_deploy; then
    log_error "Could not pause the content-worker consumers before queue quiescence; services were not stopped."
    exit 1
  fi
  start_stage quiescence
  log_info "Validating migration plan before stopping services"
  if ! run_migration_plan; then
    log_error "Migration plan failed; services were not stopped."
    exit 1
  fi
  DEPLOY_LEDGER_BEFORE=$(migration_ledger_fingerprint)
  [[ -n "$DEPLOY_LEDGER_BEFORE" ]] || { log_error "Could not capture migration ledger fingerprint"; exit 1; }
  log_info "Migration ledger before=${DEPLOY_LEDGER_BEFORE}"
  log_info "Checking queue quiescence before stopping services"
  if ! compose run --rm -T --interactive=false migration bun scripts/assert-queue-quiescence.ts --database-only --scoped; then
    log_error "Database work is not quiescent; services were not stopped."
    exit 1
  fi
  # Pause every queue consumed by content-worker before accepting the scoped
  # result so delayed and prioritized content jobs cannot become active in the
  # stop race. Keep the combined worker alive while active work (including HTTP
  # work) drains; stopping it first would orphan a slow provider job behind the
  # worker's 30s shutdown controller.
  DEPLOY_ROLLBACK_ELIGIBLE=false
  if rollback_runtime_is_eligible \
    "$old_container" "$DEPLOY_OLD_IMAGE" "$DEPLOY_OLD_REVISION" \
    "$DEPLOY_OLD_RELEASE_SHA" "$DEPLOY_OLD_IMAGE_ID"; then
    DEPLOY_ROLLBACK_ELIGIBLE=true
  fi
  if ! wait_for_scoped_queue_quiescence 150 2; then
    log_error "Queue work is not quiescent; services were not stopped."
    exit 1
  fi
  DEPLOY_CONTENT_X_SCAN_PRODUCER_FENCED=true
  log_info "Stopping content-worker after active content work drained"
  if ! compose stop -t 45 content-worker; then
    log_error "Content worker did not stop cleanly after queue drain; migration was not started."
    restore_stopped_services
    exit 1
  fi
  if ! drain_content_x_scan_for_deploy; then
    log_error "Could not place content-x-scan into drain-only mode after stopping the producer; migration was not started."
    restore_stopped_services
    exit 1
  fi
  log_info "Migration plan and queue quiescence passed before stopping services"
  DEPLOY_ROLLBACK_ELIGIBLE=false
  if rollback_runtime_is_eligible \
    "$old_container" "$DEPLOY_OLD_IMAGE" "$DEPLOY_OLD_REVISION" \
    "$DEPLOY_OLD_RELEASE_SHA" "$DEPLOY_OLD_IMAGE_ID"; then
    DEPLOY_ROLLBACK_ELIGIBLE=true
  fi
  log_info "Stopping services and waiting for workers to settle"
  DEPLOY_SERVICES_STOPPED=true
  if ! compose stop -t 45 api worker; then
    log_error "Services did not stop cleanly; migration was not started."
    restore_stopped_services
    exit 1
  fi
  if ! compose stop -t 45 scheduler; then
    log_error "Scheduler did not stop cleanly; migration was not started."
    restore_stopped_services
    exit 1
  fi
  if ! compose stop -t 45 media-worker; then
    log_error "Media worker did not stop cleanly; migration was not started."
    restore_stopped_services
    exit 1
  fi
  if ! compose stop -t 45 live-picks-worker official-h2h-worker; then
    log_error "Provider-heavy workers did not stop cleanly; migration was not started."
    restore_stopped_services
    exit 1
  fi
  remove_exact_stopped_container api
  wait_for_port_3000_free 30 2
  if ! compose run --rm -T --interactive=false migration bun scripts/assert-queue-quiescence.ts --database-only --scoped; then
    log_error "Database work is not quiescent; migration was not started."
    restore_stopped_services
    exit 1
  fi
  final_queue_probe_output=$(mktemp "${TMPDIR:-/tmp}/letletme-data-final-queue-quiescence.XXXXXX")
  if ! run_scoped_queue_quiescence_probe "$final_queue_probe_output" 10; then
    cat "$final_queue_probe_output" >&2 || true
    rm -f "$final_queue_probe_output"
    log_error "Queue work is not quiescent; migration was not started."
    restore_stopped_services
    exit 1
  fi
  cat "$final_queue_probe_output"
  rm -f "$final_queue_probe_output"
  log_info "Creating and validating the pre-migration PostgreSQL dump"
  if ! compose --profile migration run --rm -T --interactive=false backup; then
    log_error "Pre-migration backup failed; migration was not started."
    restore_stopped_services
    exit 1
  fi
  finish_stage
  x_scan_setting=$(read_env_setting CONTENT_X_SCAN_ENABLED "$ENV_FILE" | tr '[:upper:]' '[:lower:]' || true)
  real_grok_setting=$(read_env_setting CONTENT_REAL_GROK_ENABLED "$ENV_FILE" | tr '[:upper:]' '[:lower:]' || true)
  if [[ "$x_scan_setting" =~ ^(1|true|yes|on)$ ]] &&
    [[ "$real_grok_setting" =~ ^(1|true|yes|on)$ ]]; then
    start_stage hostRunner
    runner_root=/home/workspace/letletme-grok-runner
    DEPLOY_RUNNER_PREVIOUS_TARGET=$(readlink -e "$runner_root/current" 2>/dev/null || true)
    DEPLOY_RUNNER_PREVIOUS_RELEASE=$(cat "$runner_root/current.release" 2>/dev/null || printf unknown)
    DEPLOY_RUNNER_PREVIOUS_RELEASE=${DEPLOY_RUNNER_PREVIOUS_RELEASE:-unknown}
    runner_image_ref=${APP_IMAGE:-letletme-data:local}
    test -x "${PROJECT_DIR}/scripts/deploy-host-grok-runner.sh"
    test -x "${PROJECT_DIR}/scripts/run-briefing-control-probe.sh"
    DEPLOY_RUNNER_UPDATED=true
    "${PROJECT_DIR}/scripts/deploy-host-grok-runner.sh" \
      "$runner_image_ref" "$DEPLOY_SHA" "$runner_root"
    if "${PROJECT_DIR}/scripts/run-briefing-control-probe.sh" \
      "$ENV_FILE" "$MIGRATION_ENV_FILE" "$DEPLOY_SHA"; then
      DEPLOY_RUNNER_PROBE_SUCCEEDED=true
      finish_stage
    else
      runner_probe_status=$?
      export CONTENT_GROK_RUNNER_RELEASE_SHA="${DEPLOY_RUNNER_PREVIOUS_RELEASE:-unknown}"
      test -x "${PROJECT_DIR}/scripts/rollback-host-grok-runner.sh"
      "${PROJECT_DIR}/scripts/rollback-host-grok-runner.sh" \
        "$runner_root" "$DEPLOY_RUNNER_PREVIOUS_TARGET" "$DEPLOY_RUNNER_PREVIOUS_RELEASE"
      DEPLOY_RUNNER_UPDATED=false
      printf '{"event":"briefing_control_probe","outcome":"degraded","exitCode":%s,"runnerRestored":true,"dataDeploymentContinues":true}\n' \
        "$runner_probe_status"
      finish_stage degraded
    fi
  else
    log_info 'Host Grok runner is not required while X scanning or the real Grok provider is disabled'
  fi
  start_stage migration
  DEPLOY_MIGRATION_STARTED=true
  log_info "Running migrations"
  if ! compose run --rm -T --interactive=false migration bun run db:migrate; then
    log_error "SQL migrations failed; aborting deploy before services start."
    exit 1
  fi
  compose run --rm -T --interactive=false migration bun run db:migrate:status
  if ! compose run --rm -T --interactive=false migration bun run db:migration-contract; then
    log_error "Migration LOGIN contract failed after migrations."
    exit 1
  fi
  finish_stage
  start_stage roleVerify
  if ! compose run --rm -T --interactive=false migration bun run db:verify-runtime-logins; then
    log_error "Runtime LOGIN verification failed; services remain stopped for a forward fix."
    exit 1
  fi
  finish_stage
  start_stage v2Seed
  log_info "Seeding and verifying the Live Points V2 global and entry publications"
  # The cutover seed is a one-shot operation: use the migration LOGIN's
  # direct/session URL, while compose supplies the runtime database and Redis
  # credentials to checkpoint services.
  if ! LIVE_POINTS_V2_SEED_DATABASE_URL="$migration_database_url" \
    LIVE_POINTS_SEED_CONFIRM=YES \
    compose run --rm -T --interactive=false \
    -e LIVE_POINTS_V2_SEED_DATABASE_URL \
    -e LIVE_POINTS_SEED_CONFIRM api \
    bun run db:cutover-seed-live-points-v2 -- --execute --cache --all-finalized \
    --season "$LIVE_POINTS_V2_SEED_SEASON" \
    --event-id "$LIVE_POINTS_V2_SEED_EVENT_ID"; then
    log_error "Live Points V2 seed failed; services remain stopped for a forward fix."
    exit 1
  fi
  if ! compose run --rm -T --interactive=false \
    api \
    bun run verify:live-points-v2 -- \
    --season "$LIVE_POINTS_V2_SEED_SEASON" \
    --event-id "$LIVE_POINTS_V2_SEED_EVENT_ID" \
    --all-finalized; then
    log_error "Live Points V2 verification failed; services remain stopped for a forward fix."
    exit 1
  fi
  if ! compose run --rm -T --interactive=false \
    api \
    bun run db:cutover-seed-live-match-v2 -- --execute --all-finalized \
    --season "$LIVE_POINTS_V2_SEED_SEASON" \
    --event-id "$LIVE_POINTS_V2_SEED_EVENT_ID"; then
    log_error "Live Matches V2 seed failed; services remain stopped for a forward fix."
    exit 1
  fi
  finish_stage
  start_stage cachePublish
  log_info "Publishing and verifying the canonical core cache"
  if ! DATABASE_URL="$data_runtime_database_url" \
    compose run --rm -T --interactive=false \
    -e DATABASE_URL api \
    bun run cache:publish-core -- --execute --allow-empty; then
    log_error "Core cache publication failed; services remain stopped for a forward fix."
    exit 1
  fi
  finish_stage
  if ! renew_content_x_scan_admission; then
    log_error "Content-x-scan admission could not be renewed before service start."
    exit 1
  fi
  start_stage serviceReady
  log_info "Starting services"
  # The media worker owns a runtime heartbeat even when source-media
  # processing is disabled. Keep it in the normal forward start so /ready can
  # distinguish an intentionally disabled worker from a missing or crashed
  # worker. RUNTIME_INCLUDE_MEDIA_WORKER=false is reserved for restoring a
  # release that never had this container.
  export RUNTIME_INCLUDE_MEDIA_WORKER=true
  start_runtime_services
  log_info "Current service status"
  compose ps
  if ! PROJECT_DIR="$PROJECT_DIR" COMPOSE_FILE="$COMPOSE_FILE" COMPOSE_BIN="$COMPOSE_BIN" \
    scripts/verify-runtime-health.sh; then
    log_error "Runtime health verification failed."
    exit 1
  fi
  finish_stage
  if [[ "$x_scan_setting" =~ ^(1|true|yes|on)$ ]] &&
    [[ "$real_grok_setting" =~ ^(1|true|yes|on)$ ]] &&
    [[ "$DEPLOY_RUNNER_PROBE_SUCCEEDED" = true ]]; then
    test -x "${PROJECT_DIR}/scripts/rearm-briefing-x-after-probe.sh"
    "${PROJECT_DIR}/scripts/rearm-briefing-x-after-probe.sh" "$ENV_FILE" "$MIGRATION_ENV_FILE"
  elif [[ "$x_scan_setting" =~ ^(1|true|yes|on)$ ]] &&
    [[ "$real_grok_setting" =~ ^(1|true|yes|on)$ ]]; then
    printf '%s\n' '{"event":"briefing_x_rearm","outcome":"skipped","reason":"control-probe-not-successful"}'
  fi
  if ! restore_content_deploy_controls; then
    log_error "Could not restore content-worker admission and consumer state after service readiness."
    exit 1
  fi
  DEPLOY_COMMITTED=true
}

update_repo() {
  if [[ -d .git ]]; then
    log_info "Updating git worktree"
    git pull --ff-only
  else
    log_warn "Not a git repository; skipping pull."
  fi
}

status() {
  require_compose
  require_files
  compose ps
  compose --profile migration run --rm -T --no-deps --entrypoint sh backup -euc \
    'exec psql "$DATABASE_URL" -X -qAt --set=ON_ERROR_STOP=1' <<'SQL'
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT jsonb_build_object(
  'event', 'briefing_source_media_health',
  'health', to_jsonb(health)
)::text
FROM content.source_media_health AS health;
COMMIT;
SQL
}

stream_logs() {
  require_compose
  require_files
  compose logs -f "$@"
}

show_usage() {
  cat <<USAGE
Usage: scripts/deploy.sh [command]

Commands:
  deploy        Build containers, run migrations, then start stack (default)
  update        git pull --ff-only, then deploy
  status        Show docker compose service status
  logs [svc]    Tail logs (all services by default)
  help          Show this message

Environment:
  COMPOSE_BIN   Command used for Compose (default: "docker compose")
  COMPOSE_FILE  Compose file to use (default: docker-compose.yml)
  ENV_FILE      Env file that must exist (default: .env.deploy)
  MIGRATION_ENV_FILE  One-shot migration env file (default: .env.migrate)
  CONTENT_MEDIA_ENV_FILE  Media-worker-only env file (default: .env.media)
  PROJECT_DIR   Directory passed to compose (default: pwd)
USAGE
}

main() {
  case "${1:-deploy}" in
    deploy)
      deploy
      ;;
    update)
      update_repo
      deploy
      ;;
    status)
      status
      ;;
    logs)
      shift || true
      stream_logs "$@"
      ;;
    help|--help|-h)
      show_usage
      ;;
    *)
      log_error "Unknown command: $1"
      show_usage
      exit 1
      ;;
  esac
}

main "$@"
