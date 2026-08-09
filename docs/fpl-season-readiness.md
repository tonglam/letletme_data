# FPL season readiness and rollover runbook

Use this runbook when FPL starts publishing a new season or when deciding which datasets can be
synchronized safely. Keep these questions separate:

1. Does the official upstream endpoint return a valid response now?
2. Which row is authoritative in `fpl.seasons`?
3. Has this environment persisted and published the accepted dataset?

An upstream `200` proves neither PostgreSQL freshness nor Redis publication. Redis never chooses
the season.

## External endpoint inventory

The FPL client has ten logical endpoint patterns. Test them read-only with real current IDs where
required; an expected pre-publication `404` is not a schema failure.

| Endpoint pattern | Client method | Becomes useful when |
| --- | --- | --- |
| `/bootstrap-static/` | `getBootstrap()` | FPL publishes events, teams, players, phases |
| `/fixtures/` or `/fixtures/?event={eventId}` | `getFixtures()` | The fixture list/requested GW exists |
| `/event/{eventId}/live/` | `getEventLive()` | The gameweek live feed is published |
| `/element-summary/{elementId}/` | history backfill source (`fixtures`, `history`, `history_past`) | The player element exists; use the preserved per-player history for historical fixture and market fields |
| `/entry/{entryId}/` | `getEntrySummary()` | The entry exists in the new season |
| `/entry/{entryId}/event/{eventId}/picks/` | `getEntryEventPicks()` | Picks are published |
| `/entry/{entryId}/transfers/` | `getEntryTransfers()` | The entry transfer feed exists |
| `/entry/{entryId}/history/` | `getEntryHistory()` | Current/past history exists |
| `/entry/{entryId}/cup/` | `getEntryCup()` | Cup data exists; `404` is a valid absence |
| `/leagues-classic/{leagueId}/standings/` | `getLeagueClassicStandings()` | A current classic league exists |
| `/leagues-h2h/{leagueId}/standings/` | `getLeagueH2HStandings()` | A current H2H league exists |

For every probe record HTTP status, schema validation, identifiers, response counts, and timestamp.
Endpoint counts are observations, not configuration.

## Boundary compatibility

Pre-season payloads may contain these valid placeholders:

| Field | Accepted value | Meaning |
| --- | ---: | --- |
| Team `strength` | `null` | Rating not published; never substitute a number |
| Team `position` | `0` | Unranked; sort after ranked teams |
| Fixture `pulse_id` | `0` | Identifier not assigned |

The current v3 schema stores them directly in `fpl.teams` and `fpl.fixtures`.

## Current-season authority

Exactly one row must satisfy `fpl.seasons.is_current=true`. Read it before any write:

```sql
SELECT season_id, season_code, display_name, lifecycle_state, is_current, starts_at, ends_at
FROM fpl.seasons
ORDER BY season_id;
```

A core sync derives the upstream code from GW1 metadata and requires it to equal that current row.
It cannot insert or activate a different season. If upstream has moved ahead:

1. stop ordinary Data writers;
2. capture the outgoing season counts/publication evidence;
3. add or activate the new `fpl.seasons` row through a reviewed Data-owned migration/runbook;
4. prove the transaction leaves exactly one current row;
5. restart Data and run one complete core snapshot.

Do not infer the row from the server date and do not create a Redis manifest manually.

## Staged synchronization

### Stage 1: complete core

One job owns all five physical targets and one immutable Redis revision:

| PostgreSQL target | Core publication item | Required evidence |
| --- | --- | --- |
| `fpl.events` | `events` | 38 unique GW identities; GW1 deadline identifies the expected season |
| `fpl.teams` | `teams` | non-empty, unique team identities |
| `fpl.fixtures` | `fixtures` | complete season feed; normally 380 matches for a 20-team league |
| `fpl.players` | `players` | non-empty, unique player identities linked to teams |
| `fpl.phases` | `phases` | non-empty, unique phase identities |
| — | `currentEventId` | derived from the same accepted events revision |

