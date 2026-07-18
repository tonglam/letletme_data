-- FP-21 · Convert player_stats metric columns from text to numeric(10,2)
-- Idempotent: re-running only alters the type if it is still text.

DO $$
DECLARE
    v_col text;
    v_cols text[] := ARRAY[
        'form',
        'ict_index',
        'expected_goals',
        'expected_assists',
        'expected_goal_involvements',
        'expected_goals_conceded'
    ];
BEGIN
    FOREACH v_col IN ARRAY v_cols
    LOOP
        IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'player_stats'
              AND column_name = v_col
              AND data_type = 'text'
        ) THEN
            EXECUTE format(
                'ALTER TABLE player_stats ALTER COLUMN %I TYPE numeric(10,2) USING NULLIF(%I, '''')::numeric(10,2)',
                v_col, v_col
            );
        END IF;
    END LOOP;
END $$;
