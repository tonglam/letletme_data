-- ============================================================================
-- Verify Row Level Security (RLS) Status
-- ============================================================================

-- Check which tables have RLS enabled
SELECT 
    tablename,
    rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- Check all policies on tables
SELECT 
    tablename,
    policyname,
    cmd AS operation,
    roles,
    CASE 
        WHEN qual IS NOT NULL THEN 'Has USING clause'
        ELSE 'No USING clause'
    END AS using_check,
    CASE 
        WHEN with_check IS NOT NULL THEN 'Has WITH CHECK'
        ELSE 'No WITH CHECK'
    END AS with_check_clause
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- Count tables with/without RLS
SELECT 
    CASE 
        WHEN rowsecurity THEN 'RLS Enabled'
        ELSE 'RLS Disabled'
    END AS status,
    COUNT(*) AS table_count
FROM pg_tables
WHERE schemaname = 'public'
GROUP BY rowsecurity;

-- Count policies by table
SELECT 
    tablename,
    COUNT(*) AS policy_count
FROM pg_policies
WHERE schemaname = 'public'
GROUP BY tablename
ORDER BY policy_count DESC, tablename;
