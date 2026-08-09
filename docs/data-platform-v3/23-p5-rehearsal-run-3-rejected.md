# P5 Rehearsal Run 3 - Rejected

Date: 2026-08-09

Run ID: `v3-20260808T160008Z-b9eddc0`

Status: **rejected; does not satisfy P5-01 or P5-05**

## Accepted preactivation evidence

The disposable PostgreSQL 15.8 database and Redis 7.0.15 instance were restored from encrypted B0.
Before activation:

- all 198 public table/view/MV hashes, 22 sequence states, and the public ACL manifest matched B0
  with zero-byte diffs;
- Web migration `0008_web_auth_runtime_role.sql` applied once and was a no-op on its second run;
- `p5_web_run3` inherited only `letletme_web_auth`, passed the runtime contract, and the direct
  `postgres` URL failed that runtime contract;
- English and Chinese maintenance pages returned 503, the GraphQL proxy returned 503, and the Auth
  session route remained 200;
- 296 BullMQ keys copied from Redis DB0 to DB1 with payload manifest
  `68fed9e96cec9a596c5da6f55bc7ebe4d46c345f37b4e2c6870e95344bbdf768`; DB0 retained 473 keys,
  DB1 contained exactly 296, and neither database had an active-job key; and
- the direct `postgres` migration contract passed for the exact 220-relation, six-function, and
  20-enum public B0 scope.

Evidence is under external `p5/rehearsal-3/`. No connection string or credential is retained there.

## Reject reason

The Supabase image's database template already contained the same empty `fpl` schema present in
production B0, but its local owner was `supabase_admin`; production's owner is `postgres`.
`pg_restore --no-owner` did not replace an existing schema's owner. The first `0079` transaction
therefore stopped at `ALTER SCHEMA fpl OWNER TO letletme_data_owner` with:

```text
must be owner of schema fpl
```

The whole `0079` transaction rolled back. `ops.schema_migrations`, `fpl.seasons`, every v3 business
relation, and every v3 migration row remained absent. No cleanup migration ran. This is still a
failed formal activation attempt, so a later correction cannot turn run 3 into an accepted run.

An earlier pre-maintenance Web probe also exposed the same restore-fidelity issue for template-owned
`bauth` and `wechat` schemas. That probe failed before ledger mutation. The ownership normalizer was
made transactional and corrected for those schemas before the formal attempt, but it did not yet
include the empty `fpl` placeholder.

## Permanent correction

- `sql/v3/p5-normalize-b0-ownership.sql` now atomically reconciles the exact production B0 owner for
  `bauth`, empty `fpl`, `wechat`, and every public source object. It refuses a non-`p5_*` database,
  a non-`postgres` target owner, or any count/scope drift.
- `db:migration-contract` now rejects preactivation when any v3 target schema other than the empty
  `fpl` placeholder exists, when that placeholder is not owned by the direct `postgres` LOGIN, or
  when any preactivation v3 schema already contains a relation, function, enum, or domain.
- The new negative gate reproduced the wrong-owner failure before DDL; normalization then made the
  same contract pass with `invalidSchemas=0` and `objects=0`.
- Data unit tests pass 679/679; lint, typecheck, and build pass.

The Web process and run-3 database/Redis state are disposable. The replacement rehearsal must start
from a new B0 clone and a clean Redis DB1, repeat every preactivation gate, and apply all 17
activation migrations without a retry or correction.
