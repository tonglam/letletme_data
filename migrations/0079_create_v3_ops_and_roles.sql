-- Data Platform v3 ownership boundary and operational source of truth.
-- This migration is intentionally non-destructive: v2 remains unchanged.

-- The B0 backup and every rehearsed restore run on PostgreSQL 15. Refuse a
-- different major before creating or altering any v3/source object: restoring
-- first and discovering an unsupported server during conversion is unsafe.
DO $postgres_major_guard$
BEGIN
  IF current_setting('server_version_num')::integer / 10000 <> 15 THEN
    RAISE EXCEPTION
      'Data Platform v3 requires PostgreSQL 15; connected server is %',
      current_setting('server_version')
      USING ERRCODE = '0A000';
  END IF;
END
$postgres_major_guard$;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- A fresh Supabase-compatible database reaches 0079 through the immutable
-- historical migration chain, whose empty legacy shape predates a few
-- production convergence fixes. Converge only when every legacy business
-- table is empty. A non-empty database is never auto-shaped here.
DO $empty_legacy_source_convergence$
DECLARE
  relation_record record;
  relation_has_rows boolean;
  source_has_rows boolean := false;
BEGIN
  FOR relation_record IN
    SELECT relation_row.relname
    FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind IN ('r', 'p')
      -- The immutable legacy chain seeds archive-control metadata even on a
      -- brand-new database. Those rows describe season availability; they are
      -- not migrated business facts and must not make the source look like B0.
      AND relation_row.relname NOT IN (
        'fpl_season_archive_items',
        'fpl_season_archives',
        'graphql_schema_migrations',
        'sql_migrations'
      )
    ORDER BY relation_row.relname
  LOOP
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM public.%I LIMIT 1)',
      relation_record.relname
    ) INTO relation_has_rows;
    source_has_rows := source_has_rows OR relation_has_rows;
    EXIT WHEN source_has_rows;
  END LOOP;

  IF source_has_rows THEN
    RETURN;
  END IF;

  ALTER TABLE public.players
    ADD COLUMN IF NOT EXISTS total_points integer DEFAULT 0;
  ALTER TABLE public.players_history
    ADD COLUMN IF NOT EXISTS total_points integer;

  ALTER TABLE public.entry_event_cup_results
    ADD COLUMN IF NOT EXISTS opponent_entry_id integer,
    ADD COLUMN IF NOT EXISTS opponent_name text,
    ADD COLUMN IF NOT EXISTS entry_points integer NOT NULL,
    ADD COLUMN IF NOT EXISTS opponent_points integer NOT NULL;

  ALTER TABLE public.tournament_groups
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;

  CREATE TABLE IF NOT EXISTS public.graphql_schema_migrations (
    version text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  );

  IF to_regclass('public.event_live_id_seq') IS NOT NULL
     AND to_regclass('public.event_lives_id_seq') IS NULL THEN
    ALTER SEQUENCE public.event_live_id_seq RENAME TO event_lives_id_seq;
  END IF;
END
$empty_legacy_source_convergence$;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'letletme_data_owner') THEN
    CREATE ROLE letletme_data_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;

  -- Temporary conversion capability. Migration 0090 revokes BYPASSRLS before activation.
  ALTER ROLE letletme_data_owner BYPASSRLS;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'letletme_v2_frozen_owner') THEN
    CREATE ROLE letletme_v2_frozen_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  -- This temporary owner holds every frozen v2 object after activation so the
  -- migration login (currently postgres in production) has no implicit owner
  -- access. Supabase's supautils blocks non-superusers from issuing even a
  -- no-op NOSUPERUSER ALTER, so validate an existing role instead of altering
  -- privileged flags after creation.
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'letletme_v2_frozen_owner'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolcanlogin OR rolinherit OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'existing letletme_v2_frozen_owner has unsafe role attributes';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'letletme_data_writer') THEN
    CREATE ROLE letletme_data_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'letletme_graphql_reader') THEN
    CREATE ROLE letletme_graphql_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;

  -- The migration login needs to SET ROLE so every v3 object has one durable owner.
  IF NOT pg_has_role(session_user, 'letletme_data_owner', 'MEMBER') THEN
    EXECUTE format('GRANT letletme_data_owner TO %I', session_user);
  END IF;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS fpl AUTHORIZATION letletme_data_owner;
