-- Rebind existing durable live publication items to the PostgreSQL jsonb
-- canonical representation used by the new writer and Redis-miss fallback.
-- This is idempotent and leaves core/market publication contracts untouched.
UPDATE ops.dataset_publication_items AS item
SET checksum = encode(sha256(convert_to(item.payload::text, 'UTF8')), 'hex')
FROM ops.dataset_publications AS publication
WHERE publication.publication_id = item.publication_id
  AND publication.dataset = 'fpl:live';

-- The durable reader validates the database item proof against the manifest
-- stored on the same publication row. Rewrite both representations in one
-- migration transaction so an existing live publication remains readable on
-- a Redis miss after checksum canonicalisation.
WITH manifest_items AS (
  SELECT
    publication.publication_id,
    jsonb_agg(
      CASE
        WHEN item.checksum IS NULL THEN manifest_item.item
        ELSE jsonb_set(manifest_item.item, '{sha256}', to_jsonb(item.checksum), true)
      END
      ORDER BY manifest_item.ordinality
    ) AS items,
    count(*) AS manifest_item_count,
    count(item.item_name) AS matched_item_count,
    count(DISTINCT item.item_name) AS matched_name_count
  FROM ops.dataset_publications AS publication
  CROSS JOIN LATERAL jsonb_array_elements(publication.manifest->'items')
    WITH ORDINALITY AS manifest_item(item, ordinality)
  LEFT JOIN ops.dataset_publication_items AS item
    ON item.publication_id = publication.publication_id
   AND item.item_name = manifest_item.item->>'name'
  WHERE publication.dataset = 'fpl:live'
  GROUP BY publication.publication_id
)
UPDATE ops.dataset_publications AS publication
SET manifest = jsonb_set(publication.manifest, '{items}', manifest_items.items, false),
    updated_at = now()
FROM manifest_items
WHERE publication.publication_id = manifest_items.publication_id
  AND manifest_items.manifest_item_count = 2
  AND manifest_items.matched_item_count = 2
  AND manifest_items.matched_name_count = 2;
