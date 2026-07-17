-- Align the live table name with the Drizzle schema and production.
-- Journaled migration 0005 created the table as "event_live"; production was
-- renamed out-of-band long ago, so ALTER ... IF EXISTS makes this a no-op there.
-- Lexically sorts before 0006_remove_event_lives_mng_columns.sql so fresh
-- installs have the canonical name before later ALTERs run.

ALTER TABLE IF EXISTS public.event_live RENAME TO event_lives;
