# Data API cheat sheet

Examples use `http://data.internal.example`; substitute the trusted environment URL.

- This is an ingestion/operations API, not the public product API.
- `/health` is process liveness. `/ready` requires PostgreSQL, cache Redis, queue Redis, exactly
  one current row in `fpl.seasons`, fresh scheduler/worker heartbeats, and DB/Redis publication
  consistency (a transient publication mismatch is tolerated for 120 seconds).
- Every `POST`, `PATCH`, and `DELETE` requires `x-api-key` when `ENABLE_AUTH=true`.
- A `202` normally proves enqueueing only. Verify the BullMQ result and PostgreSQL/publication
  state separately.
- Every route resolves the current season from PostgreSQL; callers cannot select it via Redis or
  wall-clock inference.

```bash
export DATA_URL='http://data.internal.example'
export DATA_API_KEY='<secret from the trusted secret manager>'
export DATA_AUTH_HEADER="x-api-key: $DATA_API_KEY"
```

## Base and readiness

```bash
curl "$DATA_URL/"
curl "$DATA_URL/health"
curl "$DATA_URL/ready"
```

## Core and FPL facts

```bash
curl "$DATA_URL/events/current"
curl "$DATA_URL/events/next"

curl -X POST "$DATA_URL/events/sync" -H "$DATA_AUTH_HEADER"
curl -X POST "$DATA_URL/teams/sync" -H "$DATA_AUTH_HEADER"
curl -X POST "$DATA_URL/players/sync" -H "$DATA_AUTH_HEADER"
curl -X POST "$DATA_URL/phases/sync" -H "$DATA_AUTH_HEADER"
curl -X POST "$DATA_URL/fixtures/sync" -H "$DATA_AUTH_HEADER"
```

All five mutation routes enqueue the same complete core snapshot. There is no events-only writer,
event-specific fixture writer, cache-delete endpoint, or 38-request fixture route.

```bash
curl -X POST "$DATA_URL/player-stats/sync" -H "$DATA_AUTH_HEADER"
curl -X POST "$DATA_URL/player-stats/sync/1" -H "$DATA_AUTH_HEADER"
curl -X POST "$DATA_URL/player-values/sync" -H "$DATA_AUTH_HEADER"
```

Player value changes persist in PostgreSQL/reporting; Data does not publish a PlayerValue cache.

## Live event

```bash
curl "$DATA_URL/event-lives/1"
curl -X POST "$DATA_URL/event-lives/cache/1" -H "$DATA_AUTH_HEADER"
curl -X POST "$DATA_URL/event-lives/sync/1" -H "$DATA_AUTH_HEADER"
```

`cache` publishes one coherent live revision. `sync` also persists event-live and explain facts.
Both validate the complete current-season player and fixture identity baseline.

## Official manager live read-through

The GraphQL service uses this protected endpoint for official manager headlines. It is
season-scoped, accepts at most 500 entries, and does not accept caller-supplied league
identities. A tournament ID is checked against the current-season roster; H2H tournaments
return `UNSUPPORTED_H2H_LIVE` and remain on the legacy GraphQL adapter.

```bash
curl -X POST "$DATA_URL/internal/manager-live/resolve" \
  -H "$DATA_AUTH_HEADER" -H 'content-type: application/json' \
  -d '{"eventId":1,"entryIds":[12345,67890],"tournamentId":42}'
```

Rows are published under `OfficialManagerLive:{season}:{event}` with a 48-hour Redis
retention window. Each row exposes `checkedAt` and `staleAt`. Rows outside the stale window
are not returned; callers receive an explicit unavailable result instead of a locally
calculated manager score. This is a forward-only contract: there is no local manager-score
mode or rollback switch; an unavailable row is repaired by refreshing the official
publication.

## Entries

```bash
curl -X POST "$DATA_URL/entry-info/12345/sync" -H "$DATA_AUTH_HEADER"

curl -X POST "$DATA_URL/entry-sync/picks" \
  -H "$DATA_AUTH_HEADER" -H 'content-type: application/json' \
  -d '{"entryIds":[12345,67890],"eventId":1}'

curl -X POST "$DATA_URL/entry-sync/transfers" \
  -H "$DATA_AUTH_HEADER" -H 'content-type: application/json' \
  -d '{"entryIds":[12345,67890],"eventId":1}'

curl -X POST "$DATA_URL/entry-sync/results" \
  -H "$DATA_AUTH_HEADER" -H 'content-type: application/json' \
  -d '{"entryIds":[12345,67890],"eventId":1}'

curl -X POST "$DATA_URL/entry-sync/all" \
  -H "$DATA_AUTH_HEADER" -H 'content-type: application/json' \
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
curl "$DATA_URL/jobs"
curl "$DATA_URL/jobs/status" -H "$DATA_AUTH_HEADER"
curl -X POST "$DATA_URL/jobs/core-snapshot-sync/trigger" -H "$DATA_AUTH_HEADER"
curl -X POST "$DATA_URL/jobs/live-snapshot/trigger" -H "$DATA_AUTH_HEADER"
curl -X POST "$DATA_URL/jobs/player-prices/trigger" \
  -H "$DATA_AUTH_HEADER" -H 'content-type: application/json' \
  -d '{"changeDate":"20260803"}'
```

`GET /jobs` is generated from the scheduler registry and the compatibility
manual adapters; use it as the runtime authority rather than copying a static
schedule list. Compatibility adapters include `core-snapshot-sync`,
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
