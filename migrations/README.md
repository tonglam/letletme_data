# Database migrations

`0000_platform_baseline.sql` is the canonical empty-database definition for the Data-owned
schemas. It creates schema only: no seasons, provider responses, competition records, users, or
other business rows are seeded.

`bun run db:migrate` is the only migration entry point. It takes an advisory lock, verifies every
applied checksum in `ops.schema_migrations`, and applies pending SQL files transactionally in lexical
order. The initial baseline is followed by hand-written `0001_*`, `0002_*`, and later migrations.

The temporary production adopter accepts only the frozen pre-baseline ledger, exact schema/ACL/
ownership fingerprint, populated reporting models, and the accepted business-data/sequence digest.
It replaces only the migration ledger. The adopter is removed after production acceptance.

Drizzle remains a typed schema mapping and export/parity tool. It is not a second migration engine.
