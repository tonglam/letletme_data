DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'understat_lane') THEN
    CREATE TYPE understat_lane AS ENUM ('team', 'player');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'understat_sync_mode') THEN
    CREATE TYPE understat_sync_mode AS ENUM ('incremental', 'full', 'reconcile');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'understat_sync_trigger') THEN
    CREATE TYPE understat_sync_trigger AS ENUM ('cron', 'manual', 'api');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'understat_sync_run_status') THEN
    CREATE TYPE understat_sync_run_status AS ENUM (
      'pending', 'running', 'failed', 'ready_to_publish', 'published'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'understat_sync_item_status') THEN
    CREATE TYPE understat_sync_item_status AS ENUM (
      'pending', 'running', 'failed', 'completed', 'skipped'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.understat_sync_runs (
  run_id uuid PRIMARY KEY,
  lane understat_lane NOT NULL,
  season text NOT NULL REFERENCES public.understat_seasons(season),
  mode understat_sync_mode NOT NULL,
  trigger understat_sync_trigger NOT NULL,
  status understat_sync_run_status NOT NULL,
  expected_items integer NOT NULL DEFAULT 0,
  completed_items integer NOT NULL DEFAULT 0,
  failed_items integer NOT NULL DEFAULT 0,
  skipped_items integer NOT NULL DEFAULT 0,
  data_changed boolean NOT NULL DEFAULT false,
  cache_revision text,
  error_summary text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_understat_sync_runs_lane_season_started
  ON public.understat_sync_runs (lane, season, started_at);
CREATE INDEX IF NOT EXISTS idx_understat_sync_runs_status
  ON public.understat_sync_runs (status);

CREATE TABLE IF NOT EXISTS public.understat_sync_items (
  run_id uuid NOT NULL REFERENCES public.understat_sync_runs(run_id),
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  status understat_sync_item_status NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  source_hash text,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_understat_sync_items_run_status
  ON public.understat_sync_items (run_id, status);

DO $$
DECLARE table_name text; client_role text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['understat_sync_runs', 'understat_sync_items'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, client_role);
      END IF;
    END LOOP;
  END LOOP;
END $$;

