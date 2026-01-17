# Row Level Security (RLS) Implementation

**Date:** 2026-01-18  
**Issue:** Tables exposed via Supabase Data API without authentication

---

## Problem

When using Supabase with the Data API enabled, tables without RLS are publicly accessible, allowing anyone to read/write data without authentication. This is a **security vulnerability**.

### Current State

```
❌ ALL tables: RLS DISABLED
❌ NO policies exist
❌ Result: Anyone can access all data via Data API
```

---

## Solution

Enable RLS on all tables with appropriate policies based on data sensitivity:

### 1. **Public Data** (Read-Only for Public)
Tables that contain game data everyone should be able to view:
- `events`, `fixtures`, `phases`
- `teams`, `players`
- `player_stats`, `player_values`, `player_value_tracks`
- `event_fixtures`, `event_lives`, `event_live_explains`
- **`event_live_summaries`** ⭐ (The table mentioned in the warning)

**Policy:**
```sql
-- Anyone can read
CREATE POLICY "Allow public read access" 
ON table_name FOR SELECT TO public USING (true);

-- Only authenticated (service) can write
CREATE POLICY "Allow authenticated write access"
ON table_name FOR ALL TO authenticated USING (true) WITH CHECK (true);
```

### 2. **User Data** (Authenticated Only)
Tables that contain user-specific or sensitive data:
- `entry_infos`, `entry_league_infos`, `entry_history_infos`
- `entry_event_picks`, `entry_event_transfers`, `entry_event_results`, `entry_event_cup_results`
- `league_event_results`
- All `tournament_*` tables

**Policy:**
```sql
-- Only authenticated users can read and write
CREATE POLICY "Allow authenticated full access"
ON table_name FOR ALL TO authenticated USING (true) WITH CHECK (true);
```

---

## Implementation

### Quick Fix (event_live_summaries only)

```bash
# Connect to your Supabase database
psql "$DATABASE_URL" < sql/enable-rls-event-live-summaries.sql
```

### Complete Fix (all tables)

```bash
# Apply RLS to ALL tables
psql "$DATABASE_URL" < sql/enable-rls-all-tables.sql
```

---

## Policy Explanation

### Roles in Supabase

1. **`public`** role
   - Anonymous access via Data API
   - No authentication required
   - Should only have SELECT access on public data

2. **`authenticated`** role
   - Access with valid API key (service role or user JWT)
   - Your backend service uses this
   - Can read and write data

### Policy Components

```sql
ALTER TABLE table_name ENABLE ROW LEVEL SECURITY;
-- Enables RLS enforcement

CREATE POLICY "policy_name"
ON table_name
FOR <operation>      -- SELECT, INSERT, UPDATE, DELETE, or ALL
TO <role>            -- public or authenticated
USING (condition)    -- Row visibility check (READ)
WITH CHECK (condition); -- Row modification check (WRITE)
```

### Common Patterns

**Public Read Only:**
```sql
FOR SELECT TO public USING (true);
```
- Anyone can SELECT (read) all rows

**Authenticated Full Access:**
```sql
FOR ALL TO authenticated USING (true) WITH CHECK (true);
```
- Authenticated users can do everything (SELECT, INSERT, UPDATE, DELETE)
- All rows are visible and modifiable

**User-Specific Data:**
```sql
USING (user_id = auth.uid())
```
- Only show rows where `user_id` matches the authenticated user
- Common for user profiles, preferences, etc.

---

## Verification

### Check RLS Status

```sql
SELECT tablename, rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
```

**Expected:** All tables should show `rls_enabled = true`

### Check Policies

```sql
SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
```

**Expected:** Each table should have 1-2 policies

---

## Security Impact

### Before RLS ❌

```
Data API Request (no auth) → event_live_summaries
Result: ✅ Access granted, returns all data
Risk: Anyone can read/write all data
```

### After RLS ✅

**Public Data (e.g., event_live_summaries):**
```
Data API GET (no auth) → event_live_summaries
Result: ✅ Read access granted
Reason: Public read policy allows SELECT

Data API POST (no auth) → event_live_summaries
Result: ❌ Access denied
Reason: No write policy for public role
```

**User Data (e.g., entry_infos):**
```
Data API GET (no auth) → entry_infos
Result: ❌ Access denied
Reason: No policy for public role

Data API GET (with service key) → entry_infos
Result: ✅ Access granted
Reason: Authenticated policy allows all operations
```

