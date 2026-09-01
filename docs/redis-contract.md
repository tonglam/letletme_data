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

Live league V2 publications are Data-owned, immutable tournament/event read
models. Classic has one complete board; H2H has one composite head, one
official standings overlay, and independently replaceable match scopes:

```text
llm:data:v2:fpl:league-live:<season>:<event>:<tournament>:classic:active|previous|sequence|desired|checkpoint-desired
llm:data:v2:fpl:league-live:<season>:<event>:<tournament>:classic:<generation>:index|payload

llm:data:v2:fpl:league-live:<season>:<event>:<tournament>:h2h-head:active|previous|sequence|desired|checkpoint-desired
llm:data:v2:fpl:league-live:<season>:<event>:<tournament>:h2h-match-<matchId>:active|previous|sequence|desired|checkpoint-desired
llm:data:v2:fpl:league-live:<season>:<event>:<tournament>:h2h-standings:active|previous|sequence|desired|checkpoint-desired
llm:data:v2:fpl:league-live:<season>:<event>:<tournament>:h2h-head:<generation>:index|payload
llm:data:v2:fpl:league-live:<season>:<event>:<tournament>:h2h-match-<matchId>:<generation>:index|payload
llm:data:v2:fpl:league-live:<season>:<event>:<tournament>:h2h-standings:<generation>:index|payload

llm:data:v2:fpl:league-live:<season>:<event>:finalization-desired
```

`index` and `payload` are immutable siblings and are accepted only when their
manifest metadata, byte length, and SHA-256 agree. Active pointers have no TTL
during live operation; previous pointers/items retain 24 hours, finalized
siblings retain 48 hours, and the finalization marker retains seven days.
Data alone promotes and checkpoints these keys. GraphQL is read-only and must
select one coherent current/previous/checkpoint publication; it never builds a
league board by reading entry inputs one at a time.

Live Matches V3 uses an independent namespace. It is fed by the same coherent
fixtures/event-live observation as Live Points, but desk and player detail are
separate publications so a detail failure cannot remove an available score
board:

```text
llm:data:v3:fpl:live-match:<season>:active-event

llm:data:v3:fpl:live-match:desk:<season>:<event>:active
llm:data:v3:fpl:live-match:desk:<season>:<event>:previous
llm:data:v3:fpl:live-match:desk:<season>:<event>:sequence
llm:data:v3:fpl:live-match:desk:<season>:<event>:<generation>:desk

llm:data:v3:fpl:live-match:detail:<season>:<event>:active
llm:data:v3:fpl:live-match:detail:<season>:<event>:previous
llm:data:v3:fpl:live-match:detail:<season>:<event>:sequence
llm:data:v3:fpl:live-match:detail:<season>:<event>:<generation>:manifest
llm:data:v3:fpl:live-match:detail:<season>:<event>:<generation>:<fixture>:<sha256>

llm:data:v3:fpl:live-match:checkpoint:<season>:<event>:desk|detail
llm:data:v3:fpl:live-match:checkpoint:<season>:<event>:desk|detail:last
```

The desk contains only fixture identity and score state. Detail is fixture
grain: player points are summed from that fixture's explain block and BPS is
read from that fixture's own stats, which prevents double-gameweek aggregate
duplication. An item key may be reused across detail generations when its
fixture payload hash is unchanged. Readers validate the manifest and every
referenced item before selecting current or previous; detail is served only
when its observed desk generation is not ahead of the selected desk and its
fixture identity revision matches.

Live Matches current pointers have no TTL; previous pointers and replaced
items retain 24 hours, while final publications retain 48 hours. Heartbeat
touches update source/next-check/stale timestamps only and never advance a
generation, client content revision, PostgreSQL row, or checkpoint watermark.
The `checkpoint:*` marker is latest-wins desired state; the `*:last` marker is
the Redis checkpoint watermark used to coalesce non-boundary PostgreSQL writes
to at most one per ten minutes. Final and lifecycle/identity boundary
publications set `force: true`, bypass that window, and are fenced against
supersession. A worker must honor that durable marker even when the previous
checkpoint is recent.

Protected diagnosis and recovery use `POST /ops/live-matches-v3/repair` with
one explicit season/event. An `inspect` request validates active, previous,
desired, and self-contained PostgreSQL checkpoints for both streams. Write
requests require an explicit desk/detail kind, a reason of at least 12
characters, and `confirmation: "LIVE_MATCHES_V3_REPAIR"`; they may only
CAS-promote previous, restore current from the exact checkpoint, or replay the
latest merged checkpoint obligation. The endpoint is protected by the existing
ops API-key guard.

The Live Points V2 global publication items are exactly `eventLive` and
`fixtures`. A Live Points V2 entry publication contains one complete `input`
item. Those global and entry manifests remain V2 and are still read by the V2
publication parser; this document's V3 manifest rules apply only to the Live
Matches desk/detail namespace described above.

An active Live Matches V3 manifest is scoped to one season/event, carries a
monotonic generation, and uses the lifecycle states defined by its own
contract. It contains the V3 contract version, publication identity,
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
bun run db:cutover-seed-live-points-v2 --cache --all-finalized --season 2627 --event-id 2
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

For My Tournament Review V2, the cache dataset revision is the active
`competition.tournament_review_heads.revision` for one
`(season, tournament, event)` scope. Every catalog, gameweek, season, and
status response key also includes the query arguments and has a finite TTL
(60s for catalog, 300s for review/status reads). The cache is a read-through
optimization only: PostgreSQL publication rows and the active head remain the
authority, and a missing/corrupt/expired cache entry is discarded and rebuilt
from that coherent head.

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
llm:data:v3:fpl:live-match:<season>:<event>:...
llm:data:v2:fpl:league-live:<season>:<event>:<tournament>:...
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
