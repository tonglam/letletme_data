# Test Suite

This directory contains the test suite for `letletme_data`. Tests are split by speed and infrastructure requirements so CI and local runs stay fast and safe.

## Running tests

| Command | What it runs | Infrastructure |
|---|---|---|
| `bun run test` or `bun test tests/unit` | Unit tests only (`tests/unit`) | None |
| `bun run test:integration` | Integration tests (`tests/integration`) | Postgres + Redis (test instance only) |
| `bun run test:publication:integration` | Immutable publication + Redis separation | Postgres + Redis (test instance only) |
| `bun run test:core-publication-benchmark` | Full B0 core publication budget | Restored B0 Postgres + Redis; `RUN_B0_ACCEPTANCE=1` |
| `RUN_INTEGRATION=1 bun run test:all` | Unit + integration | Postgres + Redis (test instance only) |

Do not use bare `bun test` as a unit-test shortcut. Bun discovers both test
directories directly, so the integration environment guard will reject the run
unless the explicit test-only infrastructure variables are present.

Integration tests are gated by `tests/integration/helpers/env-guard.ts`. They refuse to start unless **all** of the following are true:

- `RUN_INTEGRATION=1`
- `DATABASE_URL` points at `localhost`, `127.0.0.1`, or a database name ending in `_test`
- `CACHE_REDIS_DB` and `QUEUE_REDIS_DB` are non-zero and distinct

This prevents accidental runs against production infrastructure.

## Directory layout

```
tests/
├── unit/              # Fast, hermetic unit tests (no DB/Redis/network)
│   ├── *.test.ts      # Domain, transformer, repository structure, API handler tests
│   └── ...
├── integration/       # End-to-end tests that write real data
│   ├── helpers/       # Env guard and recorded FPL client override
│   └── *.test.ts      # Service + worker + cache + DB tests
├── fixtures/          # Static FPL-shaped test data
│   └── *.fixtures.ts
└── utils/
    └── test-config.ts # Shared test config (used by integration env guard)
```

### Unit tests (`tests/unit`)

Unit tests validate:

- Domain logic and predicates (`src/domain`)
- Transformer output shape and validation (`src/transformers`)
- Repository method signatures and error paths with in-memory stubs
- API handler routing, validation, and enqueue behavior (`src/api`)
- Cache operations, job priority, mutation scopes, rate limiting, logging

They must not require PostgreSQL, Redis, or outbound network calls.

### Integration tests (`tests/integration`)

Integration tests exercise:

- Full data flow: FPL boundary → transformer → repository → DB → cache
- Worker behavior with BullMQ against a real Redis instance
- Tournament lifecycle, cascade barriers, and mutation locking
- Upsert correctness and idempotency

They assume a fresh or isolated test database and a non-zero Redis DB. Run migrations before the suite:

```bash
# Example local setup
createdb letletme_data_test
DATABASE_URL=postgresql://user:pass@localhost:5432/letletme_data_test \
  CACHE_REDIS_DB=9 QUEUE_REDIS_DB=10 \
  bun run db:migrate

RUN_INTEGRATION=1 \
  DATABASE_URL=postgresql://user:pass@localhost:5432/letletme_data_test \
  CACHE_REDIS_HOST=localhost CACHE_REDIS_PORT=6379 CACHE_REDIS_DB=9 \
  QUEUE_REDIS_HOST=localhost QUEUE_REDIS_PORT=6379 QUEUE_REDIS_DB=10 \
  bun run test:integration
```

The B0 benchmark uses the same guarded variables plus `RUN_B0_ACCEPTANCE=1` and a restored database
that contains the accepted 2526 season. It publishes only to the configured non-zero cache Redis
database and must complete within five minutes.

## Hermetic FPL boundary

Integration tests that need FPL payloads should use recorded fixtures from `tests/fixtures/` and override the FPL client methods via `tests/integration/helpers/mock-fpl.ts` instead of calling the real API. This keeps the suite deterministic and removes the dependency on an internet connection.

## Adding tests

- New domain functions → `tests/unit/<domain>.test.ts`
- New transformer → `tests/unit/<entity>.test.ts`
- New service that writes data → `tests/integration/<entity>.test.ts`
- New API handler → `tests/unit/<entity>-handlers.test.ts`

Always import the integration env guard first in any new integration file.
