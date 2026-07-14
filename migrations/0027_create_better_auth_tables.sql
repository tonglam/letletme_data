-- Better Auth tables live in the dedicated `bauth` schema.
-- Core tables (user/session/account/verification) already exist there;
-- this migration only adds the API key table required by @better-auth/api-key.

CREATE SCHEMA IF NOT EXISTS bauth;

CREATE TABLE IF NOT EXISTS bauth.apikey (
  id text PRIMARY KEY NOT NULL,
  config_id text DEFAULT 'default' NOT NULL,
  name text,
  start text,
  reference_id text NOT NULL,
  prefix text,
  key text NOT NULL,
  refill_interval integer,
  refill_amount integer,
  last_refill_at timestamptz,
  enabled boolean DEFAULT true,
  rate_limit_enabled boolean DEFAULT true,
  rate_limit_time_window integer DEFAULT 60000,
  rate_limit_max integer DEFAULT 100,
  request_count integer DEFAULT 0,
  remaining integer,
  last_request timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  permissions text,
  metadata text
);

CREATE INDEX IF NOT EXISTS apikey_configId_idx ON bauth.apikey (config_id);
CREATE INDEX IF NOT EXISTS apikey_referenceId_idx ON bauth.apikey (reference_id);
CREATE INDEX IF NOT EXISTS apikey_key_idx ON bauth.apikey (key);
