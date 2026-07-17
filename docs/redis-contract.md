# Redis Key Contract — letletme_data

**Status:** authoritative inventory of every Redis key this system writes, as of 2026-07-17.
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

`{season}` is the FPL season short code, e.g. `2526` (2025/26). The active
season comes from `Season:active` (§2) — writers resolve it at write time via
`getActiveCacheSeason()`.

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
| `PlayerValueMissing:{YYYYMMDD}` | *(consumer-owned)* | — | *(consumer-defined)* | **Not written by this service** — an external consumer creates it. **This service deletes it** on every `playerValuesCache.set` / `clear` for that date (`src/cache/player-values-cache.ts`), defensively, whenever the real `PlayerValue:{date}` hash is refreshed or cleared. Freeze/sign-off rules still apply: do not rename or repurpose the key; the delete-on-refresh behavior is part of the contract. |

## 5. `PlayerStat:{season}` — latest-event-wins view (important)

`PlayerStat:{season}` is a **current view**, not an archive: each stats sync
replaces the *entire* hash (`DEL` + `HSET`) with the stats of the event being
synced. Consumers must read it as "stats as of the latest synced event", never
as per-event history.

**Current writer behavior:** any event sync (including backfills) can replace
the whole view.

**Planned (FP-12, not yet implemented):** writer guard so only the current
event may rewrite the cache; old-event syncs write DB only. Read-side
semantics stay "latest synced event wins" once FP-12 lands.

The misleadingly-named internal helper `clearByEvent(eventId)` also clears the
**whole** hash — it is not per-event. Same FP-12 guard item.

## 6. `FixturesByTeam:{season}:{teamId}` — one fixture per (team, event)

The hash field is `eventId`, so the shape can hold **only one fixture per team
per event**. In double gameweeks the second fixture overwrites the first.
Fixing this requires a shape change → **deferred**: it will be served from a
new additive key only if a consumer requests it (see fix-plan "Deferred").

**Current writer behavior** (`src/cache/fixtures-cache.ts`): on fixtures
`set`, the writer always scans `FixturesByTeam:{season}:*`, `DEL`s those keys,
then rebuilds from `Team:{season}` + fixtures. If `Team:{season}` is empty
(fixtures-before-teams sync order), the rebuild is empty and the keys are
**wiped**.

**Planned (FP-12, not yet implemented):** when `Team:{season}` is empty, skip
the delete+rebuild so that ordering cannot wipe `FixturesByTeam:*`.

## 7. Mutation locks (internal)

| Key pattern | Type | Notes |
|---|---|---|
| `mutation-lock:{scope}` | string | Redlock-style mutex (`SET NX PX` with a random token, TTL from `MUTATION_LOCK_TTL_MS`). Scopes come from `src/domain/mutation-scope.ts` (e.g. `tournament-structure:global`, `entry-event:event:N`). Internal coordination only — **do not read or write from other systems.** |

## 8. BullMQ queue keys (internal)

BullMQ stores queue state under `bull:{queueName}:*` on the **queue Redis**
(`QUEUE_REDIS_*`, falling back to `REDIS_*`). Queue names: `data-sync`,
`entry-sync`, `live-data`, `league-sync`, `tournament-sync`,
`tournament-setup`. When `ENABLE_TIERED_MUTATION_QUEUES` is on (default off),
each base queue is replaced by `…-p0` / `…-p1` / `…-p2` / `…-p3` tier queues.
Internal to the worker fleet — do not consume directly.

## 9. Consumers

> **Pending Tong's inventory** (requested 2026-07-17 in the fix plan). Until it
> is provided, **every key above is treated as externally consumed** and the
> ground rules apply to all of them.

| Consumer | Keys read | Contact/notes |
|---|---|---|
| _TBD_ | _TBD_ | _TBD_ |

## 10. Season rollover

### Automatic today (when `Season:active` changes)

Entity writers call `finalizeSeasonCacheWrite(season, prefixes)`, which:

1. Updates `Season:active` if the write season is newer.
2. If (and only if) that value **changed**, calls `clearStaleSeasonCache` to
   `DEL` keys under the given prefixes that are **not** for the new active
   season.

Prefixes currently passed in by writers:

| Prefixes | Call site family |
|---|---|
| `Event` | events cache |
| `Team` | teams cache |
| `Player` | players cache |
| `Phase` | phases cache |
| `Fixtures`, `FixturesByTeam` | fixtures cache |

So on a real season transition, the **next** sync for those entities can delete
prior-season `Event:*`, `Team:*`, `Player:*`, `Phase:*`, `Fixtures*`, and
`FixturesByTeam*` keys automatically. This is **not** a full Redis wipe.

### Not auto-deleted today

Examples that **do not** go through the prefix cleanup above (and must not be
assumed gone after rollover):

- `PlayerValue:{YYYYMMDD}` (explicit no-auto-delete / retention policy; still deleted only via explicit `clear` or future runbook)
- `PlayerValueMissing:{YYYYMMDD}` (consumer-owned; this service only DELs it when refreshing/clearing that date’s `PlayerValue` — see §4)
- `EntryInfo:{season}`, live hashes (`EventLive*`, `LiveFixture`, `LiveBonus`),
  `EventOverallResult`, `event:current`
- Ops markers (`LaunchNotification:*`, `letletme:entry-info-sync:*`)
- `mutation-lock:*`, BullMQ `bull:*` keys

### Manual / planned (FP-17)

A sign-off-approved runbook (full key list + checklist) ships with FP-17 for
broader retention and any cleanup beyond the automatic prefix pass. Until
then: do **not** add new automatic deletion jobs; do **not** manually delete
consumer-facing keys without sign-off.
