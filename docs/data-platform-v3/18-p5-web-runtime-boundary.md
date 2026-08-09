# P5 Web Runtime Database Boundary

Date: 2026-08-09

Status: component accepted; P5-01 and P5-08 remain open until the clean, consolidated full-B0
rehearsal and cross-service report pass.

## Candidate

- Web predecessor: `7c7a2bcf4d355f0539f4e0ea7679d78d8253beb2`
- Web branch: `codex/data-platform-v3-auth-role`
- Web candidate: `6c885629a48c97e9050d192ff7f7959ae4627753`
- Full-B0 test database: `p5_rehearsal_1_full` on the isolated Supabase PostgreSQL 15.8
  container
- Runtime test login: `p5_web_run1`, inheriting only `letletme_web_auth`

The original Web worktree and its `web-adjustments` branch were not modified.

## B0 finding and correction

The full B0 restore contains 12 `bauth` physical tables: the ten tables in the current Web Drizzle
schema, `bauth.__drizzle_migrations`, and `bauth.apikey`. The last table has three historical
`admin-bootstrap` rows created for the retired `@better-auth/api-key` integration. Current Web has
no API-key plugin, ORM declaration, or runtime reference.

The first draft of migration `0008` dynamically granted DML to every non-ledger `bauth` table.
That would have exposed the unreferenced API-key rows. The draft was rejected during rehearsal and
was never committed or applied outside the disposable database. The accepted migration instead:

- creates a NOLOGIN, NOINHERIT, non-elevated `letletme_web_auth` capability role;
- grants DML only to an explicit ten-table current-runtime allowlist;
- enables RLS and creates one service-principal policy on each allowlisted table;
- preserves but grants no access to `bauth.apikey` and the Web migration ledger;
- grants no default privileges to future auth tables;
- revokes direct privileges on all Data schemas; and
- leaves login/password provisioning outside source-controlled SQL.

No API-key value was selected, logged, changed, or deleted. The three rows remain recoverable in
B0 and in the rehearsal database.

## Fail-closed runtime contract

Root `instrumentation.ts` runs before the Node server can serve healthy traffic. It verifies:

- the connection is a non-elevated LOGIN with `INHERIT`;
- its complete recursive membership set is exactly `letletme_web_auth`;
- the capability role is NOLOGIN and has the locked attributes;
- `bauth` usage without schema creation;
- exact allowlisted DML, RLS, and policy contracts;
- no access to non-runtime auth tables or the Web migration ledger; and
- no schema, relation, sequence, or function access across Data/private and frozen `public`
  objects.

An invalid connection exits the process with status 1. `DIRECT_DATABASE_URL` remains available
only to the guarded Web migration runner; `DATABASE_URL` is the dedicated runtime URL.

## Verification

Repository gates on the accepted Web candidate:

- ESLint: pass
- TypeScript: pass
- Web tests: 208 pass, 0 fail, 4 environment-gated skips
- production build without a database URL: pass, 46 pages generated
- migration audit/journal: pass

Real full-B0 PostgreSQL 15.8 gates after Data `0079` through `0090_zzz` and Web `0008`:

- `db:runtime-contract` returned `web_database_contract_passed` for `p5_web_run1` and the exact ten
  runtime tables;
- runtime-role integration tests: 4 pass, 0 fail;
- insert/update/select/delete on `bauth.user`: pass;
- reads from `fpl.seasons`, `bauth.apikey`, and `bauth.__drizzle_migrations`: denied;
- `CREATE TABLE` in `bauth`: denied;
- the migration administrator is rejected by the explicit contract;
- candidate Next server with the dedicated login served `/api/auth/get-session` as HTTP 200;
- candidate Next server with the migration administrator exited 1; and
- the expanded Data P5 quality validator passed and reported
  `"webRuntimeLogins":["p5_web_run1"]`.

## Remaining gate

This correction was discovered inside rehearsal run 1, so that run is not declared intervention-
free. The final P5-01 evidence must recreate a clean full-B0 database, apply the committed Data and
Web candidates once, provision the runtime login through the documented operator step, and repeat
the complete Data/GraphQL/Web/Redis journey suite without deleting or rewriting a migration-ledger
row. P5-08 remains open until that consolidated run also proves the Data and GraphQL roles.
