# Redis contract

PostgreSQL is canonical. Redis contains only rebuildable publications, TTL-bound GraphQL query and
security caches, BullMQ state, and bounded worker coordination state.

## Endpoint ownership

| Configuration | Contents | Local database |
| --- | --- | ---: |
| `CACHE_REDIS_*` | Data publications and GraphQL query/security caches | 0 |
| `QUEUE_REDIS_*` | BullMQ and worker coordination | 1 |

Startup rejects identical cache and queue tuples. Understat business data is deliberately not
cached.

## Data publications

Core keys:

```text
llm:data:fpl:core:<season>:active
llm:data:fpl:core:<season>:<revision>:<item>
```

Core items are exactly `events`, `teams`, `players`, `phases`, `fixtures`, and `currentEventId`.

Live keys:

```text
llm:data:fpl:live:<season>:<event>:active
llm:data:fpl:live:<season>:<event>:<revision>:<item>
```

Live items are exactly `eventLives`, `fixtures`, `liveFixtures`, and `liveBonus`. A live manifest
state is `scheduled`, `live`, or `settled`.

The active manifest has this exact top-level field set:

- `dataset`, `seasonCode`, nullable `eventId`, `revision`, and `publicationId`;
- `sourceCheckedAt`, `publishedAt`, and `state`;
- `items`.

Each item contains exactly `name`, `key`, `type`, `count`, `bytes`, and `sha256`. Readers validate
the exact field and item sets, scope, key prefix, Redis type, byte length, count, JSON payload, and
SHA-256 before accepting a publication. A rejected publication falls back to one coherent
PostgreSQL read model; per-item Redis/PostgreSQL mixing is prohibited.

### Publication lifecycle

1. Reserve a monotonically increasing revision in `ops.dataset_publications`.
2. Stage every immutable item with a 15-minute TTL.
3. Persist and validate the complete PostgreSQL scope.
4. Verify all staged keys and atomically replace the active manifest in Lua.
5. Persist accepted items and give replaced items a 24-hour TTL.
6. Mark the database publication active and its predecessor retired.

Repeating the same publication ID is idempotent. Ordering uses `sourceCheckedAt`, then revision; an
older competing candidate cannot replace the active pointer.

| State | TTL |
| --- | ---: |
| Active manifest | none |
| Active items | none |
| Unactivated staged items | 15 minutes |
| Replaced items | 24 hours |

## GraphQL cache ownership

GraphQL owns these DB0 families:

```text
llm:gql:<dataset-revision>:<query-name>:<args-hash>
llm:gql:security:rate:<scope>:<subject>
```

Query invalidation follows dataset revision plus TTL. Data never writes, scans, or removes GraphQL
keys during normal operation.

## BullMQ and coordination

BullMQ uses `bull:<queue>:*` in DB1. The eight owned queues are:

- `data-sync`, `entry-sync`, `live-data`, and `league-sync`;
- `tournament-sync` and `tournament-setup`;
- `understat-team-sync` and `understat-player-sync`.

Understat queues are opened lazily. Their completed jobs retain at most 20 records for seven days;
failed jobs retain at most 50 records for fourteen days.

Non-BullMQ state uses:

```text
llm:queue:coordination:<purpose>
```

Purposes include mutation locks, Understat request permits, tournament cascade barriers, daily
entry-sync markers, and launch-notification deduplication. Coordination keys must use the queue
client and carry a purpose-specific bounded TTL or documented durable-marker lifecycle.

## Deliberately uncached data

- Understat facts and normalized staging evidence;
- player market history and value changes;
- player season summaries;
- tournament selection and entry-event reporting.

These remain PostgreSQL reads. Redis loss may reduce performance, but cannot remove canonical
business data.

## Safety rules

- Never use `KEYS`, `FLUSHDB`, `FLUSHALL`, or unbounded deletion in application code.
- Operational removal resolves an exact namespace with cursor-based `SCAN`, records key type and
  TTL, applies a maximum-count bound, and deletes exact keys with bounded `UNLINK` batches.
- A publication writer may only retire keys named by the previously validated active manifest.
- Current-season authority is exactly one `fpl.seasons.is_current=true` row; Redis and wall-clock
  inference are not authorities.
