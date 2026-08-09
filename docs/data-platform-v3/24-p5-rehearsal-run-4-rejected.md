# P5 Rehearsal Run 4 - Rejected

Date: 2026-08-09

Run ID: `v3-20260808T160008Z-b9eddc0`

Status: **rejected; does not satisfy P5-01 or P5-05**

## Passed evidence before the rejection

Rehearsal 4 started from new PostgreSQL 15.8 and Redis 7.0.15 containers and a new target database.
The encrypted B0 PostgreSQL dump and Redis RDB were restored without a plaintext host dump. The
production-faithful owner normalizer ran once before any application migration.

- all B0 public relation, sequence, ACL, and application-schema ownership gates passed;
- Web migration `0008` applied once and was a no-op on its second run;
- the dedicated Web LOGIN passed its positive contract and the administrator URL failed it;
- maintenance pages, GraphQL maintenance proxy, and Auth-session boundary returned their expected
  status codes;
- 296 BullMQ keys copied to DB1 and independently reproduced payload manifest
  `68fed9e96cec9a596c5da6f55bc7ebe4d46c345f37b4e2c6870e95344bbdf768`;
- all 17 non-destructive Data migrations applied once in 19 seconds and were no-ops on their
  second run; no `0091`-`0093` cleanup migration ran;
- Data and GraphQL dedicated LOGIN contracts passed and both administrator negative checks failed
  closed;
- activation validation passed with 192 frozen relations, 192 write fences, and one active
  publication;
- the P5 quality validator passed all 51 migration checks for 10 complete historical seasons and
  the single 2627 preseason authority; and
- 197 frozen public business-object hashes and 45 v3 business-object hashes matched accepted run-1
  outputs byte-for-byte.

Durable evidence is under external `p5/rehearsal-4/`. No credential or connection string is
retained there.

## Reject reason

The first `cache:publish-core` dry-run used `p5_data_run4`, whose only recursive capability was
`letletme_data_writer`, and passed the exact runtime identity gate. It then failed before any Redis
write while reading the cutover preflight row:

```text
PostgresError: permission denied for table migration_runs
```

The publisher intentionally checks `ops.migration_runs.status` and `metadata` to prove that the
exact run is activated and legacy cleanup has not started. Migration `0079` granted the writer
access to runtime sync/publication tables but omitted this preflight read. Running the command as
`postgres` or granting broad table access would violate the accepted runtime boundary, so neither
is an acceptable workaround.

The failure was read-only. Redis DB0 remained at 473 keys, the `llm:v3:data:*` key count remained
zero, DB1 retained the independently verified queue copy, and no Data or GraphQL service had
started. Production was not mutated.

## Permanent correction

- Plan 3.2.5 grants `letletme_data_writer` column-level `SELECT` only on
  `ops.migration_runs(run_id, status, metadata)`.
- Activation and P5 validators require exactly those three readable columns, reject table-level
  `SELECT`, reject every other readable migration-run column, and reject all table/column mutation
  privileges.
- PostgreSQL integration tests enforce the same positive and negative matrix.
- Data and GraphQL require publication plan 3.2.5, so a stale 3.2.4 database cannot serve the new
  candidates.

A post-rejection focused writer regression also exposed that the existing Data tournament services
could not enter `reporting`: the role had function `EXECUTE` but lacked schema `USAGE`, and the
services read both refreshed MVs for completion and stale-row checks. Plan 3.2.5 therefore also
grants `reporting` usage and `SELECT` only on the two tournament MVs. It does not grant Data either
ordinary reporting-view access, reporting DML/DDL, or any additional function. This follow-on
finding does not change the disposition of run 4; it prevents wasting the next clean replay on a
known application startup defect.

Rehearsal 4 remains rejected even after the correction. Two new independent B0 replays must apply
the corrected migrations without intervention, publish/read back the immutable core cache using
the Data writer, and complete all application journeys.
