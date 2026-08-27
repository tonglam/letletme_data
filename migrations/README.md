# Database migrations

`0000_platform_baseline.sql` defines the empty Data-owned schemas. It seeds no
seasons, provider responses, competition records, users, or other business
rows.

## One ledger and one identity

`bun run db:migrate` is the only migration entry point. It takes an advisory
lock, verifies every applied checksum in `ops.schema_migrations`, and applies
pending SQL files transactionally in lexical filename order. Drizzle is a
typed schema mapping and parity tool, not a second migration engine.

The complete filename (for example,
`0065_my_fpl_snapshot_invalidation_outbox.sql`) is the migration identity in
the ledger. The numeric prefix is ordering metadata only. Existing migrations
are immutable: do not rename, rewrite, squash, or reuse a ledgered filename.

## Adding a migration

1. Start from the latest `origin/main` and inspect all existing filenames.
2. Choose the next available filename and write one hand-authored transactional
   SQL file. Use the next available number when possible.
3. Update the typed Drizzle schema mapping and any schema parity fixtures.
4. Add focused unit/integration coverage and run `bun run db:migrate:status`.
5. Document rollout and rollback behavior in the PR. Additive migrations remain
   in the database when an older application image is rolled back.

The historical duplicate numeric prefixes below are grandfathered because both
filenames are already ledgered and cannot be renamed:

`0016`, `0017`, `0018`, `0019`, `0020`, `0025`, `0026`, `0032`.

The migration contract test permits only that explicit allowlist. Any new
duplicate numeric prefix fails CI, even when the complete filenames differ.

## Status and recovery

Use:

```bash
bun run db:migrate:status
bun run db:migration-contract
```

The status command must show matching checksums and no pending files before a
runtime is considered current. A failed migration transaction rolls back its
own changes and does not create a consumable partial ledger row. After a
committed destructive change, recovery is a correcting migration or an
immutable older image with a compatible schema; never use `git reset` or delete
ledger rows.
