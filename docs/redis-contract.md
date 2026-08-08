# Redis Key Contract — letletme_data

**Status:** authoritative inventory of every Redis key this system writes, as of 2026-08-08.
**Audience:** anyone changing cache code, and every external system that reads this Redis.

## Ground rules (binding)

1. **Every existing key pattern, hash field, and JSON shape below is FROZEN.**
   Multiple known consumer systems read this Redis directly. Fixes must be
   writer-side or reader-side *within* existing shapes.
2. **New data needs → new additive keys only.** Never rename, re-shape, or
   repurpose an existing key, hash field, or JSON property.
3. **Consumer-facing deletions need sign-off** (broader retention, full
   inventory wipe). Prefer manual runbooks. **Exception (current code):** when
   `Season:active` advances, entity writers auto-`DEL` stale keys for the
   prefixes they own — see §11. That is documented behavior, not a license to
   delete other keys or invent new cleanup jobs.
4. When you change anything on this page, update this document in the same PR.

---

## 1. Season-scoped entity hashes

All values are JSON strings; hash fields are decimal IDs as strings. All TTLs
are `-1` (no expiry) — data is refreshed **on write**, never expired.

| Key pattern | Type | Hash field | Value (JSON) | Written by |
|---|---|---|---|---|
| `Event:{season}` | hash | `eventId` | Domain `Event` (camelCase) | events sync |
| `Team:{season}` | hash | `teamId` | Domain `Team` | teams sync |
| `Phase:{season}` | hash | `phaseId` | Domain `Phase` | phases sync |
| `Player:{season}` | hash | `elementId` | Domain `Player` | players sync |
| `PlayerStat:{season}` | hash | `elementId` | Domain `PlayerStat` | player-stats sync (**see §5**) |
| `EntryInfo:{season}` | hash | `entryId` | Domain `EntryInfo` | entry-info sync |
| `Fixtures:{season}:{eventId}` | hash | `fixtureId` | Domain `EventFixture` | fixtures sync; coordinated live snapshot during match windows |
| `Fixtures:{season}:unscheduled` | hash | `fixtureId` | Domain `EventFixture` | fixtures sync |
| `FixturesByTeam:{season}:{teamId}` | hash | `eventId` | Team-fixture view (**see §6**) | fixtures sync |
| `EventLive:{season}:{eventId}` | hash | `elementId` | Domain `EventLive` | coordinated live snapshot; legacy manual live-data sync |
| `EventLiveExplain:{season}:{eventId}` | hash | `elementId` | Frozen legacy explain shape through `savesPoints`; defensive-contribution properties are deliberately omitted | live explain sync |
| `EventLiveExplainV2:{season}:{eventId}` | hash | `elementId` | Complete Domain `EventLiveExplain`, including `defensiveContribution` and `defensiveContributionPoints` | live explain sync |
| `EventLiveSummary:{season}:{eventId}` | hash | `elementId` | Current-event `EventLiveSummary` | live summary sync |
| `EventOverallResult:{season}` | hash | `eventId` | Overall-result payload incl. chip data | overall-result sync |
| `LiveFixture:{season}:{eventId}` | hash | `teamId` | Frozen `LiveFixtureByStatus` JSON | coordinated live snapshot; legacy manual cache job |
| `LiveFixtureV2:{season}:{eventId}` | hash | `teamId` | `LiveFixtureByStatusV2` JSON; every fixture includes `fixtureId` | coordinated live snapshot |
| `LiveBonus:{season}:{eventId}` | hash | `teamId` | Frozen `{ [elementId]: bonus }` JSON | coordinated live snapshot; legacy manual cache job |
| `LiveBonusV2:{season}:{eventId}` | hash | `teamId` | `{ [elementId]: fixture-summed bonus }` JSON | coordinated live snapshot; legacy manual cache job |

`{season}` is the FPL season short code, e.g. `2526` (2025/26). The active
season comes from `Season:active` (§2) — writers resolve it at write time via
`getActiveCacheSeason()`. Missing, malformed, or unavailable metadata is an
error; readers and writers never substitute a calendar-derived season.

## 2. Control keys

