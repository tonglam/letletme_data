-- A stale host-runner readiness probe is a second billable X call made by the
-- same formal run. It must remain an independently transitionable reservation
-- when it shares the main call's hourly ledger. The runtime keeps ordinary
-- reservations coalesced, while probe reservations use a separate row.
ALTER TABLE content.acquisition_budget_reservations
  DROP CONSTRAINT IF EXISTS content_acquisition_budget_reservations_run_ledger_key;
