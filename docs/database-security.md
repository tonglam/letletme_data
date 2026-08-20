# Database security boundary

PostgreSQL is the application source of truth, but the Supabase Data API is not a LetLetMe product
interface. Browser and Mini Program traffic goes through Web and GraphQL; Data is the only writer to
the Data-owned schemas.

## Schema exposure

- `fpl`, `competition`, `understat`, `bridge`, `reporting`, and `ops` are private application
  schemas.
- `public` contains no application tables, views, materialized views, sequences, or functions.
- `anon`, `authenticated`, `service_role`, and `PUBLIC` receive no application-schema privileges.
- `bauth` is owned and migrated by `letletme-web`; Data neither imports nor writes it.
- Supabase-managed schemas, roles, and extensions are outside the Data migration boundary.

RLS is not used as a substitute for this schema and role boundary. The baseline preserves the exact
catalog RLS state and contains no client-facing policy that grants access to Data-owned relations.

## Role contract

`letletme_data_owner`, `letletme_data_writer`, and `letletme_graphql_reader` are NOLOGIN capability
roles. Environment-specific LOGIN roles are provisioned separately and inherit exactly one runtime
capability:

- Data runtime receives schema usage plus the required read/write relation, sequence, and reporting
  refresh privileges through `letletme_data_writer`.
- GraphQL runtime receives schema usage and SELECT-only access through
  `letletme_graphql_reader`.
- Migration runs use the direct PostgreSQL 15 `postgres` LOGIN, or the equivalent Supavisor
  session-mode endpoint on port 5432 when the host is IPv4-only. Both preserve one session so the
  LOGIN can assume the owner role and update `ops.schema_migrations`; transaction mode is not valid.

Passwords and runtime LOGIN definitions are never stored in the baseline.

The three reporting views use `security_invoker=true`. Their caller must therefore hold access to
the underlying relations. The two materialized views are read models refreshed only through the
Data writer's two restricted refresh functions.

## Verification

The migration contract and schema parity tests fail closed on object, owner, ACL, RLS, policy,
function, view, materialized-view, and default-privilege drift. For a direct catalog check:

```sql
SELECT n.nspname AS schema_name,
       c.relname AS object_name,
       c.relkind,
       pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'fpl', 'competition', 'understat', 'bridge', 'reporting', 'ops')
  AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
ORDER BY n.nspname, c.relkind, c.relname;

SELECT grantee, table_schema, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema IN ('fpl', 'competition', 'understat', 'bridge', 'reporting', 'ops')
ORDER BY table_schema, table_name, grantee, privilege_type;
```

Expected: no `public` application object, no Supabase client-role grant, Data write privileges only
through the writer capability, and GraphQL access limited to SELECT.