| Key | Type | Value | Notes |
|---|---|---|---|
| `Season:active` | string | season code, e.g. `2526` | Single source of truth for which `{season}` the entity hashes use. Set when a newer season is detected from events/fixtures. |
| `event:current` | string | Domain `Event` JSON | Denormalized "current gameweek" for hot reads. Refreshed by `events-cache` and the `event-current-refresh` ops trigger; derived from the `Event:{season}` hash. |
| `LiveSnapshotMeta:{season}:{eventId}` | string | `LiveSnapshotMeta` JSON | Revision/freshness pointer for the six coordinated live hashes; no TTL. See §7. |

## 3. Ops / job-marker keys (internal)

These are **not** season-scoped entity views. They are write-side markers for
jobs and alerts. External consumers should not depend on them, but they are
live Redis state and belong in this inventory.

| Key pattern | Type | Value | TTL | Written by |
|---|---|---|---|---|
| `LaunchNotification:warning:{year}` | string | ISO timestamp | none (`SET NX`) | `src/jobs/launch.jobs.ts` — Telegram pre-season warning dedupe (year-suffixed so it re-arms each pre-season) |
| `LaunchNotification:happening:{season}` | string | ISO timestamp | none (`SET NX`) | `src/jobs/launch.jobs.ts` — Telegram “new season live” dedupe |
| `letletme:entry-info-sync:daily:{YYYY-MM-DD}` | string | JSON `{ ranAt, jobId? }` | seconds until next UTC midnight (min 60s) | `src/jobs/entry-info-sync-marker.ts` via `cache.set` — `cache-operations` prefixes keys with `letletme:` |

## 4. Player values (date-scoped, historical)

| Key pattern | Type | Hash field | Value | Retention / ownership |
|---|---|---|---|---|
| `PlayerValue:{YYYYMMDD}` | hash | `elementId` | Domain `PlayerValue` JSON | **Written by this service.** No automatic retention job — one key per price-change date accumulates forever. Broader retention requires consumer sign-off (manual runbook only). |
| `PlayerValueMissing:{YYYYMMDD}` | *(consumer-owned)* | — | *(consumer-defined)* | **Not written by this service** — an external consumer creates it. A positive `HSET` repair clears the marker only after the real history fields are written; a true no-change run leaves both keys untouched. Explicit cache clearing also removes the matching marker. |

## 5. `PlayerStat:{season}` — latest-event-wins view (important)

`PlayerStat:{season}` is a **current view**, not an archive: each eligible stats
sync builds a complete staging hash and atomically renames it over the entire
view. Consumers must read it as "stats for the current event", or the next event
only when no current event exists, never as per-event history.

Writer rule (FP-12): a sync for the **current event** may write this view. When
there is no current event, the next event may write it for preseason. Historical
and manual backfills persist to the DB only, so they cannot clobber the latest
view (enforced by `shouldWritePlayerStatsView`).

The misleadingly-named internal helper `clearByEvent(eventId)` also clears the
**whole** hash — it is not per-event (documented at the method; the argument
is ignored).

## 6. `FixturesByTeam:{season}:{teamId}` — one fixture per (team, event)

The hash field is `eventId`, so the shape can hold **only one fixture per team
per event**. In double gameweeks the second fixture overwrites the first.
Fixing this requires a shape change → **deferred**: it will be served from a
new additive key only if a consumer requests it (see fix-plan "Deferred").

**Current writer behavior** (`src/cache/fixtures-cache.ts`, FP-12): on fixtures
`set`, the writer rebuilds `FixturesByTeam:{season}:*` from `Team:{season}` +
fixtures. If `Team:{season}` is empty (fixtures-before-teams sync order), it
**skips** the delete+rebuild and logs a warning so ordering cannot wipe the
view; existing keys stay intact until a later sync with teams present.

## 7. Coordinated live snapshot

During an actual match window, one `live-snapshot` job fetches FPL event-live
and fixture responses concurrently and derives these views from that same
accepted upstream pair:

- `EventLive:{season}:{eventId}`
- `Fixtures:{season}:{eventId}`
- `LiveFixture:{season}:{eventId}` (frozen compatibility shape)
- `LiveFixtureV2:{season}:{eventId}` (fixture-safe additive shape)
- `LiveBonus:{season}:{eventId}` (frozen compatibility calculation)
- `LiveBonusV2:{season}:{eventId}` (fixture-scoped calculation)

Before deriving any view, the writer requires both upstream identity sets to be
complete: fixture IDs must match the fixtures persisted for that event, and
event-live element IDs must match the loaded player baseline. Missing,
unexpected, duplicate, mixed-event, or partially transformed data rejects the
whole poll. This prevents a transient truncated FPL response from becoming a
smaller but internally self-consistent published snapshot.

