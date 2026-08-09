# FPL season readiness and rollover runbook

Use this runbook when official FPL starts publishing a new season or when
deciding which data can be synchronized safely. It deliberately separates two
questions:

1. Does the official upstream endpoint return a usable response now?
2. Has this environment validated, persisted, and cached that data?

An upstream `200` does not prove PostgreSQL or Redis is current. A local empty
table does not prove the upstream endpoint is unavailable.

## External endpoint inventory

The FPL client and history backfill use eleven logical endpoint patterns. Test them read-only with real,
current IDs where required; do not treat an expected pre-publication `404` as a
schema failure.

| Endpoint pattern | Client method | Becomes useful when |
|---|---|---|
| `/bootstrap-static/` | `getBootstrap()` | FPL publishes events, teams, players, and phases |
| `/fixtures/` or `/fixtures/?event={eventId}` | `getFixtures()` | The fixture list or requested GW exists |
| `/event/{eventId}/live/` | `getEventLive()` | The gameweek live feed is published |
| `/element-summary/{elementId}/` | history backfill source (`fixtures`, `history`, `history_past`) | The player element exists; use the preserved per-player history for historical fixture and market fields |
| `/entry/{entryId}/` | `getEntrySummary()` | The entry exists in the new season |
| `/entry/{entryId}/event/{eventId}/picks/` | `getEntryEventPicks()` | Picks for that GW are published |
| `/entry/{entryId}/transfers/` | `getEntryTransfers()` | The entry has a current-season transfer feed |
| `/entry/{entryId}/history/` | `getEntryHistory()` | The entry has current/past history data |
| `/entry/{entryId}/cup/` | `getEntryCup()` | Cup data exists; `404` is handled as unavailable |
| `/leagues-classic/{leagueId}/standings/` | `getLeagueClassicStandings()` | A current classic league ID exists |
| `/leagues-h2h/{leagueId}/standings/` | `getLeagueH2HStandings()` | A current H2H league ID exists |

`/element-summary/{elementId}/` is an upstream historical-data endpoint, not a
separate live feed. It supplies per-player `fixtures`, `history`, and
`history_past`; the `2526` importer consumes a preserved raw mirror of this
shape. The routine runtime `FPLClient` does not call it for every player on
each sync, and the older transformed-source fallbacks (`1617`–`2425`) do not
claim that raw endpoint coverage.

Record the HTTP result, validation result, tested IDs, response counts, and
timestamp for each live audit. Endpoint counts are observations, not durable
configuration.

## Boundary compatibility

Pre-season payloads can contain valid placeholders that would be invalid once
the competition is ranked. Preserve them exactly:

| Domain field | Accepted placeholder | Downstream behavior |
|---|---:|---|
| `Team.strength` | `null` | Unknown; never treated as a strong team or included in a strength range |
| `Team.position` | `0` | Unranked; sorts after ranked teams when points are tied |
| `Fixture.pulseId` | `0` | Not assigned; remains a non-null integer in PostgreSQL |

Migration `0035_allow_preseason_team_strength.sql` makes
`public.teams.strength` nullable. Migration
`0036_align_fpl_runtime_types.sql` aligns the remaining live runtime types.
Apply and verify both migration ledgers before any write.

## Staged synchronization matrix

### Stage 1: core season metadata

This stage is safe once bootstrap and fixtures validate with non-empty core
arrays. It does not require a current gameweek.

| Sync | PostgreSQL target | Redis target | Minimum upstream evidence |
|---|---|---|---|
| Events | `events` | `Season:active`, `Event:{season}` | GW1 has a valid deadline |
| Teams | `teams` | `Team:{season}` | Non-empty teams array validates |
| Fixtures | `event_fixtures` | `Fixtures:{season}:*`, `FixturesByTeam:{season}:*` | Non-empty fixtures array validates |
| Players | `players` | `Player:{season}` | Non-empty elements array validates |
| Phases | `phases` | `Phase:{season}` | Non-empty phases array validates |

Run in this order: events, teams, fixtures, players, phases. Wait for each
BullMQ job to complete. An HTTP `202` means only that the command was queued.

### Stage 2: bound entries and metadata

`entry_infos`, `entry_history_infos`, and `entry_league_infos` depend on known,
current entry IDs. Seed or sync only explicitly bound entries. They are not part
of automatic core-season bootstrap.

### Stage 3: current-event and match data

