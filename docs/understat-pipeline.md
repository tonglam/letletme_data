# Understat pipeline

Status: authoritative runtime and storage contract.

Understat uses an independent DB-first ingestion pipeline and publishes no business-data cache.

## 1. Locked boundaries

1. PostgreSQL is the only source of truth for Understat business data and sync evidence.
2. Team and Player are independent ingestion lanes with separate BullMQ queues, jobs, workers, and
   `ops.sync_runs` rows.
3. Understat and FPL never share provider tables, clients, queues, or sync state.
4. Cross-provider analysis is allowed only through verified rows in the `bridge` schema.
5. Data publishes no Understat Redis read model and has no Understat cache manifest, revision, TTL,
   or cache fallback.
6. Redis is used only for BullMQ and short-lived worker coordination on `QUEUE_REDIS_*`.
7. A detail/discovery job stages normalized evidence; only a lane finalizer may mutate Understat
   business facts.
8. A finalizer commits one complete snapshot transaction or no business changes at all.

The staged JSON in `ops.sync_items.normalized_payload` is normalized evidence, not a byte-for-byte
HTTP raw-response archive. Immutable raw capture, if required, belongs to the separate Understat
pipeline task and must not introduce a second business-data authority.

## 2. Upstream client

The client validates parsed payloads from these provider routes:

| Resource | Route |
| --- | --- |
| League discovery | `/getLeagueData/{league}/{sourceYear}` |
| Team detail | `/getTeamData/{teamTitle}/{sourceYear}` |
| Match roster | `/getMatchData/{matchId}` |

The client applies schema validation, timeout handling, retry classification, and concurrency
permits. Provider permits use the queue-coordination key
`llm:queue:coordination:understat-request-permits`; they never use the Data cache endpoint.

## 3. Runtime controls

| Variable | Purpose |
| --- | --- |
| `UNDERSTAT_ENABLED` | Enables API validation and Understat workers. Default `false`. |
| `UNDERSTAT_BASE_URL` | Provider base URL. |
| `UNDERSTAT_LEAGUE` | Provider league, currently `EPL`. |
| `UNDERSTAT_MIN_SEASON` | Oldest accepted four-digit season code. |
| `UNDERSTAT_SEASON` | Newest/active accepted season code. |
| `UNDERSTAT_TIMEOUT_MS` | Provider request timeout. |
| `UNDERSTAT_MAX_CONCURRENCY` | Provider-wide request-permit limit. |

Season acceptance comes from these explicit Understat settings. It is independent of
`fpl.seasons.is_current`; neither wall-clock inference nor a Redis key decides the Understat season.
The two BullMQ clients are created only after an accepted explicit sync or after the enabled worker
passes its feature-flag gate. With the default `UNDERSTAT_ENABLED=false`, importing either process
does not open an Understat queue connection.

## 4. Queues and jobs

| Lane | Queue | Jobs |
| --- | --- | --- |
| Team | `understat-team-sync` | `understat-team-discover`, `understat-team-detail`, `understat-team-finalize` |
| Player | `understat-player-sync` | `understat-player-discover`, `understat-player-team-detail`, `understat-player-match`, `understat-player-finalize` |

All Understat jobs take the provider-reference mutation scope. This serializes shared season/team/
match mutations across both lanes and replicas. Detail jobs also take a resource-specific scope.

When `UNDERSTAT_ENABLED=true`, the scheduler runs only incremental lanes on the UTC+8 staggered
schedule: Team at 11:15 and Player at 12:15. Full and reconcile modes remain API/manual-only. A
30-minute maintenance job reconciles active runs that have made no database progress for 30
minutes; it defers while either Understat queue still has waiting, delayed, active, or paused work.

## 5. Durable run and staging state

Understat uses the shared operations tables:

### `ops.sync_runs`

- `provider = 'understat'`
- `lane = 'team' | 'player'`
- `scope = 'understat.team' | 'understat.player'`
- explicit `season_code`, mode, trigger, counters, timestamps, error, and metadata
- scheduler `obligationId` and `obligationGeneration` when launched by the daily scheduler;
  finalizer completion is the only successful obligation evidence

### `ops.sync_items`

The primary key is `(run_id, resource_type, resource_id)`. A completed item stores:

