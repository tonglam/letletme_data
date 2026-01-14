# Unimplemented Jobs Implementation Guide

This guide outlines the remaining (not yet implemented) jobs, grouped by category, with recommended structure and steps for future implementation.

## Matchday Jobs

### `event-live-explain-sync`
- **Status:** ✅ Implemented.
- **No action needed.**

### `event-overall-result-sync`
- **Status:** ✅ Implemented.
- **No action needed.**

### `event-standings-sync`
- **Status:** ✅ Implemented.
- **Checklist:**
  - [x] Pulselive standings client with configurable `compSeason`.
  - [x] `event_standings` schema + migration (truncate + insert latest only).
  - [x] Repository `replaceAll` + cache `EventStandings:season:eventId`.
  - [x] Service: `syncEventStandings()` (map club.abbr → teamId + teamName).
  - [x] Job: cron `0 12 * * *`, gated by `isAfterMatchDay`.
  - [x] Manual job trigger in `/jobs` list.

## Matchday Snapshots (not yet implemented)

### `event-live-summary-sync`
- **Status:** ✅ Implemented.
- **No action needed.**

### `event-live-summary`/`event-live-explain` API
- **Goal:** optional read endpoints for cached summaries/explains.
- **Steps:**
  - Add API route: `GET /event-live-summary/:eventId` + `GET /event-live-explain/:eventId`.
  - Cache‑first (Redis → DB fallback) if persistence is required.

## Selection Window Jobs (Pre‑deadline)

### `league-event-picks-sync`
- **Status:** ✅ Implemented.
- **Checklist:**
  - [x] Use existing `entry_event_picks` storage.
  - [x] Service: `syncLeagueEventPicks(eventId)` with league/tournament entries.
  - [x] Cron: `*/5 * * * *`, gated by `isSelectTime`.
  - [x] Manual trigger wired in `/jobs`.

### `tournament-event-picks-sync`
- **Status:** ✅ Implemented.
- **Checklist:**
  - [x] Reuse `entry_event_picks` storage for tournament entries.
  - [x] Service: `syncTournamentEventPicks(eventId)`.
  - [x] Cron: `*/5 0-4,18-23 * * *`, gated by `isSelectTime`.
  - [x] Manual trigger wired in `/jobs`.

### `tournament-event-transfers-pre-sync`
- **Status:** ✅ Implemented.
- **Checklist:**
  - [x] Service: `syncTournamentEventTransfersPre(eventId)`.
  - [x] Cron: `*/5 0-4,18-23 * * *`, gated by `isSelectTime`.
  - [x] Manual trigger wired in `/jobs`.

## Post‑Matchday Jobs

### `league-event-results-sync`
- **Status:** ✅ Implemented.
- **Checklist:**
  - [x] Schema + repository for `league_event_results`.
  - [x] Service: `syncLeagueEventResults(eventId)`.
  - [x] Cron: `0 8,10,12 * * *`, gated by `isAfterMatchDay`.
  - [x] Manual trigger wired in `/jobs`.

### `tournament-event-results-sync`
- **Status:** ✅ Implemented.
- **Checklist:**
  - [x] Service: `syncTournamentEventResults(eventId)`.
  - [x] Cron: `10 6,8,10 * * *`, gated by `isAfterMatchDay`.
  - [x] Manual trigger wired in `/jobs`.

### `tournament-points-race-results-sync`
- **Status:** ✅ Implemented.
- **Checklist:**
  - [x] Service: `syncTournamentPointsRaceResults(eventId)`.
  - [x] Cron: `20 6,8,10 * * *`, gated by `isAfterMatchDay`.
  - [x] Manual trigger wired in `/jobs`.

### `tournament-battle-race-results-sync`
- **Status:** ✅ Implemented.
- **Checklist:**
  - [x] Service: `syncTournamentBattleRaceResults(eventId)`.
  - [x] Cron: `30 6,8,10 * * *`, gated by `isAfterMatchDay`.
  - [x] Manual trigger wired in `/jobs`.

### `tournament-knockout-results-sync`
- **Status:** ✅ Implemented.
- **Checklist:**
  - [x] Service: `syncTournamentKnockoutResults(eventId)`.
  - [x] Cron: `40 6,8,10 * * *`, gated by `isAfterMatchDay`.
  - [x] Manual trigger wired in `/jobs`.

### `tournament-event-transfers-post-sync`
- **Status:** ✅ Implemented.
- **Checklist:**
  - [x] Service: `syncTournamentEventTransfersPost(eventId)`.
  - [x] Cron: `45 6,8,10 * * *`, gated by `isAfterMatchDay`.
  - [x] Manual trigger wired in `/jobs`.

### `tournament-event-cup-results-sync`
- **Status:** ✅ Implemented.
- **Checklist:**
  - [x] Service: `syncTournamentEventCupResults(eventId)`.
  - [x] Cron: `55 6,8,10 * * *`, gated by `isAfterMatchDay`.
  - [x] Manual trigger wired in `/jobs`.

## Daily Tournament Metadata

### `tournament-info-sync`
- **Status:** ✅ Implemented.
- **Checklist:**
  - [x] Service: `syncTournamentInfo()`.
  - [x] Job: daily 10:45.
  - [x] Manual trigger wired in `/jobs`.

## Implementation Template

For each new job:
1. **Schema + Migration** (if new data table).
2. **Repository** with `replaceAll` or `upsertBatch`.
3. **Service** orchestration (fetch → transform → persist → cache).
4. **Cache** (hash by season/event where applicable).
5. **Job wiring** (cron + manual trigger) + docs update.
