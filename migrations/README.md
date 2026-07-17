# Migrations

Two migrators share this directory:

- `bun run db:migrate` (drizzle-kit) applies exactly the files journaled in
  `meta/_journal.json` (currently `0000`–`0005`).
- `bun run db:apply-sql` (`scripts/apply-sql-migrations.ts`) applies every other
  `NNNN_name.sql` file here, in lexical order, and records applied files in the
  `sql_migrations` ledger table. Journal-listed files are always excluded.

**`bun run db:generate` is frozen** (see `docs/fix-plan-2026-07-17.md`, FP-01):
running it now would emit a schema-reset migration. Until the freeze is lifted,
add new migrations as hand-written, idempotent (`IF NOT EXISTS`) `NNNN_name.sql`
files with the next sequential number, so already-migrated environments are no-ops.
