# Fix Plan Checklist — letletme_data

Living tracker for the 2026-07-17 code-review fix plan. Check items off as they land; append commit SHA + date in the completion log at the bottom.

- **Full detail (file-level changes, acceptance criteria):** [fix-plan-2026-07-17.md](./fix-plan-2026-07-17.md)
- **Findings evidence:** [code-review-2026-07-17.md](./code-review-2026-07-17.md)

**Progress:** P0 `6/6` · P1 `6/10` · P2 `0/9` · Deferred `0/4`

**Ground rules**
1. Redis keys/shapes are **frozen** — fixes within existing shapes; new data → additive keys only; deletions need consumer sign-off.
2. `bun run db:generate` is **frozen** until FP-01 merges.
3. One FP item = one PR.

**Waiting on Tong:** consumer inventory (which systems read which Redis keys) → fills the Consumers section in `docs/redis-contract.md` (FP-06).

---

## P0 — Safety & correctness foundations (~3 days, sequential)

- [x] **FP-01 · Repair fresh-database bootstrap** (C1, L15 · effort L) — *blocks FP-10, FP-15*
  - [x] `migrations/0026_create_tournament_selection_stats.sql` — `CREATE TABLE IF NOT EXISTS` per Drizzle schema (sorts before the RLS file)
  - [x] `migrations/0028_add_entry_event_transfers_unique_index.sql` — `CREATE UNIQUE INDEX IF NOT EXISTS … (entry_id, event_id)` + matching `uniqueIndex` in `entry-event-transfers.schema.ts` *(prod check found existing `unique_entry_event_transfer`; reused that name — no duplicate index)*
  - [x] Delete orphan duplicates `0003_create_player_values_table.sql`, `0005_remove_unused_player_stats_fields.sql`
  - [x] `apply-sql-migrations.ts` excludes journal-listed files; add `migrations/README` note ("db:generate frozen, hand-write `NNNN_name.sql`")
  - [x] Fresh-install rehearsal: empty Postgres → `db:migrate` + `db:apply-sql` green; `tournament_selection_stats`, `bauth.*`, unique index verified
  - [x] *Found during rehearsal:* journaled `0005` `teams.unavailable` bool→int alter was un-castable (added `USING` + default fix; prod never applied it — still boolean, timestamp-gated so it never re-runs); `0006_align_event_lives_table_name.sql` (0005 created `event_live`, prod/schema use `event_lives`); `0023_add_tournament_points_group_cum_columns.sql` (4 `cum_*` columns existed only in prod, views 0023/0024 need them)
