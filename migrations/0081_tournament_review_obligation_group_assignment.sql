-- Keep the last canonical tournament group assignment observed by review
-- reconciliation.  This semantic baseline wakes a scope once when a durable
-- assignment changes, and wakes an exhausted degraded scope when the source is
-- corrected back, without extending the repair horizon on every poll.

ALTER TABLE competition.tournament_review_obligations
  ADD COLUMN group_assignment_payload jsonb;

-- Seed published scopes from the assignment that was actually observed by the
-- immutable head.  Reconciliation can then compare that baseline with the
-- current canonical tournament_groups rows and wake a READY scope exactly
-- once when the assignment changes.  Headless legacy obligations remain NULL
-- and are initialized by their first reconciliation observation.
UPDATE competition.tournament_review_obligations obligation
SET group_assignment_payload = observed.group_assignment_payload
FROM (
  SELECT head.season_id,
         head.tournament_id,
         head.event_id,
         publication.format,
         jsonb_build_object(
           'count', count(payload_row)::integer,
           'assignments', COALESCE(
             jsonb_object_agg(
               payload_row->>'entryId',
               payload_row->'groupId'
             ) FILTER (WHERE payload_row->>'entryId' IS NOT NULL),
             '{}'::jsonb
           )
         ) AS group_assignment_payload
  FROM competition.tournament_review_heads head
  JOIN competition.tournament_review_publications publication
    ON publication.season_id = head.season_id
   AND publication.tournament_id = head.tournament_id
   AND publication.event_id = head.event_id
   AND publication.revision = head.revision
  LEFT JOIN LATERAL jsonb_array_elements(
    CASE publication.format
      WHEN 'POINTS' THEN
        CASE
          WHEN jsonb_typeof(publication.payload #> '{points,rows}') = 'array'
            THEN publication.payload #> '{points,rows}'
          ELSE '[]'::jsonb
        END
      WHEN 'H2H' THEN
        CASE
          WHEN jsonb_typeof(publication.payload #> '{h2h,standings}') = 'array'
            THEN publication.payload #> '{h2h,standings}'
          ELSE '[]'::jsonb
        END
      ELSE '[]'::jsonb
    END
  ) payload_row ON true
  WHERE publication.format IN ('POINTS', 'H2H')
  GROUP BY head.season_id, head.tournament_id, head.event_id, publication.format
) observed
WHERE obligation.season_id = observed.season_id
  AND obligation.tournament_id = observed.tournament_id
  AND obligation.event_id = observed.event_id
  AND obligation.format = observed.format
  AND obligation.group_assignment_payload IS NULL;

ALTER TABLE competition.tournament_review_obligations
  ADD CONSTRAINT tournament_review_obligations_group_assignment_payload_check
  CHECK (
    group_assignment_payload IS NULL
    OR jsonb_typeof(group_assignment_payload) = 'object'
  );

COMMENT ON COLUMN competition.tournament_review_obligations.group_assignment_payload IS
  'Last canonical tournament entry/group assignment observed by reconciliation; nullable for legacy rows until first observation.';
