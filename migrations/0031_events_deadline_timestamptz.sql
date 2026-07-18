-- FP-21 · Convert events.deadline_time from text to timestamptz
-- Idempotent: only alters the type if it is still text.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'events'
          AND column_name = 'deadline_time'
          AND data_type = 'text'
    ) THEN
        ALTER TABLE events
        ALTER COLUMN deadline_time TYPE timestamptz
        USING NULLIF(deadline_time, '')::timestamptz;
    END IF;
END $$;