- [x] **FP-02 · Fence integration tests off real infra** (C2 · M)
  - [x] `test` → `bun test tests/unit`; add `test:integration` (`RUN_INTEGRATION=1`) and `test:all`
  - [x] `tests/integration/helpers/env-guard.ts` (RUN_INTEGRATION=1 + test-pattern DATABASE_URL + non-0 Redis DB), wired to `tests/utils/test-config.ts`
  - [x] Import guard first in all 33 integration files *(call-style `assertIntegrationEnv()` — bun shares the module registry across files, so a top-level module throw only fenced the first file)*
  - [x] `tournament-seed.ts`: delete seeded rows in `afterAll` *(seed entry IDs moved to synthetic range 99000001+ so cleanup can't touch real entries)*
- [x] **FP-03 · Harden Redis client against outages** (C3, M15 · M · contract-safe)
  - [x] `commandTimeout: 5000` + `connectTimeout: 5000` in `src/cache/singleton.ts`
  - [x] Create client once; `connect()` idempotent; never `new Redis()` over a live instance (kills reconnect leak)
  - [x] Initial `ping()` raced against timeout (no `isConnecting` spin)
  - [x] Unit test: black-holed Redis → ops reject/return null within ~5 s
- [x] **FP-04 · FPL boundary schema timebombs** (H3, H4 · S)
  - [x] `fpl.ts:348` → `explain: z.array(z.unknown()).nullable()`
  - [x] `fpl.ts:502` → `active_chip: z.string().nullable()` + known-chip mapping with `logWarn` on unknown (new `src/domain/chips.ts`)
  - [x] Regression tests: `explain: null` element; `active_chip: manager` picks payload
- [x] **FP-05 · CI typecheck step** (H14 · XS) — `bun run typecheck` in `ci.yml` after Lint *(verified green 2026-07-17)*
- [x] **FP-06 · Redis key contract doc** (new · S · *needs Tong's consumer inventory*)
  - [x] `docs/redis-contract.md`: key patterns, hash fields, JSON shapes, TTL behavior *(ops markers + honest current-vs-planned writer semantics included)*
  - [ ] Consumers section (from Tong's inventory) — still TBD; every key treated as externally consumed until filled
  - [x] Ground rules added to `CLAUDE.md`

## P1 — Data integrity & operability (~9–10 days, parallel except noted)

- [x] **FP-07 · Unify tournament lock scopes** (C4 · M) — shared `tournament-structure:global` scope for setup + 4 results jobs + MV refresh; scope unit tests
- [x] **FP-08 · Tournament creation rank poisoning** (C5 · S) — `entry_infos` upsert → `ON CONFLICT (id) DO NOTHING`; integration test with already-synced entry
- [x] **FP-09 · Battle-race counters** (C6 · M · *after FP-07*) — skip matchup on missing entry result; clear stale phantom points; recompute counters; env-guarded integration test
- [x] **FP-10 · Upsert correctness pack** (H5, H6 · S · *after FP-01*)
  - [x] `entry-event-transfers` conflict update: `elementInPlayed` → `COALESCE(excluded, existing)`
  - [x] `player-values.insertBatch` → `.onConflictDoNothing({ target: [elementId, changeDate] })` + return only inserted rows for cache/notify
- [x] **FP-11 · Live bonus per match** (H7 · M) — rank combined match bucket (≤6 pts/match); DGW-safe pairing; finished multi-match seed-only; live multi-match full rank + keepMax
- [x] **FP-12 · Cache writer bugs — shape-preserving** (H8, H9 · M · *after FP-06*)
  - [x] `fixtures-cache.ts`: skip delete+rebuild of `FixturesByTeam:*` when `teamById` empty
  - [x] Player-stats cache = latest-event-wins view: only write when `eventId` is current event; old-event syncs → DB only
  - [x] Document both semantics + DGW one-fixture limitation in `redis-contract.md`
- [x] **FP-13 · API hardening pack** (H1, H2, M1–M4, L1–L4 · L · *client-visible: announce error-envelope change*)
  - [x] a. Generic 5xx message in prod; `getHttpStatusFromError` in global handler
  - [x] b. Rate limit on POST/DELETE (trigger + sync routes), independent of `ENABLE_AUTH`
  - [x] c. Deterministic job IDs for manual triggers (drop `Date.now()`)
  - [x] d. Inline syncs → enqueue + 202 (`sync-all-gameweeks`, entity `/sync` routes)
  - [x] e. `entry-sync` via queue / `mapWithConcurrency` cap
  - [x] f. Mount better-auth under `/api/auth` (restore JSON 404 envelope)
  - [x] g. `t.Numeric()` schemas; delete bare `parseInt`
  - [x] h. Standardize `{ success, data?, error? }`; 200 sync / 202 enqueued
  - [x] i. `check-name` minLength 1; drop `setupError` from public `setup-status`
  - [x] j. 429 on `RATE_LIMITED`; try/catch → 503 on auth-infra failure
- [ ] **FP-14 · Job safety pack** (H10, H11, M9–M14 · L · *alerting needs prod `TELEGRAM_*` envs*)
  - [ ] a. `entry-event-results-daily`: `isFPLSeason` + current-event guards
  - [ ] b. Watchdog checks active job/lock before recovering setups
  - [ ] c. `errors > 0 → throw` in tournament-event-picks, transfers (pre+post), tournament-info
  - [ ] d. `alertOnFinalFailure(job)` → Telegram in every worker `failed` handler
  - [ ] e. `event-lives-db`: window re-check in worker + waiting-room dedup
  - [ ] f. Deterministic chunk job IDs (`${jobName}-${runId}-chunk-${offset}`)
  - [ ] g. Cascade fan-outs throw when any enqueue fails (3 call sites)
  - [ ] h. Per-table scopes (`entry-event-picks|transfers|results:event:N`)
- [x] **FP-15 · Deploy safety pack** (H12, H13, M23, M24 · M · *after FP-01*)
  - [x] Worker heartbeat file + Docker/compose healthcheck; deploy asserts both services healthy
  - [x] `cancel-in-progress: false`; `workflow_dispatch` `inputs.sha`; targeted prune (keep last 3)
  - [x] `deploy.sh`: migrate before `up -d`; exit non-zero on migration failure
  - [x] Dockerfile: pin `oven/bun:1.3.3`; production-only `node_modules` stage
  - [x] `package.json`: `"packageManager": "bun@1.3.3"`
- [x] **FP-16 · Transaction coverage pack** (M5–M7 · M)
  - [x] `syncEventLives`: both upserts in one `db.transaction`
  - [x] `syncKnockoutForTournament`: four upserts in one transaction
  - [x] `upsertFromSummary`: `last_*` computed in SQL; delete read-modify-write

## P2 — Hardening & maintainability (~10 days)

- [ ] **FP-17 · Cache hygiene — shape-preserving** (M8, M16, M17, L7 · M)
  - [ ] `ttl > 0 ? setex : set` in `cache-operations.set` *(audit external readers of those keys first)*; delete dead `CACHE_TTL`
  - [ ] Season-rollover cleanup → manual runbook + sign-off checklist in `redis-contract.md` (no auto-delete, no PlayerValue retention job)
  - [ ] Per-field `JSON.parse` tolerance + corrupt-field logging
  - [ ] `Season:active` in-process cache (~5 s)
  - [ ] Battle-race N+1 → batch `findByTournamentAndEntries` + in-memory bucket
- [ ] **FP-18 · FPL client resilience** (M18 · M) — one `request()` helper (10 s timeout, ≤3 jittered retries honoring `Retry-After`, User-Agent); all 9 call sites; mocked-fetch tests
- [ ] **FP-19 · Type & transformer consolidation** (L5, L6, L8 · M) — `z.infer` RawFPL types from client schemas; delete `types/index.ts` duplicates; `transformEventLive` validates output; dedupe `getChangeType`
- [ ] **FP-20 · RLS & migration-ledger hardening** (M19, L17 · M · *after FP-01*) — RLS into numbered migrations; delete stale `sql/*.sql`; advisory lock + `ON CONFLICT` in `apply-sql-migrations`; update `RLS_SECURITY.md` to reality
- [ ] **FP-21 · Schema types + season semantics** (M20, M21 · M) — `text→numeric(10,2)` metric columns; `deadline_time→timestamptz`; document single-season semantics (accepted design)
- [ ] **FP-22 · Config & logging hygiene** (M22, L16 · S) — 6 env flags into Zod `EnvSchema` (one transform); pino `redact` paths; scrub `notify.ts` URL/chat-ID logging
- [ ] **FP-23 · Job-system leftovers** (L9–L14 · M)
  - [ ] `tournament-info` cron → enqueue (delete inline path)
  - [ ] Worker shutdown: 30 s `Promise.race` timeout; `closeLockClient()`
  - [ ] Priority gate: count `waiting`+`delayed` only
  - [ ] `player-values` failed-job retry so same-day ticks aren't blocked
  - [ ] Explicit `timezone` on all `cron()` registrations; cache null season-window
  - [ ] `mutation-lock` `finally` release try/catch; correct error labeling
- [ ] **FP-24 · Test infrastructure** (L18, L19 · L · *after FP-02*)
  - [ ] Delete `tests/utils/mocks.ts` / `test-helpers.ts`; rewrite `tests/README.md`
  - [ ] Hermetic integration suite: mock FPL boundary with recorded fixtures; CI job with pg/redis services
  - [ ] DI service tests for the 9 untested services; replace mock-echo repository tests
- [ ] **FP-25 · Docs & dependency hygiene** (L20 · S) — README fixes (fp-ts, deployment-plan ref, Bun); drop `@types/supertest`; admin-key "do not log" warning + env guard; schedule major upgrades (zod 4, pino 10, eslint 10)

## Deferred — accepted risks (documented, not scheduled)

- [ ] DGW second fixture in `FixturesByTeam` — shape change; additive key only if a consumer requests it
- [ ] Multi-season DB history — single-season semantics accepted and documented (FP-21)
- [ ] `PlayerValue:*` automatic retention — manual runbook only (FP-17)
- [ ] Tiered-queue starvation — fix ships in FP-23; feature is off by default

---

## Completion log

| FP | Commit SHA | Date | Notes |
|----|-----------|------|-------|
| FP-01 | 47baf1f (PR #3) | 2026-07-17 | Prod no-ops verified; teams.unavailable prod drift noted for FP-21 |
| FP-05 | 78a9660 (PR #7) | 2026-07-17 | tsc now blocks merges |
| FP-02 | 692a977 (PR #4) | 2026-07-17 | bun shared-registry made import-throw insufficient; call-style guard |
| FP-03 | a896251 (PR #5) | 2026-07-17 | Watch DB load during Redis blips after deploy |
| FP-04 | 81ef6e4 (PR #6) | 2026-07-17 | Unknown chips now logWarn + pass through per row |
| FP-08 | 5a53a87 (PR #10) | 2026-07-17 | — |
| FP-15 | 8a0c80a (PR #17) | 2026-07-17 | PR #17 |
| FP-06 | (PR #8) | 2026-07-17 | Codex P2s addressed: ops keys, FixturesByTeam current behavior, auto season cleanup |
| FP-07 | (PR #9) | 2026-07-17 | global structure lock; MV refresh waits on same scope (Codex P2) |
| FP-09 | (PR #11) | 2026-07-17 | clear phantom points on skip; integration env guard |
| FP-10 | (PR #12) | 2026-07-17 | COALESCE elementInPlayed; player-values DO NOTHING + return inserted |
| FP-11 | (PR #13) | 2026-07-17 | per-match 3/2/1; DGW finished seed-only; live full rank + keepMax |
| FP-12 | (PR #14) | 2026-07-17 | FixturesByTeam empty-teams guard; PlayerStat current-event-only write |
| FP-13 | (PR #15) | 2026-07-17 | error envelope, rate limit, queue-first entry/entity syncs |
| FP-16 | (PR #18) | 2026-07-17 | transaction coverage: event-lives, knockout, upsertFromSummary |
