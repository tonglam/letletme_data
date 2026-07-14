# API Cheat Sheet

Current production base URL:

- `http://43.163.91.9`

Important:

- `GET` endpoints are public.
- `POST`, `PUT`, `PATCH`, and `DELETE` require an API key in the `x-api-key` header when `ENABLE_AUTH=true`.
- Bootstrap a key once with `bun run auth:create-admin-key` on the server.

## Auth header for mutations

```bash
export API_KEY='llm_...'
curl -X POST http://43.163.91.9/events/sync -H "x-api-key: $API_KEY"
```

## Base

- `GET /`
  - `curl http://43.163.91.9/`
- `GET /health`
  - `curl http://43.163.91.9/health`

## Events

- `GET /events/current`
  - `curl http://43.163.91.9/events/current`
- `GET /events/next`
  - `curl http://43.163.91.9/events/next`
- `POST /events/sync`
  - `curl -X POST http://43.163.91.9/events/sync -H "x-api-key: $API_KEY"`

## Event Lives

- `GET /event-lives/:eventId`
  - `curl http://43.163.91.9/event-lives/1`
- `POST /event-lives/sync/:eventId`
  - `curl -X POST http://43.163.91.9/event-lives/sync/1`
- `POST /event-lives/cache/:eventId`
  - `curl -X POST http://43.163.91.9/event-lives/cache/1`

## Fixtures

- `POST /fixtures/sync`
  - `curl -X POST http://43.163.91.9/fixtures/sync`
- `POST /fixtures/sync?event=:eventId`
  - `curl -X POST 'http://43.163.91.9/fixtures/sync?event=1'`
- `POST /fixtures/sync-all-gameweeks`
  - `curl -X POST http://43.163.91.9/fixtures/sync-all-gameweeks`
- `DELETE /fixtures/cache`
  - `curl -X DELETE http://43.163.91.9/fixtures/cache`

## Teams / Players / Stats / Values / Phases

- `POST /teams/sync`
  - `curl -X POST http://43.163.91.9/teams/sync`
- `POST /players/sync`
  - `curl -X POST http://43.163.91.9/players/sync`
- `POST /player-stats/sync`
  - `curl -X POST http://43.163.91.9/player-stats/sync`
- `POST /player-stats/sync/:eventId`
  - `curl -X POST http://43.163.91.9/player-stats/sync/1`
- `POST /player-values/sync`
  - `curl -X POST http://43.163.91.9/player-values/sync`
- `POST /phases/sync`
  - `curl -X POST http://43.163.91.9/phases/sync`

## Entry

- `POST /entry-info/:entryId/sync`
  - `curl -X POST http://43.163.91.9/entry-info/12345/sync`
- `POST /entry-sync/picks`
  - `curl -X POST http://43.163.91.9/entry-sync/picks -H 'Content-Type: application/json' -d '{"entryIds":[12345,67890],"eventId":1}'`
- `POST /entry-sync/transfers`
  - `curl -X POST http://43.163.91.9/entry-sync/transfers -H 'Content-Type: application/json' -d '{"entryIds":[12345,67890],"eventId":1}'`
- `POST /entry-sync/results`
  - `curl -X POST http://43.163.91.9/entry-sync/results -H 'Content-Type: application/json' -d '{"entryIds":[12345,67890],"eventId":1}'`
- `POST /entry-sync/all`
  - `curl -X POST http://43.163.91.9/entry-sync/all -H 'Content-Type: application/json' -d '{"entryIds":[12345,67890],"eventId":1}'`

## Jobs

- `GET /jobs`
  - `curl http://43.163.91.9/jobs`
- `POST /jobs/:name/trigger`
  - `curl -X POST http://43.163.91.9/jobs/events-sync/trigger`
  - `curl -X POST http://43.163.91.9/jobs/event-lives-db-sync/trigger`
  - `curl -X POST http://43.163.91.9/jobs/live-scores/trigger`

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
