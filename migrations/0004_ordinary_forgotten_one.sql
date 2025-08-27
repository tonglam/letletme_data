ALTER TABLE "player_values" ADD COLUMN "web_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "player_values" ADD COLUMN "element_type_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "player_values" ADD COLUMN "team_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "player_values" ADD COLUMN "team_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "player_values" ADD COLUMN "team_short_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "player_values" ADD CONSTRAINT "player_values_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;