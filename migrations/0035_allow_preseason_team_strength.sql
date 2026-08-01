-- FPL leaves team strength unset during the preseason. Preserve that upstream
-- value instead of forcing it into a misleading numeric default.
ALTER TABLE IF EXISTS public.teams
  ALTER COLUMN strength DROP NOT NULL;
