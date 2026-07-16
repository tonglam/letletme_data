# Code Review — letletme_data (2026-07-17)

Full-repo review of `main` @ `0961660`. Scope: all of `src/` (~25.7k LOC), tests (67 files), migrations, CI/CD, Docker, scripts. Method: 6 parallel layer reviews (API/auth, services+repositories, jobs/queues/workers, cache/client/transformers, DB/migrations, tests/CI/deploy), followed by manual verification of every Critical/High finding against the code. All findings below carry file:line evidence.

**Totals: 6 Critical · 14 High · 24 Medium · 20 Low**

---

## What this codebase does well

- **The mutation-lock implementation is textbook** (`src/utils/mutation-lock.ts`): atomic `SET NX PX`, Lua compare-and-del release, heartbeat refresh, sorted multi-key acquisition with release-all-and-jittered-retry (deadlock-free), guaranteed release in `finally`.
- **Secure-by-default auth**: on in production, 32-char secret enforced when on, CORS `origin: false` when unconfigured, no unauthenticated API-key creation path.
- **BullMQ connection isolation is correct** — queues/workers never share the cache singleton; `maxRetriesPerRequest: null` handled properly. Queue dedup semantics (unique vs stable job IDs) are understood and documented in code.
- **Write patterns where good, are exemplary**: `event_live_summaries` uses `pg_advisory_xact_lock` + truncate + insert in one transaction; upsert conflict targets otherwise match real unique indexes; `inArray` lookups chunk at 1000 IDs.
- **Resilient batch transformers**: per-item try/catch with aggregate logging, all-or-nothing only when everything fails.
- **Deploy workflow fundamentals**: exact `workflow_run.head_sha` checkout, SHA-tagged images, migrate-before-up, real health-check loop; Dockerfile is multi-stage with a non-root user and a proper `.dockerignore`.
- **Unit-test discipline where present**: ~1,046 `expect()` calls vs 23 `toBeDefined()`; DI-based service tests are real behavioral assertions; env validation has a single source of truth (`validate-env.ts` delegates to `config.ts`).

---

## Critical

### C1. Fresh database bootstrap is broken — three independent defects, one root cause
Two uncoordinated migration systems operate on one directory: `drizzle-kit migrate` applies only journal entries `0000`–`0005` (`migrations/meta/_journal.json`); `scripts/apply-sql-migrations.ts` applies only files numbered `> 5` (`apply-sql-migrations.ts:28`), tracked in a separate `sql_migrations` ledger.

- **C1a. `entry_event_transfers` upsert targets a unique constraint that does not exist.** `src/repositories/entry-event-transfers.ts:65-70` runs `onConflictDoNothing/Update` with `target: [entryId, eventId]`, but the schema (`src/db/schemas/entry-event-transfers.schema.ts:30`) defines only a non-unique index, and no migration creates `UNIQUE(entry_id, event_id)`. Postgres raises `42P10` on every call on a fresh DB — the core entry-transfer sync path fails hard. Production works only because the constraint was created out-of-band and never captured.
- **C1b. Migration 0026 alters a table no migration creates; 0027 (auth) never applies on fresh installs.** No `CREATE TABLE tournament_selection_stats` exists anywhere in `migrations/` or `sql/`, yet `migrations/0026_enable_rls_tournament_selection_stats.sql:1` does `ALTER TABLE` on it. `apply-sql-migrations.ts` exits non-zero at 0026, so `0027_create_better_auth_tables.sql` is never applied — **auth is broken on fresh deploys**. 0026 also uses `auth.role()`, which exists only on Supabase.
- **C1c. The next `bun run db:generate` is a landmine.** The drizzle snapshot predates all hand-written changes, so `db:generate` will emit a giant `0006_*.sql` re-creating existing tables — and that file also matches the `> 5` filter, so **both** tools apply it. Separately, `0003_create_player_values_table.sql` and `0005_remove_unused_player_stats_fields.sql` are orphaned duplicates of journaled files that neither tool applies.

**Fix:** pick one migration runner. Recommended: convert hand-written files into drizzle custom migrations (register in the journal), add the missing `UNIQUE(entry_id, event_id)` and `CREATE TABLE tournament_selection_stats` migrations, delete the two orphaned duplicates, and block deploys on migration failure (see H12/H13).

