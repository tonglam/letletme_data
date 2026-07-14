CREATE TABLE IF NOT EXISTS "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "email_verified" boolean DEFAULT false NOT NULL,
  "image" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "user_email_unique" UNIQUE("email")
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY NOT NULL,
  "expires_at" timestamp NOT NULL,
  "token" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "user_id" text NOT NULL,
  CONSTRAINT "session_token_unique" UNIQUE("token"),
  CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("user_id");

CREATE TABLE IF NOT EXISTS "account" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamp,
  "refresh_token_expires_at" timestamp,
  "scope" text,
  "password" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp NOT NULL,
  CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("user_id");

CREATE TABLE IF NOT EXISTS "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");

CREATE TABLE IF NOT EXISTS "apikey" (
  "id" text PRIMARY KEY NOT NULL,
  "config_id" text DEFAULT 'default' NOT NULL,
  "name" text,
  "start" text,
  "reference_id" text NOT NULL,
  "prefix" text,
  "key" text NOT NULL,
  "refill_interval" integer,
  "refill_amount" integer,
  "last_refill_at" timestamp,
  "enabled" boolean DEFAULT true,
  "rate_limit_enabled" boolean DEFAULT true,
  "rate_limit_time_window" integer DEFAULT 60000,
  "rate_limit_max" integer DEFAULT 100,
  "request_count" integer DEFAULT 0,
  "remaining" integer,
  "last_request" timestamp,
  "expires_at" timestamp,
  "created_at" timestamp NOT NULL,
  "updated_at" timestamp NOT NULL,
  "permissions" text,
  "metadata" text
);

CREATE INDEX IF NOT EXISTS "apikey_configId_idx" ON "apikey" ("config_id");
CREATE INDEX IF NOT EXISTS "apikey_referenceId_idx" ON "apikey" ("reference_id");
CREATE INDEX IF NOT EXISTS "apikey_key_idx" ON "apikey" ("key");