CREATE SCHEMA IF NOT EXISTS competition AUTHORIZATION letletme_data_owner;
CREATE SCHEMA IF NOT EXISTS understat AUTHORIZATION letletme_data_owner;
CREATE SCHEMA IF NOT EXISTS bridge AUTHORIZATION letletme_data_owner;
CREATE SCHEMA IF NOT EXISTS reporting AUTHORIZATION letletme_data_owner;
CREATE SCHEMA IF NOT EXISTS ops AUTHORIZATION letletme_data_owner;

ALTER SCHEMA fpl OWNER TO letletme_data_owner;
ALTER SCHEMA competition OWNER TO letletme_data_owner;
ALTER SCHEMA understat OWNER TO letletme_data_owner;
ALTER SCHEMA bridge OWNER TO letletme_data_owner;
ALTER SCHEMA reporting OWNER TO letletme_data_owner;
ALTER SCHEMA ops OWNER TO letletme_data_owner;

REVOKE ALL ON SCHEMA fpl, competition, understat, bridge, reporting, ops FROM PUBLIC;

DO $revoke_data_api$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'REVOKE ALL ON SCHEMA fpl, competition, understat, bridge, reporting, ops FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END
$revoke_data_api$;

GRANT USAGE ON SCHEMA fpl, competition, understat, bridge, ops TO letletme_data_writer;
GRANT USAGE ON SCHEMA fpl, competition, understat, bridge, reporting TO letletme_graphql_reader;

-- The NOLOGIN owner is also the conversion role. Runtime roles receive no v2 grant.
GRANT USAGE ON SCHEMA public TO letletme_data_owner;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO letletme_data_owner;

SET LOCAL ROLE letletme_data_owner;

CREATE SEQUENCE IF NOT EXISTS ops.dataset_publication_revisions AS bigint;

