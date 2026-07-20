# Row Level Security and Data API exposure

**Updated:** 2026-07-21

## Decision

The Supabase Data API is not a LetLetMe product interface. Browser and Mini
Program reads go through GraphQL, and writes go through trusted Data/Web
services. Migration `0033_lock_down_public_data_api.sql` therefore:

- enables RLS on every `public` table;
- drops the permissive policies introduced by historical migration `0029`;
- revokes table, view, materialized-view, sequence, and function privileges from `PUBLIC`,
  `anon`, and `authenticated`; and
- revokes default privileges for future relations created by the migration role.

Trusted direct database owners and Supabase `service_role` connections keep
their intended access. Do not use an end-user JWT as a backend database
credential.

The `bauth` schema is owned and migrated by `letletme-web`; its lockdown lives in
the Web migration journal. Data's historical `0027` API-key table migration is
retained only because applied migration history is immutable. Data no longer
imports or writes any `bauth` table.

## Verification

Run as an administrative database role:

```sql
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

SELECT schemaname, tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

SELECT grantee, table_schema, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('PUBLIC', 'anon', 'authenticated')
ORDER BY grantee, table_name, privilege_type;

SELECT routine_schema, routine_name, grantee, privilege_type
FROM information_schema.role_routine_grants
WHERE routine_schema = 'public'
  AND grantee IN ('PUBLIC', 'anon', 'authenticated')
ORDER BY grantee, routine_name, privilege_type;
```

Expected result: every public table has RLS enabled, no public-table policies
remain, and no client-role table or function grants remain. GraphQL's forward
migration grants only the required RPCs to `service_role`. Separately smoke-test
GraphQL with its service credential and Data with its direct database connection.
