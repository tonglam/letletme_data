-- Rebind existing durable live publication items to the PostgreSQL jsonb
-- canonical representation used by the new writer and Redis-miss fallback.
-- This is idempotent and leaves core/market publication contracts untouched.
UPDATE ops.dataset_publication_items AS item
SET checksum = encode(sha256(convert_to(item.payload::text, 'UTF8')), 'hex')
FROM ops.dataset_publications AS publication
WHERE publication.publication_id = item.publication_id
  AND publication.dataset = 'fpl:live';
