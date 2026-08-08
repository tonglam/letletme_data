# LetLetMe system contracts

This repository participates in one four-repository system:

| Repository | Runtime responsibility | May write |
|---|---|---|
| `letletme_data` | FPL integration, validation, jobs, domain persistence, shared Redis read models | `public` domain tables and documented shared Redis keys |
| `letletme-graphql` | Public read API, authorization enforcement, query shaping | Its `gql:v2:*` caches and coordinated negative markers only |
| `letletme-web` | Browser UI, Better Auth, verified FPL binding, Mini Program session issuer | `bauth` only; invokes Data mutations with a server credential |
| `letletme-wechat-miniprogram` | Native client | No database or shared-cache writes |

## End-to-end flow

1. Data's FPL client applies timeouts, retries, and Zod schemas at the external
   boundary.
2. Transformers map snake_case FPL payloads to validated domain objects.
3. Services and repositories transactionally persist canonical PostgreSQL rows.
4. Data publishes the additive Redis shapes in `redis-contract.md`. Redis is a
   rebuildable acceleration layer, never the system of record.
5. GraphQL reads PostgreSQL and Data-owned positive hashes, then exposes the
   product schema. It must preserve a database fallback or an explicit error;
   cache misses cannot become invented data. Team strength is nullable while
   FPL has not published its pre-season rating; readers must preserve that
   unknown state rather than substitute a numeric value.
6. Web signs short-lived user and ingress envelopes for GraphQL. Web-authenticated
   tournament mutations are forwarded to Data with a separate internal API key.
7. The Mini Program obtains a hashed bearer session from Web and uses it for
   protected product reads. It never creates identity directly in GraphQL.

## Sources of truth

| Concern | Canonical source | Derived state |
|---|---|---|
| FPL domain and tournament state | PostgreSQL `public` tables, written by Data | Redis hashes, GraphQL response caches, UI state |
| Website and Mini Program identity | PostgreSQL `bauth`, written by Web/Better Auth | Signed request envelopes and bearer sessions |
| Active cache namespace | Redis string `Season:active`, written by Data | Season-scoped cache keys |
| External input | Validated FPL API response captured by the running sync | Raw response objects in memory |
| Migration history | Repository-owned ledgers: Data `drizzle.__drizzle_migrations` and `public.sql_migrations`; GraphQL `public.graphql_schema_migrations`; Web `bauth.__drizzle_migrations` | Deployment logs |

If canonical PostgreSQL and a cache disagree, PostgreSQL wins and the cache is
rebuilt. If an FPL response fails validation, the sync fails without overwriting
the last accepted canonical state.

## Authentication boundary

- End users authenticate only with Web. Data never hosts Better Auth and never
  accepts browser identity headers as authorization.
- Data mutation routes require `x-api-key` when `ENABLE_AUTH=true`. The configured
  values are SHA-256 digests, support overlap during rotation, and do not require
  auth-database availability.
- Web must derive `adminId` from the verified session FPL entry and overwrite any
  browser-supplied identity before forwarding a tournament command.
- Network policy should restrict Data to trusted callers even though its
  application-layer mutation guard remains mandatory.
- Supabase `anon` and `authenticated` roles have no direct table/view privileges.
  GraphQL uses a trusted service connection; Data uses a direct database role.

## Transfer cutover

`TRANSFER_SYNC_MODE=all` is the canonical production mode after migration 0034
widens the legacy one-row-per-event index. The FPL endpoint returns the full
history, so the ordinary `entry-transfers` job performs the backfill without a
one-off script. All-mode verifies the persisted signatures and rolls back if
the widened index is missing. `latest` remains an emergency compatibility mode
for deployments that have not completed the migration.

## Operational invariants

- Run both migrators, then `bun run db:migrate:status`; a checksum mismatch,
  missing ledgered file, or migration inserted before the applied tail blocks
  deployment.
- `/health` is process liveness and is the Docker/deploy restart gate. `/ready`
  is dependency readiness: PostgreSQL, Redis, and a valid `Season:active`
  authority key must all respond or it returns 503.
- After a fresh install or Redis restore without that key, trigger the
  authenticated `events-sync` job from the trusted network. It derives the
  season from FPL GW1 metadata and establishes the key; do not set a guessed
  calendar value merely to make `/ready` green.
- One core discovery snapshot (events, teams, fixtures, players, phases) runs
  year-round so new-season metadata can be accepted before the fixture-derived
  season window opens. It validates one bootstrap response and one fixtures
  response, commits all five PostgreSQL domains together, then atomically
  replaces the complete Redis view. Empty or incomplete core payloads preserve
  accepted state.
- Valid pre-season placeholders remain explicit: team `strength=null`, team
  `position=0`, and fixture `pulseId=0`. They mean unknown, unranked, and not
  assigned respectively; downstream code must not infer stronger values.
- When a core write advances `Season:active`, Data removes prior-season keys
  for every family in `SEASON_CACHE_PREFIXES`. Price-history, ops, lock,
  cascade-coordination, BullMQ, and consumer-owned keys remain outside that
  cleanup.
- League and tournament result polling uses the fixture-bounded 24-hour
  post-match window rather than the calendar season boundary. Final league
  results are corrected again after fresh `event_lives` persistence so GW38
  and delayed FPL finalization cannot leave a stale snapshot.
- LiveBonus V2 is additive. Keep GraphQL `LIVE_POINTS_V2=false` until the V2 hash
  has been sampled for single and double gameweeks.
- Never deploy one repository's contract switch before its producer/validator
  prerequisite. Rollout order belongs in the coordinated PR descriptions.