### C2. Integration tests are destructive against whatever infrastructure `.env` points to
`tests/integration/workers/data-sync.worker.test.ts:17-24` calls `queue.drain()` + `queue.clean(0,0,'completed'|'failed')` on the real `data-sync` queues; `live-data-jobs.test.ts:15-19` and `tournament-sync-jobs.test.ts:22-26` do the same. All integration tests use `src/` `getDb()`/`getConfig()` — i.e., the developer's real `DATABASE_URL`/Redis. The dedicated test config (`tests/utils/test-config.ts`, separate DB + Redis DB 1) is **imported nowhere**. Seeded `Integration Seed …` tournament rows are never cleaned up. `bun test` runs **all** tests.
**Scenario:** anyone runs `bun test` with a prod-like `.env` → production queues drained, prod DB polluted.
**Fix:** gate `tests/integration` behind `RUN_INTEGRATION=1`, refuse to start unless `DATABASE_URL`/`REDIS_HOST` match a test pattern, point at a dedicated Redis DB index, clean up seeds in `afterAll`, and make the default `test` script unit-only (`test:all` for everything).

### C3. A Redis outage makes every cache operation hang forever — the documented DB fallback never fires
`src/cache/singleton.ts:38-46`: no `commandTimeout`, no `connectTimeout`, no bounded `retryStrategy`, offline queue enabled (default), and `maxRetriesPerRequest: null` — commands issued while disconnected **never reject**. `connect()` also does `await client.ping()` (line 75) which queues in the offline buffer and never resolves while Redis is down, so the `isConnecting` spin-wait (lines 27-29) blocks all concurrent callers too.
**Scenario:** Redis drops on a match night → every API endpoint and worker job touching cache hangs (each op also does a second round trip to `Season:active`, `cache-season.ts:103`); BullMQ jobs stall, get re-run as stalled, and pile up. "Services fall back to DB on cache miss" can't happen because reads hang instead of returning `null`.
**Fix:** add `commandTimeout` (3–5s), `connectTimeout`, and a bounded `retryStrategy`; let timeouts surface as errors the existing try/catch fallbacks convert to `null`.

### C4. Tournament structure rebuild races results syncs — mutation-lock scope mismatch
`src/domain/mutation-scope.ts` maps tournament **results** jobs (`tournament-points-race`, `-battle-race`, `-knockout`, `-cup-results`) to `tournament-structure:event:{eventId}`, but the tournament-**setup** queue maps to `tournament-structure:tournament:{tournamentId}` — different lock keys, no mutual exclusion. `rebuildTournamentStructure` (`tournament-structure.service.ts:30-92`) deletes and re-inserts all group/knockout/result rows in a transaction while `syncBattleRaceForTournament` (`tournament-battle-race-results.service.ts:126-207`) does read-modify-write on the same rows.
**Scenario:** the watchdog re-triggers a setup during a post-matchday cascade → battle-race upserts stale-read rows over freshly rebuilt ones, resurrecting old counters and corrupting standings.
**Fix:** give both sides a shared scope (e.g. results jobs also acquire `tournament-structure:tournament:{id}` — they already know the tournament).

### C5. `createTournamentWithEntries` poisons `entry_infos.overall_rank` with league-local rank
`src/repositories/tournament-infos.ts:442-463` upserts `entry_infos` with `overall_rank = participant.overallRank`, but `mapStandingsResultToParticipant` (`src/domain/tournament.ts:284`) sets that from `result.rank` — the rank **inside the league**, not the FPL overall rank `syncEntryInfo` maintains. On conflict it also overwrites `overall_points` with the league total and can clobber real names with `Entry {id}` placeholders. `findEntrySeedsByTournamentId` then seeds knockout brackets from the bogus rank.
**Fix:** `ON CONFLICT (id) DO NOTHING` (or update only placeholder names); never touch `overall_rank`/`overall_points`.

