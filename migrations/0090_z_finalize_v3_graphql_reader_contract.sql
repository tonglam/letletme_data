-- Complete the read-only GraphQL runtime boundary before approval-gated v2 cleanup.
-- The table grant in 0079 was unusable without USAGE on the private ops schema.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL ROLE letletme_data_owner;

GRANT USAGE ON SCHEMA ops TO letletme_graphql_reader;

UPDATE ops.dataset_publications
SET
  manifest = jsonb_set(manifest, '{planVersion}', '"3.2.2"'::jsonb, true),
  updated_at = now()
WHERE manifest ->> 'schemaVersion' = 'v3'
  AND manifest ->> 'planVersion' IS DISTINCT FROM '3.2.2';

RESET ROLE;
