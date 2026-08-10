-- Production entered the platform cutover with five applied GraphQL DDL
-- migrations. The historical Data migration chain preserves and then removes
-- that ledger, so a fresh-database integration run must model the same source
-- cardinality before migration 0087 captures its evidence.
INSERT INTO public.graphql_schema_migrations (version, checksum, applied_at)
VALUES
  ('0001', repeat('1', 64), '2026-01-01T00:00:01Z'),
  ('0002', repeat('2', 64), '2026-01-01T00:00:02Z'),
  ('0003', repeat('3', 64), '2026-01-01T00:00:03Z'),
  ('0004', repeat('4', 64), '2026-01-01T00:00:04Z'),
  ('0005', repeat('5', 64), '2026-01-01T00:00:05Z');
