# TODO — Unimplemented Jobs

These jobs exist in the Java `fpl-data` reference implementation but have not yet been ported to this TypeScript project.

---

## 1. Standings Sync (`upsertStandings`)

**Java source**: `MatchDayTask.upsertStandings()` → `eventUpdateService.upsertStandings()`
**Java schedule**: `0 10 6,8,10 * * *` (06:10, 08:10, 10:10) — condition: `isMatchDay(event)`

**What it does**: Syncs Premier League table standings after each matchday. The Java implementation fetches standings data (likely from FPL or Pulselive API) and persists them to a standings table.

**What's needed**:
- Investigate which API endpoint provides standings data (`fplClient` or `pulseliveClient`)
- New DB table (e.g., `standings` or `event_standings`) with Drizzle schema + migration
- New domain type + Zod schema in `src/domain/`
- New transformer in `src/transformers/`
- New repository in `src/repositories/`
- New cache operations in `src/cache/` (optional — standings are static post-match)
- New service function `syncStandings()` in `src/services/`
- New job in the appropriate queue (likely `data-sync`)
- Cron registration in `src/jobs/` — fire at 06:10, 08:10, 10:10 with `isMatchDay` condition

---

## 2. Hourly Player Value History Snapshot (`insertPlayerValueInfo`)

**Java source**: `DailyTask.insertPlayerValueInfo()` → `dataService.insertPlayerValueInfo()`
**Java schedule**: `0 10 */1 * * *` (minute :10 of every hour, unconditional)

**What it does**: Records a recurring raw-value snapshot of player prices into a history log table. This is **distinct** from `syncCurrentPlayerValues` (which only fires 09:25–09:35 and only records detected price changes). The hourly snapshot creates a complete price log regardless of whether prices changed.

**What's needed**:
- Clarify the target table — likely a separate `player_value_info` or `player_price_history` table (not `player_values`)
- New DB table with Drizzle schema + migration
- New service function (extend `player-values.service.ts` or create a new service)
- New cron job firing at minute :10 of every hour (unconditional, no season/matchday guard needed unless desired)

---

## 3. Pre-Season Warning Alert (`warning`)

**Java source**: `LaunchTask.warning()` — `@Async("TaskThreadPool")`
**Java schedule**: `0 */1 * * * *` (every minute, unconditional)

**What it does**: Polls `bootstrap-static` every minute. If the `events` list is **empty** (FPL has not published the new season yet), fires a Telegram notification and email with message: `"【NEW SEASON】WARNING! WARNING! WARNING!"`.

**What's needed**:
- Notification utility: Telegram bot webhook sender (token + chat ID from env) and/or SMTP email sender
- New `LaunchTask`-equivalent job in `src/jobs/launch.jobs.ts`
- Condition: call `fplClient.getBootstrap()`, check `events.length === 0`
- The cron fires every minute unconditionally — runs year-round as a monitor
- Register in `src/index.ts`

**Note**: The Java implementation also sends email via `JavaMailSender`. Decide which notification channels to support (Telegram only, email only, or both).

---

## 4. New Season Launch Alert (`happening`)

**Java source**: `LaunchTask.happening()` — `@Async("TaskThreadPool")`
**Java schedule**: `0 */1 * * * *` (every minute, unconditional)

**What it does**: Polls `bootstrap-static` every minute. If events are present **and** the first event's `deadlineTime` starts with the current year (new season has gone live), fires a Telegram notification and email with message: `"【NEW SEASON】ITS HAPPENING!!!"`.

**What's needed**:
- Same notification infrastructure as `warning` above
- Same `launch.jobs.ts` file (both tasks live together)
- Condition: `events.length > 0 && events[0].deadlineTime.startsWith(currentYear)`
- **Fix the Java bug**: Java hardcodes `"2024"` — TS implementation should use `new Date().getFullYear().toString()` dynamically

**Note**: Both `warning` and `happening` share the same 1-min cron and notification infra — implement them together in a single job file.
