# P5 Rehearsal Run 2 - Rejected Fresh-Cluster Attempt

Date: 2026-08-09

Run ID: `v3-20260808T160008Z-b9eddc0`

Status: rejected before any v3 migration committed. This attempt is retained because it exposed a
production deployment and least-privilege gap that the reused run-1 cluster had hidden.

## Passed pre-activation evidence

- A new Supabase PostgreSQL 15.8 container restored the encrypted full B0 dump and reproduced the
  accepted public relation, sequence, and security manifests with zero differences.
- A new Redis 7.0.15 container restored the encrypted representative B0 RDB without a plaintext
  backup artifact outside its Docker volume.
- The accepted Web candidate applied migration `0008`, ran with a dedicated
  `letletme_web_auth` LOGIN, and served English/Chinese maintenance pages, the GraphQL maintenance
  response, and the Better Auth session endpoint with their expected status codes.
- Old Data and GraphQL rehearsal processes were stopped only after exact PID/cwd checks.
- The frozen target retained exact B0 public data/sequence/security hashes. Its only remaining
  application session was the maintenance Web LOGIN, which had no public business-table DML.
- Two BullMQ dry-runs produced the same 296-key manifest. DB0-to-DB1 execution and independent
  verification reproduced key manifest
  `3a9acf9042087059a054bc0c73e25dbecf05bf568d675cecd3b8b23a5677d597` and payload manifest
  `68fed9e96cec9a596c5da6f55bc7ebe4d46c345f37b4e2c6870e95344bbdf768`.

## Fail-closed migration result

The first stateful Data migration command failed inside the transaction for
`0079_create_v3_ops_and_roles.sql`:

```text
PostgresError: must be superuser to create bypassrls users
```

The rehearsal had normalized B0 ownership to a generic non-superuser `CREATEROLE` LOGIN. That
LOGIN cannot create the temporary `BYPASSRLS` conversion owner required to read RLS-protected v2
source tables. The transaction rolled back: no `0079` ledger row or v3 schema remained and no v2
business row changed.

An isolated Supabase-image probe then proved the actual direct `postgres` LOGIN is non-superuser
but has the provider-delegated ability to create and alter `BYPASSRLS` roles. The runbook therefore
must require that exact one-shot migration identity rather than an arbitrary migration operator.

## Additional security finding

Run 1 provisioned its Data application LOGIN with `letletme_data_owner`. The schema already has a
separate `letletme_data_writer` capability containing the intended CRUD and reporting-refresh
grants. Giving the application the owner role allows DDL and invalidates the claimed
least-privilege boundary.

P5-08 and P5-09 were immediately reopened. The replacement candidate now requires:

- a migration-only container/environment holding the direct Supabase `postgres` URL;
- API and worker environments containing only the dedicated runtime URL;
- a pre-migration role/ownership contract;
- production API/worker startup to fail before listening unless the LOGIN inherits only
  `letletme_data_writer`; and
- core-cache publication to enforce the same writer contract.

## Disposition

This attempt cannot satisfy P5-01 or P5-05. Its database and Redis containers are disposable
rehearsal state and are not a source for the next accepted replay. A new independent B0 restore is
required after the corrected candidate passes repository gates.

No production PostgreSQL, Redis, queue, application, or secret was accessed or changed.
