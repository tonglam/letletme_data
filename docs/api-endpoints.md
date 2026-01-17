# API Endpoints Cheat Sheet

Base URL (via Nginx proxy): `http://43.163.91.9`

All responses are JSON with `{ success, data?, message?, error? }` depending on handler. Replace placeholders like `<eventId>` with integers.

## Root & Health
- `GET /` — service banner.
  ```bash
  curl http://43.163.91.9/
  ```
- `GET /health` — readiness probe.
  ```bash
  curl http://43.163.91.9/health
  ```

## Events (`/events`)
- `GET /events` — list events.
  ```bash
  curl http://43.163.91.9/events
  ```
- `GET /events/current`, `GET /events/next`, `GET /events/<id>`.
- `POST /events/sync` — trigger sync.
  ```bash
  curl -X POST http://43.163.91.9/events/sync
  ```
- `DELETE /events/cache` — clear cache.

## Event Lives (`/event-lives`)
- `GET /event-lives/event/<eventId>`
- `GET /event-lives/event/<eventId>/element/<elementId>`
- `GET /event-lives/element/<elementId>`
- `POST /event-lives/sync/<eventId>`
  ```bash
  curl -X POST http://43.163.91.9/event-lives/sync/38
  ```
- `DELETE /event-lives/cache/<eventId>` and `DELETE /event-lives/cache`

## Fixtures (`/fixtures`)
- `GET /fixtures`, `/fixtures/<fixtureId>`
- `GET /fixtures/event/<eventId>`
- `GET /fixtures/team/<teamId>`
- `POST /fixtures/sync?event=<eventId>` (query optional)
- `POST /fixtures/sync-all-gameweeks`
- `DELETE /fixtures/cache`
  ```bash
  curl -X POST 'http://43.163.91.9/fixtures/sync?event=10'
  ```

## Teams (`/teams`)
- `GET /teams`, `GET /teams/<teamId>`
- `POST /teams/sync`
- `DELETE /teams/cache`

## Players (`/players`)
- `POST /players/sync`
- `DELETE /players/cache`
> Note: Player read endpoints now live on the primary Player API; this ingest service only handles
> sync triggers and cache management.

## Player Stats (`/player-stats`)
- `POST /player-stats/sync`
- `POST /player-stats/sync/<eventId>`
- `DELETE /player-stats/cache` and `/player-stats/cache/<eventId>`
> Note: Player stats read endpoints now live on the primary Player Stats API; this ingest service only
> handles sync triggers and cache management.

## Player Values (`/player-values`)
- `POST /player-values/sync` and `POST /player-values/sync/<eventId>`
- `DELETE /player-values/cache` and `/player-values/cache/<changeDate>` (YYYYMMDD)
> Note: Player value read endpoints now live on the primary Player API; this ingest service only
> handles sync triggers and cache management.

## Phases (`/phases`)
- `GET /phases`, `GET /phases/<phaseId>`
- `POST /phases/sync`
- `DELETE /phases/cache`

## Entry Info (`/entry-info`)
- `POST /entry-info/<entryId>/sync`
  ```bash
  curl -X POST http://43.163.91.9/entry-info/123456/sync
  ```

## Entry Sync (`/entry-sync`)
- `POST /entry-sync/picks` — trigger entry picks sync queue (optional `{"entryIds":[...]}` body).
- `POST /entry-sync/transfers` — trigger entry transfers sync queue.
- `POST /entry-sync/results` — trigger entry results sync queue.
  ```bash
  curl -X POST http://43.163.91.9/entry-sync/picks -H 'Content-Type: application/json' -d '{"entryIds":[12345,67890]}'
  ```

## Jobs (`/jobs`)
- `GET /jobs` — list job metadata.
- `POST /jobs/<jobName>/trigger` — job names: `events-sync`, `fixtures-sync`, `teams-sync`, `players-sync`, `player-stats-sync`, `phases-sync`, `player-values-sync`, `league-event-picks-sync`, `league-event-results-sync`, `tournament-event-picks-sync`, `tournament-event-results-sync`, `tournament-event-transfers-pre-sync`, `tournament-event-transfers-post-sync`, `tournament-event-cup-results-sync`, `tournament-info-sync`, `tournament-points-race-results-sync`, `tournament-battle-race-results-sync`, `tournament-knockout-results-sync`, `event-live-summary-sync`, `event-live-explain-sync`, `event-overall-result-sync`, `event-standings-sync`, `live-scores`.
  ```bash
  curl -X POST http://43.163.91.9/jobs/events-sync/trigger
  ```

> Tip: add `-H 'Content-Type: application/json'` when sending bodies; current endpoints do not require auth.
