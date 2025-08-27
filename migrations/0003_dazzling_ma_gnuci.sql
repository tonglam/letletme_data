CREATE TABLE "player_values" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "player_values_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"event_id" integer NOT NULL,
	"element_id" integer NOT NULL,
	"element_type" integer NOT NULL,
	"value" integer NOT NULL,
	"last_value" integer NOT NULL,
	"change_date" text NOT NULL,
	"change_type" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "player_values" ADD CONSTRAINT "player_values_element_id_players_id_fk" FOREIGN KEY ("element_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_values" ADD CONSTRAINT "player_values_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
