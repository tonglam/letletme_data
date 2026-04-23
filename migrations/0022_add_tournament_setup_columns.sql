DO $$
BEGIN
  CREATE TYPE tournament_setup_status AS ENUM ('pending', 'processing', 'ready', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE tournament_infos
  ADD COLUMN IF NOT EXISTS setup_status tournament_setup_status NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS setup_error text,
  ADD COLUMN IF NOT EXISTS setup_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS setup_finished_at timestamptz;