### C6. Battle-race group counters go permanently wrong when entry results are partially missing
`tournament-battle-race-results.service.ts:97-98`: a missing entry result scores `?? 0` net points, so its opponent is credited with a win against 0. The increment guard `alreadyPlayed = played >= expectedPlayed` (lines 138-157) is one-way — a later re-run never recomputes the wrongly awarded 3 points.
**Scenario:** one missing `entry_event_results` row (mid-window entry addition, upstream partial failure) → standings permanently inflated until a full structure rebuild.
**Fix:** skip the whole group when any member lacks results, or make counters fully derived (like points-race's `played = eventId - startEventId + 1`, `tournament-points-race-results.service.ts:135`) instead of incremental.

---

## High

### H1. Internal error messages returned verbatim to clients on 500
`src/index.ts:98-100` returns `{ success: false, error: message }` where `message` is the raw `error.message`; same in `src/api/jobs.api.ts:54`. `GET /events/current` with Postgres down → raw pg driver error (connection details) to an unauthenticated client. **Fix:** generic `"Internal server error"` for 5xx in production; details stay in logs.

### H2. Job-trigger and sync endpoints: no throttle, no enqueue dedup, and heavy work inline
Trigger job IDs are unique per call (`${jobName}-e${eventId}-${Date.now()}`, `src/jobs/live-data.jobs.ts:29`), so every trigger enqueues fresh work; with `ENABLE_AUTH=false` (non-prod default) these endpoints are also unauthenticated. Several sync endpoints run heavy work **inline in the HTTP request** (`POST /fixtures/sync-all-gameweeks` loops 38 gameweeks, `fixtures.api.ts:30-40`; likewise events/teams/players/player-stats syncs). `runEntrySync` fires `Promise.allSettled(entryIds.map(...))` with no concurrency limit (`entry-sync.service.ts:29-40`) — 500 posted IDs ≈ 1,500 concurrent FPL calls from the API process, outside the mutation guard.
**Fix:** HTTP-layer rate limit regardless of auth; deterministic job IDs (or BullMQ dedup) for manual triggers; convert inline syncs to enqueue-and-return-202; route entry sync through `mapWithConcurrency`.

### H3. `explain: null` rejected by the client schema — one null kills an entire gameweek's live sync
`src/clients/fpl.ts:348` declares `explain: z.array(z.unknown())` (non-nullable); `src/types/index.ts:349` declares `explain: … | null`, and the explain transformer guards non-arrays (`transformers/event-live-explains.ts:44-46`). FPL returns `explain: null` → `EventLiveResponseSchema.parse` throws for the whole response → `event-lives-db-sync` fails and the entire cascade (summary, explain, bonus, overall result, live fixtures) never enqueues. **Fix:** `.nullable()`.

### H4. Closed `z.enum` on `active_chip` breaks all picks syncs the day FPL adds a chip
`src/clients/fpl.ts:502`: `z.enum(['wildcard','freehit','bboost','3xc'])` — the 24/25 assistant-manager chip (`'manager'`) is already outside this list. Any entry that played an unlisted chip → ZodError → every picks call for that entry fails until redeploy. **Fix:** accept `z.string().nullable()` at the boundary; map known chips downstream.

### H5. `element_in_played` is nulled on every event-results re-sync
`replaceForEvent`'s `onConflictDoUpdate` always writes `elementInPlayed`, which is `options?.elementInPlayed ?? null` when called without options (`entry-event-transfers.ts:48,69-82`) — and both `syncEntryEventTransfers` and `syncTournamentEventResultsForEntryIds` call it without options, while only `syncTournamentEventTransfersPost` sets the computed value. The 10-minute post-matchday cron nulls the column each run until the cascade recomputes it; if transfers-post fails, it stays null. **Fix:** `COALESCE(excluded.element_in_played, entry_event_transfers.element_in_played)` in the conflict update.

### H6. `player_values` insert has no conflict handling — check-then-insert race fails the whole batch
`insertBatch` is a bare `db.insert` (`repositories/player-values.ts:94`) against `unique_player_values (elementId, changeDate)`; the service pre-filters via `findByChangeDate(today)` (`player-values.service.ts:75-104`). Two concurrent runs in the 09:25–09:35 window (cron + manual trigger) both pass the filter → unique violation fails the entire batch. **Fix:** `.onConflictDoNothing({ target: [elementId, changeDate] })`.

### H7. Live bonus estimate awards 3/2/1 per team instead of per match
`calculateBonusPoints` filters to `el.teamId === teamId` (`live-bonus.service.ts:127-130`), so each team gets its own 3/2/1 — up to 12 bonus points per match vs FPL's 6 (top-3 BPS across **both** teams). The opponent dual-add at lines 266-274 (exactly what per-match ranking needs) is dead code because of the filter. **Fix:** rank the combined match bucket; emit bonus only for the bucket's owning team.

### H8. `FixturesByTeam` cache: wiped when teams cache is empty; second DGW fixture dropped
- After deleting all `FixturesByTeam` keys, `fixturesCache.set` builds from the `Team:{season}` hash; if teams haven't synced yet, `teamById` is empty and **zero keys are rewritten** (`fixtures-cache.ts:177-189`) — team-fixture endpoints return null until the next full sync.
- `teamFixtureMap.set(eventId, toTeamFixture(eventFixtures[0], …))` (`fixtures-cache.ts:90-93`) keeps only the **first** fixture per team per event — double-gameweek data loss.
**Fix:** skip the rebuild (and the delete) when `teamById.size === 0`; key the map by fixture id or store arrays.

### H9. `player-stats` cache is a single-slot cache masquerading as a per-event API
`setPlayerStatsByEvent` `DEL`s the whole `PlayerStat:{season}` hash then writes only one event's stats (`player-stats-cache.ts:59-68`); `clearByEvent(eventId)` deletes the entire hash regardless of `eventId` (line 95). Two close-together event syncs evict each other; readers of the earlier event silently fall back to DB. **Fix:** key by `PlayerStat:{season}:{eventId}` like the other live caches.

### H10. `entry-event-results-daily` cron has zero guards — full-table FPL sync 365 days/year
`src/jobs/entry-results.jobs.ts:20-23` enqueues without `isFPLSeason`/current-event/window checks, unlike every sibling cron. The worker then chunks the entire `entry_infos` table calling FPL per entry; off-season, `getCurrentEvent()` null fails every entry and the worker enqueues two more retry cycles — tripling pointless load (FPL rate-limit/ban risk). **Fix:** add the same guard block used in `entry-transfers.jobs.ts`.

### H11. Setup watchdog "recovers" healthy long-running setups → duplicate full setups
`recoverStuckTournamentSetups` (`tournament-setup.service.ts:86-116`) marks any setup processing >15 min as failed and force-enqueues a replacement, based on DB state only — without checking for an active BullMQ job or a held mutation lock. Big-tournament setups legitimately exceed 15 min; the duplicate runs the entire setup again after the original finishes (and the original's `markSetupResult('ready')` overwrites the watchdog's 'failed'). Repeats every 5 min. **Fix:** check `queue.getJob`/job state or the lock key before recovering; or heartbeat `setupStartedAt`.

### H12. `deploy.sh` runs the app before migrations and only warns on migration failure
`scripts/deploy.sh:44-61`: `compose up -d` runs **before** migrations, and migration failure only `log_warn`s — the API boots against an unmigrated schema (this is how C1b goes unnoticed). The GitHub path (`deploy.yml`) does it correctly (migrate first, `exit 1`). The break-glass path should be the strictest. **Fix:** reorder to migrate-first; hard-fail on migration errors.

### H13. Deploy safety gaps: worker not health-checked, no rollback, mid-deploy cancellation
- `deploy.yml:101-112` health-checks only the API (`/health` via nginx); `docker-compose.yml:37-49` gives the worker **no healthcheck** — a crash-looping worker deploys "successfully" and syncs silently stop.
- `workflow_dispatch` has no `inputs` → can't redeploy a previous SHA; final `docker image prune --all --force` (line 117) deletes the previous image → rollback is SSH + manual git reset.
- `cancel-in-progress: true` (lines 10-12) can kill the SSH session between `git reset --hard` / migrations and `compose up -d`, leaving the VPS checkout and DB ahead of running containers.
**Fix:** worker heartbeat healthcheck + assert both services healthy; `inputs.sha` for manual deploys; targeted prune keeping last N tags; `cancel-in-progress: false`.

### H14. CI never typechecks
`bun run build` does no type checking; ESLint uses the non-type-checked ruleset; `bun run typecheck` exists but isn't in `ci.yml`. A PR with a `tsc` error merges green. **Fix:** add a typecheck step (one line).

---

## Medium (grouped)

**API consistency (M1–M4):**
- M1. The mounted better-auth handler shadows the app's 404 handling: `.mount(auth.handler)` (`auth.guard.ts:23`) is a wildcard `ALL /*`; better-auth returns a bodyless 404 for unmatched paths, so the app's `NOT_FOUND` JSON envelope never fires (empirically verified). Fix: mount under `/api/auth`.
- M2. The global error handler flattens typed errors to 500; `getHttpStatusFromError` (`utils/errors.ts:78-84`) exists but is used only by `tournaments.api.ts:20`. Same input error yields HTTP 200 (`fixtures.api.ts:15-20`), 400 (`event-lives.api.ts:22-25`), or 500 (`player-stats.api.ts:22-24`) depending on the route.
- M3. Bare `parseInt` with no radix and no Elysia schema (`event-lives.api.ts:12,21,36,51`, `fixtures.api.ts:16`) — `POST /event-lives/sync/37xyz` silently syncs event 37. Fix: `t.Numeric()` schemas everywhere.
- M4. Response envelope and success-status inconsistencies (`entry-sync.api.ts:25-26` lacks `success`; spread vs nested `data`; 200 vs 202 for enqueued work).

**Data integrity (M5–M8):**
- M5. `syncEventLives` writes `event_lives` + `event_live_explains` with no transaction (`event-lives.service.ts:103-108`); explains failure leaves mismatched tables until next run.
- M6. `syncKnockoutForTournament` performs four dependent upserts without a transaction (`tournament-knockout-results.service.ts:273,366,386,410`) — mid-sequence failure leaves a half-advanced bracket.
- M7. `upsertFromSummary` read-modify-write race on `entry_infos` snapshot fields (`entry-infos.ts:79-128`) — the API path has no lock; compute `last_*` in SQL from the pre-update row instead.
- M8. N+1 in battle-race: one query per group per sync (`tournament-battle-race-results.service.ts:125-129`); the sibling points-race loads all groups in one batched call.

**Jobs (M9–M14):**
- M9. Per-entry error swallowing fixed in only 2 of 5 tournament services (commit `5d4b41d` pattern missing in `tournament-event-picks.service.ts:58-74`, `tournament-event-transfers.service.ts:124-185,265-282`, `tournament-info.service.ts:52-85`) — jobs complete "successfully" on partial data and cascade onward. Apply `if (errors > 0) throw` uniformly.
- M10. Final job failure is silent everywhere — attempts:3 + backoff, then only a log line. `sendTelegramMessage` exists but is never wired to failure. Fix: alert when `job.attemptsMade >= attempts`.
- M11. `event-lives-db` backlog storm after worker downtime: every-10-min cron with unique jobIds and no waiting-room dedup, no window re-check in the worker case (`live-data.worker.ts:71-75`) — 3h downtime ≈ 18 primaries × 5 cascade jobs serialized through one lock.
- M12. Cascade fan-outs swallow partial enqueue failures (`Promise.allSettled` + log-only) in all three implementations (`tournament-sync.worker.ts:49-82`, `live-data-cascade.service.ts:65-85`, `league-sync.service.ts:19-44`) — a Redis blip permanently drops that cascade leg on manual triggers. Throw when `failed > 0`.
- M13. Entry chunk chain can fork into duplicate chains on retry (fresh `Date.now()` jobId for the next chunk enqueued mid-job, `entry-sync.worker.ts:204-218`). Fix: deterministic chunk jobIds per run.
- M14. Coarse shared scope `entry-event:event:N` serializes entry/league/tournament jobs across three domains (`mutation-scope.ts:44-47,78-86,93-103`) — a slow league run makes tournament jobs hit the 120s lock timeout and burn retries. Narrow scopes per table written.

**Cache (M15–M18):**
- M15. Singleton leaks a Redis connection on every error-triggered reconnect: `'error'` sets `isConnected=false`, next `getClient()` runs `connect()` which creates a **new** `Redis` without disconnecting the old one (`singleton.ts:48,60-63`) — orphaned clients + duplicate listeners on flaky networks.
- M16. `cache.set` always uses `SETEX` with default TTL 300 (`cache-operations.ts:44,51`) — contradicts the all-TTLs-`-1` doc (and -1 would throw); `CACHE_TTL` is dead code. Implement `ttl > 0 ? setex : set`; delete or wire `CACHE_TTL`.
- M17. Season-rollover cleanup covers only 6 of ~13 key prefixes (`cache-season.ts:11`), and `PlayerValue:{YYYYMMDD}` gains a new key daily, cleared only for *today* — unbounded Redis growth across seasons.
- M18. FPL client (`clients/fpl.ts`): no timeout, no retry/backoff, no 429 handling, no User-Agent — a hung socket stalls a BullMQ job until stall detection; a 429 costs a 60s-backoff attempt.

**DB/ops (M19–M22):**
- M19. RLS is uncoordinated and cosmetic for the app role: manual `psql < sql/enable-rls-all-tables.sql` untracked by any ledger; the file is stale (alters the dropped `fixtures` table, references nonexistent `player_value_tracks`, misses `tournament_selection_stats`); the app connects as owner and bypasses RLS anyway. Fold RLS into ledgered migrations; delete stale `sql/` files.
- M20. Inconsistent types for identical metrics: `player_stats` stores xG/xA/ICT/form as `text` (`player-stats.schema.ts:19-25`) vs `decimal(10,2)` in `event_lives`; `events.deadline_time` is `text` while kickoff is `timestamptz`. Text blocks SQL-side numeric ordering; a view already casts to compensate.
- M21. No `season` column in event-scoped DB tables — season exists only in Redis keys; every new-season sync upsert-overwrites the prior season's rows. Undocumented, irreversible. At minimum, document single-season semantics.
- M22. Env flags (`ENABLE_TIERED_MUTATION_QUEUES`, `ENABLE_MUTATION_CONFLICT_GUARD`, `MUTATION_LOCK_*`) bypass the Zod schema and are parsed three different ways (`worker.ts:15-17` vs `tiered-queue.ts:7-23` vs `mutation-lock.ts:7-12`) — `=1` activates tiered queues while the startup log reports them disabled. Move into `EnvSchema` with one boolean transform.

**Build/deploy (M23–M24):**
- M23. Bun version drift: CI pinned to 1.3.3, Docker `FROM oven/bun:1` (floating), local dev 1.2.x — prod runs a runtime CI never tested. Pin the same version/digest in both Docker stages; add `"packageManager": "bun@1.3.3"`.
- M24. Production image ships all devDependencies (`bun install --frozen-lockfile` copied into the runner, `Dockerfile:10,25`) — eslint/prettier/typescript in prod: size + attack surface. Add a `--production` install stage.

---

## Low (one-liners)

**API:** L1 public GETs disclose internals (`/jobs/` lists all schedules; `check-name` enables enumeration; `setup-status` returns internal `setupError`). L2 rate-limited keys get 401 instead of 429 (`auth.guard.ts:38-42`). L3 auth verification: unhandled infra failure → leaky 500 instead of 503; per-request DB write (`requestCount` increment, no `deferUpdates`). L4 `check-name` accepts empty string (no `minLength`).
**Cache/client:** L5 `transformEventLive` is the only transformer that skips domain validation (`transformers/event-lives.ts:7-36`). L6 three hand-maintained copies of FPL payload shapes (`types/index.ts`, client schemas, transformer schemas), all strip-mode — drift already visible. L7 one corrupt JSON field kills an entire hash read; extra `Season:active` round trip per op on the hot path. L8 `getChangeType` (`transformers/player-values.ts:314-320`) vs `determineValueChangeType` (`domain/player-values.ts:104-109`) return different labels for the same input.
**Jobs:** L9 `tournament-info` queue path is dead; cron runs inline in the API process with no lock/retry (`tournament-info.jobs.ts:19`). L10 worker shutdown has no timeout; lock client never closed (`worker.ts:47-56`). L11 strict-priority gate counts `active` jobs as backlog → starvation (latent; tiered queues default off). L12 failed `player-values` job blocks same-day re-enqueue (stable jobId). L13 crons assume server-local timezone (no `timezone` option); `isFPLSeason` re-queries DB every minute off-season. L14 mutation-lock `finally` release failure can mask the real job outcome; operation errors mislabeled as guard failures.
**DB:** L15 dead/churn migration files (two orphan duplicates; 0020/0021 add-then-remove pair; numbering gap at 0013). L16 logger has no pino `redact` paths; `notify.ts` logs webhook URLs/chat IDs. L17 `apply-sql-migrations.ts` ledger: no advisory lock, `markApplied` without `ON CONFLICT`.
**Tests/deps/docs:** L18 `tests/utils/*` dead (Express-style mocks for an Elysia app); `tests/README.md` describes a suite that no longer exists. L19 coverage pockets: 9/38 services and 26/30 job files with zero tests; a few repository tests are mock-echo smoke tests. L20 doc drift: README claims fp-ts (not a dependency) and references `docs/deployment-plan.md` (doesn't exist); `@types/supertest` unused; `create-admin-key.ts` prints the full admin key to stdout with no environment guard.

---

## Improvement roadmap (prioritized)

**P0 — this week (correctness & safety):**
1. **Fix database bootstrap (C1):** add `UNIQUE(entry_id, event_id)` migration; add `CREATE TABLE tournament_selection_stats` before 0026 (or make 0026 Supabase-conditional); consolidate to one migration runner + one ledger; delete orphan duplicates; **do not run `db:generate` until done**.
2. **Fence integration tests (C2):** `RUN_INTEGRATION=1` gate + infra-pattern assert + dedicated Redis DB; default `bun test` → unit only.
3. **Harden the Redis client (C3, M15):** `commandTimeout`/`connectTimeout`/bounded `retryStrategy`; stop recreating the client on error.
4. **Boundary schema fixes (H3, H4):** `explain` nullable; `active_chip` as open string. These are the two "FPL changes data → sync dies" timebombs.
5. **Add the typecheck step to CI (H14).** One line; currently nothing typechecks in CI.

**P1 — next two weeks (data integrity & operability):**
6. Unify tournament mutation scopes (C4); make `createTournamentWithEntries` stop touching `overall_rank`/`overall_points` (C5); derive or group-skip battle-race counters (C6).
7. Upsert fixes: `COALESCE` for `element_in_played` (H5); `onConflictDoNothing` for player values (H6).
8. API hardening: generic 500s (H1); rate limit + trigger dedup + enqueue-instead-of-inline (H2); `t.Numeric()` schemas (M2/M3); mount auth under `/api/auth` (M1).
9. Job safety: guard `entry-event-results-daily` (H10); watchdog checks active job before "recovering" (H11); `errors > 0 → throw` everywhere (M9); **wire Telegram alerting on final job failure (M10)** — currently a match-night outage is invisible.
10. Live bonus per-match fix (H7); player-stats cache per-event keys (H9); FixturesByTeam guards (H8).
11. Deploy: worker healthcheck + both-services assertion, `cancel-in-progress: false`, `inputs.sha` rollback, targeted prune, migrate-first in `deploy.sh` (H12/H13).

**P2 — this quarter (maintainability):**
12. FPL client: timeout + bounded retry with jitter + User-Agent (M18).
13. Redis hygiene: per-field JSON error tolerance, in-process `Season:active` caching, complete season-rollover prefixes, `PlayerValue:*` retention job (M16/M17, L7).
14. Single source for `RawFPL*` types (`z.infer` off client schemas) (L6); make `transformEventLive` validate (L5).
15. Fold RLS into ledgered migrations; delete stale `sql/*.sql` band-aids (M19, L15).
16. Env flags into Zod; logger redaction paths (M22, L16).
17. Standardize response envelope + status codes (M4); transaction coverage for multi-table writes (M5/M6).
18. Hermetic integration tests (mock the FPL boundary with recorded fixtures); extend DI service tests to the 9 untested services; delete dead test utils; fix README/tests-README drift (L18–L20).
19. Dependency hygiene: drop `@types/supertest`, pin `packageManager`, schedule major upgrades (zod 4, pino 10, eslint 10).