The writer builds uniquely named staging hashes, verifies every field count,
then validates and publishes all six views plus `LiveSnapshotMeta` in one
atomic Lua script. This prevents a partial writer commit: one Redis command sees
the complete previous revision or the complete next revision, never a
delete-first gap or independently timed live jobs. It does **not** make several
consumer commands atomic; publication can occur between two `HGETALL`/`HMGET`
calls. Unlike a Redis `MULTI`/`EXEC` runtime command error, a missing staging
key fails the script before any published key changes. Empty bonus views
deliberately delete the old bonus hash inside the same script; the four required
views refuse empty publication.

Every event refresh also holds `pg_advisory_xact_lock(namespace, eventId)` for
the complete fetch, validation, PostgreSQL persistence, and Redis publication
flow. This PostgreSQL-owned lock is mandatory and survives Redis lock expiry or
configuration changes; different events remain parallel. After the lock is
held, PostgreSQL `clock_timestamp()` supplies the shared `checkedAt` ordering
token before the upstream requests begin, so host clock skew cannot make a
newer serialized poll appear older. As a second fence, the Redis publisher
compares that token both before staging and inside the commit script. Lua honors
only metadata that satisfies the complete schema and canonical timestamp shape;
malformed JSON values are replaced rather than becoming permanent fences.

Consumers that combine two or more live views MUST use this retry protocol:

1. Read and validate `LiveSnapshotMeta` immediately before the first live-view
   command.
2. Read every required view and validate its fields/cardinality against the
   metadata counts. A required view may not fall back independently.
3. Read metadata fresh again after the final live-view command.
4. Accept the calculation only when both metadata reads exist and have the same
   revision. If the revision advanced, discard every value and retry the whole
   calculation once from fresh metadata.
5. If metadata disappears or becomes malformed, a view is incomplete, sibling
   roots finish on different revisions, or publication advances again during
   the retry, discard every Redis candidate and run the whole event calculation
   from one PostgreSQL fallback mode. Never mix a DB fixture with Redis live or
   bonus rows.

`letletme-graphql` implements this contract in its live snapshot coordinator,
including a sibling-root barrier before GraphQL exposes any candidate. Writer
or reader changes to this protocol must update and test both repositories.
The old `event-lives-cache`, `event-lives-db`, `live-fixture-cache`,
`live-bonus-cache`, and `live-scores` queue names are compatibility aliases:
new calls enqueue `live-snapshot`, and workers route any old waiting entries
through the same complete publisher. No supported job may replace one published
live view independently while snapshot metadata exists.
This ownership boundary is also enforced inside the compatibility cache
helpers: replacing or clearing `Fixtures`, `EventLive`, `LiveFixture`,
`LiveBonus`, or `LiveBonusV2` performs an atomic metadata-existence check and
leaves the hash untouched when `LiveSnapshotMeta:{season}:{eventId}` exists.
The daily/full fixture refresh still upserts PostgreSQL, rebuilds
`FixturesByTeam`, and refreshes events without snapshot metadata, but preserves
all snapshot-owned event hashes. Only the coordinated publisher (or explicit
season cleanup that removes metadata and its views together) may change them.
If FPL moves a fixture to a different event, either an event-specific or full
fixture sync compares the accepted fixture identities with their prior database
ownership. Fixture syncs first enter a mandatory global advisory lane, then
take every prior and destination event lock in numeric order. While those locks
are held, the writer atomically deletes `LiveSnapshotMeta` plus all six
coordinated views before changing database ownership. Readers
therefore observe either the old complete snapshot or a complete miss and use
the documented PostgreSQL fallback; they never consume a stale partial event.
Retirement-before-upsert also keeps retries safe: a Redis failure leaves the
old database owner discoverable, while a later database failure leaves only a
safe cache miss that the next snapshot can rebuild.
When a fixture becomes unscheduled, its nullable PostgreSQL `event_id` is also
set to `NULL` before scheduled rows are upserted. The retired event therefore
cannot keep the moved fixture in its next expected-identity baseline.
Transient staging keys use `{target}:staging:{uuid}`, expire after fifteen
minutes if a worker is terminated, and are deleted on every success or handled
failure. The atomic rename removes that temporary TTL from published hashes;
season rollover is the final recovery cleanup.

`LiveSnapshotMeta` is JSON with this additive contract:

