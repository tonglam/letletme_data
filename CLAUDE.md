# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Hard rules

1. **Redis keys/shapes are frozen.** Multiple external systems read this Redis. Fixes stay within existing key patterns, hash fields, and JSON shapes; new data needs go to **new additive keys only**. Consumer-facing deletions need sign-off (prefer manual runbooks). Exception already in code: when `Season:active` advances, entity writers auto-`DEL` stale keys for their prefixes — see `docs/redis-contract.md` §10. Do not add new automatic cleanup jobs without updating that contract.
2. **`bun run db:generate` is frozen** (would emit a schema-reset migration). Add migrations as hand-written, idempotent `migrations/NNNN_name.sql` files — see `migrations/README.md`.
3. One fix-plan item = one PR. Tracker: `docs/fix-plan-checklist.md`.

## Commands

```bash
# Development
bun run dev          # API server with hot reload (src/index.ts)
bun run worker:dev   # BullMQ worker with hot reload (src/worker.ts)

# Production
bun run build        # Compile to dist/
bun run start        # Run compiled API
bun run worker:start # Run compiled worker

# Testing
bun test                             # All tests
bun test tests/unit                  # Unit tests only (no infra needed)
bun test tests/unit/events.test.ts   # Single test file
bun test --coverage                  # With coverage

# Code quality
bun run lint         # ESLint check
bun run lint:fix     # ESLint auto-fix
bun run format:fix   # Prettier format

# Database
bun run db:generate  # Generate Drizzle migrations from schema changes
bun run db:migrate   # Apply migrations
bun run db:studio    # Open Drizzle Studio (DB browser)
```

Integration tests require a live PostgreSQL + Redis instance. Unit tests run without any infrastructure.

## Architecture

The system has **two separate processes**:

1. **API server** (`src/index.ts`) — Elysia HTTP server + cron job registration
2. **Worker** (`src/worker.ts`) — BullMQ workers consuming queued jobs

Both must run concurrently in development. Crons fire in the API process, enqueue jobs to BullMQ, and workers execute the actual work.

### Data Flow

```
FPL API → transformer (Zod validate + camelCase) → service (upsert to DB + cache) → API endpoints read cache-first
```

Cron → enqueue job → BullMQ queue → worker → service function → PostgreSQL upsert + Redis cache update

### Layer Responsibilities

| Layer | Directory | Responsibility |
|-------|-----------|----------------|
| API | `src/api/` | Elysia route handlers, thin wrappers over services |
| Service | `src/services/` | Business logic, orchestrates repository + cache |
| Repository | `src/repositories/` | Drizzle ORM queries, factory pattern (`createXRepository(dbInstance?)`) |
| Cache | `src/cache/` | Per-entity Redis operations, entity-specific hash structures |
| Transformer | `src/transformers/` | Raw FPL JSON → domain types, Zod validation at boundary |
| Domain | `src/domain/` | Types + Zod schemas + validate functions + business logic predicates |
| Jobs | `src/jobs/` | Cron registration (`register*Jobs`) + enqueue helpers |
| Queues | `src/queues/` | BullMQ queue instances + job name enums |
| Workers | `src/workers/` | BullMQ worker switch handlers, delegate to services |

### Job System

Five BullMQ queues: `data-sync`, `entry-sync`, `live-data`, `league-sync`, `tournament-sync`.

**Cascade pattern**: A primary DB sync job completes → enqueues secondary jobs (summary, explain, bonus, overall result, live fixtures) via `source: 'cascade'`. Example: `event-lives-db-sync` → enqueues `event-live-summary`, `event-live-explain`, `event-overall-result`, `live-fixture-cache`, `live-bonus-cache`.

**Cron schedules** (all in `src/jobs/`):
- Data sync jobs: daily 6:35–9:45 AM (`data-jobs.ts`)
- Live data: every 1 min (cache update), 10 min (DB sync), 15 min (live scores) (`live.jobs.ts`)
- Entry/league/tournament: various windows (`entry-sync.jobs.ts`, `league-jobs.ts`, `tournament-jobs.ts`)

All cron handlers call `isFPLSeason()` and `isMatchDayTime()` / `isMatchHours()` guards before enqueuing.

### Cache Key Pattern

Redis keys follow `Entity:season` (e.g., `Event:2526`, `PlayerStats:2526`). All TTLs are set to `-1` (no expiration) — data is refreshed on write, never expired. Cache operations return `null` on miss; services fall back to DB.

### Domain Layer Pattern

Every domain file in `src/domain/` must have:
1. TypeScript interface(s)
2. Zod schema(s) matching the interface
3. `validate*()` and `safeValidate*()` functions
4. Business logic predicates (e.g., `hasPlayed()`, `isFinished()`)

### Type Flow

`RawFPL*` types (from `src/types/index.ts`) → Zod validated in transformer → domain types (`src/domain/*.ts`) → stored as `DbX` types (Drizzle schema in `src/db/schemas/`) → returned as domain types from services.

`EventChipData` and `EventTopElementData` are defined in `src/domain/event-overall-results.ts` and re-exported from `src/types/index.ts`.

### Adding a New Entity

1. Add DB schema to `src/db/schemas/` → run `bun run db:generate && bun run db:migrate`
2. Add domain interface + Zod schema + predicates to `src/domain/`
3. Add transformer in `src/transformers/` (Zod validate raw input, map to domain type)
4. Add repository in `src/repositories/` using `createXRepository(dbInstance?)` factory
5. Add cache operations in `src/cache/` following the entity hash pattern
6. Add service in `src/services/` (sync writes DB + cache; getters read cache → DB fallback)
7. Add API routes in `src/api/` and register in `src/index.ts`
8. Add job/queue/worker entries if background sync is needed
9. Add fixtures in `tests/fixtures/` and unit tests in `tests/unit/`

<!-- autoskills:start -->

Summary generated by `autoskills`. Check the full files inside `.claude/skills`.

## Bun Skill

Use when building JavaScript/TypeScript applications, setting up HTTP servers, managing dependencies, bundling code, running tests, or working with full-stack applications. Bun is a complete JavaScript runtime, package manager, bundler, and test runner that replaces Node.js, npm, and other tools.

- `.claude/skills/bun/SKILL.md`

## TypeScript Advanced Types

Master TypeScript's advanced type system including generics, conditional types, mapped types, template literals, and utility types for building type-safe applications. Use when implementing complex type logic, creating reusable type utilities, or ensuring compile-time type safety in TypeScript pr...

- `.claude/skills/typescript-advanced-types/SKILL.md`

<!-- autoskills:end -->
