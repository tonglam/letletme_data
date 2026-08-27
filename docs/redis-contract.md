# Redis contract

PostgreSQL is canonical. Redis contains only rebuildable Data publications,
bounded GraphQL caches, BullMQ delivery state, and short-lived coordination.
Redis loss may reduce performance or delay delivery; it must not delete or
replace a canonical business fact.

## Endpoint ownership

| Configuration | Contents | Default local DB |
| --- | --- | ---: |
| `CACHE_REDIS_*` | `llm:data:*` publications and GraphQL `llm:gql:*` query/security cache | 0 |
| `QUEUE_REDIS_*` | all BullMQ queues and worker/scheduler coordination | 1 |

The configured host, port, and database tuples must be distinct; startup rejects
an identical tuple. Passwords and URLs are never copied into tests or logs.
Understat business data is PostgreSQL-only and has no Data-owned cache.

## Data publications on cache Redis

Core keys:

```text
llm:data:fpl:core:<season>:active
llm:data:fpl:core:<season>:<revision>:<item>
```

Core items are exactly `events`, `teams`, `players`, `phases`, `fixtures`, and
`currentEventId`.

Live keys:

```text
llm:data:fpl:live:<season>:<event>:active
llm:data:fpl:live:<season>:<event>:<revision>:<item>
```

Live items are exactly `eventLives`, `fixtures`, `liveFixtures`, and
`liveBonus`. A live manifest is `scheduled`, `live`, or `settled`.

An active manifest contains exactly `dataset`, `seasonCode`, nullable `eventId`,
`revision`, `publicationId`, `sourceCheckedAt`, `publishedAt`, `state`, and
`items`. Each item contains `name`, `key`, `type`, `count`, `bytes`, and
`sha256`. Readers validate field sets, scope, key prefix, Redis type, byte
length, count, JSON shape, and digest before accepting a revision. They either
use that complete revision or a coherent PostgreSQL fallback; per-item mixing is
forbidden.

Publication lifecycle:

1. Reserve a monotonic revision in `ops.dataset_publications`.
2. Stage every immutable item with a 15-minute TTL.
3. Commit and validate the complete PostgreSQL scope.
4. Verify staged keys and atomically replace the active manifest in Lua.
5. Keep active items without expiry; retire the replaced revision for 24 hours.
6. Mark the database publication active and its predecessor retired.

Repeating one publication ID is idempotent. An older candidate cannot replace a
newer active pointer.

| State | TTL |
| --- | ---: |
| Active manifest and active items | none |
| Unactivated staging items | 15 minutes |
| Replaced revision items | 24 hours |

## GraphQL cache ownership

GraphQL owns these cache families on the cache endpoint:

```text
llm:gql:<dataset-revision>:<query-name>:<args-hash>
llm:gql:security:rate:<scope>:<subject>
```

Data never scans, removes, or writes GraphQL keys during normal operation.
Query invalidation follows the dataset revision and the GraphQL TTL policy.

## BullMQ and coordination on queue Redis

`src/queues/names.ts` is the only queue inventory. It contains 24 names: 21
core queues and three content queues:

| Core queues | Content queues |
| --- | --- |
| `data-sync`, `fpl-critical-sync`, `fpl-price-watch`, `entry-sync`, `league-sync`, `live-data`, `manager-live`, `tournament-sync`, `tournament-setup`, `tournament-repair`, `understat-player-sync`, `understat-team-sync`, `maintenance`, `live-picks`, `official-h2h-live`, `my-fpl-orchestration`, `publication-outbox`, `entry-onboarding`, `data-repair`, `housekeeping`, `data-governance` | `content-http-acquisition`, `content-media-transcript`, `content-x-scan` |

BullMQ keys use `bull:<queue>:*`. Completed jobs are retained for 24 hours
(maximum 500 per queue); failed jobs are retained for seven days (maximum 500).
The Understat queues are opened lazily when the feature is enabled.

Non-BullMQ coordination uses the purpose-prefixed
`llm:queue:coordination:*` family. Examples include FPL admission leases,
Understat request permits, tournament cascade barriers, daily entry markers,
launch-notification deduplication, and scheduler lane state. Every key has a
purpose-specific bounded TTL or an explicitly documented durable-marker
lifecycle.

The current key-builder families are:

```text
llm:data:fpl:core:<season>:...
llm:data:fpl:live:<season>:<event>:...
llm:data:fpl:my-fpl:<season>:<event>:active
fpl:price-changes:hot:<season>:...
llm:tournament:preview:...
llm:fpl:admission:...
llm:queue:coordination:...
ops:fpl-admission:telemetry:...
ops:runtime-heartbeat:...
ops:scheduler-progress
ops:queue-health:...
ops:queue-admission:...
ops:queue-monitor-leader:...
```

These families are produced by the existing key builders; adding a new family
requires updating this contract and its ownership/retention rule in the same
change.

## Deliberately uncached in Data

- Understat facts and normalized staging evidence;
- player market history and value changes;
- player season summaries;
- tournament selection and entry-event reporting.

These remain PostgreSQL reads. GraphQL may add a revision-aware query cache, but
that cache cannot become a Data ingestion dependency.

## Safety rules

- Never use `KEYS`, `FLUSHDB`, `FLUSHALL`, or unbounded deletion.
- Cleanup must resolve an exact namespace, use cursor-based bounded `SCAN`,
  record key type/TTL, enforce a maximum count, and delete validated keys with
  bounded `UNLINK` batches.
- A publication writer may retire only keys named by the previously validated
  active manifest.
- Current-season authority is exactly one `fpl.seasons.is_current=true` row;
  Redis and wall-clock inference are not authorities.