Wait until a current event exists and the relevant endpoint is published before
enabling or manually triggering:

- player statistics and player values;
- picks, transfers, and per-entry results;
- event-live rows, explanations, summaries, live fixtures, and bonus views;
- league and tournament results or their derived materialized views.

The ordinary cron gates perform these checks, but a manual trigger may bypass a
time window. Manual execution is an operations decision, not proof that
upstream data is ready.

## Write procedure

1. Confirm the target environment and take a read-only count/key inventory.
2. Apply migrations and require `bun run db:migrate:status` to pass.
3. Start both the API and worker processes.
4. Trigger the five Stage 1 syncs in order.
5. Audit job completion and error counts; do not rely only on enqueue responses.
6. Verify PostgreSQL and Redis independently.
7. Sample records, including nullable/zero placeholder fields.
8. Report missing fields or rejected records before advancing to Stage 2 or 3.

Example authenticated triggers:

```bash
export DATA_URL='http://localhost:3000'
export DATA_API_KEY='<plaintext internal key>'

curl -X POST "$DATA_URL/events/sync" -H "x-api-key: $DATA_API_KEY"
curl -X POST "$DATA_URL/teams/sync" -H "x-api-key: $DATA_API_KEY"
curl -X POST "$DATA_URL/fixtures/sync" -H "x-api-key: $DATA_API_KEY"
curl -X POST "$DATA_URL/players/sync" -H "x-api-key: $DATA_API_KEY"
curl -X POST "$DATA_URL/phases/sync" -H "x-api-key: $DATA_API_KEY"
```

## Read-only verification

### PostgreSQL

Run against the intended database using a read-only session or role:

```sql
SELECT 'events' AS table_name, count(*) AS row_count FROM public.events
UNION ALL
SELECT 'teams', count(*) FROM public.teams
UNION ALL
SELECT 'event_fixtures', count(*) FROM public.event_fixtures
UNION ALL
SELECT 'players', count(*) FROM public.players
UNION ALL
SELECT 'phases', count(*) FROM public.phases
ORDER BY table_name;
```

Check placeholder preservation:

```sql
SELECT id, name, position, strength
FROM public.teams
WHERE position = 0 OR strength IS NULL
ORDER BY id;

SELECT id, event_id, pulse_id
FROM public.event_fixtures
WHERE pulse_id = 0
ORDER BY id
LIMIT 20;
```

### Redis

Use `SCAN`, not `KEYS`, in production:

```bash
redis-cli GET Season:active
redis-cli HLEN Event:2627
redis-cli HLEN Team:2627
redis-cli HLEN Player:2627
redis-cli HLEN Phase:2627
redis-cli --scan --pattern 'Fixtures:2627:*' | wc -l
redis-cli --scan --pattern 'FixturesByTeam:2627:*' | wc -l
```

The expected season must come from the accepted GW1 metadata. Replace `2627`
with the observed value; never use the example as an instruction to overwrite
`Season:active`.

## Post-match result readiness

League and tournament result schedulers poll every ten minutes but enqueue only
inside the 24-hour period after the last fixture's expected end
(`kickoff + 2 hours`). Each hour has a deterministic slot:

- `provisional-N` while FPL has not marked event data checked;
- `final-N` after `data_checked=true`.

Successful deterministic jobs are retained for 24 hours to deduplicate repeated
ticks. Failed deterministic jobs are removed so a later tick can retry the same
slot. After an `event_lives` database sync succeeds, the worker enqueues a
distinct final league correction when the event is checked. This keeps league
snapshots aligned with freshly persisted live totals, including the day after
GW38.

Tournament result completion starts its cascade only when active tournament
entries were actually processed. An empty result does not fan out no-op
derivative jobs.

## Audit report template

Report these sections separately:

- **Upstream:** endpoint, tested identifiers, HTTP status, validation status,
  response count, and observation time.
- **PostgreSQL:** target, before/after count, rejected records, and sampled
  placeholder values.
- **Redis:** `Season:active`, hash/key counts by family, stale-season inventory,
  and BullMQ keys kept separate from data caches.
- **Deferred:** every dataset still waiting for a current event, published GW
  data, or explicit entry/league identifiers.
- **Decision:** ready/not ready for each stage, with missing fields listed
  explicitly.

For deletion and stale-season recovery, follow the sign-off rules in the
[Redis contract](redis-contract.md). Never use `FLUSHDB` or `FLUSHALL` as a
season rollover procedure.
