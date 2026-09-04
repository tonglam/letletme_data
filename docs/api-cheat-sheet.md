# Data API cheat sheet

Examples use `http://data.internal.example`; substitute the trusted environment URL.

- This is an ingestion/operations API, not the public product API.
- `/health/live` is process liveness. `/health/ready` reports capability readiness: the Redis-hot
  read path stays available while PostgreSQL is degraded. `/health/deploy` is the strict release
  gate and requires Redis, PostgreSQL, release identity, and worker heartbeats.
- Every `POST`, `PATCH`, and `DELETE` requires `x-api-key` when `ENABLE_AUTH=true`.
- A `202` normally proves enqueueing only. Verify the BullMQ result and PostgreSQL/publication
  state separately.
- Every route resolves the current season from PostgreSQL; callers cannot select it via Redis or
  wall-clock inference.

```bash
export LETLETME_DATA_URL='http://data.internal.example'
export LETLETME_DATA_API_KEY='<secret from the trusted secret manager>'
```

## Base and readiness

```bash
curl "$LETLETME_DATA_URL/"
curl "$LETLETME_DATA_URL/health/live"
curl "$LETLETME_DATA_URL/health/ready"
curl "$LETLETME_DATA_URL/health/deploy"
```

## Core and FPL facts

```bash
curl "$LETLETME_DATA_URL/events/current"
curl "$LETLETME_DATA_URL/events/next"

curl -X POST "$LETLETME_DATA_URL/events/sync" -H "x-api-key: $LETLETME_DATA_API_KEY"
curl -X POST "$LETLETME_DATA_URL/teams/sync" -H "x-api-key: $LETLETME_DATA_API_KEY"
curl -X POST "$LETLETME_DATA_URL/players/sync" -H "x-api-key: $LETLETME_DATA_API_KEY"
curl -X POST "$LETLETME_DATA_URL/phases/sync" -H "x-api-key: $LETLETME_DATA_API_KEY"
curl -X POST "$LETLETME_DATA_URL/fixtures/sync" -H "x-api-key: $LETLETME_DATA_API_KEY"
```

All five mutation routes enqueue the same complete core snapshot. There is no events-only writer,
event-specific fixture writer, cache-delete endpoint, or 38-request fixture route.

```bash
curl -X POST "$LETLETME_DATA_URL/player-stats/sync" -H "x-api-key: $LETLETME_DATA_API_KEY"
curl -X POST "$LETLETME_DATA_URL/player-stats/sync/1" -H "x-api-key: $LETLETME_DATA_API_KEY"
curl -X POST "$LETLETME_DATA_URL/player-values/sync" -H "x-api-key: $LETLETME_DATA_API_KEY"
```

Player value changes persist in PostgreSQL/reporting; Data does not publish a PlayerValue cache.

## Live event

```bash
curl "$LETLETME_DATA_URL/event-lives/1"
curl -X POST "$LETLETME_DATA_URL/event-lives/cache/1" -H "x-api-key: $LETLETME_DATA_API_KEY"
curl -X POST "$LETLETME_DATA_URL/event-lives/sync/1" -H "x-api-key: $LETLETME_DATA_API_KEY"
```

`cache` and `sync` both publish one coherent live revision. The hot path is Redis-first; `sync`
also creates the normal asynchronous PostgreSQL checkpoint obligation. Both validate the complete
current-season player and fixture identity baseline.

## Live Points V2 publication

Live Points is a breaking V2 contract. Data publishes a complete coherent event snapshot and a
per-entry input under the `llm:data:v2:fpl:*` namespace. Redis current is promoted only after
validating event/fixture identity, player roster, item count, bytes, and SHA-256; the previous
complete publication remains in `previous`. PostgreSQL is an asynchronous checkpoint, not part of
the hot read path.

```bash
curl "$LETLETME_DATA_URL/internal/live/status" -H "x-api-key: $LETLETME_DATA_API_KEY"
curl "$LETLETME_DATA_URL/jobs/status" -H "x-api-key: $LETLETME_DATA_API_KEY"
```

The global live lane observes event-live and fixtures together every 30 seconds while an event is
active. A heartbeat updates `sourceCheckedAt` and `expectedNextCheckAt` without creating a new
generation or database write; it advances `publishedAt` only when needed to keep the active
manifest's timestamp order causal. A content change creates one immutable generation and one
merged checkpoint obligation. The reader order is Redis current, Redis previous, GraphQL process
LKG, and then a complete PostgreSQL checkpoint; no request calls FPL, a Data manager API, or a
queue.

