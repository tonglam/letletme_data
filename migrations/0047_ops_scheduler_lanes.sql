-- Single-flight lanes keep latest-authoritative scheduler work coalesced while
-- retaining every scheduled obligation as durable audit evidence.
CREATE TABLE ops.scheduler_lanes (
  lane_id uuid PRIMARY KEY,
  lane_key text NOT NULL,
  job_name text NOT NULL,
  scope_key text NOT NULL,
  queue_name text NOT NULL,
  state text NOT NULL DEFAULT 'idle',
  desired_obligation_id uuid NOT NULL,
  desired_due_at timestamptz NOT NULL,
  active_obligation_id uuid,
  dispatch_generation integer NOT NULL DEFAULT 0,
  dispatch_owner text,
  dispatch_lease_expires_at timestamptz,
  bull_job_id text,
  run_id uuid,
  blocker_job_id text,
  retry_not_before timestamptz,
  last_error text,
  last_progress_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  superseded_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT scheduler_lanes_state_check CHECK (
    state IN ('idle', 'dispatching', 'enqueued', 'running', 'blocked')
  ),
  CONSTRAINT scheduler_lanes_generation_check CHECK (dispatch_generation >= 0),
  CONSTRAINT scheduler_lanes_superseded_check CHECK (superseded_count >= 0),
  CONSTRAINT scheduler_lanes_identity_check CHECK (
    btrim(lane_key) <> '' AND btrim(job_name) <> '' AND btrim(scope_key) <> ''
  ),
  CONSTRAINT scheduler_lanes_desired_obligation_fk
    FOREIGN KEY (desired_obligation_id)
    REFERENCES ops.scheduler_obligations(obligation_id)
    ON DELETE RESTRICT,
  CONSTRAINT scheduler_lanes_active_obligation_fk
    FOREIGN KEY (active_obligation_id)
    REFERENCES ops.scheduler_obligations(obligation_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX scheduler_lanes_lane_key
  ON ops.scheduler_lanes (lane_key);
CREATE INDEX scheduler_lanes_state_idx
  ON ops.scheduler_lanes (state, retry_not_before, updated_at);
CREATE INDEX scheduler_lanes_progress_idx
  ON ops.scheduler_lanes (last_progress_at, lane_id);

REVOKE ALL ON TABLE ops.scheduler_lanes FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE ops.scheduler_lanes TO letletme_data_writer;
REVOKE ALL ON TABLE ops.scheduler_lanes FROM letletme_graphql_reader;
