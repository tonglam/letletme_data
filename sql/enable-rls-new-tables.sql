-- Enable RLS and add policies for entry_event_cup_results
ALTER TABLE entry_event_cup_results ENABLE ROW LEVEL SECURITY;

-- Policy: Authenticated users have full access (user/entry data)
CREATE POLICY "Allow authenticated full access to entry_event_cup_results"
ON entry_event_cup_results
FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);

-- Enable RLS and add policies for league_event_results
ALTER TABLE league_event_results ENABLE ROW LEVEL SECURITY;

-- Policy: Authenticated users have full access (user/entry data)
CREATE POLICY "Allow authenticated full access to league_event_results"
ON league_event_results
FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);
