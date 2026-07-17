# Fix Plan Checklist — letletme_data

Living tracker for the 2026-07-17 code-review fix plan. Check items off as they land; append commit SHA + date in the completion log at the bottom.

- **Full detail (file-level changes, acceptance criteria):** [fix-plan-2026-07-17.md](./fix-plan-2026-07-17.md)
- **Findings evidence:** [code-review-2026-07-17.md](./code-review-2026-07-17.md)

**Progress:** P0 `0/6` · P1 `0/10` · P2 `0/9` · Deferred `0/4`

**Ground rules**
1. Redis keys/shapes are **frozen** — fixes within existing shapes; new data → additive keys only; deletions need consumer sign-off.
2. `bun run db:generate` is **frozen** until FP-01 merges.
3. One FP item = one PR.

**Waiting on Tong:** consumer inventory (which systems read which Redis keys) → fills the Consumers section in `docs/redis-contract.md` (FP-06).

---

## P0 — Safety & correctness foundations (~3 days, sequential)

- [ ] **FP-01 · Repair fresh-database bootstrap** (C1, L15 · effort L) — *blocks FP-10, FP-15*
  - [ ] `migrations/0026_create_tournament_selection_stats.sql` — `CREATE TABLE IF NOT EXISTS` per Drizzle schema (sorts before the RLS file)
  - [ ] `migrations/0028_add_entry_event_transfers_unique_index.sql` — `CREATE UNIQUE INDEX IF NOT EXISTS … (entry_id, event_id)` + matching `uniqueIndex` in `entry-event-transfers.schema.ts` *(check prod for an existing constraint name first)*
  - [ ] Delete orphan duplicates `0003_create_player_values_table.sql`, `0005_remove_unused_player_stats_fields.sql`
  - [ ] `apply-sql-migrations.ts` excludes journal-listed files; add `migrations/README` note ("db:generate frozen, hand-write `NNNN_name.sql`")
  - [ ] Fresh-install rehearsal: empty Postgres → `db:migrate` + `db:apply-sql` green; `tournament_selection_stats`, `bauth.*`, unique index verified
- [ ] **FP-02 · Fence integration tests off real infra** (C2 · M)
  - [ ] `test` → `bun test tests/unit`; add `test:integration` (`RUN_INTEGRATION=1`) and `test:all`
  - [ ] `tests/integration/helpers/env-guard.ts` (RUN_INTEGRATION=1 + test-pattern DATABASE_URL + non-0 Redis DB), wired to `tests/utils/test-config.ts`
  - [ ] Import guard first in all 33 integration files
  - [ ] `tournament-seed.ts`: delete seeded rows in `afterAll`
- [ ] **FP-03 · Harden Redis client against outages** (C3, M15 · M · contract-safe)
  - [ ] `commandTimeout: 5000` + `connectTimeout: 5000` in `src/cache/singleton.ts`
  - [ ] Create client once; `connect()` idempotent; never `new Redis()` over a live instance (kills reconnect leak)
  - [ ] Initial `ping()` raced against timeout (no `isConnecting` spin)
  - [ ] Unit test: black-holed Redis → ops reject/return null within ~5 s
- [ ] **FP-04 · FPL boundary schema timebombs** (H3, H4 · S)
  - [ ] `fpl.ts:348` → `explain: z.array(z.unknown()).nullable()`
  - [ ] `fpl.ts:502` → `active_chip: z.string().nullable()` + known-chip mapping with `logWarn` on unknown
  - [ ] Regression tests: `explain: null` element; `active_chip: 'manager'` picks payload
