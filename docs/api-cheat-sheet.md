# API Cheat Sheet

Current production base URL:

- `http://data.internal.example`

Important:

- `GET` endpoints are operational reads, not the public product API. Network
  policy should restrict this service to trusted callers; clients use GraphQL.
- `/health` is process liveness and remains usable during first-deploy recovery.
  `/ready` returns 503 until PostgreSQL, Redis, and the FPL-derived
  `Season:active` key are ready. On a fresh Redis restore, use the authenticated
  `events-sync` trigger to establish the key, then confirm `/ready`.
- `POST`, `PUT`, `PATCH`, and `DELETE` require an API key in the `x-api-key` header when `ENABLE_AUTH=true`.
- Generate a random key outside the service, store its SHA-256 digest in
  `DATA_API_KEY_HASHES`, and store the plaintext only in the trusted caller's
  secret manager. Comma-separated digests allow overlap during rotation.

## Auth header for mutations

```bash
export API_KEY='<secret from your secret manager>'
curl -X POST http://data.internal.example/events/sync -H "x-api-key: $API_KEY"
```

## Base

- `GET /`
  - `curl http://data.internal.example/`
- `GET /health`
  - `curl http://data.internal.example/health`
- `GET /ready`
  - `curl http://data.internal.example/ready`

## Events

- `GET /events/current`
  - `curl http://data.internal.example/events/current`
- `GET /events/next`
  - `curl http://data.internal.example/events/next`
- `POST /events/sync`
  - `curl -X POST http://data.internal.example/events/sync -H "x-api-key: $API_KEY"`

## Event Lives

- `GET /event-lives/:eventId`
  - `curl http://data.internal.example/event-lives/1`
- `POST /event-lives/sync/:eventId`
  - `curl -X POST http://data.internal.example/event-lives/sync/1`
- `POST /event-lives/cache/:eventId`
  - `curl -X POST http://data.internal.example/event-lives/cache/1`

## Fixtures

- `POST /fixtures/sync`
  - `curl -X POST http://data.internal.example/fixtures/sync`
- `POST /fixtures/sync?event=:eventId`
  - `curl -X POST 'http://data.internal.example/fixtures/sync?event=1'`
- `POST /fixtures/sync-all-gameweeks`
  - `curl -X POST http://data.internal.example/fixtures/sync-all-gameweeks`
- `DELETE /fixtures/cache`
  - `curl -X DELETE http://data.internal.example/fixtures/cache`

## Teams / Players / Stats / Values / Phases

- `POST /teams/sync`
  - `curl -X POST http://data.internal.example/teams/sync`
- `POST /players/sync`
  - `curl -X POST http://data.internal.example/players/sync`
- `POST /player-stats/sync`
  - `curl -X POST http://data.internal.example/player-stats/sync`
- `POST /player-stats/sync/:eventId`
  - `curl -X POST http://data.internal.example/player-stats/sync/1`
- `POST /player-values/sync`
  - `curl -X POST http://data.internal.example/player-values/sync`
- `POST /phases/sync`
  - `curl -X POST http://data.internal.example/phases/sync`

## Entry

- `POST /entry-info/:entryId/sync`
  - `curl -X POST http://data.internal.example/entry-info/12345/sync`
- `POST /entry-sync/picks`
  - `curl -X POST http://data.internal.example/entry-sync/picks -H 'Content-Type: application/json' -d '{"entryIds":[12345,67890],"eventId":1}'`
- `POST /entry-sync/transfers`
  - `curl -X POST http://data.internal.example/entry-sync/transfers -H 'Content-Type: application/json' -d '{"entryIds":[12345,67890],"eventId":1}'`
- `POST /entry-sync/results`
  - `curl -X POST http://data.internal.example/entry-sync/results -H 'Content-Type: application/json' -d '{"entryIds":[12345,67890],"eventId":1}'`
- `POST /entry-sync/all`
  - `curl -X POST http://data.internal.example/entry-sync/all -H 'Content-Type: application/json' -d '{"entryIds":[12345,67890],"eventId":1}'`

## Jobs

- `GET /jobs`
  - `curl http://data.internal.example/jobs`
- `POST /jobs/:name/trigger`
  - `curl -X POST http://data.internal.example/jobs/events-sync/trigger`
  - `curl -X POST http://data.internal.example/jobs/event-lives-db-sync/trigger`
  - `curl -X POST http://data.internal.example/jobs/live-scores/trigger`

Supported job names:

- `events-sync`
- `fixtures-sync`
- `teams-sync`
- `players-sync`
- `player-stats-sync`
- `phases-sync`
- `player-values-sync`
- `league-event-picks-sync`
- `league-event-results-sync`
- `tournament-event-picks-sync`
- `tournament-event-results-sync`
- `tournament-event-transfers-pre-sync`
- `tournament-event-transfers-post-sync`
- `tournament-event-cup-results-sync`
- `tournament-info-sync`
- `tournament-points-race-results-sync`
- `tournament-battle-race-results-sync`
- `tournament-knockout-results-sync`
- `event-lives-cache-update`
- `event-lives-db-sync`
- `event-live-summary-sync`
- `event-live-explain-sync`
- `event-overall-result-sync`
- `live-scores`
- `post-match-consolidation`
