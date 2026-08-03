# Redis Key Contract — letletme_data

**Status:** authoritative inventory of every Redis key this system writes, as of 2026-08-01.
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
   prefixes they own — see §10. That is documented behavior, not a license to
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
| `Fixtures:{season}:{eventId}` | hash | `fixtureId` | Domain `EventFixture` | fixtures sync |
| `Fixtures:{season}:unscheduled` | hash | `fixtureId` | Domain `EventFixture` | fixtures sync |
| `FixturesByTeam:{season}:{teamId}` | hash | `eventId` | Team-fixture view (**see §6**) | fixtures sync |
| `EventLive:{season}:{eventId}` | hash | `elementId` | Domain `EventLive` | live-data sync |
| `EventLiveExplain:{season}:{eventId}` | hash | `elementId` | Domain `EventLiveExplain` | live explain sync |
| `EventLiveSummary:{season}:{eventId}` | hash | `elementId` | Domain `EventLiveSummary` | live summary sync |
| `EventOverallResult:{season}` | hash | `eventId` | Overall-result payload incl. chip data | overall-result sync |
| `LiveFixture:{season}:{eventId}` | hash | `teamId` | `LiveFixtureByStatus` JSON | live-fixture cache job |
| `LiveBonus:{season}:{eventId}` | hash | `teamId` | `{ [elementId]: bonus }` JSON | live-bonus cache job |
| `LiveBonusV2:{season}:{eventId}` | hash | `teamId` | `{ [elementId]: fixture-summed bonus }` JSON | live-bonus cache job |

`{season}` is the FPL season short code, e.g. `2526` (2025/26). The active
season comes from `Season:active` (§2) — writers resolve it at write time via
`getActiveCacheSeason()`. Missing, malformed, or unavailable metadata is an
error; readers and writers never substitute a calendar-derived season.

## 2. Control keys

| Key | Type | Value | Notes |
|---|---|---|---|
| `Season:active` | string | season code, e.g. `2526` | Single source of truth for which `{season}` the entity hashes use. Set when a newer season is detected from events/fixtures. |
| `event:current` | string | Domain `Event` JSON | Denormalized "current gameweek" for hot reads. Refreshed by `events-cache` and the `event-current-refresh` ops trigger; derived from the `Event:{season}` hash. |

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

## 7. Mutation locks (internal)

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

## 8. BullMQ queue keys (internal)

BullMQ stores queue state under `bull:{queueName}:*` on the **queue Redis**
(`QUEUE_REDIS_*`, falling back to `REDIS_*`). Queue names: `data-sync`,
`entry-sync`, `live-data`, `league-sync`, `tournament-sync`,
`tournament-setup`. When `ENABLE_TIERED_MUTATION_QUEUES` is on (default off),
each base queue is replaced by `…-p0` / `…-p1` / `…-p2` / `…-p3` tier queues.
Internal to the worker fleet — do not consume directly.

Post-match league and tournament schedulers use deterministic hourly job IDs.
Successful deterministic jobs remain for 24 hours to deduplicate repeated cron
ticks. Failed deterministic jobs are removed so a later tick can retry the same
slot. This retention applies only to BullMQ job state; it does not change the
entity-key retention rules above.

## 9. Consumers

| Consumer | Keys read | Contact/notes |
|---|---|---|
| `letletme-graphql` | Positive entity hashes, `Season:active`, `event:current`, `LiveBonus*`, `PlayerValue:*` | Public read API; owns only `gql:v2:*` shaped/negative caches plus the coordinated `PlayerValueMissing:*` marker. |
| Data API and workers | All Data-owned hashes, mutation locks, BullMQ keys | Writer/control plane in this repository. |

## 10. Season rollover

### Automatic today (when `Season:active` advances)

Core entity writers call `finalizeSeasonCacheWrite(season, prefixes)`, which:

1. Updates `Season:active` only when the validated FPL-derived season is newer.
2. If (and only if) that value **changed**, expands the cleanup set to the full
   `SEASON_CACHE_PREFIXES` inventory and deletes keys that are not scoped to the
   new active season.

The automatic rollover prefixes are:

| Core metadata | Current-event and entry views |
|---|---|
| `Event` | `EventLive` |
| `Team` | `EventLiveSummary` |
| `Player` | `EventLiveExplain` |
| `Phase` | `LiveFixture` |
| `Fixtures` | `LiveBonus` |
| `FixturesByTeam` | `LiveBonusV2` |
|  | `EventOverallResult` |
|  | `EntryInfo` |
|  | `PlayerStat` |

The first core cache write that advances `Season:active` therefore removes
prior-season keys for all fifteen families in one pass, even if that family is
not part of the current write. This is **not** a full Redis wipe.

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
         EventLive EventLiveExplain EventLiveSummary EventOverallResult \
         LiveFixture LiveBonus LiveBonusV2; do
  echo "$p: $(redis-cli --scan --pattern "$p:$OLD*" | wc -l)"
done
```

**Step 3 — consumer sign-off checklist** (every box required before any DEL)

- [ ] `Season:active` points at the new season and new-season hashes are
      populated (Step 1).
- [ ] Every consumer in §9 has confirmed it no longer reads `<old-season>`
      keys. Until §9 is filled in, that means **Tong explicitly approves the
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
redis-cli --scan --pattern "EventLiveSummary:$OLD:*" | xargs -r redis-cli DEL
redis-cli --scan --pattern "EventOverallResult:$OLD" | xargs -r redis-cli DEL
redis-cli --scan --pattern "LiveFixture:$OLD:*"      | xargs -r redis-cli DEL
redis-cli --scan --pattern "LiveBonus:$OLD:*"        | xargs -r redis-cli DEL
redis-cli --scan --pattern "LiveBonusV2:$OLD:*"      | xargs -r redis-cli DEL
redis-cli --scan --pattern "PlayerStat:$OLD"         | xargs -r redis-cli DEL
```

(All fifteen season-scoped families are normally already gone via the automatic
prefix pass. Delete only the explicit leftovers reported by Step 2.)

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
- `bull:*` — managed by BullMQ (§8).

## 11. Database single-season semantics (FP-21)

The PostgreSQL database stores **one FPL season at a time**:

- `events.id` restarts at 1 each season; a new season's syncs overwrite the
  prior season's rows. There is no `season` column on event or player tables.
- `player_stats` is keyed by `(event_id, element_id)`. Old-event rows remain
  until the same `(event_id, element_id)` pair is overwritten by the new
  season, at which point they naturally become new-season data.
- `PlayerStat:{season}` in Redis is a **latest-event-wins view** (§5). Only
  syncs for the current gameweek write it; older-event backfills persist to
  DB only.

This is an accepted design decision, not a temporary limitation. Multi-season
history would require additive schema changes and explicit consumer demand.
