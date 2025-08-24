CREATE TABLE "events" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"deadline_time" timestamp,
	"average_entry_score" numeric,
	"finished" boolean DEFAULT false NOT NULL,
	"data_checked" boolean DEFAULT false NOT NULL,
	"highest_scoring_entry" integer,
	"deadline_time_epoch" integer,
	"deadline_time_game_offset" integer,
	"highest_score" integer,
	"is_previous" boolean DEFAULT false NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"is_next" boolean DEFAULT false NOT NULL,
	"cup_league_create" boolean DEFAULT false NOT NULL,
	"h2h_ko_matches_created" boolean DEFAULT false NOT NULL,
	"chip_plays" jsonb DEFAULT '[]'::jsonb,
	"most_selected" integer,
	"most_transferred_in" integer,
	"top_element" integer,
	"top_element_info" jsonb,
	"transfers_made" integer,
	"most_captained" integer,
	"most_vice_captained" integer,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" integer PRIMARY KEY NOT NULL,
	"code" integer NOT NULL,
	"type" integer NOT NULL,
	"team_id" integer NOT NULL,
	"price" integer NOT NULL,
	"start_price" integer NOT NULL,
	"first_name" text NOT NULL,
	"second_name" text NOT NULL,
	"web_name" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"short_name" text NOT NULL,
	"code" integer NOT NULL,
	"draw" integer DEFAULT 0 NOT NULL,
	"form" text,
	"loss" integer DEFAULT 0 NOT NULL,
	"played" integer DEFAULT 0 NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"position" integer NOT NULL,
	"strength" integer NOT NULL,
	"team_division" integer,
	"unavailable" boolean DEFAULT false NOT NULL,
	"win" integer DEFAULT 0 NOT NULL,
	"strength_overall_home" integer NOT NULL,
	"strength_overall_away" integer NOT NULL,
	"strength_attack_home" integer NOT NULL,
	"strength_attack_away" integer NOT NULL,
	"strength_defence_home" integer NOT NULL,
	"strength_defence_away" integer NOT NULL,
	"pulse_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;