- `source_hash`: SHA-256 of the normalized staging envelope;
- `normalized_payload`: the complete normalized envelope needed by the finalizer;
- attempts, status, error, and completion timestamps.

Resource types are:

| Lane | Resource types |
| --- | --- |
| Team | `league`, `team-detail` |
| Player | `league`, `team-participants`, `match-roster` |

The shared ops status `ready_to_publish` means “all required staging items settled and ready for the
Understat finalizer.” It does not mean Redis publication. A successful Understat finalizer moves the
run to `completed`; an incomplete but internally valid snapshot moves it to `skipped`. The status
response includes each run's `updatedAt` plus lane-level `stale` and `recovery` fields.

## 6. Staging envelope contract

Every staged payload contains:

```json
{
  "kind": "team-league",
  "season": "2526",
  "capturedAt": "2026-08-09T00:00:00.000Z",
  "data": {}
}
```

Before finalization, the reader verifies:

- payload exists and is an object;
- SHA-256 equals `source_hash`;
- kind and season match the sync item;
- arrays and required object fields have the expected shape;
- serialized dates rehydrate as valid timestamps;
- team/match identity inside each detail payload matches its resource key.

A mismatch is a hard failure before any business fact is written.

## 7. Team lane

1. Discovery fetches and validates the full league payload.
2. It computes changed/missing team-detail targets from PostgreSQL evidence.
3. It creates every `ops.sync_items` row before marking league discovery complete.
4. Discovery stages normalized season, teams, matches, team match stats, and team-season summaries.
5. Each detail job reads the staged league item, validates provider dates, and stages one team's
   seven split dimensions.
6. When all items settle, one finalizer job is enqueued.
7. The discovery graph is persisted before detail fanout so every detail resource has its foreign-key
   parents available.
8. Each team detail job hash-verifies and commits its own split resource in a short PostgreSQL
   transaction. A complete team is visible without waiting for other teams.
9. The finalizer replays any staged resources idempotently, records incomplete teams, and completes
   the run with partial-resource metadata instead of rolling back successful teams.

For EPL, the shared discovery requires exactly 20 teams and 380 matches. A team resource is complete
when its season summary, all seven split dimensions, and its team-stat row for each completed match
involving that team are present. An unavailable current-season team does not block other teams.

## 8. Player lane

1. Discovery fetches the league payload and stages player-season summaries plus shared references.
2. Team detail jobs stage participant identities and per-team player-season rows.
3. Match jobs stage complete rosters for selected completed matches.
4. Discovery is persisted before detail fanout. Each team-participant and match-roster resource is
   committed independently after its own completeness check.
5. The finalizer replays staged resources idempotently, records incomplete teams/matches, and refreshes
   the Player State read model after the run is settled.

For EPL, player summaries are shared discovery facts. A team-participant resource requires non-empty
participant rows whose players exist in the league discovery; a match-roster resource requires 11
starters on both sides. Preseason matches are retained but require no roster until `is_result = true`.

## 9. PostgreSQL business model

### `understat`

| Table | Grain |
| --- | --- |
| `seasons` | one provider season |
| `teams` | one durable provider team identity |
| `players` | one durable provider player identity |
| `matches` | one provider match |
| `team_seasons` | season + team |
| `team_match_stats` | match + team |
| `team_stat_splits` | season + team + dimension + split key |
| `player_seasons` | season + player |
| `player_team_seasons` | season + player + team |
| `player_match_stats` | match + roster row |

The 0090 Understat runtime integration migration adds provider-pair idempotency and makes
`player_team_seasons` reference season and team independently. This lets the Player lane ingest its
own participant facts without depending on a Team-lane aggregate row.

### `bridge`

| Table | Purpose |
| --- | --- |
| `entity_links` | Team/player provider identity links and review evidence |
| `match_links` | Season-scoped Understat match to FPL fixture links |
| `entity_aliases` | Observed provider aliases used by matching rules |

Verified links are unique on both provider sides. Pending, ambiguous, quarantined, rejected, and
manual-review states remain explicit; no name-only join is silently promoted to verified.

## 10. Idempotency and correction rules