CREATE TABLE IF NOT EXISTS ops.schema_migrations (
  filename text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schema_migrations_filename_nonempty CHECK (btrim(filename) <> ''),
  CONSTRAINT schema_migrations_checksum_sha256 CHECK (checksum ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS ops.dataset_publications (
  publication_id uuid PRIMARY KEY,
  dataset text NOT NULL,
  season_id smallint,
  event_id integer,
  revision bigint NOT NULL DEFAULT nextval('ops.dataset_publication_revisions'),
  status text NOT NULL DEFAULT 'staging',
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_run_id uuid,
  activated_at timestamptz,
  retired_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dataset_publications_dataset_nonempty CHECK (btrim(dataset) <> ''),
  CONSTRAINT dataset_publications_revision_positive CHECK (revision > 0),
  CONSTRAINT dataset_publications_event_positive CHECK (event_id IS NULL OR event_id > 0),
  CONSTRAINT dataset_publications_status_valid CHECK (
    status IN ('staging', 'active', 'retired', 'failed')
  ),
  CONSTRAINT dataset_publications_active_timestamp CHECK (
    status <> 'active' OR activated_at IS NOT NULL
  ),
  CONSTRAINT dataset_publications_retired_timestamp CHECK (
    status <> 'retired' OR retired_at IS NOT NULL
  ),
  CONSTRAINT dataset_publications_manifest_object CHECK (jsonb_typeof(manifest) = 'object'),
  CONSTRAINT dataset_publications_scope_unique
    UNIQUE NULLS NOT DISTINCT (dataset, season_id, event_id, revision)
);

CREATE UNIQUE INDEX IF NOT EXISTS dataset_publications_one_active_scope_idx
  ON ops.dataset_publications (dataset, season_id, event_id)
  NULLS NOT DISTINCT
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS dataset_publications_status_created_idx
  ON ops.dataset_publications (status, created_at DESC);
CREATE INDEX IF NOT EXISTS dataset_publications_source_run_idx
  ON ops.dataset_publications (source_run_id)
  WHERE source_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ops.sync_runs (
  run_id uuid PRIMARY KEY,
  provider text NOT NULL,
  lane text NOT NULL,
  scope text NOT NULL,
  season_id smallint,
  season_code text,
  event_id integer,
  mode text NOT NULL,
  trigger text NOT NULL,
  status text NOT NULL,
  expected_items integer NOT NULL DEFAULT 0,
  completed_items integer NOT NULL DEFAULT 0,
  failed_items integer NOT NULL DEFAULT 0,
  skipped_items integer NOT NULL DEFAULT 0,
  data_changed boolean NOT NULL DEFAULT false,
  publication_id uuid,
  error_summary text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_runs_provider_nonempty CHECK (btrim(provider) <> ''),
  CONSTRAINT sync_runs_lane_nonempty CHECK (btrim(lane) <> ''),
  CONSTRAINT sync_runs_scope_nonempty CHECK (btrim(scope) <> ''),
  CONSTRAINT sync_runs_mode_nonempty CHECK (btrim(mode) <> ''),
  CONSTRAINT sync_runs_trigger_nonempty CHECK (btrim(trigger) <> ''),
  CONSTRAINT sync_runs_status_valid CHECK (
    status IN ('pending', 'running', 'failed', 'completed', 'ready_to_publish', 'published', 'skipped')
  ),
  CONSTRAINT sync_runs_item_counts_nonnegative CHECK (
    expected_items >= 0 AND completed_items >= 0 AND failed_items >= 0 AND skipped_items >= 0
  ),
  CONSTRAINT sync_runs_event_positive CHECK (event_id IS NULL OR event_id > 0),
  CONSTRAINT sync_runs_completion_order CHECK (completed_at IS NULL OR completed_at >= started_at),
  CONSTRAINT sync_runs_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS sync_runs_provider_scope_started_idx
  ON ops.sync_runs (provider, scope, started_at DESC);
CREATE INDEX IF NOT EXISTS sync_runs_status_started_idx
  ON ops.sync_runs (status, started_at DESC);
CREATE INDEX IF NOT EXISTS sync_runs_season_event_idx
  ON ops.sync_runs (season_id, event_id)
  WHERE season_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ops.sync_items (
  run_id uuid NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  source_hash text,
  normalized_payload jsonb,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_items_pkey PRIMARY KEY (run_id, resource_type, resource_id),
  CONSTRAINT sync_items_run_fk FOREIGN KEY (run_id) REFERENCES ops.sync_runs(run_id)
    ON DELETE CASCADE,
  CONSTRAINT sync_items_resource_type_nonempty CHECK (btrim(resource_type) <> ''),
  CONSTRAINT sync_items_resource_id_nonempty CHECK (btrim(resource_id) <> ''),
  CONSTRAINT sync_items_status_valid CHECK (
    status IN ('pending', 'running', 'failed', 'completed', 'skipped')
  ),
  CONSTRAINT sync_items_attempts_nonnegative CHECK (attempts >= 0),
  CONSTRAINT sync_items_payload_object CHECK (
    normalized_payload IS NULL OR jsonb_typeof(normalized_payload) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS sync_items_status_idx
  ON ops.sync_items (status, run_id);

CREATE TABLE IF NOT EXISTS ops.migration_runs (
  run_id text PRIMARY KEY,
  plan_version text NOT NULL,
  source_project text NOT NULL,
  source_postgres_version text NOT NULL,
  source_data_sha text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT migration_runs_run_id_format CHECK (
    run_id ~ '^v3-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,12}$'
  ),
  CONSTRAINT migration_runs_plan_version_nonempty CHECK (btrim(plan_version) <> ''),
  CONSTRAINT migration_runs_source_sha_format CHECK (source_data_sha ~ '^[0-9a-f]{7,40}$'),
  CONSTRAINT migration_runs_status_valid CHECK (
    status IN ('running', 'validated', 'activated', 'failed', 'rolled_back')
  ),
  CONSTRAINT migration_runs_completion_order CHECK (completed_at IS NULL OR completed_at >= started_at),
  CONSTRAINT migration_runs_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE IF NOT EXISTS ops.migration_objects (
  run_id text NOT NULL,
  check_name text NOT NULL,
  source_object text NOT NULL DEFAULT '',
  target_object text NOT NULL DEFAULT '',
  query_sha256 text NOT NULL,
  source_row_count bigint,
  target_row_count bigint,
  source_hash text,
  target_hash text,
  failed_count bigint NOT NULL DEFAULT 0,
  sample_failed_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL,
  executed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT migration_objects_pkey
    PRIMARY KEY (run_id, check_name, source_object, target_object),
  CONSTRAINT migration_objects_run_fk FOREIGN KEY (run_id) REFERENCES ops.migration_runs(run_id)
    ON DELETE CASCADE,
  CONSTRAINT migration_objects_check_name_nonempty CHECK (btrim(check_name) <> ''),
  CONSTRAINT migration_objects_query_hash_sha256 CHECK (query_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT migration_objects_counts_nonnegative CHECK (
    (source_row_count IS NULL OR source_row_count >= 0)
    AND (target_row_count IS NULL OR target_row_count >= 0)
    AND failed_count >= 0
  ),
  CONSTRAINT migration_objects_samples_array CHECK (jsonb_typeof(sample_failed_keys) = 'array'),
  CONSTRAINT migration_objects_status_valid CHECK (status IN ('passed', 'failed', 'accepted_exception'))
);

CREATE INDEX IF NOT EXISTS migration_objects_status_idx
  ON ops.migration_objects (run_id, status, executed_at);

CREATE TABLE IF NOT EXISTS ops.season_imports (
  season_id smallint PRIMARY KEY,
  season_code text NOT NULL UNIQUE,
  status text NOT NULL,
  reason text,
  source_core_revision text,
  item_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  error_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT season_imports_season_code_format CHECK (season_code ~ '^[0-9]{4}$'),
  CONSTRAINT season_imports_status_valid CHECK (
    status IN ('unavailable', 'pending', 'building', 'sealed', 'failed')
  ),
  CONSTRAINT season_imports_manifest_array CHECK (jsonb_typeof(item_manifest) = 'array'),
  CONSTRAINT season_imports_completion_order CHECK (
    completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at
  )
);

INSERT INTO ops.migration_runs (
  run_id,
  plan_version,
  source_project,
  source_postgres_version,
  source_data_sha,
  status,
  started_at,
  metadata
)
VALUES (
  'v3-20260808T160008Z-b9eddc0',
  '3.1.1',
  'gtwcfjoviibmtkevurjw',
  '15.8',
  'b9eddc0',
  'running',
  now(),
  jsonb_build_object(
    'purpose', 'production B0 upgrade replay',
    'sourceProfile', CASE
      WHEN EXISTS (SELECT 1 FROM public.players)
        OR EXISTS (SELECT 1 FROM public.understat_matches)
        OR EXISTS (SELECT 1 FROM public.entry_infos)
      THEN 'b0_nonempty'
      ELSE 'fresh_empty'
    END
  )
)
ON CONFLICT (run_id) DO NOTHING;

REVOKE ALL ON ALL TABLES IN SCHEMA ops FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ops FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  ops.dataset_publications,
  ops.sync_runs,
  ops.sync_items,
  ops.season_imports
TO letletme_data_writer;
GRANT USAGE, SELECT ON SEQUENCE ops.dataset_publication_revisions TO letletme_data_writer;
GRANT SELECT ON ops.dataset_publications TO letletme_graphql_reader;

ALTER DEFAULT PRIVILEGES FOR ROLE letletme_data_owner IN SCHEMA fpl
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE letletme_data_owner IN SCHEMA competition
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE letletme_data_owner IN SCHEMA understat
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE letletme_data_owner IN SCHEMA bridge
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE letletme_data_owner IN SCHEMA reporting
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE letletme_data_owner IN SCHEMA ops
  REVOKE ALL ON TABLES FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE letletme_data_owner IN SCHEMA fpl
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE letletme_data_owner IN SCHEMA competition
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE letletme_data_owner IN SCHEMA understat
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE letletme_data_owner IN SCHEMA bridge
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE letletme_data_owner IN SCHEMA ops
  REVOKE ALL ON SEQUENCES FROM PUBLIC;

RESET ROLE;

-- The migration login writes the authoritative ledger after 0090 switches
-- away from public.sql_migrations. This is an operational grant only; it does
-- not grant access to any business relation.
DO $migration_ledger_grant$
BEGIN
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE ON ops.schema_migrations TO %I',
    session_user
  );
END
$migration_ledger_grant$;
