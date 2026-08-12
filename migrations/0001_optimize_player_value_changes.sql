CREATE OR REPLACE VIEW reporting.player_value_changes
WITH (security_invoker='true') AS
SELECT
  snapshot.season_id,
  season.season_code,
  snapshot.snapshot_date,
  snapshot.element_id,
  snapshot.element_type,
  COALESCE(snapshot.source_event_id, event.event_id) AS event_id,
  snapshot.price AS value,
  CASE
    WHEN previous.price IS NULL THEN 0
    ELSE previous.price
  END AS last_value,
  CASE
    WHEN previous.price IS NULL THEN 'start'::text
    WHEN snapshot.price > previous.price THEN 'rise'::text
    ELSE 'fall'::text
  END AS change_type,
  CASE
    WHEN previous.price IS NULL THEN snapshot.price
    ELSE snapshot.price - previous.price
  END AS value_change,
  snapshot.snapshot_source,
  snapshot.source_value_id
FROM fpl.player_market_snapshots snapshot
JOIN fpl.seasons season
  ON season.season_id = snapshot.season_id
LEFT JOIN LATERAL (
  SELECT prior.price
  FROM fpl.player_market_snapshots prior
  WHERE prior.season_id = snapshot.season_id
    AND prior.element_id = snapshot.element_id
    AND prior.snapshot_date < snapshot.snapshot_date
  ORDER BY prior.snapshot_date DESC
  LIMIT 1
) previous ON TRUE
LEFT JOIN fpl.events event
  ON event.season_id = snapshot.season_id
 AND event.deadline_time::date = snapshot.snapshot_date
WHERE previous.price IS NULL
   OR snapshot.price IS DISTINCT FROM previous.price;