Entry picks are a one-time post-deadline canary plus per-entry single-flight publication. Once a
complete same-event V2 input exists, it is not swept again on a ten-minute cohort cadence. If Redis
publishes before PostgreSQL is unavailable, the exact publication remains a Redis desired
checkpoint and is repaired from Redis without refetching FPL.

`sourceCheckedAt` describes the last successful coherent source check; `contentUpdatedAt`
describes the last semantic change; `publishedAt` describes the latest Redis active-manifest
write (promotion or heartbeat); `checkpointedAt`
describes durable completion. Age changes delivery from `FRESH` to `STALE` or `DEGRADED`; it never
deletes a same-event complete last-known-good response.

## Entries

```bash
curl -X POST "$LETLETME_DATA_URL/entry-info/12345/sync" -H "x-api-key: $LETLETME_DATA_API_KEY"

curl -X POST "$LETLETME_DATA_URL/entry-sync/picks" \
  -H "x-api-key: $LETLETME_DATA_API_KEY" -H 'content-type: application/json' \
  -d '{"entryIds":[12345,67890],"eventId":1}'

curl -X POST "$LETLETME_DATA_URL/entry-sync/transfers" \
  -H "x-api-key: $LETLETME_DATA_API_KEY" -H 'content-type: application/json' \
  -d '{"entryIds":[12345,67890],"eventId":1}'

curl -X POST "$LETLETME_DATA_URL/entry-sync/results" \
  -H "x-api-key: $LETLETME_DATA_API_KEY" -H 'content-type: application/json' \
  -d '{"entryIds":[12345,67890],"eventId":1}'

curl -X POST "$LETLETME_DATA_URL/entry-sync/all" \
  -H "x-api-key: $LETLETME_DATA_API_KEY" -H 'content-type: application/json' \
  -d '{"entryIds":[12345,67890],"eventId":1}'
```

`entryIds` accepts 1-100 positive IDs. `eventId` is optional; the worker resolves its bounded
season-scoped target when omitted.

## Tournaments

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/tournaments/check-name?name=...` | Check current-season name availability |
| `GET` | `/tournaments/:id/setup-status` | Read bounded setup progress |
| `POST` | `/tournaments` | Create and enqueue setup |
| `POST` | `/tournaments/:id/setup` | Retry setup |
| `POST` | `/tournaments/:id/roster-sync` | Retry official roster sync |
| `PATCH` | `/tournaments/:id/roster-mode` | Enable official roster sync |
| `PATCH` | `/tournaments/:id/state` | Activate/deactivate |
| `PATCH` | `/tournaments/:id` | Rename |
| `DELETE` | `/tournaments/:id` | Delete after admin verification |

Mutation bodies include the verified `adminEntryId` contract documented by the Web proxy.

## Manual jobs

```bash
curl "$LETLETME_DATA_URL/jobs"
curl "$LETLETME_DATA_URL/jobs/status" -H "x-api-key: $LETLETME_DATA_API_KEY"
curl -X POST "$LETLETME_DATA_URL/jobs/core-snapshot-sync/trigger" -H "x-api-key: $LETLETME_DATA_API_KEY"
curl -X POST "$LETLETME_DATA_URL/jobs/live-snapshot/trigger" -H "x-api-key: $LETLETME_DATA_API_KEY"
curl -X POST "$LETLETME_DATA_URL/jobs/player-prices/trigger" \
  -H "x-api-key: $LETLETME_DATA_API_KEY" -H 'content-type: application/json' \
  -d '{"changeDate":"20260803"}'
```

`GET /jobs` is generated from the scheduler registry and the explicit manual
adapters; use it as the runtime authority rather than copying a static
schedule list. Manual adapters include `core-snapshot-sync`,
`event-current-refresh`, `player-prices`, `player-stats-sync`,
`player-values-sync`, `entry-info-daily`, `entry-event-results-daily`,
`league-event-results-sync`, `tournament-event-results-sync`,
`tournament-selection-stats-sync`, `tournament-info-sync`,
`tournament-materialized-views-refresh`, `live-snapshot`,
`post-match-consolidation`, and `launch-monitor`. Registry names include
`entry-picks`, `entry-transfers`, `entry-results`, `league-event-picks`,
`league-event-results`, `tournament-event-picks`, `tournament-event-results`,
`tournament-transfers-pre`, `core-snapshot`, `market-daily`, `player-stats`,
`live-finalization`, and the maintenance queue jobs shown by `GET /jobs`.

Only names returned by `GET /jobs` are accepted; removed trigger aliases are not recognized.
