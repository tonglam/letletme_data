-- Downstream provider identity bridge; provider syncs never depend on it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'provider_entity_type') THEN
    CREATE TYPE provider_entity_type AS ENUM ('team', 'player');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'provider_link_status') THEN
    CREATE TYPE provider_link_status AS ENUM (
      'pending', 'auto_verified', 'manual_verified', 'ambiguous',
      'quarantined', 'rejected'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.provider_entity_links (
  id uuid PRIMARY KEY,
  entity_type provider_entity_type NOT NULL,
  left_provider text NOT NULL,
  left_entity_id text,
  right_provider text NOT NULL,
  right_entity_id text NOT NULL,
  status provider_link_status NOT NULL,
  method text NOT NULL,
  rule_version text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_season text,
  last_seen_season text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  CONSTRAINT provider_entity_links_verified_left_check CHECK (
    status NOT IN ('auto_verified', 'manual_verified') OR left_entity_id IS NOT NULL
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_entity_links_pair
  ON public.provider_entity_links (
    entity_type, left_provider, left_entity_id, right_provider, right_entity_id
  );
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_entity_links_verified_left
  ON public.provider_entity_links (entity_type, left_provider, left_entity_id, right_provider)
  WHERE status IN ('auto_verified', 'manual_verified');
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_entity_links_verified_right
  ON public.provider_entity_links (entity_type, right_provider, right_entity_id, left_provider)
  WHERE status IN ('auto_verified', 'manual_verified');
CREATE INDEX IF NOT EXISTS idx_provider_entity_links_status
  ON public.provider_entity_links (entity_type, status);

CREATE TABLE IF NOT EXISTS public.provider_match_links (
  id uuid PRIMARY KEY,
  season text NOT NULL,
  left_provider text NOT NULL,
  left_match_id text NOT NULL,
  right_provider text NOT NULL,
  right_match_id text NOT NULL,
  status provider_link_status NOT NULL,
  method text NOT NULL,
  rule_version text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_match_links_pair
  ON public.provider_match_links (
    season, left_provider, left_match_id, right_provider, right_match_id
  );
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_match_links_verified_left
  ON public.provider_match_links (season, left_provider, left_match_id, right_provider)
  WHERE status IN ('auto_verified', 'manual_verified');
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_match_links_verified_right
  ON public.provider_match_links (season, right_provider, right_match_id, left_provider)
  WHERE status IN ('auto_verified', 'manual_verified');
CREATE INDEX IF NOT EXISTS idx_provider_match_links_status
  ON public.provider_match_links (season, status);

CREATE TABLE IF NOT EXISTS public.provider_entity_aliases (
  id uuid PRIMARY KEY,
  entity_type provider_entity_type NOT NULL,
  provider text NOT NULL,
  provider_entity_id text NOT NULL,
  alias text NOT NULL,
  source text NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_entity_aliases
  ON public.provider_entity_aliases (
    entity_type, provider, provider_entity_id, alias, source
  );
CREATE INDEX IF NOT EXISTS idx_provider_entity_aliases_lookup
  ON public.provider_entity_aliases (entity_type, provider, provider_entity_id);

DO $$
DECLARE table_name text; client_role text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'provider_entity_links', 'provider_match_links', 'provider_entity_aliases'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, client_role);
      END IF;
    END LOOP;
  END LOOP;
END $$;