Trigger any one core alias; all enqueue `core-snapshot-sync`:

```bash
curl -X POST "$DATA_URL/events/sync" -H "x-api-key: $DATA_API_KEY"
```

Wait for the BullMQ result. An HTTP `202` is not completion.

### Stage 2: entries and competition metadata

Entry profiles, season histories, leagues, and tournament rosters use known entry IDs. They are not
part of core bootstrap and must remain scoped to the explicit current season.

### Stage 3: event and reporting facts

Wait for a valid event/upstream publication before triggering:

- player event snapshots and market changes;
- picks, transfers, entry/league/tournament results;
- live gameweek stats, scoring items, and fixture-grain player evidence;
- `reporting.player_season_summaries`;
- tournament materialized views.

`reporting.tournament_selection_stats` refreshes only when every eligible tournament entry has
exactly 15 valid picks and its transfer checkpoint covers the event.

## Independent verification

### PostgreSQL

Replace `2627` with the observed authoritative season code:

```sql
WITH target AS (
  SELECT season_id
  FROM fpl.seasons
  WHERE season_code = '2627'
)
SELECT 'events' AS relation, count(*) AS rows FROM fpl.events WHERE season_id = (SELECT season_id FROM target)
UNION ALL
SELECT 'teams', count(*) FROM fpl.teams WHERE season_id = (SELECT season_id FROM target)
UNION ALL
SELECT 'fixtures', count(*) FROM fpl.fixtures WHERE season_id = (SELECT season_id FROM target)
UNION ALL
SELECT 'players', count(*) FROM fpl.players WHERE season_id = (SELECT season_id FROM target)
UNION ALL
SELECT 'phases', count(*) FROM fpl.phases WHERE season_id = (SELECT season_id FROM target)
ORDER BY relation;
```

Check placeholders without treating them as errors:

```sql
SELECT team_id, name, position, strength
FROM fpl.teams
WHERE season_id = (SELECT season_id FROM fpl.seasons WHERE is_current)
  AND (position = 0 OR strength IS NULL)
ORDER BY team_id;

SELECT fixture_id, event_id, pulse_id
FROM fpl.fixtures
WHERE season_id = (SELECT season_id FROM fpl.seasons WHERE is_current)
  AND pulse_id = 0
ORDER BY fixture_id
LIMIT 20;
```

### Redis publication

Use cache Redis and `SCAN`, never `KEYS`:

```bash
SEASON=2627
MANIFEST_KEY="llm:v3:data:fpl:core:$SEASON:active"

redis-cli GET "$MANIFEST_KEY" | jq .
redis-cli --scan --pattern "llm:v3:data:fpl:core:$SEASON:*"
```

Verify the manifest scope, `schemaVersion=v3`, publication ID, revision, six exact item names, key
types, counts, byte lengths, and SHA-256 evidence. Then confirm every item key belongs to that same
revision. A missing or invalid item rejects the whole publication.

## Post-match readiness

League and tournament result schedulers poll inside the 24 hours after the final fixture's expected
end (`kickoff + 2 hours`). Deterministic hourly `provisional-N`/`final-N` IDs deduplicate successful
ticks while failed jobs remain retryable. The window intentionally remains valid after GW38.

A durable live snapshot persists gameweek stats, scoring items, and fixture evidence and may
enqueue the final league correction after `data_checked=true`. Player season summaries derive from
all persisted gameweeks; there is no physical per-event summary table.

## Audit report

Report these independently:

- **Upstream:** endpoint, identifiers, HTTP/schema result, count, observed time.
- **Authority:** all `fpl.seasons` rows and the one current season.
- **PostgreSQL:** target counts, rejected records, sampled placeholders, source checked time.
- **Redis:** active manifest/revision, item validation, staging/retired leftovers.
- **Deferred:** every dataset waiting for event, entry, league, or publication evidence.
- **Decision:** ready/not ready per stage with explicit blockers.

Use the scoped cleanup contract in [redis-contract.md](redis-contract.md). Never use `FLUSHDB` or
`FLUSHALL` for season rollover.
