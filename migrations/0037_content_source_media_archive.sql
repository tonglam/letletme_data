-- Durable X source-media inventory and archive queue. Receipt revisions remain immutable;
-- media state is normalized here and never participates in acquisition-run success.

CREATE TABLE content.source_media_gates (
  gate_id uuid PRIMARY KEY,
  receipt_id uuid NOT NULL
    REFERENCES content.source_receipts(receipt_id) ON DELETE RESTRICT,
  receipt_revision_id uuid NOT NULL
    REFERENCES content.source_receipt_revisions(receipt_revision_id) ON DELETE RESTRICT,
  post_id text NOT NULL,
  canonical_url text NOT NULL,
  request_hash text NOT NULL,
  season_id smallint REFERENCES fpl.seasons(season_id) ON DELETE RESTRICT,
  retain_until date,
  status text NOT NULL DEFAULT 'PENDING',
  release_deadline_at timestamptz NOT NULL,
  next_attempt_at timestamptz,
  repair_until_at timestamptz NOT NULL,
  repair_exhausted_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  first_attempt_at timestamptz,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  last_failure_class text,
  last_failure_hash text,
  discovered_count integer NOT NULL DEFAULT 0,
  archived_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  media_state_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_source_media_gates_revision_key UNIQUE (receipt_revision_id),
  CONSTRAINT content_source_media_gates_post_id_check CHECK (post_id ~ '^[0-9]+$'),
  CONSTRAINT content_source_media_gates_url_check CHECK (
    canonical_url ~ '^https://(www\.)?(x\.com|twitter\.com)/[^/]+/status/[0-9]+$'
    AND canonical_url LIKE '%/status/' || post_id
  ),
  CONSTRAINT content_source_media_gates_request_hash_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT content_source_media_gates_status_check CHECK (
    status IN ('PENDING', 'RUNNING', 'COMPLETE', 'CHECKED_NONE', 'PARTIAL', 'UNAVAILABLE')
  ),
  CONSTRAINT content_source_media_gates_deadline_order_check CHECK (
    repair_until_at >= release_deadline_at
  ),
  CONSTRAINT content_source_media_gates_season_retention_check CHECK (
    season_id IS NOT NULL OR retain_until IS NULL
  ),
  CONSTRAINT content_source_media_gates_attempt_check CHECK (attempt_count >= 0),
  CONSTRAINT content_source_media_gates_counts_check CHECK (
    discovered_count >= 0 AND archived_count >= 0 AND rejected_count >= 0
    AND archived_count <= discovered_count
    AND rejected_count <= discovered_count
    AND archived_count + rejected_count <= discovered_count
  ),
  CONSTRAINT content_source_media_gates_lease_check CHECK (
    (status = 'RUNNING' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'RUNNING' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT content_source_media_gates_failure_hash_check CHECK (
    last_failure_hash IS NULL OR last_failure_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT content_source_media_gates_state_hash_check CHECK (
    media_state_hash IS NULL OR media_state_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT content_source_media_gates_exhausted_check CHECK (
    repair_exhausted_at IS NULL OR repair_exhausted_at >= release_deadline_at
  )
);

CREATE INDEX content_source_media_gates_receipt_idx
  ON content.source_media_gates (receipt_id, created_at DESC);
CREATE INDEX content_source_media_gates_season_idx
  ON content.source_media_gates (season_id, retain_until)
  WHERE season_id IS NOT NULL;
CREATE INDEX content_source_media_gates_due_idx
  ON content.source_media_gates (next_attempt_at, release_deadline_at, gate_id)
  WHERE status IN ('PENDING', 'PARTIAL', 'UNAVAILABLE')
    AND next_attempt_at IS NOT NULL
    AND repair_exhausted_at IS NULL;
CREATE INDEX content_source_media_gates_reclaim_idx
  ON content.source_media_gates (lease_expires_at, gate_id)
  WHERE status = 'RUNNING';

CREATE TABLE content.source_media_assets (
  asset_id uuid PRIMARY KEY,
  sha256 text NOT NULL,
  object_key text NOT NULL,
  actual_mime text NOT NULL,
  byte_size bigint NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  bucket text NOT NULL,
  storage_state text NOT NULL DEFAULT 'RESERVED',
  upload_lease_owner text,
  upload_lease_expires_at timestamptz,
  available_at timestamptz,
  deleted_at timestamptz,
  last_failure_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_source_media_assets_sha_key UNIQUE (sha256),
  CONSTRAINT content_source_media_assets_object_key_key UNIQUE (object_key),
  CONSTRAINT content_source_media_assets_sha_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT content_source_media_assets_object_key_check CHECK (
    object_key ~ '^x/images/sha256/[0-9a-f]{2}/[0-9a-f]{64}\.(jpg|png|webp|gif)$'
  ),
  CONSTRAINT content_source_media_assets_object_identity_check CHECK (
    object_key = 'x/images/sha256/' || left(sha256, 2) || '/' || sha256 ||
      CASE actual_mime
        WHEN 'image/jpeg' THEN '.jpg'
        WHEN 'image/png' THEN '.png'
        WHEN 'image/webp' THEN '.webp'
        WHEN 'image/gif' THEN '.gif'
      END
  ),
  CONSTRAINT content_source_media_assets_mime_check CHECK (
    actual_mime IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
  ),
  CONSTRAINT content_source_media_assets_size_check CHECK (
    byte_size > 0 AND byte_size <= 25165824
  ),
  CONSTRAINT content_source_media_assets_dimensions_check CHECK (
    width > 0 AND height > 0
    AND width <= 8192 AND height <= 8192
    AND width::bigint * height::bigint <= 67108864
  ),
  CONSTRAINT content_source_media_assets_bucket_check CHECK (bucket = 'briefing-source-media'),
  CONSTRAINT content_source_media_assets_state_check CHECK (
    storage_state IN ('RESERVED', 'AVAILABLE', 'DELETED', 'FAILED')
  ),
  CONSTRAINT content_source_media_assets_upload_lease_check CHECK (
    (upload_lease_owner IS NULL AND upload_lease_expires_at IS NULL)
    OR (upload_lease_owner IS NOT NULL AND upload_lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT content_source_media_assets_available_check CHECK (
    storage_state NOT IN ('AVAILABLE', 'DELETED') OR available_at IS NOT NULL
  ),
  CONSTRAINT content_source_media_assets_deleted_check CHECK (
    (storage_state = 'DELETED' AND deleted_at IS NOT NULL)
    OR (storage_state <> 'DELETED' AND deleted_at IS NULL)
  ),
  CONSTRAINT content_source_media_assets_failure_hash_check CHECK (
    last_failure_hash IS NULL OR last_failure_hash ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX content_source_media_assets_state_idx
  ON content.source_media_assets (storage_state, updated_at);
CREATE INDEX content_source_media_assets_upload_lease_idx
  ON content.source_media_assets (upload_lease_expires_at, asset_id)
  WHERE upload_lease_expires_at IS NOT NULL;

CREATE TABLE content.source_media_items (
  item_id uuid PRIMARY KEY,
  gate_id uuid NOT NULL REFERENCES content.source_media_gates(gate_id) ON DELETE RESTRICT,
  ordinal integer NOT NULL,
  role text NOT NULL,
  source_url text NOT NULL,
  alt_text text,
  source_variant text NOT NULL,
  actual_mime text,
  archive_status text NOT NULL DEFAULT 'PENDING',
  asset_id uuid REFERENCES content.source_media_assets(asset_id) ON DELETE RESTRICT,
  failure_class text,
  failure_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_source_media_items_gate_ordinal_key UNIQUE (gate_id, ordinal),
  CONSTRAINT content_source_media_items_ordinal_check CHECK (ordinal >= 0),
  CONSTRAINT content_source_media_items_role_check CHECK (
    role IN ('IMAGE', 'VIDEO_POSTER', 'VIDEO_STREAM')
  ),
  CONSTRAINT content_source_media_items_url_check CHECK (
    (
      role IN ('IMAGE', 'VIDEO_POSTER')
      AND source_url ~ '^https://pbs\.twimg\.com/(media|amplify_video_thumb)/'
    )
    OR (
      role = 'VIDEO_STREAM'
      AND source_url ~ '^https://video\.twimg\.com/amplify_video/'
    )
  ),
  CONSTRAINT content_source_media_items_variant_check CHECK (source_variant IN ('PAGE', 'ORIG')),
  CONSTRAINT content_source_media_items_mime_check CHECK (
    actual_mime IS NULL OR actual_mime IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
  ),
  CONSTRAINT content_source_media_items_archive_status_check CHECK (
    archive_status IN ('PENDING', 'ARCHIVED', 'RETRYABLE', 'UNAVAILABLE', 'REJECTED_UNSAFE')
  ),
  CONSTRAINT content_source_media_items_asset_check CHECK (
    (archive_status = 'ARCHIVED' AND asset_id IS NOT NULL AND actual_mime IS NOT NULL)
    OR (archive_status <> 'ARCHIVED' AND asset_id IS NULL)
  ),
  CONSTRAINT content_source_media_items_failure_hash_check CHECK (
    failure_hash IS NULL OR failure_hash ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX content_source_media_items_gate_idx
  ON content.source_media_items (gate_id, ordinal);
CREATE INDEX content_source_media_items_asset_idx
  ON content.source_media_items (asset_id)
  WHERE asset_id IS NOT NULL;
CREATE INDEX content_source_media_items_archive_status_idx
  ON content.source_media_items (archive_status, updated_at);

ALTER TABLE content.pipeline_outbox
  ADD COLUMN media_gate_id uuid
    REFERENCES content.source_media_gates(gate_id) ON DELETE RESTRICT;

ALTER TABLE content.pipeline_outbox
  DROP CONSTRAINT content_pipeline_outbox_event_type_check,
  ADD CONSTRAINT content_pipeline_outbox_event_type_check CHECK (
    event_type IN ('receipt.accepted.v1', 'receipt.updated.v1', 'receipt.media.updated.v1')
  );

CREATE INDEX content_pipeline_outbox_media_gate_idx
  ON content.pipeline_outbox (media_gate_id, status, available_at)
  WHERE media_gate_id IS NOT NULL;

CREATE OR REPLACE FUNCTION content.validate_source_media_gate_receipt_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = content, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM content.source_receipt_revisions AS revision
    JOIN content.source_receipts AS receipt ON receipt.receipt_id = revision.receipt_id
    WHERE revision.receipt_revision_id = NEW.receipt_revision_id
      AND revision.receipt_id = NEW.receipt_id
      AND receipt.receipt_key LIKE 'x:%'
      AND receipt.content_kind = 'POST'
      AND receipt.external_id = NEW.post_id
  ) THEN
    RAISE EXCEPTION 'source_media_gates must bind one matching X post receipt revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER content_source_media_gates_receipt_identity_valid
BEFORE INSERT ON content.source_media_gates
FOR EACH ROW EXECUTE FUNCTION content.validate_source_media_gate_receipt_identity();

CREATE OR REPLACE FUNCTION content.prevent_source_media_gate_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = content, pg_catalog
AS $$
BEGIN
  IF NEW.receipt_id IS DISTINCT FROM OLD.receipt_id
    OR NEW.receipt_revision_id IS DISTINCT FROM OLD.receipt_revision_id
    OR NEW.post_id IS DISTINCT FROM OLD.post_id
    OR NEW.canonical_url IS DISTINCT FROM OLD.canonical_url
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.season_id IS DISTINCT FROM OLD.season_id
    OR NEW.retain_until IS DISTINCT FROM OLD.retain_until
    OR NEW.release_deadline_at IS DISTINCT FROM OLD.release_deadline_at
    OR NEW.repair_until_at IS DISTINCT FROM OLD.repair_until_at
  THEN
    RAISE EXCEPTION 'source_media_gates request identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER content_source_media_gates_identity_immutable
BEFORE UPDATE ON content.source_media_gates
FOR EACH ROW EXECUTE FUNCTION content.prevent_source_media_gate_identity_mutation();

CREATE OR REPLACE FUNCTION content.prevent_source_media_asset_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = content, pg_catalog
AS $$
BEGIN
  -- available_at is retained across DELETED -> RESERVED -> AVAILABLE so a
  -- previously archived content-addressed row can never mutate its facts while
  -- being restored after retention.
  IF OLD.available_at IS NOT NULL AND (
    NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.object_key IS DISTINCT FROM OLD.object_key
    OR NEW.actual_mime IS DISTINCT FROM OLD.actual_mime
    OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
    OR NEW.width IS DISTINCT FROM OLD.width
    OR NEW.height IS DISTINCT FROM OLD.height
    OR NEW.bucket IS DISTINCT FROM OLD.bucket
    OR NEW.available_at IS DISTINCT FROM OLD.available_at
  ) THEN
    RAISE EXCEPTION 'available source_media_assets facts are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER content_source_media_assets_facts_immutable
BEFORE UPDATE ON content.source_media_assets
FOR EACH ROW EXECUTE FUNCTION content.prevent_source_media_asset_fact_mutation();

CREATE OR REPLACE FUNCTION content.prevent_source_media_item_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = content, pg_catalog
AS $$
BEGIN
  IF NEW.gate_id IS DISTINCT FROM OLD.gate_id
    OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
    OR NEW.role IS DISTINCT FROM OLD.role
    OR NEW.source_url IS DISTINCT FROM OLD.source_url
    OR NEW.alt_text IS DISTINCT FROM OLD.alt_text
    OR (
      OLD.archive_status = 'ARCHIVED'
      AND (
        NEW.archive_status IS DISTINCT FROM OLD.archive_status
        OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
        OR NEW.actual_mime IS DISTINCT FROM OLD.actual_mime
        OR NEW.source_variant IS DISTINCT FROM OLD.source_variant
      )
    )
  THEN
    RAISE EXCEPTION 'source_media_items observed evidence is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER content_source_media_items_evidence_immutable
BEFORE UPDATE ON content.source_media_items
FOR EACH ROW EXECUTE FUNCTION content.prevent_source_media_item_evidence_mutation();

CREATE OR REPLACE FUNCTION content.validate_source_media_item_archive()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = content, pg_catalog
AS $$
BEGIN
  IF NEW.archive_status = 'ARCHIVED' AND NOT EXISTS (
    SELECT 1
    FROM content.source_media_assets AS asset
    WHERE asset.asset_id = NEW.asset_id
      AND asset.storage_state = 'AVAILABLE'
      AND asset.actual_mime = NEW.actual_mime
      AND asset.upload_lease_owner IS NULL
  ) THEN
    RAISE EXCEPTION 'archived source_media_items require an AVAILABLE MIME-matched asset'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER content_source_media_items_archive_valid
BEFORE INSERT OR UPDATE ON content.source_media_items
FOR EACH ROW EXECUTE FUNCTION content.validate_source_media_item_archive();

-- Backfill every formal X receipt revision. Backfill receives a fresh repair window so old posts
-- are actually processed instead of becoming instantly exhausted because their revision is old.
WITH current_season AS (
  SELECT season_id, ends_at
  FROM fpl.seasons
  WHERE is_current = true
  LIMIT 1
), raw_x_revisions AS (
  SELECT
    revision.receipt_revision_id,
    receipt.receipt_id,
    receipt.external_id AS post_id,
    COALESCE(
      revision.payload ->> 'canonicalUrl',
      receipt.canonical_url
    ) AS raw_canonical_url,
    season.season_id,
    CASE WHEN season.ends_at IS NULL THEN NULL ELSE season.ends_at + 90 END AS retain_until
  FROM content.source_receipt_revisions AS revision
  JOIN content.source_receipts AS receipt ON receipt.receipt_id = revision.receipt_id
  LEFT JOIN current_season AS season ON true
  WHERE receipt.receipt_key LIKE 'x:%'
    AND receipt.content_kind = 'POST'
), x_revisions AS (
  SELECT
    receipt_revision_id,
    receipt_id,
    post_id,
    COALESCE(
      (
        regexp_match(
          raw_canonical_url,
          '^(https://(www\.)?(x\.com|twitter\.com)/[^/]+/status/'
            || post_id
            || ')(?:[/?#].*)?$'
        )
      )[1],
      'https://x.com/i/status/' || post_id
    ) AS canonical_url,
    season_id,
    retain_until
  FROM raw_x_revisions
)
INSERT INTO content.source_media_gates (
  gate_id,
  receipt_id,
  receipt_revision_id,
  post_id,
  canonical_url,
  request_hash,
  season_id,
  retain_until,
  status,
  release_deadline_at,
  next_attempt_at,
  repair_until_at
)
SELECT
  gen_random_uuid(),
  receipt_id,
  receipt_revision_id,
  post_id,
  canonical_url,
  encode(
    sha256(convert_to(
      'x-page-media-v1|' || receipt_revision_id::text || '|' || post_id || '|' || canonical_url,
      'UTF8'
    )),
    'hex'
  ),
  season_id,
  retain_until,
  'PENDING',
  now() + interval '20 minutes',
  now(),
  now() + interval '24 hours'
FROM x_revisions
ON CONFLICT (receipt_revision_id) DO NOTHING;

UPDATE content.pipeline_outbox AS outbox
SET
  media_gate_id = gate.gate_id,
  available_at = GREATEST(outbox.available_at, gate.release_deadline_at),
  updated_at = now()
FROM content.source_media_gates AS gate
WHERE outbox.receipt_revision_id = gate.receipt_revision_id
  AND outbox.status = 'PENDING'
  AND outbox.event_type IN ('receipt.accepted.v1', 'receipt.updated.v1')
  AND outbox.media_gate_id IS NULL;

CREATE VIEW content.source_media_health
WITH (security_invoker = true) AS
SELECT
  now() AS observed_at,
  gate_stats.pending_count,
  gate_stats.running_count,
  gate_stats.complete_count,
  gate_stats.checked_none_count,
  gate_stats.partial_count,
  gate_stats.unavailable_count,
  gate_stats.oldest_due_at,
  CASE
    WHEN gate_stats.oldest_due_at IS NULL THEN NULL
    ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - gate_stats.oldest_due_at)))::bigint
  END AS oldest_due_age_seconds,
  gate_stats.release_deadline_overdue_count,
  gate_stats.repair_exhausted_count,
  gate_stats.oldest_running_lease_at,
  CASE
    WHEN gate_stats.oldest_running_lease_at IS NULL THEN NULL
    ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - gate_stats.oldest_running_lease_at)))::bigint
  END AS oldest_running_lease_age_seconds,
  gate_stats.recent_failure_classes,
  item_stats.media_item_count,
  item_stats.archived_item_count,
  item_stats.video_stream_count,
  item_stats.rejected_item_count,
  asset_stats.asset_count,
  asset_stats.available_asset_count,
  asset_stats.available_bytes,
  asset_stats.mime_distribution,
  asset_stats.average_storage_latency_ms,
  asset_stats.unreferenced_asset_count,
  asset_stats.retention_due_soon_count,
  asset_stats.retention_due_count,
  asset_stats.deleted_asset_count,
  outbox_stats.ready_pipeline_outbox_count,
  outbox_stats.media_deadline_blocked_count
FROM (
  SELECT
    count(*) FILTER (WHERE status = 'PENDING')::integer AS pending_count,
    count(*) FILTER (WHERE status = 'RUNNING')::integer AS running_count,
    count(*) FILTER (WHERE status = 'COMPLETE')::integer AS complete_count,
    count(*) FILTER (WHERE status = 'CHECKED_NONE')::integer AS checked_none_count,
    count(*) FILTER (WHERE status = 'PARTIAL')::integer AS partial_count,
    count(*) FILTER (WHERE status = 'UNAVAILABLE')::integer AS unavailable_count,
    min(next_attempt_at) FILTER (
      WHERE status IN ('PENDING', 'PARTIAL', 'UNAVAILABLE')
        AND repair_exhausted_at IS NULL
    ) AS oldest_due_at,
    count(*) FILTER (
      WHERE release_deadline_at <= now()
        AND status NOT IN ('COMPLETE', 'CHECKED_NONE')
    )::integer AS release_deadline_overdue_count,
    count(*) FILTER (WHERE repair_exhausted_at IS NOT NULL)::integer AS repair_exhausted_count,
    min(last_attempt_at) FILTER (WHERE status = 'RUNNING') AS oldest_running_lease_at,
    (
      SELECT COALESCE(jsonb_agg(DISTINCT recent.failure_class), '[]'::jsonb)
      FROM (
        SELECT last_failure_class AS failure_class
        FROM content.source_media_gates
        WHERE last_failure_class IS NOT NULL
          AND updated_at >= now() - interval '24 hours'
        UNION ALL
        SELECT failure_class
        FROM content.source_media_items
        WHERE failure_class IS NOT NULL
          AND updated_at >= now() - interval '24 hours'
      ) AS recent
    ) AS recent_failure_classes
  FROM content.source_media_gates
) AS gate_stats
CROSS JOIN (
  SELECT
    count(*)::integer AS media_item_count,
    count(*) FILTER (WHERE archive_status = 'ARCHIVED')::integer AS archived_item_count,
    count(*) FILTER (WHERE role = 'VIDEO_STREAM')::integer AS video_stream_count,
    count(*) FILTER (WHERE archive_status = 'REJECTED_UNSAFE')::integer AS rejected_item_count
  FROM content.source_media_items
) AS item_stats
CROSS JOIN (
  SELECT
    count(*)::integer AS asset_count,
    count(*) FILTER (WHERE storage_state = 'AVAILABLE')::integer AS available_asset_count,
    COALESCE(sum(byte_size) FILTER (WHERE storage_state = 'AVAILABLE'), 0)::bigint
      AS available_bytes,
    (
      SELECT COALESCE(jsonb_object_agg(mime.actual_mime, mime.asset_count), '{}'::jsonb)
      FROM (
        SELECT actual_mime, count(*)::integer AS asset_count
        FROM content.source_media_assets
        WHERE storage_state = 'AVAILABLE'
        GROUP BY actual_mime
      ) AS mime
    ) AS mime_distribution,
    avg(storage_latency_ms)::bigint AS average_storage_latency_ms,
    count(*) FILTER (
      WHERE storage_state = 'AVAILABLE' AND reference_count = 0
    )::integer AS unreferenced_asset_count,
    count(*) FILTER (WHERE retention_due_soon)::integer AS retention_due_soon_count,
    count(*) FILTER (WHERE retention_due)::integer AS retention_due_count,
    count(*) FILTER (WHERE storage_state = 'DELETED')::integer AS deleted_asset_count
  FROM (
    SELECT
      asset.asset_id,
      asset.actual_mime,
      asset.byte_size,
      asset.storage_state,
      count(item.item_id)::integer AS reference_count,
      CASE
        WHEN asset.available_at IS NULL THEN NULL
        ELSE GREATEST(0, EXTRACT(EPOCH FROM (asset.available_at - asset.created_at)) * 1000)
      END AS storage_latency_ms,
      asset.storage_state = 'AVAILABLE'
        AND bool_and(gate.retain_until IS NOT NULL)
        AND max(gate.retain_until) < current_date AS retention_due,
      asset.storage_state = 'AVAILABLE'
        AND bool_and(gate.retain_until IS NOT NULL)
        AND max(gate.retain_until) >= current_date
        AND max(gate.retain_until) <= current_date + 30 AS retention_due_soon
    FROM content.source_media_assets AS asset
    LEFT JOIN content.source_media_items AS item ON item.asset_id = asset.asset_id
    LEFT JOIN content.source_media_gates AS gate ON gate.gate_id = item.gate_id
    GROUP BY asset.asset_id
  ) AS asset_rollup
) AS asset_stats
CROSS JOIN (
  SELECT
    count(*) FILTER (
      WHERE status = 'PENDING' AND available_at <= now()
    )::integer AS ready_pipeline_outbox_count,
    count(*) FILTER (
      WHERE status = 'PENDING' AND media_gate_id IS NOT NULL AND available_at > now()
    )::integer AS media_deadline_blocked_count
  FROM content.pipeline_outbox
) AS outbox_stats;

REVOKE ALL ON FUNCTION content.prevent_source_media_gate_identity_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION content.prevent_source_media_asset_fact_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION content.prevent_source_media_item_evidence_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION content.validate_source_media_gate_receipt_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION content.validate_source_media_item_archive() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION content.prevent_source_media_gate_identity_mutation()
  TO letletme_data_writer;
GRANT EXECUTE ON FUNCTION content.prevent_source_media_asset_fact_mutation()
  TO letletme_data_writer;
GRANT EXECUTE ON FUNCTION content.prevent_source_media_item_evidence_mutation()
  TO letletme_data_writer;
GRANT EXECUTE ON FUNCTION content.validate_source_media_gate_receipt_identity()
  TO letletme_data_writer;
GRANT EXECUTE ON FUNCTION content.validate_source_media_item_archive()
  TO letletme_data_writer;

GRANT SELECT, INSERT, UPDATE ON content.source_media_gates TO letletme_data_writer;
GRANT SELECT, INSERT, UPDATE ON content.source_media_items TO letletme_data_writer;
GRANT SELECT, INSERT, UPDATE ON content.source_media_assets TO letletme_data_writer;
GRANT SELECT ON content.source_media_health TO letletme_data_writer;
REVOKE DELETE ON content.source_media_gates FROM letletme_data_writer;
REVOKE DELETE ON content.source_media_items FROM letletme_data_writer;
REVOKE DELETE ON content.source_media_assets FROM letletme_data_writer;

REVOKE ALL ON content.source_media_gates FROM letletme_graphql_reader;
REVOKE ALL ON content.source_media_items FROM letletme_graphql_reader;
REVOKE ALL ON content.source_media_assets FROM letletme_graphql_reader;
REVOKE ALL ON content.source_media_health FROM letletme_graphql_reader;

COMMENT ON TABLE content.source_media_gates IS
  'PostgreSQL-backed X media queue and 20-minute Receipt event release contract';
COMMENT ON TABLE content.source_media_items IS
  'Ordered X post media inventory; ordinal preserves target-article DOM order';
COMMENT ON TABLE content.source_media_assets IS
  'Content-addressed private Storage objects verified from actual image bytes';
COMMENT ON COLUMN content.pipeline_outbox.media_gate_id IS
  'Optional X media gate; available_at remains the hard upper bound on media waiting';
COMMENT ON VIEW content.source_media_health IS
  'Internal source-media backlog, archive, outbox SLA and retention health projection';
