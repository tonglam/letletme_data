# Migrations

Two migrators share this directory:

- `bun run db:migrate` (drizzle-kit) applies exactly the files journaled in
  `meta/_journal.json` (currently `0000`–`0005`).
- `bun run db:apply-sql` (`scripts/apply-sql-migrations.ts`) applies every other
  `NNNN_name.sql` file here, in lexical order, and records applied files in the
  `sql_migrations` ledger table. Journal-listed files are always excluded. Each
  file and ledger insert share one transaction; the ledger stores a SHA-256
  checksum and refuses edited or missing applied files.
- `bun run db:migrate:status` is read-only apart from bootstrapping the ledger
  shape and exits non-zero for pending, legacy-unchecksummed, mismatched, or
  missing migrations.

**`bun run db:generate` is frozen** (see `docs/fix-plan-2026-07-17.md`, FP-01):
running it now would emit a schema-reset migration. Until the freeze is lifted,
add new migrations as hand-written, idempotent (`IF NOT EXISTS`) `NNNN_name.sql`
files with the next sequential number, so already-migrated environments are no-ops.

`0034_widen_entry_event_transfers_identity.sql` is a staged cutover. Deploy the
service with `TRANSFER_SYNC_MODE=latest` first, apply 0034, then change the mode
to `all` and trigger the existing entry-transfers sync job to backfill history.
