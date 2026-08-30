---
name: letletme-data-pipeline
description: Trace or change LetLetMe Data ingestion, scheduler and queue execution, PostgreSQL persistence, migrations, or Redis publications. Do not use for GraphQL/UI-only work or generic Bun and TypeScript questions.
---

# LetLetMe Data Pipeline

Work from the actual `letletme_data` checkout and produce evidence at the layer where the task occurs. Preserve unrelated worktrees and WIP.

## Route before reading broadly

- Ownership or cross-repository contract: read [SYSTEM_CONTRACTS.md](../../../docs/SYSTEM_CONTRACTS.md).
- Scheduler, cadence, catch-up, or missed work: read [job-schedule.md](../../../docs/job-schedule.md), then inspect `src/scheduler/job-registry.ts`, the relevant job, queue, worker, and durable obligation evidence.
- Redis publication, cache, freshness, fallback, or cleanup: read [redis-contract.md](../../../docs/redis-contract.md) and [cache-ttl-summary.md](../../../docs/cache-ttl-summary.md).
- Schema, migration, login, or privilege work: read [migrations/README.md](../../../migrations/README.md) and, for role boundaries, [database-security.md](../../../docs/database-security.md).
- Understat work: read [understat-pipeline.md](../../../docs/understat-pipeline.md).
- Test selection or infrastructure: read [tests/README.md](../../../tests/README.md).

Read only the routes relevant to the task. Inspect current source and manifests after the routed reference; documentation is a contract to verify, not proof of current runtime state.

## Trace the complete producer path

Follow the applicable chain without skipping layers:

1. Provider request, timeout/retry/admission, and raw artifact when one exists.
2. Boundary validation and domain transformation.
3. Service orchestration and repository transaction/locking.
4. Durable run, checkpoint, scheduler obligation, outbox, or publication row.
5. Redis staging, manifest validation, atomic pointer activation, and retention when the dataset has a read model.
6. GraphQL and representative consumer evidence when the reported behavior is user-visible.

Separate source-code, local-test, database, Redis, deployed-image, API, and UI evidence. A healthy worker, successful enqueue, HTTP 200, or locally passing test proves only its own layer.

## Make a change

- Keep Data-owned writes and provider policy here; do not compensate for producer defects in GraphQL or clients.
- Preserve complete season/event/tournament units, idempotency, deterministic job identities, durable checkpoints, and revision-aware compare-and-swap behavior.
- For a migration, use the next available filename, hand-write transactional SQL, update Drizzle mappings/parity, and keep applied files immutable.
- For a publication change, test completeness and failure behavior before the happy path. Never allow mixed revisions or a partial candidate to replace the active revision.
- For a scheduler/queue change, test obligation reservation, deduplication, retries, descendants/finalizers, and business completion evidence; queue settlement alone is insufficient.
- If the public contract or release order changes, expand to the global cross-stack workflow only then. A normal single-repository change does not need a cross-repository Change ID.

## Validate proportionally

Start with the narrowest unit file, then use `bun run test`, `bun run typecheck`, and `bun run lint` as justified. Add `bun run docs:contract` when executable inventories or documented contracts change, `bun run db:migrate:status` plus `bun run db:migration-contract` for schema work, and guarded integration tests only with isolated test infrastructure.

Production inspection is read-only unless the user authorizes a mutation or release. For authorized operations, use checked-in scripts and exact bounded targets; do not construct ad-hoc Redis, queue, database, or deployment mutations when a repository gate already exists.
