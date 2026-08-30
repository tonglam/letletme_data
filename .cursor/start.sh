#!/usr/bin/env bash
# Per-boot reconciliation for the letletme_data Cloud Agent environment.
# Starts PostgreSQL 15 and Redis, ensures the local databases/roles exist,
# provisions a local .env, applies migrations, and then returns. Safe to re-run.
set -euo pipefail

export PATH="$HOME/.bun/bin:$PATH"
cd "$(dirname "$0")/.."

PG_SUPERUSER_PASSWORD="postgres"
DEV_DB="letletme_data"
TEST_DB="letletme_data_test"

echo "[start] ensuring PostgreSQL 15 is running"
if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
  sudo pg_ctlcluster 15 main start || true
fi
for _ in $(seq 1 30); do
  pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 && break
  sleep 1
done
pg_isready -h 127.0.0.1 -p 5432

echo "[start] ensuring Redis is running"
if ! redis-cli ping >/dev/null 2>&1; then
  sudo redis-server /etc/redis/redis.conf --daemonize yes || true
fi
for _ in $(seq 1 30); do
  redis-cli ping >/dev/null 2>&1 && break
  sleep 1
done
redis-cli ping >/dev/null

echo "[start] ensuring databases, superuser password, and Supabase-compatible roles"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER ROLE postgres WITH PASSWORD '${PG_SUPERUSER_PASSWORD}';"
for DB in "${DEV_DB}" "${TEST_DB}"; do
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB}'" | grep -q 1; then
    sudo -u postgres createdb "${DB}"
  fi
  # Supabase provisions anon/authenticated/service_role; the database trust
  # boundary integration tests assert these client roles have no app-schema
  # privileges, so they must exist for the checks to run.
  sudo -u postgres psql -d "${DB}" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END $$;
SQL
done

echo "[start] ensuring local .env"
if [ ! -f .env ]; then
  cp .cursor/dev.env .env
  echo "[start] wrote .env from .cursor/dev.env"
fi

echo "[start] applying migrations (development database)"
bun run db:migrate

echo "[start] applying migrations (test database)"
DATABASE_URL="postgresql://postgres:${PG_SUPERUSER_PASSWORD}@127.0.0.1:5432/${TEST_DB}" \
  CACHE_REDIS_DB=9 QUEUE_REDIS_DB=10 \
  bun run db:migrate

echo "[start] environment ready (api + worker start in their terminals)"
