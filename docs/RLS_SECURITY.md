# Row Level Security (RLS)

**Date:** 2026-01-18  
**Updated:** 2026-07-18 (FP-20)

---

## Purpose

RLS policies protect the Supabase Data API (PostgREST) from anonymous reads and
writes. They do **not** restrict the application backend, which connects with a
service role that bypasses RLS.

## Important reality

- The application role (`postgres` / service role / `supabase_admin`) has
  `BYPASSRLS`. Every query from the Elysia API and BullMQ workers runs as that
  role, so RLS policies have **no effect** on normal application operations.
- Policies only matter when tables are exposed through the Supabase Data API
  using the anonymous / `public` role or a user JWT.
- There is currently no user-scoped data access; the `authenticated` policy
  grants full access to any authenticated Data API caller. If user-level
  isolation is needed later, replace those policies with `user_id = auth.uid()`
  predicates and keep the app on the bypass role.

## What is enabled

Migration `0029_enable_rls_all_tables.sql` enables RLS and creates policies for
all tables in the `public` schema plus the `bauth.*` auth tables:

- **Public read** tables (anonymous `SELECT`, authenticated `ALL`):
  `events`, `fixtures`, `phases`, `teams`, `players`, `player_values`,
  `player_stats`, `event_fixtures`, `event_lives`, `event_live_explains`,
  `event_live_summaries`.
- **Authenticated-only** tables (no anonymous access): all entry tables, league
  tables, tournament tables, `sql_migrations`, and `bauth.*` tables.

## Ledgered application

RLS is applied through the SQL-migration ledger (`bun run db:apply-sql`), not
through ad-hoc `psql` scripts. The migration is idempotent and is recorded in
the `sql_migrations` table.

## Operational notes

- `scripts/apply-sql-migrations.ts` takes a PostgreSQL advisory lock while it
  runs and uses `ON CONFLICT DO NOTHING` when recording applied files, so
  concurrent deploys cannot double-apply migrations.
- New tables added after this migration must include their own RLS setup in the
  same numbered migration that creates them, or in a later migration that
  follows the same public-read / authenticated-only classification.

## Verification

```sql
SELECT schemaname, tablename, rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname IN ('public', 'bauth')
ORDER BY schemaname, tablename;

SELECT schemaname, tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname IN ('public', 'bauth')
ORDER BY schemaname, tablename, policyname;
```

## Historical scripts (removed)

The one-off `sql/enable-rls-*.sql` and `sql/create-missing-tables.sql` scripts
were removed in FP-20. Use the numbered migration instead.
