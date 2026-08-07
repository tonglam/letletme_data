# Understat 2025/26 backfill and 2026/27 pipeline

Understat is an independent analytics provider. PostgreSQL is the durable source of truth; Redis
contains rebuildable Team and Player read models. Neither Understat lane participates in FPL sync
readiness, and FPL sync code never reads Understat or provider-link tables.

## Activation gate

`UNDERSTAT_ENABLED=false` and `UNDERSTAT_SCHEDULES_ENABLED=false` are the safe defaults. Disabling
the provider prevents workers and HTTP requests. Enabling the provider while leaving schedules off
allows authenticated, operator-controlled historical backfills without registering cron jobs.

The persistence window starts at `2526`. Understat 2025/26 is a durable historical provider
dataset; it is not deleted after validation. The fixtures under `tests/fixtures/` are reduced
contract samples, not a substitute for the persisted source dataset. A 2526 run never changes
`Understat:Season:active`, because the configured active season is `2627`.

Required settings:

```dotenv
UNDERSTAT_ENABLED=false
UNDERSTAT_SCHEDULES_ENABLED=false
UNDERSTAT_BASE_URL=https://understat.com
UNDERSTAT_LEAGUE=EPL
UNDERSTAT_MIN_SEASON=2526
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
replacements are transactional. The client makes one HTTP attempt; BullMQ provides at most three
total attempts and honors provider `Retry-After`. Each lane has worker concurrency 2, while a Redis
lease semaphore caps aggregate HTTP concurrency across replicas at 4. The run reaches
`ready_to_publish` only after every required item is `completed` or `skipped`; any final failure
blocks only that lane's manifest.

An EPL league snapshot must contain 20 teams and 380 matches, and may not drop a previously seen
match ID. Team incremental selection compares Team-owned match-stat hashes; Player selection
compares Player-owned season hashes plus unsynced rosters. This prevents one lane's shared reference
upsert from hiding changes from the other lane. Season participants are monotonic: a snapshot that
drops an observed player fails without deleting the prior rows.

Redis publication writes a hidden generation, verifies hash cardinalities, then atomically switches
`Understat:Snapshot:{season}:{lane}`. A Team snapshot must contain all 20 teams, 380 matches, both
team-stat sides for every result, and all seven split dimensions for every team. A first Player
snapshot additionally requires all 20 participant snapshots and both 11-player starting sides for
every completed match. A partial smoke run is recorded as `completed` with
`publicationSkipReason`; it never replaces a complete manifest. Team and Player revisions can
differ. The former revision is kept for 24 hours; publication retries use the same run ID and never
expire the active generation.

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
goals/own-goals/cards across at least two distinct verified matches. Missing per-fixture FPL
`starts` remains `null` and does not invent starter evidence. Names are stored as aliases and
candidate evidence only.

Team confirmation is explicit per season through `evidence.confirmedSeasons`; a broad first/last
seen range never counts as confirmation for an intervening season.

Consumers may join only `auto_verified` and `manual_verified`. A later hard conflict moves the link
to `quarantined`; the matcher blocks both identities from automatic rebinding until an operator
reviews the link through the mapping endpoints.

FPL 2025/26 is explicitly `unavailable`: the provider snapshot was not persisted before rollover,
so no 2526 bridge matching or `not_observed` result is produced. FPL history starts in 2026/27.
Current provider tables keep their existing unsuffixed names. Once all 38 events, all 380 fixtures,
all finished flags, and all 38 final live consolidations are present, `/fpl/archive/2627` copies the
12 FPL-owned datasets into LIST-partitioned history tables. It compares counts, both row sets,
checksums and historical foreign keys before sealing. A sealed season is immutable and a repeated
archive request is a no-op. Entry, league and tournament tables are never modified by this job.

## 2025/26 durable landing runbook

Keep schedules disabled throughout this backfill. Run the two lanes independently and inspect
`GET /understat/status/2526` after each step.

1. Apply migrations `0043` through `0055` in ledger order. Do not run `db:generate`.
2. Team smoke: enqueue `full` with Arsenal team ID `83`. Verify 20 teams, 380 completed matches,
   760 team-match rows, 20 team-season rows, 38 Arsenal dates, all seven Arsenal split dimensions,
   and no Team manifest.
3. Team full: enqueue `full` without IDs. Verify every team has 38 history rows, every team has all
   seven non-empty split dimensions, and publish the complete Team manifest.
4. Player smoke: enqueue `full` with `teamIds=[83]` and `matchIds=[28786]`. Verify Arsenal has 25
   season participants; match 28786 has 31 roster rows (15 home, 16 away) and 11 starters per side;
   no Player manifest may be published.
5. Player full: enqueue `full` without IDs. Verify 537 player-season rows, 551 player-team-season
   memberships, 14 players with multiple team memberships, and source-identical rosters for all
   380 matches before publishing the Player manifest.
6. Run a second `full`/`reconcile`. Unchanged business rows must not update, and no new cache
   revision is created.
7. Keep all 2526 PostgreSQL rows and both 2526 Redis manifests. Do not create any 2526 provider
   mapping because the FPL side is unavailable.

The live source contract was last checked on 2026-08-07 and returned exactly the counts above.

## 2026/27 launch checklist

- Apply migrations `0050` through `0055`; do not run `db:generate`.
- Confirm all new relations have RLS and no `anon`/`authenticated` grants.
- Keep `UNDERSTAT_ENABLED=false` while validating the 2026 endpoint manually.
- After the first completed fixture, run Team full and Player full once.
- Compare all first-round teams, matches, participants, and both match rosters.
- Manually confirm all team links and review every first-round auto-verified player link.
- Require seven days without schema drift, stale lanes, or incorrect links before consumer rollout.
- Enable the production schedules last.
