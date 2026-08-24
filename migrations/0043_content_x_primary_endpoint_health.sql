-- Keep the legacy endpoint health projection one row per endpoint/partition
-- schedule.  BACKSTOP is exposed by acquisition_schedule_health instead of
-- duplicating endpoint-level health rows.

ALTER VIEW content.acquisition_endpoint_health
  RENAME TO acquisition_endpoint_health_with_roles;

CREATE VIEW content.acquisition_endpoint_health
WITH (security_invoker = true) AS
SELECT health.*
FROM content.acquisition_endpoint_health_with_roles AS health
WHERE health.schedule_id IS NULL
   OR EXISTS (
     SELECT 1
     FROM content.source_schedules AS schedule
     WHERE schedule.schedule_id = health.schedule_id
       AND schedule.schedule_role = 'PRIMARY'
   );

GRANT SELECT ON content.acquisition_endpoint_health TO letletme_data_writer;
REVOKE ALL ON content.acquisition_endpoint_health FROM letletme_graphql_reader;

COMMENT ON VIEW content.acquisition_endpoint_health IS
  'Internal endpoint health projection restricted to PRIMARY schedules; role-specific health is in acquisition_schedule_health';
