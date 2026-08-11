# Database migrations

`0000_platform_baseline.sql` is the empty-database definition for the Data-owned
schemas. It creates schema only: no seasons, provider responses, competition records, users, or
other business rows are seeded.

`bun run db:migrate` is the only migration entry point. It takes an advisory lock, verifies every
applied checksum in `ops.schema_migrations`, and applies pending SQL files transactionally in lexical
order. The initial migration is followed by hand-written `0001_*`, `0002_*`, and later migrations.

Drizzle remains a typed schema mapping and export/parity tool. It is not a second migration engine.
