Environment Configuration

- Required
  - `DATABASE_URL` — PostgreSQL connection string
  - `REDIS_HOST` — Redis host (default: `localhost`)
  - `REDIS_PORT` — Redis port (default: `6379`)
  - `PORT` — API port (default: `3000`)

- Optional
  - `REDIS_PASSWORD` — Redis password
  - `REDIS_DB` — Redis DB index (default: `0`)
  - `QUEUE_REDIS_HOST` / `QUEUE_REDIS_PORT` / `QUEUE_REDIS_PASSWORD` / `QUEUE_REDIS_DB` — override queue Redis connection (defaults to cache Redis)
  - `SUPABASE_URL` / `SUPABASE_KEY` — if you also use Supabase APIs
  - `NODE_ENV` — `production` | `development` | `test`
  - `LOG_LEVEL` — `fatal` | `error` | `warn` | `info` | `debug` | `trace`

Sample .env.production

DATABASE_URL="postgresql://user:pass@db-host:5432/letletme_data?pgbouncer=true&timezone=UTC"
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password
PORT=3000

Validate Environment

- Run: `bun run env:check`
- Fails with non‑zero exit code if validation fails.
