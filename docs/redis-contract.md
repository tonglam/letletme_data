# Redis Contract — LetLetMe Data Platform v3

**Status:** authoritative v3 writer/reader contract
**Owner:** `letletme_data` for Data publications and worker coordination
**Schema version:** `v3`

## Invariants

1. PostgreSQL is canonical. Redis contains rebuildable read models and worker state only.
2. `fpl.seasons.is_current` is the sole current-season authority. Redis and wall-clock season
   inference are not authorities.
3. Cache and queue clients must resolve to different host/port/database tuples. Production must
   explicitly configure both `CACHE_REDIS_*` and `QUEUE_REDIS_*`.
4. A Data publication is one immutable revision. Writers stage every item, validate it, and move
   one active manifest pointer atomically.
5. Readers accept every item from one validated manifest or reject the whole revision and use one
   coherent PostgreSQL fallback. Per-item cache/DB mixing is forbidden.
6. Data never writes GraphQL query-cache keys and never scans/deletes GraphQL keys during normal
   operation.
7. `FLUSHDB`, `FLUSHALL`, broad `KEYS`, and unscoped deletion are prohibited.

## Endpoint ownership

| Configuration | Contents | Default local DB |
| --- | --- | ---: |
| `CACHE_REDIS_*` | Rebuildable immutable Data publications | 0 |
| `QUEUE_REDIS_*` | BullMQ and worker coordination/dedupe state | 1 |

Application startup rejects an identical cache and queue endpoint. Cache outages must not corrupt
or block BullMQ state; queue outages must not mutate an active Data publication.

## Data publication namespace

All Data cache keys begin with `llm:v3:data`.

### Core

| Purpose | Key |
| --- | --- |
| Active manifest | `llm:v3:data:fpl:core:{season}:active` |
| Immutable item | `llm:v3:data:fpl:core:{season}:{revision}:{item}` |

Core items are `events`, `teams`, `players`, `phases`, `fixtures`, and `currentEventId`.

### Live event

| Purpose | Key |
| --- | --- |
| Active manifest | `llm:v3:data:fpl:live:{season}:{event}:active` |
| Immutable item | `llm:v3:data:fpl:live:{season}:{event}:{revision}:{item}` |

Live items are `eventLives`, `fixtures`, `liveFixtures`, `liveFixturesV2`, `liveBonus`, and
`liveBonusV2`. The manifest state is `scheduled`, `live`, or `settled`.

`{season}` is a four-digit short code such as `2627`; `{event}` and `{revision}` are positive
integers. Item names are lower camel case. Every item is a JSON string and carries type, count,
UTF-8 byte length, and SHA-256 evidence in the active manifest.

## Manifest contract

An active manifest contains:

- `schemaVersion`, `dataset`, `seasonCode`, and nullable `eventId`;
- monotonic PostgreSQL-reserved `revision` and UUID `publicationId`;
- database-clock `sourceCheckedAt` and diagnostic `publishedAt`;
- optional live `state`;
- the complete item list with `name`, exact `key`, Redis `type`, `count`, `bytes`, and `sha256`.

Readers reject malformed scope, missing items, wrong Redis type, count/size/hash mismatch, invalid
JSON, duplicate item names, or an item key outside the manifest revision prefix.

## Publication and TTL lifecycle

1. Reserve `ops.dataset_publications.revision` and create a `staging` row linked to
   `ops.sync_runs`.
2. Write every immutable item with a 15-minute staging TTL.
3. Complete durable PostgreSQL persistence and revalidate the explicit season/scope.
4. In one Lua operation, verify every staged key and atomically replace the active manifest.
5. Remove staging TTLs from accepted items and give items from the prior revision a 24-hour TTL.
6. Mark the new ops publication `active`, the prior one `retired`, and the run `published`.

Ordering is by `sourceCheckedAt`, then revision. Repeating the same publication ID is idempotent.
An older/equal competing revision is `skipped`, not `failed`. If the process stops after the Redis
swap but before the ops transaction, recovery activates the exact staging row referenced by the
validated manifest; it never manufactures or regresses a revision.

| State | TTL |
| --- | ---: |
| Active manifest | none |
| Active revision items | none |
| Unactivated staging items | 15 minutes |
| Retired revision items | 24 hours |

## Queue and coordination namespace

BullMQ keys remain `bull:{queue}:*`, but exist only on `QUEUE_REDIS_*`. Owned queues are
`data-sync`, `entry-sync`, `live-data`, `league-sync`, `tournament-sync`, and
`tournament-setup`, including optional `-p0` through `-p3` tier suffixes.

Non-BullMQ worker state begins with `llm:v3:queue:coordination:*`, including mutation locks,
tournament cascade barriers, daily entry-sync markers, and launch-notification dedupe. It must not
be written with the cache client.

## Deliberately uncached data

- Understat ingestion writes PostgreSQL and ops evidence only; Data publishes no Understat Redis
  keys.
- Player market history is read from PostgreSQL; `PlayerValue:*` is retired.
- Player season summaries are reporting reads; `EventLiveSummary:*` is retired.
- Tournament selection statistics and tournament entry-event summaries are reporting MVs, not
  Data Redis entities.

GraphQL may own revision-keyed query caches under `llm:v3:gql:*`. Those keys are outside the Data
writer contract and have their own query TTLs.

## Legacy retirement

`src/cache/legacy-cleanup.ts` is the only v2 key-retirement implementation. It:

- defaults to dry-run;
- accepts only immutable, code-defined cleanup groups;
- enumerates with cursor-based `SCAN MATCH`;
- deduplicates and sorts exact keys, then records a SHA-256 key manifest;
- enforces a maximum matched-key bound before any mutation;
- deletes in bounded `UNLINK` batches; and
- contains no `DEL`, `FLUSHDB`, or `FLUSHALL` path.

Cleanup groups are independently gated:

| Group | Scope | Earliest safe point |
| --- | --- | --- |
| `dataCache` | v2 FPL/Understat Data cache and abandoned staging/backup keys | v3 Data + GraphQL readers active |
| `dataCoordination` | old Data dedupe/lock/cascade keys in cache DB | workers stopped and v3 queue state active |
| `graphqlCache` | old `gql:v2`, `player_state`, and `PlayerValueMissing` keys | GraphQL v3 hard cutover verified |
| `legacyQueueDb0` | exact Data/Understat BullMQ queue names left in DB 0 | queue copy/drain verification complete |

The operator must save the dry-run key list/hash, compare it to the cutover inventory, and use the
same groups and safety bound for execution. Unknown keys and every `llm:v3:*` key survive.
