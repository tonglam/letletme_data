# Migrations

Two migrators share this directory:

- `bun run db:migrate` applies only files journaled in `meta/_journal.json` (the immutable
  Drizzle baseline).
- `bun run db:apply-sql` applies every other numbered `NNNN_name.sql` file in lexical order.
  It stores SHA-256 checksums and refuses edited, missing, or backdated applied files.
- `bun run db:migrate:status` verifies both histories and exits non-zero for any pending,
  unchecksummed, mismatched, missing, or backdated migration.

Before v3 activation, the numbered ledger is `public.sql_migrations`. Migration `0090` atomically
moves authority to `ops.schema_migrations` and leaves only its temporary compatibility boundary.
Migration `0093` removes that compatibility object after the separately approved legacy cleanup.

## v3 ordering and gates

- `0079`-`0089` create, migrate, validate, and prepare the six private Data schemas.
- The `0090_*` files activate/freeze v2, add runtime identities/business keys, and install the final
  reporting/publication definitions. `0090_zzz` is the final non-destructive publication identity
  and plan-version fence. These files are ordered lexically and each has an independent checksum.
- `0091`-`0093` are legacy-drop migrations. The runner excludes them unless
  `V3_LEGACY_DROP_APPROVAL` exactly matches the approved run ID contract.
- Production deployment also requires the external release manifest, exact candidate SHA/image
  digest, cutover run ID, and activation approval before any v3 migration runs.

Never renumber, edit, or remove an applied migration. A correction is a new lexically later file,
unless the changed migration has only been exercised in disposable rehearsal databases and the
versioned acceptance report explicitly supersedes its earlier checksum.

## Schema declarations

`src/db/schemas/platform-v3.schema.ts` is the TypeScript declaration used by runtime repositories
and `bun run db:check`. Hand-written SQL remains authoritative for PostgreSQL features that Drizzle
ORM 0.43 cannot express, including the partial unique
`ops.dataset_publications_one_active_scope_idx ... NULLS NOT DISTINCT`, role/grant boundaries,
security-invoker views, reporting refresh functions, and approval gates.

Do not run `bun run db:generate` as a production migration shortcut. Update the declaration and add
a reviewed, idempotent numbered SQL migration with explicit lock/statement timeouts, then replay
fresh and B0 PostgreSQL 15 paths twice.
