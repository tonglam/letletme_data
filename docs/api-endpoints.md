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
- `GET /players?team=<teamId>&limit=<n>`
- `GET /players/<playerId>`
- `POST /players/sync`
- `DELETE /players/cache`

## Player Stats (`/player-stats`)
- Query params on `GET /player-stats`: `event`, `player`, `team`, `position`, `limit`.
- `GET /player-stats/event/<eventId>`
- `GET /player-stats/player/<playerId>`
- `GET /player-stats/team/<teamId>`
- `GET /player-stats/position/<position>`
- `GET /player-stats/event/<eventId>/player/<playerId>`
- `GET /player-stats/top/<eventId>?limit=<n>`
- `GET /player-stats/analytics`
- `POST /player-stats/sync` and `POST /player-stats/sync/<eventId>`
- `DELETE /player-stats/event/<eventId>`
- `DELETE /player-stats/cache` and `/player-stats/cache/<eventId>`
  ```bash
  curl 'http://43.163.91.9/player-stats?event=10&team=3&limit=20'
  ```

## Player Values (`/player-values`)
- Filters on `GET /player-values`: `event`, `team`, `position`, `changeType`, `sortBy`, `limit`.
- `GET /player-values/event/<eventId>`
- `GET /player-values/player/<playerId>`
- `GET /player-values/team/<teamId>?event=<eventId>`
- `GET /player-values/position/<position>?event=<eventId>`
- `GET /player-values/change-type/<changeType>?event=<eventId>`
- `GET /player-values/date/<YYYYMMDD>`
- `GET /player-values/event/<eventId>/player/<playerId>`
- `GET /player-values/risers/<eventId>?limit=<n>`
- `GET /player-values/fallers/<eventId>?limit=<n>`
- `GET /player-values/analytics?event=<eventId>`
- `GET /player-values/count`
- `POST /player-values/sync` and `POST /player-values/sync/<eventId>`
- `DELETE /player-values/event/<eventId>`
- `DELETE /player-values/cache` and `/player-values/cache/<eventId>`
  ```bash
  curl 'http://43.163.91.9/player-values?changeType=increase&limit=25'
  ```

## Phases (`/phases`)
- `GET /phases`, `GET /phases/<phaseId>`
- `POST /phases/sync`
- `DELETE /phases/cache`

## Entries (`/entries`)
- `GET /entries/<entryId>/info`
- `POST /entries/<entryId>/sync`
  ```bash
  curl http://43.163.91.9/entries/123456/info
  curl -X POST http://43.163.91.9/entries/123456/sync
  ```

## Jobs (`/jobs`)
- `GET /jobs` — list job metadata.
- `POST /jobs/<jobName>/trigger` — job names: `events-sync`, `fixtures-sync`, `teams-sync`, `players-sync`, `player-stats-sync`, `phases-sync`, `player-values-sync`, `entry-info-sync`, `entry-picks-sync`, `entry-transfers-sync`, `entry-results-sync`, `league-event-picks-sync`, `league-event-results-sync`, `tournament-event-picks-sync`, `tournament-event-results-sync`, `tournament-event-transfers-pre-sync`, `tournament-event-transfers-post-sync`, `tournament-event-cup-results-sync`, `tournament-info-sync`, `tournament-points-race-results-sync`, `tournament-battle-race-results-sync`, `tournament-knockout-results-sync`, `event-live-summary-sync`, `event-live-explain-sync`, `event-overall-result-sync`, `event-standings-sync`, `live-scores`.
  ```bash
  curl -X POST http://43.163.91.9/jobs/events-sync/trigger
  ```

> Tip: add `-H 'Content-Type: application/json'` when sending bodies; current endpoints do not require auth.
