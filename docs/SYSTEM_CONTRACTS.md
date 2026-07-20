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
   cache misses cannot become invented data.
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
| Migration history | Drizzle journals plus checksum-protected `sql_migrations` | Deployment logs |

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

`TRANSFER_SYNC_MODE=latest` is compatible with the legacy one-row-per-event
index. Deploy this code first. The follow-up transfer-schema PR widens the unique
index; only after that migration succeeds may operators set
`TRANSFER_SYNC_MODE=all` and trigger the existing `entry-transfers` job. The FPL
endpoint returns the full history, so that ordinary job performs the backfill
without a one-off script. All-mode verifies the persisted signatures and rolls
back if the widened index is missing.

## Operational invariants

- Run both migrators, then `bun run db:migrate:status`; a checksum mismatch,
  missing ledgered file, or migration inserted before the applied tail blocks
  deployment.
- `/health` is readiness, not process liveness: PostgreSQL, Redis, and a valid
  `Season:active` authority key must all respond or it returns 503.
- After a fresh install or Redis restore without that key, trigger the
  authenticated `events-sync` job from the trusted network. It derives the
  season from FPL GW1 metadata and establishes the key; do not set a guessed
  calendar value merely to make readiness green.
- LiveBonus V2 is additive. Keep GraphQL `LIVE_POINTS_V2=false` until the V2 hash
  has been sampled for single and double gameweeks.
- Never deploy one repository's contract switch before its producer/validator
  prerequisite. Rollout order belongs in the coordinated PR descriptions.
