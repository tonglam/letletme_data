CREATE TABLE "phases" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"start_event" integer NOT NULL,
	"stop_event" integer NOT NULL,
	"highest_score" integer,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
