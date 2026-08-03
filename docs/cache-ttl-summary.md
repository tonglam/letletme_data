# Cache retention summary

This page is a quick retention view. The binding key names, shapes, ownership,
and rollover rules are in [redis-contract.md](redis-contract.md).

## Data read models

Data hashes do not expire by TTL. They are replaced by sync writers and the
season-scoped families are removed when `Season:active` advances.

| Family | Key pattern | TTL |
|---|---|---:|
| Events | `Event:{season}` | none |
| Teams | `Team:{season}` | none |
| Phases | `Phase:{season}` | none |
| Players | `Player:{season}` | none |
| Player stats | `PlayerStat:{season}` | none |
| Entry info | `EntryInfo:{season}` | none |
| Fixtures | `Fixtures:{season}:{eventId}` | none |
| Unscheduled fixtures | `Fixtures:{season}:unscheduled` | none |
| Team fixtures | `FixturesByTeam:{season}:{teamId}` | none |
| Event live | `EventLive:{season}:{eventId}` | none |
| Event live explain | `EventLiveExplain:{season}:{eventId}` | none |
| Event live summary | `EventLiveSummary:{season}:{eventId}` | none |
| Overall result | `EventOverallResult:{season}` | none |
| Live fixtures | `LiveFixture:{season}:{eventId}` | none |
| Live bonus | `LiveBonus:{season}:{eventId}` | none |
| Live bonus V2 | `LiveBonusV2:{season}:{eventId}` | none |

`PlayerValue:{YYYYMMDD}` is date-scoped historical data, also with no TTL, but
it is deliberately outside automatic season rollover.

## Control and internal state

| Key family | Retention |
|---|---|
| `Season:active` | No TTL; advances only from validated FPL season metadata |
| `event:current` | No TTL; overwritten in place from the active Event hash |
| `LaunchNotification:*` | No TTL; year/season suffix provides re-arming |
| `letletme:entry-info-sync:daily:*` | Expires at the next UTC midnight, minimum 60 seconds |
| `mutation-lock:*` | Millisecond TTL from `MUTATION_LOCK_TTL_MS` |
| `tournament-cascade:*` | 24 hours, except the refresh lease at 120 seconds |
| `bull:*` | Managed by BullMQ queue/worker retention settings |

Post-match jobs with deterministic IDs retain successful BullMQ jobs for 24
hours to deduplicate repeated ticks. Failed deterministic jobs are removed so
the same hourly slot can be retried.

## Update and rollover behavior

- Entity writers replace affected hashes; reads do not extend retention.
- Empty core upstream arrays preserve the previously accepted cache.
- The first core write that advances `Season:active` scans all fifteen
  season-scoped families and deletes prior-season keys.
- Rollover does not delete player-value history, notification markers, locks,
  cascade coordination, BullMQ state, or consumer-owned negative markers.
- Never use `FLUSHDB` or `FLUSHALL` for cache maintenance.
