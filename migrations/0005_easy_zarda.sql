CREATE TYPE "public"."chip" AS ENUM('n/a', 'wildcard', 'freehit', 'bboost', '3xc', 'manager');--> statement-breakpoint
CREATE TYPE "public"."cup_result" AS ENUM('win', 'loss');--> statement-breakpoint
CREATE TYPE "public"."group_mode" AS ENUM('no_group', 'points_races', 'battle_races');--> statement-breakpoint
CREATE TYPE "public"."knockout_mode" AS ENUM('no_knockout', 'single_elimination', 'double_elimination', 'head_to_head');--> statement-breakpoint
CREATE TYPE "public"."league_type" AS ENUM('classic', 'h2h');--> statement-breakpoint
CREATE TYPE "public"."tournament_mode" AS ENUM('normal');--> statement-breakpoint
CREATE TYPE "public"."tournament_state" AS ENUM('active', 'inactive', 'finished');--> statement-breakpoint
CREATE TYPE "public"."value_change_type" AS ENUM('start', 'rise', 'fall');--> statement-breakpoint
CREATE TABLE "entry_event_picks" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "entry_event_picks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"entry_id" integer NOT NULL,
	"event_id" integer NOT NULL,
	"chip" "chip" NOT NULL,
	"picks" jsonb,
	"transfers" integer,
	"transfers_cost" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_event_results" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "entry_event_results_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"entry_id" integer NOT NULL,
	"event_id" integer NOT NULL,
	"event_points" integer DEFAULT 0 NOT NULL,
	"event_transfers" integer DEFAULT 0 NOT NULL,
	"event_transfers_cost" integer DEFAULT 0 NOT NULL,
	"event_net_points" integer DEFAULT 0 NOT NULL,
	"event_bench_points" integer,
	"event_auto_sub_points" integer,
	"event_rank" integer,
	"event_chip" "chip",
	"event_played_captain" integer,
	"event_captain_points" integer,
	"event_picks" jsonb,
	"event_auto_sub" jsonb,
	"overall_points" integer DEFAULT 0 NOT NULL,
	"overall_rank" integer DEFAULT 0 NOT NULL,
	"team_value" integer,
	"bank" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "entry_event_transfers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "entry_event_transfers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"entry_id" integer NOT NULL,
	"event_id" integer NOT NULL,
	"element_in_id" integer,
	"element_in_cost" integer,
	"element_in_points" integer,
	"element_out_id" integer,
	"element_out_cost" integer,
	"element_out_points" integer,
	"transfer_time" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_history_infos" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "entry_history_infos_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"entry_id" integer NOT NULL,
	"season" char(4) NOT NULL,
	"total_points" integer DEFAULT 0 NOT NULL,
	"overall_rank" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_infos" (
	"id" integer PRIMARY KEY NOT NULL,
	"entry_name" text NOT NULL,
	"player_name" text NOT NULL,
	"region" text,
	"started_event" integer,
	"overall_points" integer,
	"overall_rank" integer,
	"bank" integer,
	"team_value" integer,
	"total_transfers" integer,
	"last_entry_name" text,
	"last_overall_points" integer,
	"last_overall_rank" integer,
	"last_team_value" integer,
	"used_entry_names" text[] DEFAULT '{}',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_league_infos" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "entry_league_infos_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"entry_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"league_name" text NOT NULL,
	"league_type" "league_type" NOT NULL,
	"started_event" integer,
	"entry_rank" integer,
	"entry_last_rank" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_fixtures" (
	"id" integer PRIMARY KEY NOT NULL,
	"code" integer NOT NULL,
	"event_id" integer,
	"finished" boolean DEFAULT false NOT NULL,
	"finished_provisional" boolean DEFAULT false NOT NULL,
	"kickoff_time" timestamp with time zone,
	"minutes" integer DEFAULT 0 NOT NULL,
	"provisional_start_time" boolean DEFAULT false NOT NULL,
	"started" boolean,
	"team_a_id" integer NOT NULL,
	"team_a_score" integer,
	"team_h_id" integer NOT NULL,
	"team_h_score" integer,
	"stats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"team_h_difficulty" integer,
	"team_a_difficulty" integer,
	"pulse_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "event_fixtures_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "event_live_explains" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_live_explains_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"event_id" integer NOT NULL,
	"element_id" integer NOT NULL,
	"bonus" integer,
	"minutes" integer,
	"minutes_points" integer,
	"goals_scored" integer,
	"goals_scored_points" integer,
	"assists" integer,
	"assists_points" integer,
	"clean_sheets" integer,
	"clean_sheets_points" integer,
	"goals_conceded" integer,
	"goals_conceded_points" integer,
	"own_goals" integer,
	"own_goals_points" integer,
	"penalties_saved" integer,
	"penalties_saved_points" integer,
	"penalties_missed" integer,
	"penalties_missed_points" integer,
	"yellow_cards" integer,
	"yellow_cards_points" integer,
	"red_cards" integer,
	"red_cards_points" integer,
	"saves" integer,
	"saves_points" integer,
	"mng_win" integer,
	"mng_win_points" integer,
	"mng_draw" integer,
	"mng_draw_points" integer,
	"mng_loss" integer,
	"mng_loss_points" integer,
	"mng_underdog_win" integer,
	"mng_underdog_win_points" integer,
	"mng_underdog_draw" integer,
	"mng_underdog_draw_points" integer,
	"mng_clean_sheets" integer,
	"mng_clean_sheets_points" integer,
	"mng_goals_scored" integer,
	"mng_goals_scored_points" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_live" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_live_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"event_id" integer NOT NULL,
	"element_id" integer NOT NULL,
	"minutes" integer,
	"goals_scored" integer,
	"assists" integer,
	"clean_sheets" integer,
	"goals_conceded" integer,
	"own_goals" integer,
	"penalties_saved" integer,
	"penalties_missed" integer,
	"yellow_cards" integer,
	"red_cards" integer,
	"saves" integer,
	"bonus" integer,
	"bps" integer,
	"starts" boolean,
	"expected_goals" numeric(10, 2),
	"expected_assists" numeric(10, 2),
	"expected_goal_involvements" numeric(10, 2),
	"expected_goals_conceded" numeric(10, 2),
	"mng_win" integer,
	"mng_draw" integer,
	"mng_loss" integer,
	"mng_underdog_win" integer,
	"mng_underdog_draw" integer,
	"mng_clean_sheets" integer,
	"mng_goals_scored" integer,
	"in_dream_team" boolean,
	"total_points" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fixtures" (
	"id" integer PRIMARY KEY NOT NULL,
	"code" integer NOT NULL,
	"event" integer,
	"finished" boolean DEFAULT false NOT NULL,
	"finished_provisional" boolean DEFAULT false NOT NULL,
	"kickoff_time" timestamp,
	"minutes" integer DEFAULT 0 NOT NULL,
	"provisional_start_time" boolean DEFAULT false NOT NULL,
	"started" boolean,
	"team_a" integer NOT NULL,
	"team_a_score" integer,
	"team_h" integer NOT NULL,
	"team_h_score" integer,
	"stats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"team_h_difficulty" integer,
	"team_a_difficulty" integer,
	"pulse_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tournament_battle_group_results" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tournament_battle_group_results_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tournament_id" integer NOT NULL,
	"group_id" integer NOT NULL,
	"event_id" integer NOT NULL,
	"home_index" integer NOT NULL,
	"home_entry_id" integer NOT NULL,
	"home_net_points" integer,
	"home_rank" integer,
	"home_match_points" integer,
	"away_index" integer NOT NULL,
	"away_entry_id" integer NOT NULL,
	"away_net_points" integer,
	"away_rank" integer,
	"away_match_points" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tournament_entries" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tournament_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tournament_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"entry_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tournament_groups" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tournament_groups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tournament_id" integer NOT NULL,
	"group_id" integer NOT NULL,
	"group_name" text NOT NULL,
	"group_index" integer NOT NULL,
	"entry_id" integer NOT NULL,
	"started_event_id" integer,
	"ended_event_id" integer,
	"group_points" integer,
	"group_rank" integer,
	"played" integer,
	"won" integer,
	"drawn" integer,
	"lost" integer,
	"total_points" integer,
	"total_transfers_cost" integer,
	"total_net_points" integer,
	"qualified" integer,
	"overall_rank" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tournament_infos" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tournament_infos_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"creator" text NOT NULL,
	"admin_entry_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"league_type" "league_type" NOT NULL,
	"total_team_num" integer NOT NULL,
	"tournament_mode" "tournament_mode" NOT NULL,
	"group_mode" "group_mode" NOT NULL,
	"group_team_num" integer,
	"group_num" integer,
	"group_started_event_id" integer,
	"group_ended_event_id" integer,
	"group_auto_averages" boolean,
	"group_rounds" integer,
	"group_play_against_num" integer,
	"group_qualify_num" integer,
	"knockout_mode" "knockout_mode" NOT NULL,
	"knockout_team_num" integer,
	"knockout_rounds" integer,
	"knockout_event_num" integer,
	"knockout_started_event_id" integer,
	"knockout_ended_event_id" integer,
	"knockout_play_against_num" integer,
	"state" "tournament_state" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tournament_knockout_results" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tournament_knockout_results_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tournament_id" integer NOT NULL,
	"event_id" integer NOT NULL,
	"match_id" integer NOT NULL,
	"play_against_id" integer NOT NULL,
	"home_entry_id" integer,
	"home_net_points" integer,
	"home_goals_scored" integer,
	"home_goals_conceded" integer,
	"away_entry_id" integer,
	"away_net_points" integer,
	"away_goals_scored" integer,
	"away_goals_conceded" integer,
	"match_winner" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tournament_knockouts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tournament_knockouts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tournament_id" integer NOT NULL,
	"round" integer NOT NULL,
	"started_event_id" integer,
	"ended_event_id" integer,
	"match_id" integer NOT NULL,
	"next_match_id" integer,
	"home_entry_id" integer,
	"home_net_points" integer,
	"home_goals_scored" integer,
	"home_goals_conceded" integer,
	"home_wins" integer,
	"away_entry_id" integer,
	"away_net_points" integer,
	"away_goals_scored" integer,
	"away_goals_conceded" integer,
	"away_wins" integer,
	"round_winner" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tournament_points_group_results" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tournament_points_group_results_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tournament_id" integer NOT NULL,
	"group_id" integer NOT NULL,
	"event_id" integer NOT NULL,
	"entry_id" integer NOT NULL,
	"event_group_rank" integer,
	"event_points" integer,
	"event_cost" integer,
	"event_net_points" integer,
	"event_rank" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "player_values" DROP CONSTRAINT "player_values_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "updated_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "player_stats" ALTER COLUMN "yellow_cards" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "player_stats" ALTER COLUMN "red_cards" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "player_stats" ALTER COLUMN "saves" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "player_stats" ALTER COLUMN "bonus" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "player_stats" ALTER COLUMN "bps" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "player_stats" ALTER COLUMN "starts" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "player_stats" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "player_stats" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "player_stats" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "player_stats" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "player_stats" ALTER COLUMN "updated_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "player_values" ALTER COLUMN "last_value" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "player_values" ALTER COLUMN "change_date" SET DATA TYPE char(8);--> statement-breakpoint