| Property | Meaning |
|---|---|
| `schemaVersion` | Integer contract version; currently `1` |
| `season`, `eventId` | Snapshot scope |
| `revision` | First 24 hexadecimal characters of a deterministic SHA-256 over all six view contents |
| `state` | `scheduled`, `live`, or `settled` |
| `publishedAt` | When football content last changed or a missing required view was repaired |
| `checkedAt` | When the upstream pair was last accepted, including no-change polls |
| `eventLiveCount`, `fixtureCount`, `fixtureTeamCount`, `bonusTeamCount` | Bounded completeness/diagnostic counts |

No live hash or metadata key expires. A revision-identical poll verifies the
exact published hash contents (not only cardinality), updates only `checkedAt`,
and does not rewrite the large hashes unless an independent compatibility
writer damaged a view. When football content
changes, fixture rows (roughly ten per event) are persisted after staging
validation and before the atomic Redis swap; a failed DB write therefore leaves
the old revision published and remains retryable. The much larger event-live
and explain rows are persisted every ten minutes and during post-match
consolidation. PostgreSQL remains canonical recovery/history data; Redis is the
low-latency coherent read model.

The one-minute job owns the optional Redis mutation scope
`live-snapshot:event:{eventId}`. Legacy live jobs share that scope and remain
only as recovery compatibility paths; normal cron scheduling must not run them
in parallel. Correctness does not depend on this expiring lease: the mandatory
PostgreSQL advisory lock described above is the final per-event serializer.

## 8. Mutation locks (internal)

| Key pattern | Type | Notes |
|---|---|---|
| `mutation-lock:{scope}` | string | Redlock-style mutex (`SET NX PX` with a random token, TTL from `MUTATION_LOCK_TTL_MS`). Scopes come from `src/domain/mutation-scope.ts` (e.g. `tournament-structure:global`, `entry-event:event:N`). Internal coordination only — **do not read or write from other systems.** |

Tournament result cascades also use short-lived internal coordination keys:

| Key pattern | Type | TTL | Notes |
|---|---|---:|---|
| `tournament-cascade:meta:{cascadeId}` | string | 24h | Expected structure participant count |
| `tournament-cascade:structure-done:{cascadeId}:{jobKey}` | string | 24h | Idempotent success or enqueue-failure slot per structure job |
| `tournament-cascade:refresh-pending:{cascadeId}` | string | 24h | Structure barrier completed; materialized-view refresh is pending |
| `tournament-cascade:refresh-enqueued:{cascadeId}` | string | 24h | Durable refresh-enqueued marker |
| `tournament-cascade:refresh-lease:{cascadeId}` | string | 120s | Recoverable lease around refresh enqueue |

These are worker coordination state, not consumer data. They expire
automatically and must not be included in season cleanup.

## 9. BullMQ queue keys (internal)

BullMQ stores queue state under `bull:{queueName}:*` on the **queue Redis**
(`QUEUE_REDIS_*`, falling back to `REDIS_*`). Queue names: `data-sync`,
`entry-sync`, `live-data`, `league-sync`, `tournament-sync`,
`tournament-setup`, `understat-team-sync`, and `understat-player-sync`. When
`ENABLE_TIERED_MUTATION_QUEUES` is on (default off), each of the first six FPL
base queues is replaced by `…-p0` / `…-p1` / `…-p2` / `…-p3` tier queues.
Understat's two queues remain lane-specific and are not tiered. All BullMQ
keys are internal to the worker fleet — do not consume them directly.

Post-match league and tournament schedulers use deterministic hourly job IDs.
Successful deterministic jobs remain for 24 hours to deduplicate repeated cron
ticks. Failed deterministic jobs are removed so a later tick can retry the same
slot. This retention applies only to BullMQ job state; it does not change the
entity-key retention rules above.

## 10. Consumers

| Consumer | Keys read | Contact/notes |
|---|---|---|
| `letletme-graphql` | Positive entity hashes, `Season:active`, `event:current`, `LiveSnapshotMeta:*`, `LiveFixtureV2:*`, `LiveBonus*`, `PlayerValue:*` | Public read API; owns only `gql:v2:*` shaped/negative caches plus the coordinated `PlayerValueMissing:*` marker. |
| Data API and workers | All Data-owned hashes, mutation locks, BullMQ keys | Writer/control plane in this repository. |

## 11. Season rollover

### Atomic core publication (when `Season:active` advances)

