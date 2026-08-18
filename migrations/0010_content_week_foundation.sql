-- Briefing content foundation.  This migration is additive and deliberately
-- keeps editorial/source material separate from the public compiled payload.

CREATE SCHEMA content;
ALTER SCHEMA content OWNER TO letletme_data_owner;

CREATE TABLE content.sources (
  source_id uuid PRIMARY KEY,
  platform text NOT NULL,
  external_id text NOT NULL,
  handle text,
  display_name text NOT NULL,
  source_type text NOT NULL,
  reporting_family text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  rights_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_sources_platform_external_key UNIQUE (platform, external_id),
  CONSTRAINT content_sources_status_check CHECK (status IN ('active', 'paused', 'disabled')),
  CONSTRAINT content_sources_rights_object_check CHECK (jsonb_typeof(rights_policy) = 'object')
);

CREATE TABLE content.source_groups (
  group_id uuid PRIMARY KEY,
  group_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  poll_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_source_groups_status_check CHECK (status IN ('active', 'paused', 'disabled')),
  CONSTRAINT content_source_groups_policy_object_check CHECK (jsonb_typeof(poll_policy) = 'object')
);

CREATE TABLE content.source_group_members (
  group_id uuid NOT NULL REFERENCES content.source_groups(group_id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES content.sources(source_id) ON DELETE RESTRICT,
  priority integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, source_id),
  CONSTRAINT content_source_group_members_priority_check CHECK (priority >= 0)
);

CREATE TABLE content.acquisition_checkpoints (
  group_id uuid NOT NULL REFERENCES content.source_groups(group_id) ON DELETE CASCADE,
  partition_key text NOT NULL,
  cursor text,
  source_snapshot_revision text NOT NULL,
  window_end timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, partition_key)
);

CREATE TABLE content.acquisition_budgets (
  budget_id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES content.source_groups(group_id) ON DELETE CASCADE,
  budget_date date NOT NULL,
  max_x_calls integer NOT NULL,
  used_x_calls integer NOT NULL DEFAULT 0,
  max_cost_micros bigint,
  used_cost_micros bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_acquisition_budgets_unique_day UNIQUE (group_id, budget_date),
  CONSTRAINT content_acquisition_budgets_max_calls_check CHECK (max_x_calls >= 0),
  CONSTRAINT content_acquisition_budgets_used_calls_check CHECK (used_x_calls >= 0 AND used_x_calls <= max_x_calls),
  CONSTRAINT content_acquisition_budgets_cost_check CHECK (
    (max_cost_micros IS NULL OR max_cost_micros >= 0) AND used_cost_micros >= 0
  )
);

CREATE TABLE content.acquisition_runs (
  run_id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES content.source_groups(group_id) ON DELETE RESTRICT,
  mode text NOT NULL,
  partition_key text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  source_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  skill_sha text,
  adapter_version text,
  x_call_count integer NOT NULL DEFAULT 0,
  trace_verified boolean NOT NULL DEFAULT false,
  checkpoint_advanced boolean NOT NULL DEFAULT false,
  error_summary text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_acquisition_runs_mode_check CHECK (mode IN ('poll', 'enrich', 'compose')),
  CONSTRAINT content_acquisition_runs_status_check CHECK (status IN ('pending', 'running', 'empty', 'partial', 'failed', 'completed')),
  CONSTRAINT content_acquisition_runs_window_check CHECK (window_end >= window_start),
  CONSTRAINT content_acquisition_runs_snapshot_array_check CHECK (jsonb_typeof(source_snapshot) = 'array'),
  CONSTRAINT content_acquisition_runs_x_calls_check CHECK (x_call_count >= 0)
);

