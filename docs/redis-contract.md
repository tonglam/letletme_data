# Redis contract

PostgreSQL is the durable fact/checkpoint store. For Live Points serving,
Redis V2 current/previous is the hot publication authority and is allowed to
outlive a PostgreSQL outage. Redis loss may reduce performance or delay
delivery; it must not delete or replace a canonical business fact.

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

Live Points V2 keys:

```text
llm:data:v2:fpl:live:<season>:<event>:active
llm:data:v2:fpl:live:<season>:<event>:previous
llm:data:v2:fpl:live:<season>:<event>:sequence
llm:data:v2:fpl:live:<season>:<event>:<generation>:eventLive
llm:data:v2:fpl:live:<season>:<event>:<generation>:fixtures

llm:data:v2:fpl:entry-live:<season>:<event>:<entry>:active
llm:data:v2:fpl:entry-live:<season>:<event>:<entry>:previous
llm:data:v2:fpl:entry-live:<season>:<event>:<entry>:sequence
llm:data:v2:fpl:entry-live:<season>:<event>:<entry>:<generation>:input

llm:data:v2:fpl:live:<season>:<event>:checkpoint-desired
llm:data:v2:fpl:live:<season>:<event>:picks-coordinator
llm:data:v2:fpl:live:<season>:<event>:picks-pending
llm:data:v2:fpl:live:<season>:<event>:picks-coverage
llm:data:v2:fpl:entry-live:<season>:<event>:<entry>:checkpoint-desired
```

The global publication items are exactly `eventLive` and `fixtures`. An entry
publication contains one complete `input` item. A V2 manifest is scoped to one
season/event (and, for entry input, one entry), carries a monotonic generation,
and uses the lifecycle states defined by the V2 contract.

An active manifest contains the V2 contract version, publication identity,
generation, scope, lifecycle state, source/publish/checkpoint timestamps,
revision vector, and item metadata. Each item contains `name`, `key`, `type`,
`count`, `bytes`, and `sha256`. Readers validate field sets, scope, key prefix,
Redis type, byte length, count, JSON shape, and digest before accepting a
generation. They either use that complete generation or a coherent fallback;
per-item mixing is forbidden.

Publication lifecycle:

1. Fetch FPL source data coherently and validate the complete candidate.
2. Stage every immutable item with a 15-minute TTL.
3. Verify candidate metadata and scope in one Lua promotion.
4. Atomically move the old active generation to `previous` and promote the candidate.
5. Keep active items during the event and retain `previous` for 24 hours.
6. Record one merged checkpoint obligation for asynchronous PostgreSQL durability; an entry
   checkpoint retries directly from its immutable Redis input.

No-content-change source checks update heartbeat metadata only. They do not
create a new generation, database row, or client refresh. A finalized generation
cannot be superseded by a provisional candidate. A corrupt pointer is ignored
only after the candidate itself passes the complete validation gate.

| State | TTL |
| --- | ---: |
| Active manifest and active items | none |
| Unactivated staging items | 15 minutes |
| Previous generation items | 24 hours (48 hours after final handoff) |

The `checkpoint-desired` key is one latest-wins control-plane obligation per scope. The picks
coordinator and pending/coverage keys are bounded scheduler state; they never contain a second
business payload and are not read by GraphQL to construct a score.

## Cutover seed

Before the breaking deployment, run the Data seed in dry-run mode for the exact season scope:

```bash
bun run db:cutover-seed-live-points-v2 --cache --season 2627 --event-id 2
```

The command validates the legacy durable `fpl:live` publication, converts its event-live and
fixture payloads into a V2 current publication, publishes complete entry inputs from valid
15-row pick sets, and checkpoints them. It never reads the legacy namespace at runtime. Add
`--execute` only inside the maintenance window and set `LIVE_POINTS_SEED_CONFIRM=YES`; malformed
legacy publications fail closed, while malformed entry rowsets go to the durable repair list and
do not receive a fabricated head. The operation is idempotent for an unchanged V2 current
publication and uses the normal V2 generation fence for newer source data.

## GraphQL cache ownership

GraphQL owns these cache families on the cache endpoint:

```text
llm:gql:<dataset-revision>:<query-name>:<args-hash>
llm:gql:security:rate:<scope>:<subject>
```

Data never scans, removes, or writes GraphQL keys during normal operation.
Query invalidation follows the dataset revision and the GraphQL TTL policy.

## BullMQ and coordination on queue Redis

`src/queues/names.ts` is the only queue inventory. It contains 23 names: 20
core queues and three content queues:

| Core queues | Content queues |
| --- | --- |
| `data-sync`, `fpl-critical-sync`, `fpl-price-watch`, `entry-sync`, `league-sync`, `live-data`, `tournament-sync`, `tournament-setup`, `tournament-repair`, `understat-player-sync`, `understat-team-sync`, `maintenance`, `live-picks`, `official-h2h-live`, `my-fpl-orchestration`, `publication-outbox`, `entry-onboarding`, `data-repair`, `housekeeping`, `data-governance` | `content-http-acquisition`, `content-media-transcript`, `content-x-scan` |

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
llm:data:v2:fpl:live:<season>:<event>:...
llm:data:v2:fpl:entry-live:<season>:<event>:<entry>:...
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