The core-snapshot worker publishes only after complete bootstrap and fixture
validation. It:

1. reserves a monotonic PostgreSQL revision before fetching;
2. stages every core hash with a 15-minute TTL;
3. validates every staging key inside one Redis Lua publication before any key
   is replaced;
4. records one `CoreSnapshotPublication:pending` recovery receipt and keeps
   bounded backups until the matching PostgreSQL authority row commits;
5. finalizes the backups on commit, or atomically restores them on rollback or
   the next worker recovery pass;
6. clears stale keys across the full `SEASON_CACHE_PREFIXES` inventory only
   after the core DB/cache publication is consistent.

The Redis swap checks `LiveSnapshotMeta:{season}:{eventId}` in the same Lua
operation. A fixture hash owned by a published Live snapshot is excluded from
the core receipt, backup, and replacement, while the remaining non-Live core
families still publish atomically. The separately managed Live pipeline remains
the only writer allowed to replace that event's coordinated fixture view.

A candidate for a different season stops before mutation with
`CORE_SNAPSHOT_MANUAL_ROLLOVER_REQUIRED`. Canonical table replacement is
destructive and remains a separately approved runbook, outside ordinary sync.

The automatic rollover prefixes are:

| Core metadata | Current-event and entry views |
|---|---|
| `Event` | `EventLive` |
| `Team` | `EventLiveSummary` |
| `Player` | `EventLiveExplain` |
|  | `EventLiveExplainV2` |
| `Phase` | `LiveFixture` |
| `Fixtures` | `LiveBonus` |
| `FixturesByTeam` | `LiveBonusV2` |
|  | `LiveFixtureV2` |
|  | `LiveSnapshotMeta` |
|  | `EventOverallResult` |
|  | `EntryInfo` |
|  | `PlayerStat` |

The first core cache write that advances `Season:active` therefore removes
prior-season keys for all eighteen families in one pass, even if that family
is not part of the current write. This is **not** a full Redis wipe.

### Not auto-deleted

These keys are outside `SEASON_CACHE_PREFIXES` and must not be assumed gone
after rollover:

- `PlayerValue:{YYYYMMDD}` (explicit no-auto-delete retention policy).
- `PlayerValueMissing:{YYYYMMDD}` (consumer-owned; Data clears the matching
  marker only after a positive history write or an explicit clear; see §4).
- `event:current` (overwritten in place from the active Event hash).
- Ops markers (`LaunchNotification:*`, `letletme:entry-info-sync:*`).
- `mutation-lock:*`, `tournament-cascade:*`, and BullMQ `bull:*` keys.

### Manual rollover recovery runbook (FP-17)

Manual deletion is a recovery path for a bypassed or failed automatic rollover,
not an ordinary season-start step. It always requires consumer sign-off.

**When to run:** only after `Season:active` has advanced, the first full core
sync (events, teams, fixtures, players, phases) has completed, and the read-only
inventory still shows old-season keys.

**Step 1 — verify the new season is live (read-only)**

```bash
redis-cli GET Season:active            # => new season code, e.g. 2627
redis-cli HLEN Event:<new-season>      # > 0
redis-cli HLEN Team:<new-season>       # = 20
redis-cli HLEN Player:<new-season>     # > 0
```

**Step 2 — inventory old-season leftovers (read-only)**

```bash
OLD=<old-season>   # e.g. 2526
for p in Event Team Player Phase PlayerStat EntryInfo Fixtures FixturesByTeam \
         EventLive EventLiveExplain EventLiveExplainV2 EventLiveSummary EventOverallResult \
         LiveFixture LiveFixtureV2 LiveBonus LiveBonusV2 LiveSnapshotMeta; do
  echo "$p: $(redis-cli --scan --pattern "$p:$OLD*" | wc -l)"
done
```

**Step 3 — consumer sign-off checklist** (every box required before any DEL)

- [ ] `Season:active` points at the new season and new-season hashes are
      populated (Step 1).
- [ ] Every consumer in §10 has confirmed it no longer reads `<old-season>`
      keys. Until §10 is filled in, that means **Tong explicitly approves the
      deletion** — all keys are treated as externally consumed.
- [ ] The old season's tournaments/leagues have fully concluded (no late
      entry-sync or tournament-result jobs still reading old-season live
      hashes).
- [ ] A backup exists if any consumer might need old-season data later
      (`redis-cli --rdb` snapshot or a per-key `DUMP` export).

**Step 4 — delete (manual, old season only)**

