# P5 Rehearsal Run 5 - Rejected

Date: 2026-08-09

Run ID: `v3-20260808T160008Z-b9eddc0`

Status: **rejected; does not satisfy P5-01 or P5-05**

## Failure

The encrypted full B0 dump passed its immutable SHA-256 gate and was streamed directly into a new
PostgreSQL 15.8 container without a plaintext host dump. The operator command incorrectly invoked
`pg_restore --no-owner` as the direct `postgres` migration owner rather than the local Supabase
image administrator, `supabase_admin`.

The restore failed closed while creating `realtime.list_changes`, where PostgreSQL denied its
function-level `log_min_messages` setting. No public business table had been created at that point.
The partial database was not repaired or reused.

## Scope and preservation

- the new Run 5 PostgreSQL container was stopped and retained for audit;
- Redis restoration and queue relocation never started;
- no Web, Data, or GraphQL migration or service started;
- no production database, Redis endpoint, queue, application, or secret was changed; and
- durable logs, rejection metadata, and checksums are under external `p5/rehearsal-5/`.

The earlier shell-wrapper setup abort is preserved separately under external
`p5/rehearsal-5-setup-aborted-20260809T111129Z/`; it occurred before any B0 restore and is not a
rehearsal result.

## Required correction

The runbook now explicitly separates the local Supabase image administrator used for `ALTER
SYSTEM` and full-dump restore from the direct `postgres` owner used by migration tooling. The first
eligible clean replay starts from new PostgreSQL and Redis containers as Run 6. Two complete clean
plan-3.2.5 replays remain mandatory.
