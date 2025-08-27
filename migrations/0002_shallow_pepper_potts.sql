CREATE TABLE "player_stats" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "player_stats_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"event_id" integer NOT NULL,
	"element_id" integer NOT NULL,
	"web_name" text NOT NULL,
	"element_type" integer NOT NULL,
	"element_type_name" text NOT NULL,
	"team_id" integer NOT NULL,
	"team_name" text NOT NULL,
	"team_short_name" text NOT NULL,
	"value" integer NOT NULL,
	"total_points" integer,
	"form" text,
	"influence" text,
	"creativity" text,
	"threat" text,
	"ict_index" text,
	"expected_goals" text,
	"expected_assists" text,
	"expected_goal_involvements" text,
	"expected_goals_conceded" text,
	"minutes" integer,
	"goals_scored" integer,
	"assists" integer,
	"clean_sheets" integer,
	"goals_conceded" integer,
	"own_goals" integer,
	"penalties_saved" integer,
	"yellow_cards" integer,
	"red_cards" integer,
	"saves" integer,
	"bonus" integer,
	"bps" integer,
	"starts" integer,
	"influence_rank" integer,
	"influence_rank_type" integer,
	"creativity_rank" integer,
	"creativity_rank_type" integer,
	"threat_rank" integer,
	"threat_rank_type" integer,
	"ict_index_rank" integer,
	"ict_index_rank_type" integer,
	"mng_win" integer,
	"mng_draw" integer,
	"mng_loss" integer,
	"mng_underdog_win" integer,
	"mng_underdog_draw" integer,
	"mng_clean_sheets" integer,
	"mng_goals_scored" integer,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "average_entry_score" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "phases" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "phases" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "phases" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "phases" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "phases" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "phases" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "player_stats" ADD CONSTRAINT "player_stats_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_stats" ADD CONSTRAINT "player_stats_element_id_players_id_fk" FOREIGN KEY ("element_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_stats" ADD CONSTRAINT "player_stats_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;