Delete **only** the leftover old-season keys from Step 2. Never use
`FLUSHDB`/`FLUSHALL`; prefer `--scan` batches over `KEYS` in production:

```bash
redis-cli --scan --pattern "Event:$OLD"              | xargs -r redis-cli DEL
redis-cli --scan --pattern "Team:$OLD"               | xargs -r redis-cli DEL
redis-cli --scan --pattern "Player:$OLD"             | xargs -r redis-cli DEL
redis-cli --scan --pattern "Phase:$OLD"              | xargs -r redis-cli DEL
redis-cli --scan --pattern "Fixtures:$OLD:*"         | xargs -r redis-cli DEL
redis-cli --scan --pattern "FixturesByTeam:$OLD:*"   | xargs -r redis-cli DEL
redis-cli --scan --pattern "EntryInfo:$OLD"          | xargs -r redis-cli DEL
redis-cli --scan --pattern "EventLive:$OLD:*"        | xargs -r redis-cli DEL
redis-cli --scan --pattern "EventLiveExplain:$OLD:*" | xargs -r redis-cli DEL
redis-cli --scan --pattern "EventLiveExplainV2:$OLD:*" | xargs -r redis-cli DEL
redis-cli --scan --pattern "EventLiveSummary:$OLD:*" | xargs -r redis-cli DEL
redis-cli --scan --pattern "EventOverallResult:$OLD" | xargs -r redis-cli DEL
redis-cli --scan --pattern "LiveFixture:$OLD:*"      | xargs -r redis-cli DEL
redis-cli --scan --pattern "LiveFixtureV2:$OLD:*"    | xargs -r redis-cli DEL
redis-cli --scan --pattern "LiveBonus:$OLD:*"        | xargs -r redis-cli DEL
redis-cli --scan --pattern "LiveBonusV2:$OLD:*"      | xargs -r redis-cli DEL
redis-cli --scan --pattern "LiveSnapshotMeta:$OLD:*" | xargs -r redis-cli DEL
redis-cli --scan --pattern "PlayerStat:$OLD"         | xargs -r redis-cli DEL
```

(All eighteen season-scoped families are normally already gone via the
automatic prefix pass. Delete only the explicit leftovers reported by Step 2.)

**Step 5 — verify**

- [ ] The Step 2 inventory prints `0` for every prefix.
- [ ] Consumers report healthy reads on new-season keys.

**Explicitly NOT cleaned up (retention by agreement, never by job):**

- `PlayerValue:{YYYYMMDD}` — historical price data; stays until Tong and
  consumers agree on a retention window. No automatic retention job, ever.
- `PlayerValueMissing:{YYYYMMDD}` — consumer-owned; this service clears it only
  after a positive history write or an explicit clear of the matching date (§4).
- `Season:active`, `event:current` — live control keys; `event:current` is
  overwritten in place, nothing to clean.
- `LaunchNotification:*` — re-arms per year/season by design (§3).
- `letletme:entry-info-sync:daily:*`, `mutation-lock:*`, and
  `tournament-cascade:*` — expire via TTL.
- `bull:*` — managed by BullMQ (§9).

## 12. Understat isolated read models

Understat is a separate provider and never writes the FPL `Season:active`,
`Team:*`, `Player:*`, or Live families. PostgreSQL is authoritative; these
Redis hashes are rebuildable snapshots.

| Key pattern | Type | Hash field / value | Retention |
|---|---|---|---|
| `Understat:Season:active` | string | Configured active Understat season | No TTL |
| `Understat:Snapshot:{season}:team` | string | Team manifest JSON | No TTL |
| `Understat:Snapshot:{season}:player` | string | Player manifest JSON | No TTL |
| `Understat:Team:{season}:{revision}` | hash | `teamId` → `{ team, season }` JSON | Active revision no TTL; retired 24h |
| `Understat:Match:{season}:{revision}` | hash | `matchId` → match JSON | Active revision no TTL; retired 24h |
| `Understat:TeamMatches:{season}:{revision}` | hash | `teamId` → `{ stat, match }[]` JSON | Active revision no TTL; retired 24h |
| `Understat:TeamSplits:{season}:{revision}` | hash | `teamId` → split rows JSON | Active revision no TTL; retired 24h |
| `Understat:Player:{season}:{revision}` | hash | `playerId` → summary and memberships JSON | Active revision no TTL; retired 24h |
| `Understat:TeamParticipants:{season}:{revision}` | hash | `teamId` → participant rows JSON | Active revision no TTL; retired 24h |
| `Understat:PlayerMatches:{season}:{revision}` | hash | `playerId` → `{ stat, match }[]` JSON | Active revision no TTL; retired 24h |
| `Understat:RateLimit:leases` | sorted set | Cross-replica request permits | Lease TTL only |

