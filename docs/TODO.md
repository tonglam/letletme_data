# TODO — Unimplemented Jobs

These jobs exist in the Java `fpl-data` reference implementation but have not yet been ported to this TypeScript project.

---

## 1. Hourly Player Value History Snapshot (`insertPlayerValueInfo`)

**Java source**: `DailyTask.insertPlayerValueInfo()` → `dataService.insertPlayerValueInfo()`
**Java schedule**: `0 10 */1 * * *` (minute :10 of every hour, unconditional)

**What it does**: Records a recurring raw-value snapshot of player prices into a history log table. This is **distinct** from `syncCurrentPlayerValues` (which only fires 09:25–09:35 and only records detected price changes). The hourly snapshot creates a complete price log regardless of whether prices changed.

**What's needed**:
- Clarify the target table — likely a separate `player_value_info` or `player_price_history` table (not `player_values`)
- New DB table with Drizzle schema + migration
- New service function (extend `player-values.service.ts` or create a new service)
- New cron job firing at minute :10 of every hour (unconditional, no season/matchday guard needed unless desired)

---

## 2. Pre-Season Warning Alert (`warning`)

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

## 3. New Season Launch Alert (`happening`)

**Java source**: `LaunchTask.happening()` — `@Async("TaskThreadPool")`
**Java schedule**: `0 */1 * * * *` (every minute, unconditional)

**What it does**: Polls `bootstrap-static` every minute. If events are present **and** the first event's `deadlineTime` starts with the current year (new season has gone live), fires a Telegram notification and email with message: `"【NEW SEASON】ITS HAPPENING!!!"`.

**What's needed**:
- Same notification infrastructure as `warning` above
- Same `launch.jobs.ts` file (both tasks live together)
- Condition: `events.length > 0 && events[0].deadlineTime.startsWith(currentYear)`
- **Fix the Java bug**: Java hardcodes `"2024"` — TS implementation should use `new Date().getFullYear().toString()` dynamically

**Note**: Both `warning` and `happening` share the same 1-min cron and notification infra — implement them together in a single job file.
