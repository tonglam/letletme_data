# Understat 2026/27 Pipeline

Understat is an independent analytics provider. PostgreSQL is the durable source of truth; Redis
contains rebuildable Team and Player read models. Neither Understat lane participates in FPL sync
readiness, and FPL sync code never reads Understat or provider-link tables.

## Activation gate

`UNDERSTAT_ENABLED=false` is the safe default. While disabled, the API registers no Understat cron
jobs, the worker creates no Understat workers, and the client refuses every request before network
I/O. Keep it disabled until automated access is approved and `/getLeagueData/EPL/2026` exposes the
2026/27 season.

The persistence guard rejects seasons before `2627`. The 2025/26 payloads under `tests/fixtures/`
exist only to freeze the data contract; they must not be loaded into production.

Required settings:

```dotenv
UNDERSTAT_ENABLED=false
UNDERSTAT_BASE_URL=https://understat.com
UNDERSTAT_LEAGUE=EPL
UNDERSTAT_SEASON=2627
UNDERSTAT_TIMEOUT_MS=10000
UNDERSTAT_MAX_CONCURRENCY=4
```

## Lanes and schedules

Team and Player have separate BullMQ queues, workers, mutation locks, sync runs/items, and Redis
manifests. Each worker has concurrency 2; the client caps total provider concurrency at 4.

| Lane | Routine | AWST schedule | Scope |
| --- | --- | --- | --- |
| Team | incremental | daily 10:15 | changed-result teams plus missing splits |
| Player | incremental | daily 10:30 | changed/missing participants, new and last-72h matches |
| Team | reconcile | Tuesday 11:00 | all 20 team detail snapshots |
| Player | participants full | Tuesday 11:15 | all team participant snapshots; no match backfill |
| Player | reconcile | daily 11:30 | new/recent matches plus 10 rotating historical matches |

Manual triggers are API-key protected:

- `POST /understat/team/sync`
- `POST /understat/player/sync`
- `GET /understat/status/:season`

Example body:

```json
{
  "season": "2627",
  "mode": "incremental",
  "teamIds": [83],
  "matchIds": [28786]
}
```

`matchIds` applies only to Player. Explicit IDs narrow that resource type; `full` without IDs is a
complete backfill. `/ready` deliberately ignores Understat status.

## Publication and recovery

Every fetched resource is a sync item. A resource may be retried independently and all scoped
replacements are transactional. The run reaches `ready_to_publish` only after every required item
is `completed` or `skipped`; any final failure blocks only that lane's manifest.

An EPL league snapshot must contain 20 teams and 380 matches, and may not drop a previously seen
match ID. Team incremental selection compares Team-owned match-stat hashes; Player selection
compares Player-owned season hashes plus unsynced rosters. This prevents one lane's shared reference
upsert from hiding changes from the other lane. Season participants are monotonic: a snapshot that
drops an observed player fails without deleting the prior rows.

Redis publication writes a hidden generation, verifies hash cardinalities, then atomically switches
`Understat:Snapshot:{season}:{lane}`. Team and Player revisions can differ. The former revision is
kept for 24 hours; publication retries use the same run ID and never expire the active generation.

Recovery procedure:

1. Inspect `GET /understat/status/2627` and identify the failed resource ID.
2. Correct access, schema drift, or provider data first.
3. Trigger `incremental` with explicit team/match IDs, or `reconcile` for broader repair.
4. If only Redis publication failed, a new no-change run republishes from PostgreSQL when no
   manifest exists; otherwise the old complete manifest remains active.
5. Never clear Understat tables or Redis families during a normal retry.

## Provider bridge

Mapping is downstream of both providers and cannot make either sync fail. Confirm the 20 team links
manually, then call `POST /understat/mappings/reconcile`. Match auto-verification requires confirmed
teams, kickoff within 10 minutes, identical final score, and one candidate. Player verification uses
verified match/team context, compatible position, starter/sub status, minutes within two, and exact
goals/own-goals/cards. Names are stored as aliases and evidence only.

Team confirmation is explicit per season through `evidence.confirmedSeasons`; a broad first/last
seen range never counts as confirmation for an intervening season.

Consumers may join only `auto_verified` and `manual_verified`. A later hard conflict moves the link
to `quarantined`; the matcher blocks both identities from automatic rebinding until an operator
reviews the link through the mapping endpoints.

## 2026/27 launch checklist

- Apply migrations `0040` through `0043`; do not run `db:generate`.
- Confirm all new relations have RLS and no `anon`/`authenticated` grants.
- Keep `UNDERSTAT_ENABLED=false` while validating the 2026 endpoint manually.
- After the first completed fixture, run Team full and Player full once.
- Compare all first-round teams, matches, participants, and both match rosters.
- Manually confirm all team links and review every first-round auto-verified player link.
- Require seven days without schema drift, stale lanes, or incorrect links before consumer rollout.
- Enable the production schedules last.
