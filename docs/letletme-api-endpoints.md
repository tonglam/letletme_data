# letletme-api (Port 3200)

Base host: `http://43.163.91.9:3200` (served by `letletme-api.service`).
All versioned endpoints live under `/v1`. Swagger reference responds at `/swagger`.

## System
- `GET /v1/health` — service + dependency health summary.
- `GET /v1/version` — API name/version/environment.

## Entries (`/v1/entries`)
- `GET /` — list matches (filters: `limit`, `offset`, `tournamentId`, `playerId`, `status`, `round`).
- `GET /:id` — single entry detail.
- `POST /` — create a match entry.
- `PUT /:id` — replace entry fields.
- `PATCH /:id/score` — update score/winner/status.
- `DELETE /:id` — delete entry.

## Events (`/v1/events`)
- `GET /current-with-deadline` — current event metadata + next UTC deadline.
- `GET /average-scores` — per-event average scores.

## Fixtures (`/v1/fixtures`)
- `GET /next-gameweek` — fixtures (with team data) for upcoming GW.

## Leagues (`/v1/leagues`)
- `GET /?season=<YYYY>` — league names for a season.

## Live (`/v1/live`)
- `GET /matches` — live matches (optional `tournamentId`).
- `GET /matches/:id` — specific live match.
- `PATCH /matches/:id/score` — update live score/status.
- `PATCH /matches/:id/statistics` — update stats payload.
- `GET /courts` — courts status (optional `tournamentId`).

## Notices (`/v1/notices`)
- `GET /mini-program` — WeChat mini program notice text.

## Players (`/v1/players`)
- `GET /` — players list (filters: `limit`, `offset`, `search`, `country`).
- `GET /:id` — single player profile.
- `GET /:id/stats` — player stats record.
- `POST /` — create player.
- `PUT /:id` — update player fields.
- `DELETE /:id` — delete player.

## Statistics (`/v1/statistics`)
- `GET /tournaments/:id` — tournament level stats.
- `GET /players/:id` — player stats (optional `tournamentId`).
- `GET /head-to-head?player1Id=&player2Id=&tournamentId=` — head-to-head stats.
- `GET /rankings?limit=&offset=` — ranking table.

## Summaries (`/v1/summaries`)
- `GET /tournaments/:id` — tournament summary object.

## Teams (`/v1/teams`)
- `GET /?season=<YYYY>` — team list + metadata for a season.

## Tournaments (`/v1/tournaments`)
- `GET /` — list tournaments.
- `GET /:id` — tournament detail.
- `POST /` — create tournament.
- `PUT /:id` — update tournament.
- `DELETE /:id` — delete tournament.
