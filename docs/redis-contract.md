# Redis Key Contract — letletme_data

**Status:** authoritative inventory of every Redis key this system writes, as of 2026-07-17.
**Audience:** anyone changing cache code, and every external system that reads this Redis.

## Ground rules (binding)

1. **Every existing key pattern, hash field, and JSON shape below is FROZEN.**
   Multiple known consumer systems read this Redis directly. Fixes must be
   writer-side or reader-side *within* existing shapes.
2. **New data needs → new additive keys only.** Never rename, re-shape, or
   repurpose an existing key, hash field, or JSON property.
3. **Deletions require consumer sign-off** (season rollover, retention). They
   are manual runbooks, never automatic jobs.
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
| `PlayerStat:{season}` | hash | `elementId` | Domain `PlayerStat` | player-stats sync (**see §4**) |
| `EntryInfo:{season}` | hash | `entryId` | Domain `EntryInfo` | entry-info sync |
| `Fixtures:{season}:{eventId}` | hash | `fixtureId` | Domain `EventFixture` | fixtures sync |
| `Fixtures:{season}:unscheduled` | hash | `fixtureId` | Domain `EventFixture` | fixtures sync |
| `FixturesByTeam:{season}:{teamId}` | hash | `eventId` | Team-fixture view (**see §5**) | fixtures sync |
| `EventLive:{season}:{eventId}` | hash | `elementId` | Domain `EventLive` | live-data sync |
| `EventLiveExplain:{season}:{eventId}` | hash | `elementId` | Domain `EventLiveExplain` | live explain sync |
| `EventLiveSummary:{season}:{eventId}` | hash | `elementId` | Domain `EventLiveSummary` | live summary sync |
| `EventOverallResult:{season}` | hash | `eventId` | Overall-result payload incl. chip data | overall-result sync |
| `LiveFixture:{season}:{eventId}` | hash | `teamId` | `LiveFixtureByStatus` JSON | live-fixture cache job |
| `LiveBonus:{season}:{eventId}` | hash | `teamId` | `{ [elementId]: bonus }` JSON | live-bonus cache job |

`{season}` is the FPL season short code, e.g. `2526` (2025/26). The active
season comes from `Season:active` (§2) — writers resolve it at write time via
`getActiveCacheSeason()`.

## 2. Control keys

| Key | Type | Value | Notes |
|---|---|---|---|
| `Season:active` | string | season code, e.g. `2526` | Single source of truth for which `{season}` the entity hashes use. Set when a newer season is detected from events/fixtures. |
| `event:current` | string | Domain `Event` JSON | Denormalized "current gameweek" for hot reads. Refreshed by `events-cache` and the `event-current-refresh` ops trigger; derived from the `Event:{season}` hash. |

## 3. Player values (date-scoped, historical)

| Key pattern | Type | Hash field | Value | Retention |
|---|---|---|---|---|
| `PlayerValue:{YYYYMMDD}` | hash | `elementId` | Domain `PlayerValue` JSON | **No automatic deletion.** One key per price-change date accumulates forever. Retention requires consumer sign-off (manual runbook only). |

## 4. `PlayerStat:{season}` — latest-event-wins view (important)

`PlayerStat:{season}` is a **current view**, not an archive: each stats sync
replaces the *entire* hash (`DEL` + `HSET`) with the stats of the event being
synced. Consumers must read it as "stats as of the latest synced event", never
as per-event history. (FP-12 adds a writer guard so backfills of old events
stop clobbering the view; the read-side semantics are unchanged.)

The misleadingly-named internal helper `clearByEvent(eventId)` also clears the
**whole** hash — it is not per-event. Same guard item.

## 5. `FixturesByTeam:{season}:{teamId}` — one fixture per (team, event)

The hash field is `eventId`, so the shape can hold **only one fixture per team
per event**. In double gameweeks the second fixture overwrites the first.
Fixing this requires a shape change → **deferred**: it will be served from a
new additive key only if a consumer requests it (see fix-plan "Deferred").

Writer-side guard (FP-12): when the `Team:{season}` hash is empty, the writer
skips the delete+rebuild of `FixturesByTeam:*` so a fixtures-before-teams sync
order can't wipe these keys.

## 6. Mutation locks (internal)

| Key pattern | Type | Notes |
|---|---|---|
| `mutation-lock:{scope}` | string | Redlock-style mutex (`SET NX PX` with a random token, TTL from `MUTATION_LOCK_TTL_MS`). Scopes come from `src/domain/mutation-scope.ts` (e.g. `tournament-structure:global`, `entry-event:event:N`). Internal coordination only — **do not read or write from other systems.** |

## 7. BullMQ queue keys (internal)

BullMQ stores queue state under `bull:{queueName}:*` on the **queue Redis**
(`QUEUE_REDIS_*`, falling back to `REDIS_*`). Queue names: `data-sync`,
`entry-sync`, `live-data`, `league-sync`, `tournament-sync`,
`tournament-setup`. When `ENABLE_TIERED_MUTATION_QUEUES` is on (default off),
each base queue is replaced by `…-p0` / `…-p1` / `…-p2` / `…-p3` tier queues.
Internal to the worker fleet — do not consume directly.

## 8. Consumers

> **Pending Tong's inventory** (requested 2026-07-17 in the fix plan). Until it
> is provided, **every key above is treated as externally consumed** and the
> ground rules apply to all of them.

| Consumer | Keys read | Contact/notes |
|---|---|---|
| _TBD_ | _TBD_ | _TBD_ |

## 9. Season rollover

There is **no automatic season rollover cleanup**. Old-season keys
(`*:{oldSeason}*`, `Season:active`, `event:current`) persist until a manual,
sign-off-approved runbook runs. The runbook (key list + checklist) ships with
FP-17; until then: do not delete old-season keys.