Consumers first read `Understat:Snapshot:{season}:{lane}`, then use exactly
the revision named by that manifest. Team and Player manifests are independent
and may point to different revisions. New generation hashes are staged with a
one-hour TTL, cardinality-checked, and made durable in the same transaction
that switches the lane manifest. The prior generation then receives a 24-hour
TTL. A 2526 backfill does not change `Understat:Season:active` when the
configured active season is 2627.

When a valid preseason generation has no match rows, the corresponding match
hash contains the reserved `__empty__` field with JSON value `[]`; consumers
must treat that field as an empty hash rather than a data row.

Understat worker locks use the existing
`mutation-lock:understat:{lane}:...` family plus the shared
`mutation-lock:understat:reference:{season}` discovery/publication scope. Queue state is under
`bull:understat-team-sync:*` and `bull:understat-player-sync:*`. None of these
internal keys is a consumer data source. See the
[Understat pipeline document](understat-pipeline.md) for value shapes,
publication gates, and recovery.

## 13. FPL current and historical database semantics (FP-21)

The unsuffixed PostgreSQL provider tables store **one current FPL season at a
time**. Before a new season may replace them, the outgoing season must be
copied and sealed in the season-partitioned history tables:

- `events.id` restarts at 1 each season. Current event, team, player, phase,
  fixture, stats, live, value, market-snapshot, and fixture-evidence datasets
  retain their established unsuffixed names.
- `fpl_season_archives` and `fpl_season_archive_items` record archive status,
  row counts, checksums, and verification. A sealed season is read from the
  twelve `<core_table>_history` parents; PostgreSQL partition pruning selects its
  physical season partition.
- The resolver reads unsuffixed tables only when the requested season equals
  `core_snapshot_authority.season`. A sealed older season reads history. An
  unavailable or unsealed season returns unavailable and never falls back to
  current rows.
- FPL history is sealed for `1617`, `1718`, `1819`, `1920`, `2021`, `2122`,
  `2223`, `2324`, `2425`, and `2526`; `2627` remains the current unsuffixed
  season. `2526` was backfilled from preserved raw `event live`,
  `element-summary`, fixture-stat, and core snapshots. `1617`–`2425` use the
  preserved Vaastav per-gameweek transformed fallback where raw
  `element-summary` JSON was not available. Every sealed season has archive
  item row-count/checksum and historical-FK validation. Source-unavailable
  fields such as historical status/news/chance, ownership percentages, or
  old fixture identifiers remain explicitly unknown/proxied in the archive
  reason; they are never presented as current Redis state. The `1617` and
  `1718` team names were repaired from their preserved FPL team codes. The
  `2627` team dimension is also seeded into `teams_2627`, but the season remains
  `building` until the other historical partitions are backfilled and sealed.
- A blank gameweek does not reduce the season fixture total: for example,
  `2223` keeps all 38 event rows and 380 fixtures, with GW7 containing zero
  fixtures and later double/multiple gameweeks absorbing the postponed
  matches. Player-event/live row counts must not be read as fixture counts.
- `player_stats` is keyed by `(event_id, element_id)`. Old-event rows remain
  current-season data until the separately approved rollover; its sealed copy
  is keyed by season as well.
- `PlayerStat:{season}` in Redis is a **latest-event-wins view** (§5). Only
  syncs for the current gameweek write it; older-event backfills persist to
  DB only.
- `player_market_snapshots` keeps one complete daily roster through the
  current season and is included in the sealed archive. The current table is
  changed only by the separately approved rollover; never mix two seasons to
  manufacture a comparison window.
- Entry, league, and tournament tables are outside this provider archive and
  are not modified by the archive job.

Read-only inventory before the season reset:

```sql
SELECT min(snapshot_date) AS first_date,
       max(snapshot_date) AS latest_date,
       count(DISTINCT snapshot_date) AS observed_days,
       count(*) AS rows
FROM player_market_snapshots;
```

The archive job never clears or renames current tables. Cross-domain cleanup
after sealing remains a separately approved manual rollover.