- Provider rows carry deterministic source hashes.
- Unchanged hashes do not rewrite business rows.
- Run and item identities are stable across retries.
- A completed/skipped item is not fetched again on the same run retry.
- Match disappearance is rejected; a result-to-non-result correction removes lane-owned detail rows
  inside the discovery transaction.
- Team and Player runs may complete at different times. Consumers must not claim cross-lane atomicity.
- A failed or incomplete resource cannot replace that resource's previous complete rows, while other
  successfully completed resources remain available.
- A completeness skip retries the current scheduler generation after 30 minutes, up to three
  generations; the third incomplete generation ends that day as `skipped`.
- A terminal provider/schema failure ends the current scheduler obligation immediately. A terminal
  retryable failure starts a fresh generation, while old-generation completion/failure is fenced by
  the obligation generation.

## 11. Redis contract

There are no Understat business/cache keys, manifests, generations, active-season pointers, or
publication TTLs in Data.

Allowed Redis state is limited to `QUEUE_REDIS_*`:

- BullMQ keys for the two Understat queues;
- `llm:queue:coordination:understat-request-permits`.

Cross-process mutation coordination is PostgreSQL-owned. Writers acquire the sorted
`ops.mutation_scopes` rows inside the same transaction as their canonical writes; no Redis
mutation coordination key is authoritative.

GraphQL may later add a bounded, revision-aware query cache for the few Understat pages, but that
cache is GraphQL-owned and cannot become a Data ingestion dependency.

## 12. Internal HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/understat/team/sync` | Enqueue Team lane sync |
| POST | `/understat/player/sync` | Enqueue Player lane sync |
| GET | `/understat/status/:season` | PostgreSQL run/resource status |
| POST | `/understat/mappings/team` | Manually verify a team link |
| POST | `/understat/mappings/reconcile` | Re-run provider matching |
| GET | `/understat/mappings/:season` | Review links for a season |
| PATCH | `/understat/mappings/entity/:id` | Review entity-link status |
| PATCH | `/understat/mappings/match/:id` | Review match-link status |

The status response declares `storage: 'postgresql'` and `dataCache: 'disabled'`. It reports Team
and Player runs independently and counts facts directly from the provider tables.

## 13. Failure and recovery

- Provider/schema/hash/identity failures leave facts untouched and follow BullMQ retry policy.
- A terminal detail failure marks that item failed; the run does not finalize.
- A finalizer infrastructure or constraint error marks the run failed after terminal retry.
- A resource completeness failure leaves that resource untouched, records it in partial-run metadata,
  and does not roll back other completed resources. A detail worker leaves an incomplete resource
  item unsettled; after terminal BullMQ retry, the failed resource ID is carried into the next
  scheduler generation instead of allowing the generation to succeed. Scheduler-backed detail
  incompleteness uses the 30-minute completeness recovery delay and records completeness evidence
  when the generation limit is reached.
- Player discovery rejects empty, duplicate, or shrinking player-summary sets before replacing
  season summaries. Player-team persistence likewise rejects duplicate or shrinking participant
  sets before replacing memberships.
- The worker records terminal item/run failure before throwing; the BullMQ `failed` listener is an
  idempotent fallback. If a run is active with no database progress for 30 minutes and both queues
  are empty, the maintenance reconciler fails unfinished items and the run in one transaction.
- Recovery retries or starts a new scoped run. It does not truncate provider tables or clear Redis.
- PostgreSQL backup/restore is the recovery path for durable Understat data; Redis restoration is not.

## 14. Acceptance criteria

- Typecheck, lint, format, unit tests, integration tests, and build pass.
- Staging round-trip, timestamp hydration, hash tampering, season mismatch, and resource identity
  tests pass.
- Fresh PG15 migration applies once and is a no-op on the second execution.
- Each complete Team detail resource and Player team/match resource commits independently.
- Incomplete current-season resources remain retryable without hiding already committed resources.
- Incomplete Team and Player snapshots preserve the prior complete facts byte-for-byte.
- Runtime source contains no Understat Data cache client/key/manifest/publication path.
- Permit clients resolve only to `QUEUE_REDIS_*`; mutation coordination resolves to PostgreSQL
  `ops.mutation_scopes` and never depends on Redis.
- No FPL archive service, duplicate schema, duplicate job, API, or table-name routing is introduced.