---

## Testing

### Test Public Access

```bash
# Should work (read public data)
curl -X GET \
  'https://your-project.supabase.co/rest/v1/events' \
  -H "apikey: YOUR_ANON_KEY"

# Should fail (write without auth)
curl -X POST \
  'https://your-project.supabase.co/rest/v1/events' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id": 1, "name": "test"}'
```

### Test Authenticated Access

```bash
# Should work (service role can write)
curl -X POST \
  'https://your-project.supabase.co/rest/v1/events' \
  -H "apikey: YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id": 1, "name": "test"}'
```

---

## Migration Plan

### Option 1: Enable All at Once (Recommended)

```bash
psql "$DATABASE_URL" < sql/enable-rls-all-tables.sql
```

**Pros:**
- Complete security coverage immediately
- No partial exposure window

**Cons:**
- Might break existing Data API clients if any

### Option 2: Enable Gradually

1. Start with critical user data:
   ```bash
   psql "$DATABASE_URL" -c "ALTER TABLE entry_infos ENABLE ROW LEVEL SECURITY;"
   # ... create policies
   ```

2. Then public data:
   ```bash
   psql "$DATABASE_URL" < sql/enable-rls-event-live-summaries.sql
   ```

3. Finally, remaining tables

---

## Best Practices

### 1. **Always Enable RLS**
Every new table should have RLS enabled from the start.

### 2. **Principle of Least Privilege**
Only grant the minimum access needed:
- Public data → Read-only for public
- User data → Authenticated only
- Admin data → Specific roles only

### 3. **Test Policies**
Always test both authenticated and unauthenticated access after creating policies.

### 4. **Document Access Patterns**
Keep this document updated when adding new tables.

### 5. **Monitor Access**
Use Supabase dashboard to monitor API usage and detect unauthorized access attempts.

---

## Common Mistakes

### ❌ Forgetting `TO public`

```sql
-- WRONG: Only affects authenticated users
CREATE POLICY "Allow read" ON table_name FOR SELECT USING (true);

-- RIGHT: Explicitly specifies public role
CREATE POLICY "Allow read" ON table_name FOR SELECT TO public USING (true);
```

### ❌ Enabling RLS Without Policies

```sql
-- This blocks ALL access, including your service!
ALTER TABLE table_name ENABLE ROW LEVEL SECURITY;
-- Must create at least one policy after enabling RLS
```

### ❌ Using `anon` Instead of `public`

```sql
-- WRONG: anon is for user JWTs
CREATE POLICY "..." TO anon USING (true);

-- RIGHT: public is for API key access
CREATE POLICY "..." TO public USING (true);
```

---

## Troubleshooting

### Issue: "Permission denied for table X"

**Cause:** RLS is enabled but no policy grants access.

**Fix:** Create appropriate policy or disable RLS temporarily:
```sql
ALTER TABLE table_name DISABLE ROW LEVEL SECURITY;
```

### Issue: "Service can't write data"

**Cause:** Missing authenticated policy for write operations.

**Fix:** Add authenticated write policy:
```sql
CREATE POLICY "Allow authenticated write"
ON table_name FOR ALL TO authenticated USING (true) WITH CHECK (true);
```

### Issue: "Data API returns empty results"

**Cause:** Policy condition is too restrictive.

**Fix:** Check policy USING clause:
```sql
-- See current policies
SELECT * FROM pg_policies WHERE tablename = 'your_table';
```

---

## Summary

✅ **RLS enabled** on all tables  
✅ **Public read** policies for game data  
✅ **Authenticated only** policies for user data  
✅ **Data API** secured against unauthorized access  
✅ **Service role** can still perform all operations  

---

## Next Steps

1. Apply RLS policies: `psql "$DATABASE_URL" < sql/enable-rls-all-tables.sql`
2. Verify RLS status in Supabase dashboard
3. Test Data API access (both authenticated and unauthenticated)
4. Update application to use service role key for write operations
5. Monitor for any access issues

---

**Status:** Ready to implement ✅

**Files:**
- `sql/enable-rls-event-live-summaries.sql` - Quick fix for single table
- `sql/enable-rls-all-tables.sql` - Complete fix for all tables
- `sql/check-rls.sql` - Verification queries
