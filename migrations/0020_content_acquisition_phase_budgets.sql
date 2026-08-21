-- Keep the daily allowance and the optional FINAL_90 allowance in separate,
-- database-owned ledgers.  A repeated FINAL_90 poll must consume its phase
-- budget rather than silently spending the daily poll budget forever.

ALTER TABLE content.acquisition_budgets
    ADD COLUMN IF NOT EXISTS budget_scope text NOT NULL DEFAULT 'daily';

ALTER TABLE content.acquisition_budgets
    DROP CONSTRAINT IF EXISTS content_acquisition_budgets_unique_day;

ALTER TABLE content.acquisition_budgets
    ADD CONSTRAINT content_acquisition_budgets_scope_check
    CHECK (budget_scope IN ('daily', 'final90'));

ALTER TABLE content.acquisition_budgets
    ADD CONSTRAINT content_acquisition_budgets_unique_scope_day
    UNIQUE (group_id, budget_date, budget_scope);