- [ ] **FP-05 · CI typecheck step** (H14 · XS) — `bun run typecheck` in `ci.yml` after Lint *(verified green 2026-07-17)*
- [ ] **FP-06 · Redis key contract doc** (new · S · *needs Tong's consumer inventory*)
  - [ ] `docs/redis-contract.md`: key patterns, hash fields, JSON shapes, TTL behavior
  - [ ] Consumers section (from Tong's inventory)
  - [ ] Ground rules added to `CLAUDE.md`

## P1 — Data integrity & operability (~9–10 days, parallel except noted)

- [ ] **FP-07 · Unify tournament lock scopes** (C4 · M) — shared `tournament-structure:global` scope for setup + 4 results jobs; scope unit tests
- [ ] **FP-08 · Tournament creation rank poisoning** (C5 · S) — `entry_infos` upsert → `ON CONFLICT (id) DO NOTHING`; test with already-synced entry
- [ ] **FP-09 · Battle-race counters** (C6 · M · *after FP-07*) — skip matchup on missing entry result; derive `played` like points-race; expose `skipped` count
- [ ] **FP-10 · Upsert correctness pack** (H5, H6 · S · *after FP-01*)
  - [ ] `entry-event-transfers` conflict update: `elementInPlayed` → `COALESCE(excluded, existing)`
  - [ ] `player-values.insertBatch` → `.onConflictDoNothing({ target: [elementId, changeDate] })`
- [x] **FP-11 · Live bonus per match** (H7 · M) — rank combined match bucket (≤6 pts/match); fix DGW `buildPlayingMap`; tests for both
- [ ] **FP-12 · Cache writer bugs — shape-preserving** (H8, H9 · M · *after FP-06*)
  - [ ] `fixtures-cache.ts:177-189`: skip delete+rebuild of `FixturesByTeam:*` when `teamById` empty
  - [ ] Player-stats cache = latest-event-wins view: only write when `eventId` is current event; old-event syncs → DB only
  - [ ] Document both semantics + DGW one-fixture limitation in `redis-contract.md`
- [ ] **FP-13 · API hardening pack** (H1, H2, M1–M4, L1–L4 · L · *client-visible: announce error-envelope change*)
  - [ ] a. Generic 5xx message in prod; `getHttpStatusFromError` in global handler
  - [ ] b. Rate limit on POST/DELETE (trigger + sync routes), independent of `ENABLE_AUTH`
  - [ ] c. Deterministic job IDs for manual triggers (drop `Date.now()`)
  - [ ] d. Inline syncs → enqueue + 202 (`sync-all-gameweeks`, entity `/sync` routes)
  - [ ] e. `entry-sync` via queue / `mapWithConcurrency` cap
  - [ ] f. Mount better-auth under `/api/auth` (restore JSON 404 envelope)
  - [ ] g. `t.Numeric()` schemas; delete bare `parseInt`
  - [ ] h. Standardize `{ success, data?, error? }`; 200 sync / 202 enqueued
  - [ ] i. `check-name` minLength 1; drop `setupError` from public `setup-status`
  - [ ] j. 429 on `RATE_LIMITED`; try/catch → 503 on auth-infra failure
- [ ] **FP-14 · Job safety pack** (H10, H11, M9–M14 · L · *alerting needs prod `TELEGRAM_*` envs*)
  - [ ] a. `entry-event-results-daily`: `isFPLSeason` + current-event guards
  - [ ] b. Watchdog checks active job/lock before recovering setups
  - [ ] c. `errors > 0 → throw` in tournament-event-picks, transfers (pre+post), tournament-info
  - [ ] d. `alertOnFinalFailure(job)` → Telegram in every worker `failed` handler
  - [ ] e. `event-lives-db`: window re-check in worker + waiting-room dedup
  - [ ] f. Deterministic chunk job IDs (`${jobName}-${runId}-chunk-${offset}`)
  - [ ] g. Cascade fan-outs throw when any enqueue fails (3 call sites)
  - [ ] h. Per-table scopes (`entry-event-picks|transfers|results:event:N`)
- [ ] **FP-15 · Deploy safety pack** (H12, H13, M23, M24 · M · *after FP-01*)
  - [ ] Worker heartbeat file + Docker/compose healthcheck; deploy asserts both services healthy
  - [ ] `cancel-in-progress: false`; `workflow_dispatch` `inputs.sha`; targeted prune (keep last 3)
  - [ ] `deploy.sh`: migrate before `up -d`; exit non-zero on migration failure
  - [ ] Dockerfile: pin `oven/bun:1.3.3`; production-only `node_modules` stage
  - [ ] `package.json`: `"packageManager": "bun@1.3.3"`
- [ ] **FP-16 · Transaction coverage pack** (M5–M7 · M)
  - [ ] `syncEventLives`: both upserts in one `db.transaction`
  - [ ] `syncKnockoutForTournament`: four upserts in one transaction
  - [ ] `upsertFromSummary`: `last_*` computed in SQL; delete read-modify-write

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
| — | — | — | — |
