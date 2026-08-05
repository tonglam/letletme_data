-- Durable authority follows the tournament lifecycle migration series.
-- It coordinates the one-at-a-time non-Live core snapshot publication.
-- The revision is reserved before upstream reads so a slow older fetch cannot
-- overwrite a newer snapshot after waiting for the mutation lock.

CREATE SEQUENCE IF NOT EXISTS public.core_snapshot_revision_seq AS bigint START WITH 1;

CREATE TABLE IF NOT EXISTS public.core_snapshot_authority (
  singleton_id smallint PRIMARY KEY DEFAULT 1 CHECK (singleton_id = 1),
  season text NOT NULL CHECK (season ~ '^[0-9]{4}$'),
  revision bigint NOT NULL CHECK (revision > 0),
  publication_id uuid NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS core_snapshot_authority_publication_id_idx
  ON public.core_snapshot_authority (publication_id);

-- Generic players.updated_at is also advanced by complete core upserts. Keep
-- source-ordering evidence separate so an older core or price job cannot
-- masquerade as a newer partial price update during snapshot reconciliation.
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS price_source_checked_at timestamptz;

ALTER TABLE public.core_snapshot_authority ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.core_snapshot_authority FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.core_snapshot_revision_seq FROM PUBLIC;

DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE public.core_snapshot_authority FROM %I',
        client_role
      );
      EXECUTE format(
        'REVOKE ALL ON SEQUENCE public.core_snapshot_revision_seq FROM %I',
        client_role
      );
    END IF;
  END LOOP;
END
$$;
