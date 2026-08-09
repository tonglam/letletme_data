# P5 rollback drills

Date: 2026-08-09

Run ID: `v3-20260808T160008Z-b9eddc0`

PostgreSQL: Supabase PostgreSQL 15.8 restore container on an isolated local host

External evidence root: `/Users/tong/Documents/LetLetMe Backups/v3-cutover/`
`v3-20260808T160008Z-b9eddc0/p5/`

This report accepts P5-02 and P5-03 only. It does not count either rollback probe as one of the
two consecutive full P5 rehearsals.

## P5-02 - rollback before activation

Database `p5_pre_activation_rollback` was cloned from the accepted selective B0 restore. Its
initial 198 public relation hashes, 22 sequence states, and complete public owner/ACL contract
were byte-identical to `b0_selective`.

The rehearsal then:

1. normalized the isolated B0 owner contract and generated both rollback capsules before `0079`;
2. applied exactly `0079` through `0089_prepare_v3_publications.sql`;
3. proved that all public business relation hashes and sequence states remained unchanged;
4. proved that the only public ACL delta was the documented 198 relation `SELECT` grants and one
   schema `USAGE` grant to the private Data owner;
5. exercised the generated preactivation capsule with missing and malformed approvals, both of
   which failed closed with exit 3;
6. applied the capsule with
   `APPROVE_V3_PREACTIVATION_ROLLBACK v3-20260808T160008Z-b9eddc0`;
7. compared the complete public relation hashes, sequence states, and security contract to B0;
   all three diffs are zero bytes;
8. ran the exact old Data SHA `62f134aab250d1daeee423381689924a16d438b1` migration status
   successfully and started its API; `/ready` returned 200 with PostgreSQL, Redis, and active
   season all healthy.

The capsule restores the exact 75-row v2 public ledger and removes only generated v3 staging
grants. It intentionally leaves private, inactive v3 staging schemas in place so diagnosis and a
deterministic retry do not require destructive cleanup. It never drops a schema or table and does
not mutate v2 business data.

Durable evidence:

- `p5/rollback-before-activation/manifests/preactivation-rollback.sql`, SHA-256
  `51131ab70c7b25433b361b5c98625300a395adcb40d6e5329c71cab99827ea56`;
- `p5/rollback-before-activation/logs/preactivation-rollback-approval-gate.txt`;
- `p5/rollback-before-activation/logs/preactivation-rollback-approved.log`;
- `p5/rollback-before-activation/manifests/b0-vs-rolled-back-public-relations.diff`;
- `p5/rollback-before-activation/manifests/b0-vs-rolled-back-public-sequences.diff`;
- `p5/rollback-before-activation/manifests/b0-vs-rolled-back-public-security.diff`;
- `p5/rollback-before-activation/logs/v2-sha-migration-status-after-rollback.log`;
- `p5/rollback-before-activation/logs/v2-ready-after-rollback.json`.

Result: P5-02 accepted.

## P5-03 - rollback after activation and before cleanup

Two independent probes were used. The original selective-B0 contract probe exercised missing,
wrong, and correct approval paths. A second database, `p5_full_rollback_probe`, was cloned from the
accepted full B0 restore so Supabase schemas and Web-owned `bauth` data were present.

The full probe applied `0079` through `0090_zzz_enforce_v3_publication_identity.sql`, ran the
activation and complete P5 quality validators, then applied the generated activation capsule with
`APPROVE_V3_ACTIVATION_ROLLBACK v3-20260808T160008Z-b9eddc0`.

The full restore exposed a validator defect: PostgreSQL reports a superuser as a member of every
role through `pg_has_role()` even with no `pg_auth_members` grant edge. The activation migration
already handled that distinction correctly, but the external validator and the unexecuted `0093`
cleanup postcondition did not. Both now reject real membership edges for every login and inherited
membership for non-superusers, while runtime logins remain independently tested. The corrected
activation validator and P5 quality matrix pass on the full Supabase PG15 restore.

After rollback:

- active v3 publications: 0;
- migration run status: `rolled_back`;
- restored public v2 migration ledger: exactly 75 rows;
- public relation data diff: 0 bytes;
- public sequence-state diff: 0 bytes;
- public owner/ACL diff: 0 bytes;
- Web-owned `bauth` relation-data diff: 0 bytes.

The exact old stack was then started only after v3 had been deactivated:

| Component | Baseline SHA | Probe |
| --- | --- | --- |
| Data | `62f134aab250d1daeee423381689924a16d438b1` | migration status clean; `/ready` 200; transactional writer probe passed |
| GraphQL | `3cc9951450ac5c631ea8930b0eb8c7a71a572fb6` | `/health` 200; local-PG `marketPulse` 200 |
| Web | `c290d912dfc3756237d65794c47e78f2193771e8` | build passed; home 200; GraphQL proxy 200; Better Auth session 200 |

No v3 runtime was launched during the old-stack probe. The database had zero active v3
publications before the v2 processes started, so there was no interval with both writer contracts
active.

Durable evidence:

- `p5/probe-rollback-contract/rollback-approval-gate.txt`;
- `p5/probe-rollback-contract/rollback-correct-approval.log`;
- `p5/full-rollback-probe/logs/validate-0090-fixed.log`;
- `p5/full-rollback-probe/logs/validate-p5-quality-activated.log`;
- `p5/full-rollback-probe/logs/activation-rollback-approved.log`;
- `p5/full-rollback-probe/manifests/b0-vs-rolled-back-public-relations.diff`;
- `p5/full-rollback-probe/manifests/b0-vs-rolled-back-public-sequences.diff`;
- `p5/full-rollback-probe/manifests/b0-vs-rolled-back-public-security.diff`;
- `p5/full-rollback-probe/manifests/b0-vs-rolled-back-bauth-relations.diff`;
- `p5/full-rollback-probe/logs/v2-stack-http-status.txt`;
- `p5/full-rollback-probe/logs/v2-stack-web-market.json`;
- `p5/full-rollback-probe/logs/v2-stack-web-session.json`.

Result: P5-03 accepted.

## Remaining P5 gates

P5-01, P5-04 through P5-10 remain open. In particular, this report does not freeze candidate
SHAs or migration checksums; the separate Understat integration input is still required before
P5-10.