ALTER TABLE "player_values" ALTER COLUMN "change_type" SET DATA TYPE "public"."value_change_type" USING "change_type"::"public"."value_change_type";--> statement-breakpoint
ALTER TABLE "player_values" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "player_values" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "player_values" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ALTER COLUMN "price" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "players" ALTER COLUMN "start_price" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "players" ALTER COLUMN "first_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ALTER COLUMN "second_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "players" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "players" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "position" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "unavailable" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "strength_overall_home" SET DEFAULT 1000;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "strength_overall_away" SET DEFAULT 1000;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "strength_attack_home" SET DEFAULT 1000;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "strength_attack_away" SET DEFAULT 1000;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "strength_defence_home" SET DEFAULT 1000;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "strength_defence_away" SET DEFAULT 1000;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "entry_event_picks" ADD CONSTRAINT "entry_event_picks_entry_id_entry_infos_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_event_picks" ADD CONSTRAINT "entry_event_picks_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_event_results" ADD CONSTRAINT "entry_event_results_entry_id_entry_infos_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_event_results" ADD CONSTRAINT "entry_event_results_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_event_results" ADD CONSTRAINT "entry_event_results_event_played_captain_players_id_fk" FOREIGN KEY ("event_played_captain") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_event_transfers" ADD CONSTRAINT "entry_event_transfers_entry_id_entry_infos_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_event_transfers" ADD CONSTRAINT "entry_event_transfers_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_event_transfers" ADD CONSTRAINT "entry_event_transfers_element_in_id_players_id_fk" FOREIGN KEY ("element_in_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_event_transfers" ADD CONSTRAINT "entry_event_transfers_element_out_id_players_id_fk" FOREIGN KEY ("element_out_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_history_infos" ADD CONSTRAINT "entry_history_infos_entry_id_entry_infos_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_infos" ADD CONSTRAINT "entry_infos_started_event_events_id_fk" FOREIGN KEY ("started_event") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_league_infos" ADD CONSTRAINT "entry_league_infos_entry_id_entry_infos_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_league_infos" ADD CONSTRAINT "entry_league_infos_started_event_events_id_fk" FOREIGN KEY ("started_event") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_fixtures" ADD CONSTRAINT "event_fixtures_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_fixtures" ADD CONSTRAINT "event_fixtures_team_a_id_teams_id_fk" FOREIGN KEY ("team_a_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_fixtures" ADD CONSTRAINT "event_fixtures_team_h_id_teams_id_fk" FOREIGN KEY ("team_h_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_live_explains" ADD CONSTRAINT "event_live_explains_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_live_explains" ADD CONSTRAINT "event_live_explains_element_id_players_id_fk" FOREIGN KEY ("element_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_live" ADD CONSTRAINT "event_live_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_live" ADD CONSTRAINT "event_live_element_id_players_id_fk" FOREIGN KEY ("element_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_battle_group_results" ADD CONSTRAINT "tournament_battle_group_results_tournament_id_tournament_infos_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournament_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_battle_group_results" ADD CONSTRAINT "tournament_battle_group_results_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_battle_group_results" ADD CONSTRAINT "tournament_battle_group_results_home_entry_id_entry_infos_id_fk" FOREIGN KEY ("home_entry_id") REFERENCES "public"."entry_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_battle_group_results" ADD CONSTRAINT "tournament_battle_group_results_away_entry_id_entry_infos_id_fk" FOREIGN KEY ("away_entry_id") REFERENCES "public"."entry_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_tournament_id_tournament_infos_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournament_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_entry_id_entry_infos_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_groups" ADD CONSTRAINT "tournament_groups_tournament_id_tournament_infos_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournament_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_groups" ADD CONSTRAINT "tournament_groups_entry_id_entry_infos_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_groups" ADD CONSTRAINT "tournament_groups_started_event_id_events_id_fk" FOREIGN KEY ("started_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_groups" ADD CONSTRAINT "tournament_groups_ended_event_id_events_id_fk" FOREIGN KEY ("ended_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_infos" ADD CONSTRAINT "tournament_infos_group_started_event_id_events_id_fk" FOREIGN KEY ("group_started_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_infos" ADD CONSTRAINT "tournament_infos_group_ended_event_id_events_id_fk" FOREIGN KEY ("group_ended_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_infos" ADD CONSTRAINT "tournament_infos_knockout_started_event_id_events_id_fk" FOREIGN KEY ("knockout_started_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_infos" ADD CONSTRAINT "tournament_infos_knockout_ended_event_id_events_id_fk" FOREIGN KEY ("knockout_ended_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_knockout_results" ADD CONSTRAINT "tournament_knockout_results_tournament_id_tournament_infos_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournament_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_knockout_results" ADD CONSTRAINT "tournament_knockout_results_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_knockout_results" ADD CONSTRAINT "tournament_knockout_results_home_entry_id_entry_infos_id_fk" FOREIGN KEY ("home_entry_id") REFERENCES "public"."entry_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_knockout_results" ADD CONSTRAINT "tournament_knockout_results_away_entry_id_entry_infos_id_fk" FOREIGN KEY ("away_entry_id") REFERENCES "public"."entry_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_knockout_results" ADD CONSTRAINT "tournament_knockout_results_match_winner_entry_infos_id_fk" FOREIGN KEY ("match_winner") REFERENCES "public"."entry_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_knockouts" ADD CONSTRAINT "tournament_knockouts_tournament_id_tournament_infos_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournament_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_knockouts" ADD CONSTRAINT "tournament_knockouts_started_event_id_events_id_fk" FOREIGN KEY ("started_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_knockouts" ADD CONSTRAINT "tournament_knockouts_ended_event_id_events_id_fk" FOREIGN KEY ("ended_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_knockouts" ADD CONSTRAINT "tournament_knockouts_home_entry_id_entry_infos_id_fk" FOREIGN KEY ("home_entry_id") REFERENCES "public"."entry_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_knockouts" ADD CONSTRAINT "tournament_knockouts_away_entry_id_entry_infos_id_fk" FOREIGN KEY ("away_entry_id") REFERENCES "public"."entry_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_knockouts" ADD CONSTRAINT "tournament_knockouts_round_winner_entry_infos_id_fk" FOREIGN KEY ("round_winner") REFERENCES "public"."entry_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_points_group_results" ADD CONSTRAINT "tournament_points_group_results_tournament_id_tournament_infos_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournament_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_points_group_results" ADD CONSTRAINT "tournament_points_group_results_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_points_group_results" ADD CONSTRAINT "tournament_points_group_results_entry_id_entry_infos_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entry_infos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unique_entry_event_pick" ON "entry_event_picks" USING btree ("entry_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_entry_event_picks_entry_id" ON "entry_event_picks" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_entry_event_result" ON "entry_event_results" USING btree ("entry_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_entry_event_results_entry_id" ON "entry_event_results" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "idx_entry_event_results_event_id" ON "entry_event_results" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_entry_event_transfers_entry_id" ON "entry_event_transfers" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_entry_history_info" ON "entry_history_infos" USING btree ("entry_id","season");--> statement-breakpoint
CREATE INDEX "idx_entry_history_info_entry_id" ON "entry_history_infos" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_entry_league_info" ON "entry_league_infos" USING btree ("entry_id","league_id");--> statement-breakpoint
CREATE INDEX "idx_entry_league_info_entry_id" ON "entry_league_infos" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_event_fixtures" ON "event_fixtures" USING btree ("event_id","team_h_id","team_a_id");--> statement-breakpoint
CREATE INDEX "idx_event_fixtures_event_id" ON "event_fixtures" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_event_fixtures_team_h_id" ON "event_fixtures" USING btree ("team_h_id");--> statement-breakpoint
CREATE INDEX "idx_event_fixtures_team_a_id" ON "event_fixtures" USING btree ("team_a_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_event_element_live_explain" ON "event_live_explains" USING btree ("element_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_event_live_explain_element_id" ON "event_live_explains" USING btree ("element_id");--> statement-breakpoint
CREATE INDEX "idx_event_live_explain_event_id" ON "event_live_explains" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_event_live" ON "event_live" USING btree ("event_id","element_id");--> statement-breakpoint
CREATE INDEX "idx_event_live_element_id" ON "event_live" USING btree ("element_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_tournament_battle_group_result" ON "tournament_battle_group_results" USING btree ("tournament_id","group_id","event_id","home_index","away_index");--> statement-breakpoint
CREATE INDEX "idx_tournament_battle_group_result_tournament_id" ON "tournament_battle_group_results" USING btree ("tournament_id");--> statement-breakpoint
CREATE INDEX "idx_tournament_battle_group_result_group_id" ON "tournament_battle_group_results" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_tournament_battle_group_result_event_id" ON "tournament_battle_group_results" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_tournament_entry" ON "tournament_entries" USING btree ("tournament_id","league_id","entry_id");--> statement-breakpoint
CREATE INDEX "idx_tournament_entry_tournament_id" ON "tournament_entries" USING btree ("tournament_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_tournament_group" ON "tournament_groups" USING btree ("tournament_id","group_id","entry_id");--> statement-breakpoint
CREATE INDEX "idx_tournament_group_tournament_id" ON "tournament_groups" USING btree ("tournament_id");--> statement-breakpoint
CREATE INDEX "idx_tournament_group_group_id" ON "tournament_groups" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_tournament_name" ON "tournament_infos" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_tournament_info_league_id" ON "tournament_infos" USING btree ("league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_tournament_knockout_result" ON "tournament_knockout_results" USING btree ("tournament_id","event_id","match_id","play_against_id");--> statement-breakpoint
CREATE INDEX "idx_tournament_knockout_result_tournament_id" ON "tournament_knockout_results" USING btree ("tournament_id");--> statement-breakpoint
CREATE INDEX "idx_tournament_knockout_result_event_id" ON "tournament_knockout_results" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_tournament_knockout_result_match_id" ON "tournament_knockout_results" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "idx_tournament_knockout_result_play_against_id" ON "tournament_knockout_results" USING btree ("play_against_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_tournament_knockout" ON "tournament_knockouts" USING btree ("tournament_id","match_id");--> statement-breakpoint
CREATE INDEX "idx_tournament_knockout_tournament_id" ON "tournament_knockouts" USING btree ("tournament_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_tournament_points_group_result" ON "tournament_points_group_results" USING btree ("tournament_id","group_id","event_id","entry_id");--> statement-breakpoint
CREATE INDEX "idx_tournament_points_group_result_tournament_id" ON "tournament_points_group_results" USING btree ("tournament_id");--> statement-breakpoint
CREATE INDEX "idx_tournament_points_group_result_group_id" ON "tournament_points_group_results" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_tournament_points_group_result_event_id" ON "tournament_points_group_results" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_tournament_points_group_result_entry_id" ON "tournament_points_group_results" USING btree ("entry_id");--> statement-breakpoint
ALTER TABLE "phases" ADD CONSTRAINT "phases_start_event_events_id_fk" FOREIGN KEY ("start_event") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phases" ADD CONSTRAINT "phases_stop_event_events_id_fk" FOREIGN KEY ("stop_event") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unique_player_stats" ON "player_stats" USING btree ("event_id","element_id");--> statement-breakpoint
CREATE INDEX "idx_player_stats_element_id" ON "player_stats" USING btree ("element_id");--> statement-breakpoint
CREATE INDEX "idx_player_stats_event_id" ON "player_stats" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_player_values" ON "player_values" USING btree ("element_id","change_date");--> statement-breakpoint
CREATE INDEX "idx_player_values_element_id" ON "player_values" USING btree ("element_id");--> statement-breakpoint
CREATE INDEX "idx_player_values_change_date" ON "player_values" USING btree ("change_date");--> statement-breakpoint
ALTER TABLE "phases" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "player_stats" DROP COLUMN "mng_win";--> statement-breakpoint
ALTER TABLE "player_stats" DROP COLUMN "mng_draw";--> statement-breakpoint
ALTER TABLE "player_stats" DROP COLUMN "mng_loss";--> statement-breakpoint
ALTER TABLE "player_stats" DROP COLUMN "mng_underdog_win";--> statement-breakpoint
ALTER TABLE "player_stats" DROP COLUMN "mng_underdog_draw";--> statement-breakpoint
ALTER TABLE "player_stats" DROP COLUMN "mng_clean_sheets";--> statement-breakpoint
ALTER TABLE "player_stats" DROP COLUMN "mng_goals_scored";--> statement-breakpoint
ALTER TABLE "player_values" DROP COLUMN "web_name";--> statement-breakpoint
ALTER TABLE "player_values" DROP COLUMN "element_type_name";--> statement-breakpoint
ALTER TABLE "player_values" DROP COLUMN "team_id";--> statement-breakpoint
ALTER TABLE "player_values" DROP COLUMN "team_name";--> statement-breakpoint
ALTER TABLE "player_values" DROP COLUMN "team_short_name";--> statement-breakpoint
ALTER TABLE "player_values" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "players" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "teams" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_code_unique" UNIQUE("code");--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_code_unique" UNIQUE("code");--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_pulse_id_unique" UNIQUE("pulse_id");