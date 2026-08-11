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
PROJECT_DIR=${PROJECT_DIR:-$(pwd)}
export MIGRATION_ENV_FILE

IFS=' ' read -r -a COMPOSE_CMD <<<"${COMPOSE_BIN}"

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

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
    log_error "${MIGRATION_ENV_FILE} not found. Copy .env.migrate.example and add the direct Supabase postgres URL."
    exit 1
  fi
}

compose() {
  (cd "${PROJECT_DIR}" && "${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" "$@")
}

restore_stopped_services() {
  log_warn "Restoring the existing API and worker because migration has not started"
  if ! compose start api worker; then
    log_error "The existing API and worker could not be restarted; manual recovery is required."
  fi
}

deploy() {
  require_compose
  require_files
  if [[ -n "${APP_IMAGE:-}" ]]; then
    export APP_IMAGE
    log_info "Pulling the configured application image"
    compose pull api worker migration
  else
    log_info "Building containers"
    compose build --pull
  fi
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
  data_runtime_database_password=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '\n=')
  [[ "${data_runtime_database_password}" =~ ^[A-Za-z0-9_-]{64}$ ]]
  data_runtime_database_url=$(compose run --rm -T \
    -e "DATABASE_URL=${data_runtime_database_url}" \
    -e "RUNTIME_DATABASE_SOURCE_URL=${migration_database_url}" \
    -e "RUNTIME_DATABASE_PASSWORD=${data_runtime_database_password}" migration \
    bun scripts/format-runtime-database-url.ts replace-password)
  graphql_runtime_database_password=$(sed -n 's/^GRAPHQL_RUNTIME_DB_PASSWORD=//p' "${MIGRATION_ENV_FILE}" | sed -e 's/^"//' -e 's/"$//')
  if [[ -z "${graphql_runtime_database_password}" ]]; then
    log_error "GRAPHQL_RUNTIME_DB_PASSWORD missing from ${MIGRATION_ENV_FILE}"
    exit 1
  fi
  graphql_runtime_database_url=$(compose run --rm -T \
    -e "DATA_RUNTIME_DATABASE_URL=${data_runtime_database_url}" migration \
    bun scripts/format-runtime-database-url.ts derive-graphql)
  graphql_runtime_database_url=$(compose run --rm -T \
    -e "GRAPHQL_RUNTIME_DATABASE_URL=${graphql_runtime_database_url}" \
    -e "GRAPHQL_RUNTIME_DATABASE_PASSWORD=${graphql_runtime_database_password}" migration \
    bun scripts/format-runtime-database-url.ts with-password)
  runtime_env_file=$(mktemp)
  configured_env_file="${ENV_FILE}"
  awk '!/^DATABASE_URL=/' "${ENV_FILE}" >"${runtime_env_file}"
  printf 'DATABASE_URL="%s"\n' "${data_runtime_database_url}" >>"${runtime_env_file}"
  export ENV_FILE="${runtime_env_file}"
  cleanup_runtime_env() {
    if [[ -n "${runtime_env_file}" ]]; then
      rm -f "${runtime_env_file}" "${runtime_env_file}.bak"
    fi
  }
  trap cleanup_runtime_env EXIT
  log_info "Validating the application environment"
  if ! compose run --rm -T api bun run env:check; then
    log_error "Application environment contract failed; services were not stopped."
    exit 1
  fi
  log_info "Waiting for the migration Pooler circuit breaker to clear"
  for _ in 1 2 3; do
    sleep 60
  done
  log_info "Validating the migration LOGIN before service shutdown"
  if ! compose run --rm -T migration bun scripts/migration-login-contract.ts --preflight; then
    log_error "Migration LOGIN identity contract failed; services were not stopped."
    exit 1
  fi
  if ! compose run --rm -T \
    -e "DATA_RUNTIME_DB_PASSWORD=${data_runtime_database_password}" \
    -e "GRAPHQL_RUNTIME_DB_PASSWORD=${graphql_runtime_database_password}" \
    -e "DATA_RUNTIME_DATABASE_URL=${data_runtime_database_url}" \
    -e "GRAPHQL_RUNTIME_DATABASE_URL=${graphql_runtime_database_url}" migration \
    bun run db:provision-runtime-logins --preflight; then
    log_error "Runtime LOGIN provisioning inputs failed; services were not stopped."
    exit 1
  fi
  log_info "Stopping services and waiting for workers to settle"
  if ! compose stop -t 45 api worker; then
    log_error "Services did not stop cleanly; migration was not started."
    restore_stopped_services
    exit 1
  fi
  if ! compose run --rm -T migration bun scripts/assert-queue-quiescence.ts --database-only; then
    log_error "Database work is not quiescent; migration was not started."
    restore_stopped_services
    exit 1
  fi
  if ! compose run --rm -T api bun scripts/assert-queue-quiescence.ts --redis-only; then
    log_error "Queue work is not quiescent; migration was not started."
    restore_stopped_services
    exit 1
  fi
  log_info "Running migrations"
  if ! compose run --rm -T migration bun run db:migrate; then
    log_error "SQL migrations failed; aborting deploy before services start."
    exit 1
  fi
  compose run --rm -T migration bun run db:migrate:status
  if ! compose run --rm -T migration bun run db:migration-contract; then
    log_error "Migration LOGIN contract failed after migrations."
    exit 1
  fi
  if ! compose run --rm -T \
    -e "DATA_RUNTIME_DB_PASSWORD=${data_runtime_database_password}" \
    -e "GRAPHQL_RUNTIME_DB_PASSWORD=${graphql_runtime_database_password}" \
    -e "DATA_RUNTIME_DATABASE_URL=${data_runtime_database_url}" \
    -e "GRAPHQL_RUNTIME_DATABASE_URL=${graphql_runtime_database_url}" migration \
    bun run db:provision-runtime-logins; then
    log_error "Runtime LOGIN provisioning failed; services remain stopped for a forward fix."
    exit 1
  fi
  log_info "Waiting for Supavisor credentials to converge"
  for _ in 1 2; do
    sleep 60
  done
  log_info "Publishing and verifying the canonical core cache"
  if ! compose run --rm -T \
    -e "DATABASE_URL=${data_runtime_database_url}" api \
    bun run cache:publish-core -- --execute --allow-empty; then
    log_error "Core cache publication failed; services remain stopped for a forward fix."
    exit 1
  fi
  log_info "Starting services"
  compose up -d --remove-orphans
  chmod 600 "${runtime_env_file}"
  mv "${runtime_env_file}" "${configured_env_file}"
  runtime_env_file=''
  export ENV_FILE="${configured_env_file}"
  log_info "Current service status"
  compose ps
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
