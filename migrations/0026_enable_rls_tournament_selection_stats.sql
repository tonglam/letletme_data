ALTER TABLE public.tournament_selection_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can do everything"
  ON public.tournament_selection_stats
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Authenticated users can read"
  ON public.tournament_selection_stats
  FOR SELECT
  USING (auth.role() = 'authenticated');
