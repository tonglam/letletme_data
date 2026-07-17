-- Fresh-install bootstrap for public.tournament_selection_stats.
-- Production already has this table (created out-of-band); IF NOT EXISTS makes
-- this a no-op there. Lexically sorts before 0026_enable_rls_tournament_selection_stats.sql
-- so fresh databases have the table before the RLS ALTER runs.
-- Columns/constraints mirror src/db/schemas/tournament-selection-stats.schema.ts.

CREATE TABLE IF NOT EXISTS public.tournament_selection_stats (
  "tournament_id" integer NOT NULL,
  "event_id" integer NOT NULL,
  "element_id" integer NOT NULL,
  "pick_count" integer DEFAULT 0 NOT NULL,
  "captain_count" integer DEFAULT 0 NOT NULL,
  "vice_captain_count" integer DEFAULT 0 NOT NULL,
  "transfer_in_count" integer DEFAULT 0 NOT NULL,
  "transfer_out_count" integer DEFAULT 0 NOT NULL,
  "total_entries" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone,
  CONSTRAINT "tournament_selection_stats_pkey" PRIMARY KEY ("tournament_id", "event_id", "element_id"),
  CONSTRAINT "tournament_selection_stats_tournament_id_tournament_infos_id_fk"
    FOREIGN KEY ("tournament_id") REFERENCES "public"."tournament_infos"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "tournament_selection_stats_event_id_events_id_fk"
    FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "tournament_selection_stats_element_id_players_id_fk"
    FOREIGN KEY ("element_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "idx_tournament_selection_stats_tournament_event"
  ON public.tournament_selection_stats ("tournament_id", "event_id");
CREATE INDEX IF NOT EXISTS "idx_tournament_selection_stats_pick_count"
  ON public.tournament_selection_stats ("tournament_id", "event_id", "pick_count" DESC);
CREATE INDEX IF NOT EXISTS "idx_tournament_selection_stats_captain_count"
  ON public.tournament_selection_stats ("tournament_id", "event_id", "captain_count" DESC);
CREATE INDEX IF NOT EXISTS "idx_tournament_selection_stats_vice_captain_count"
  ON public.tournament_selection_stats ("tournament_id", "event_id", "vice_captain_count" DESC);
CREATE INDEX IF NOT EXISTS "idx_tournament_selection_stats_transfer_in_count"
  ON public.tournament_selection_stats ("tournament_id", "event_id", "transfer_in_count" DESC);
CREATE INDEX IF NOT EXISTS "idx_tournament_selection_stats_transfer_out_count"
  ON public.tournament_selection_stats ("tournament_id", "event_id", "transfer_out_count" DESC);