-- Tool-level evidence is metadata only. Never persist Grok prompts, sessions or
-- credentials here; the verified hashes let an editor audit that a receipt was
-- produced by the expected skill and adapter.
CREATE TABLE content.acquisition_run_x_traces (
  run_id uuid PRIMARY KEY REFERENCES content.acquisition_runs(run_id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  skill_sha text NOT NULL,
  adapter_version text NOT NULL,
  request_hash text NOT NULL,
  response_hash text,
  call_count integer NOT NULL DEFAULT 0,
  trace_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified boolean NOT NULL DEFAULT false,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_acquisition_run_x_traces_call_count_check CHECK (call_count >= 0),
  CONSTRAINT content_acquisition_run_x_traces_metadata_object_check CHECK (jsonb_typeof(trace_metadata) = 'object')
);

CREATE TABLE content.source_receipts (
  receipt_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES content.acquisition_runs(run_id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES content.sources(source_id) ON DELETE RESTRICT,
  external_id text NOT NULL,
  canonical_url text NOT NULL,
  captured_at timestamptz NOT NULL,
  published_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  canonical_hash text NOT NULL,
  rights_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_source_receipts_source_external_key UNIQUE (source_id, external_id),
  CONSTRAINT content_source_receipts_payload_object_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT content_source_receipts_rights_object_check CHECK (jsonb_typeof(rights_policy) = 'object')
);

CREATE TABLE content.candidate_clusters (
  candidate_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES content.acquisition_runs(run_id) ON DELETE RESTRICT,
  canonical_hash text NOT NULL,
  status text NOT NULL DEFAULT 'new',
  materiality text NOT NULL DEFAULT 'unknown',
  receipt_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_candidate_clusters_status_check CHECK (status IN ('new', 'accepted', 'rejected', 'merged', 'split')),
  CONSTRAINT content_candidate_clusters_receipts_array_check CHECK (jsonb_typeof(receipt_ids) = 'array')
);

CREATE TABLE content.stories (
  story_id uuid PRIMARY KEY,
  version_group_id uuid NOT NULL,
  canonical_slug text NOT NULL UNIQUE,
  story_revision integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_stories_status_check CHECK (status IN ('draft', 'ready', 'published', 'removed')),
  CONSTRAINT content_stories_revision_check CHECK (story_revision > 0)
);

CREATE TABLE content.story_localizations (
  localization_id uuid PRIMARY KEY,
  version_group_id uuid NOT NULL,
  locale text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  body text NOT NULL,
  source_attribution text,
  claims jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_story_localizations_version_locale_key UNIQUE (version_group_id, locale),
  CONSTRAINT content_story_localizations_locale_check CHECK (locale IN ('en', 'zh-CN')),
  CONSTRAINT content_story_localizations_claims_array_check CHECK (jsonb_typeof(claims) = 'array')
);

CREATE TABLE content.story_evidence (
  story_id uuid NOT NULL REFERENCES content.stories(story_id) ON DELETE CASCADE,
  receipt_id uuid NOT NULL REFERENCES content.source_receipts(receipt_id) ON DELETE RESTRICT,
  evidence_role text NOT NULL DEFAULT 'source',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, receipt_id)
);

CREATE TABLE content.entities (
  entity_id uuid PRIMARY KEY,
  entity_type text NOT NULL,
  canonical_key text NOT NULL,
  display_name text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_entities_type_key UNIQUE (entity_type, canonical_key),
  CONSTRAINT content_entities_metadata_object_check CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE content.story_entities (
  story_id uuid NOT NULL REFERENCES content.stories(story_id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES content.entities(entity_id) ON DELETE RESTRICT,
  entity_role text NOT NULL DEFAULT 'mentioned',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, entity_id)
);

CREATE TABLE content.claims (
  claim_id uuid PRIMARY KEY,
  story_id uuid NOT NULL REFERENCES content.stories(story_id) ON DELETE CASCADE,
  claim_key text NOT NULL,
  statement text NOT NULL,
  status text NOT NULL DEFAULT 'unverified',
  confidence numeric(5, 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_claims_story_key UNIQUE (story_id, claim_key),
  CONSTRAINT content_claims_status_check CHECK (status IN ('unverified', 'verified', 'disputed', 'retracted')),
  CONSTRAINT content_claims_confidence_check CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE TABLE content.claim_evidence (
  claim_id uuid NOT NULL REFERENCES content.claims(claim_id) ON DELETE CASCADE,
  receipt_id uuid NOT NULL REFERENCES content.source_receipts(receipt_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_id, receipt_id)
);

CREATE TABLE content.week_editions (
  edition_id uuid PRIMARY KEY,
  season_code text NOT NULL,
  event_id integer NOT NULL,
  event_name text NOT NULL,
  deadline_time timestamptz NOT NULL,
  source_snapshot_revision text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_week_editions_season_check CHECK (season_code ~ '^[0-9]{4}$'),
  CONSTRAINT content_week_editions_event_check CHECK (event_id > 0),
  CONSTRAINT content_week_editions_status_check CHECK (status IN ('draft', 'ready', 'published', 'retired'))
);

CREATE TABLE content.week_edition_items (
  edition_id uuid NOT NULL REFERENCES content.week_editions(edition_id) ON DELETE CASCADE,
  story_id uuid NOT NULL REFERENCES content.stories(story_id) ON DELETE RESTRICT,
  section_key text NOT NULL,
  placement text NOT NULL DEFAULT 'standard',
  position integer NOT NULL,
  PRIMARY KEY (edition_id, story_id),
  CONSTRAINT content_week_edition_items_position_check CHECK (position >= 0)
);

CREATE TABLE content.publications (
  publication_id uuid PRIMARY KEY,
  scope_key text NOT NULL,
  revision bigint NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  season_code text NOT NULL,
  target_event_id integer,
  event_name text,
  deadline_time timestamptz,
  state text NOT NULL,
  status text NOT NULL DEFAULT 'staging',
  servable boolean NOT NULL DEFAULT false,
  source_checked_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL,
  valid_until timestamptz,
  locale_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CONSTRAINT content_publications_scope_revision_key UNIQUE (scope_key, revision),
  CONSTRAINT content_publications_schema_check CHECK (schema_version > 0),
  CONSTRAINT content_publications_state_check CHECK (state IN ('READY', 'EMPTY', 'STALE', 'OFFSEASON', 'UNAVAILABLE', 'REMOVED')),
  CONSTRAINT content_publications_status_check CHECK (status IN ('staging', 'active', 'retired', 'tombstone')),
  CONSTRAINT content_publications_season_check CHECK (season_code ~ '^[0-9]{4}$'),
  CONSTRAINT content_publications_locale_manifest_object_check CHECK (jsonb_typeof(locale_manifest) = 'object'),
  CONSTRAINT content_publications_valid_until_check CHECK (valid_until IS NULL OR deadline_time IS NULL OR valid_until <= deadline_time)
);

CREATE UNIQUE INDEX content_publications_one_active_scope_idx
  ON content.publications (scope_key)
  WHERE status = 'active' AND servable;

CREATE TABLE content.publication_payloads (
  publication_id uuid NOT NULL REFERENCES content.publications(publication_id) ON DELETE CASCADE,
  locale text NOT NULL,
  payload jsonb NOT NULL,
  payload_bytes integer NOT NULL,
  payload_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (publication_id, locale),
  CONSTRAINT content_publication_payloads_locale_check CHECK (locale IN ('en', 'zh-CN')),
  CONSTRAINT content_publication_payloads_bytes_check CHECK (payload_bytes >= 2),
  CONSTRAINT content_publication_payloads_object_check CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE content.publication_outbox (
  outbox_id uuid PRIMARY KEY,
  event_type text NOT NULL,
  publication_id uuid REFERENCES content.publications(publication_id) ON DELETE SET NULL,
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_publication_outbox_payload_object_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT content_publication_outbox_attempts_check CHECK (attempts >= 0)
);

CREATE TABLE content.acquisition_costs (
  cost_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES content.acquisition_runs(run_id) ON DELETE CASCADE,
  provider text NOT NULL,
  amount_micros bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  units integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_acquisition_costs_amount_check CHECK (amount_micros >= 0),
  CONSTRAINT content_acquisition_costs_units_check CHECK (units >= 0),
  CONSTRAINT content_acquisition_costs_metadata_object_check CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE content.publication_dependencies (
  publication_id uuid NOT NULL REFERENCES content.publications(publication_id) ON DELETE CASCADE,
  dependency_kind text NOT NULL,
  dependency_key text NOT NULL,
  dependency_revision text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (publication_id, dependency_kind, dependency_key)
);

CREATE TABLE content.editorial_actions (
  action_id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  actor_id text NOT NULL,
  role text NOT NULL,
  action_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_editorial_actions_payload_object_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT content_editorial_actions_role_check CHECK (role IN ('content_editor', 'content_publisher'))
);

CREATE INDEX content_source_group_members_source_idx ON content.source_group_members (source_id);
CREATE INDEX content_acquisition_checkpoints_updated_idx ON content.acquisition_checkpoints (updated_at DESC);
CREATE INDEX content_acquisition_budgets_date_idx ON content.acquisition_budgets (budget_date DESC);
CREATE INDEX content_acquisition_runs_group_created_idx ON content.acquisition_runs (group_id, created_at DESC);
CREATE INDEX content_acquisition_run_x_traces_verified_idx ON content.acquisition_run_x_traces (verified, captured_at DESC);
CREATE INDEX content_source_receipts_run_idx ON content.source_receipts (run_id, captured_at DESC);
CREATE INDEX content_acquisition_costs_run_idx ON content.acquisition_costs (run_id, created_at DESC);
CREATE INDEX content_stories_version_group_idx ON content.stories (version_group_id);
CREATE INDEX content_story_entities_entity_idx ON content.story_entities (entity_id);
CREATE INDEX content_claims_story_idx ON content.claims (story_id, updated_at DESC);
CREATE INDEX content_claim_evidence_receipt_idx ON content.claim_evidence (receipt_id);
CREATE INDEX content_story_localizations_locale_idx ON content.story_localizations (locale, version_group_id);
CREATE INDEX content_week_edition_items_placement_idx ON content.week_edition_items (edition_id, section_key, position);
CREATE INDEX content_publications_active_lookup_idx ON content.publications (scope_key, status, servable, revision DESC);
CREATE INDEX content_publication_outbox_pending_idx ON content.publication_outbox (created_at)
  WHERE delivered_at IS NULL;
CREATE INDEX content_publication_dependencies_key_idx ON content.publication_dependencies (dependency_kind, dependency_key);
CREATE INDEX content_editorial_actions_entity_idx ON content.editorial_actions (entity_type, entity_id, created_at DESC);

CREATE VIEW content.briefing_active_publication AS
SELECT
  publication_id,
  scope_key,
  revision,
  schema_version,
  season_code,
  target_event_id,
  event_name,
  deadline_time,
  state,
  servable,
  source_checked_at,
  published_at,
  valid_until,
  locale_manifest
FROM content.publications
WHERE status = 'active' AND servable = true;

GRANT USAGE ON SCHEMA content TO letletme_data_writer;
GRANT USAGE ON SCHEMA content TO letletme_graphql_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA content TO letletme_data_writer;
GRANT SELECT ON content.briefing_active_publication TO letletme_graphql_reader;
GRANT SELECT ON content.publication_payloads TO letletme_graphql_reader;

ALTER DEFAULT PRIVILEGES FOR ROLE letletme_data_owner IN SCHEMA content
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO letletme_data_writer;

COMMENT ON SCHEMA content IS 'Real-world Briefing source, editorial and compiled publication data';
COMMENT ON VIEW content.briefing_active_publication IS 'Narrow GraphQL reader view; raw editorial/source tables are not exposed';
