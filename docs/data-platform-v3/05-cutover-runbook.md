# Data Platform v3 Cutover and Recovery Runbook

Plan version: 3.2.4

Mode: maintenance-window hard cutover

Prohibited: dual-write, shadow reads, v2 fallback after activation, `FLUSHDB`, `FLUSHALL`, remote
`db reset`, wildcard table drops, and undocumented manual SQL.

## Operator variables

The operator resolves these values before B0/cutover. Never print connection strings, passwords,
service keys, or GPG passphrases into logs.

```text
CUTOVER_RUN_ID=v3-YYYYMMDDTHHMMSSZ-<short-data-sha>
CUTOVER_BACKUP_ROOT=/Users/tong/Documents/LetLetMe Backups/v3-cutover/<run-id>
CUTOVER_DATA_SHA=<40-char-sha>
CUTOVER_GRAPHQL_SHA=<40-char-sha>
CUTOVER_WEB_SHA=<40-char-sha>
CUTOVER_DATA_IMAGE_REF=ghcr.io/<owner>/<repo>@sha256:<64-hex-digest>
CUTOVER_RELEASE_MANIFEST=<backup-root>/release/release-manifest.json
CUTOVER_RELEASE_MANIFEST_SHA256=<64-hex-digest>
CUTOVER_MIGRATION_DATABASE_URL=<secret-direct-Supabase-postgres-url>
CUTOVER_DATA_RUNTIME_DATABASE_URL=<secret-dedicated-data-writer-login-url>
CUTOVER_WEB_RUNTIME_DATABASE_URL=<secret-dedicated-web-login-url>
CUTOVER_WEB_MIGRATION_DATABASE_URL=<secret-direct-postgres-url>
CUTOVER_QUEUE_REDIS_URL=<secret>
CUTOVER_CACHE_REDIS_URL=<secret>
```

Validation requirements:

- run ID matches `^v3-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,12}$`;
- backup root is exactly beneath `/Users/tong/Documents/LetLetMe Backups/v3-cutover/`;
- the run directory does not already exist;
- each SHA exactly matches the reviewed external release manifest;
- the Data image reference is pinned by digest and matches `dataImageDigest` in that manifest;
- database is production project `gtwcfjoviibmtkevurjw` and PostgreSQL 15;
- the hosted PostgreSQL security-patch advisor warning is resolved, or an explicit, dated exception
  is attached to the run and accepted before activation;
- the one-shot migration container alone receives `CUTOVER_MIGRATION_DATABASE_URL`; API and worker
  containers receive only `CUTOVER_DATA_RUNTIME_DATABASE_URL`, and neither runtime environment
  contains the migration secret;
- `bun run db:migration-contract` passes for the direct Supabase `postgres` LOGIN before downtime;
  a generic `CREATEROLE` login is insufficient because `0079` temporarily creates a conversion
  owner with `BYPASSRLS`;
- every P0-approved `public` relation, sequence, function, and enum is owned by that migration
  login; an ownership difference stops before `0079` mutates anything;
- queue/cache endpoints are distinct and neither value is logged.

The approved release manifest is generated only after candidate SHAs and image digests are frozen.
It is stored in encrypted cutover evidence and supplied to deployment as canonical base64; it is
not committed into the candidate commit or embedded in its image. This avoids self-referential Git
and container digests.

When migration `0079` is present, automatic deployment is blocked. Manual deployment is also
blocked unless the external manifest hash, Data SHA, candidate image digest, and run ID all match
and the operator supplies:

```text
APPROVE_V3_ACTIVATION <CUTOVER_RUN_ID>
```

This activation token does not authorize legacy deletion.

## B0 backup procedure

1. Create `<backup-root>/b0/{raw,encrypted,manifests,logs,restore}` with restrictive permissions.
2. Record UTC start time and versions of `pg_dump`, `pg_restore`, `psql`, `redis-cli`, GPG, Data,
   GraphQL, and Web.
3. Capture read-only object inventory, exact counts, canonical hashes, grants, policies, functions,
   triggers, indexes, migration ledgers, and active DB sessions.
4. Produce logical artifacts:

```text
pg_dumpall --globals-only --no-role-passwords
pg_dump --schema-only --no-owner --no-privileges
pg_dump --format=custom --compress=9 --no-owner
pg_dump --format=custom --compress=9 --no-owner \
  --schema=public --schema=bauth --schema=wechat
```

The selective command's final schema/table include list is generated from the exact P0 inventory;
the example above is not permission to omit required Data source objects or include secrets.

5. Capture Redis evidence:
   - persistence configuration and latest successful RDB/AOF snapshot evidence;
   - BullMQ queue names, paused/active/waiting/delayed/failed counts, and job ID ranges;
   - key manifest grouped by endpoint, namespace, Redis type, TTL class, count, and memory;
   - active Data core/live revision manifests and content hashes.
6. Compute SHA-256 for every raw artifact, encrypt each with GPG AES-256, compute encrypted
   checksums, and verify decryptability into the isolated restore directory.
7. Remove unencrypted raw artifacts only after encrypted checksum/decryption verification is
   recorded. Report exactly what was removed and that recovery remains available from encrypted B0.
8. Restore full and selective dumps into two isolated PostgreSQL 15 databases. Apply no migrations.
   For each restore target containing `pg_cron` objects, set `cron.database_name` to that exact
   target database in the PostgreSQL server configuration, restart PostgreSQL, and verify the
   effective setting before `pg_restore`. A restore attempted with `cron.database_name` pointing
   elsewhere is rejected even if every non-`pg_cron` object restored. After both restores and their
   reconciliation are accepted, set `cron.database_name` back to the neutral `postgres` database,
   restart, verify the setting, and only then clone or prepare a rehearsal/cutover target.
9. Run the complete B0 reconciliation suite. Archive restore logs and reports.

B0 is invalid if a dump succeeded but either restore was not tested.

## Pre-cutover gate

All fields below must be attached to the run record:

- B0 manifest and both restore reports;
- two passing rehearsal reports;
- final candidate SHAs and container image digests;
- migration filenames/checksums `0079`-`0090_zzz` and approval-gated `0091`-`0093`;
- generated source/target/drop object manifests;
- migration duration estimate plus 50% contingency;
- current database/Redis size and free-capacity report;
- rollback SHAs/images and tested B1 restore procedure;
- maintenance message and private smoke-test credentials/routes.
- the dedicated Web auth LOGIN is mapped only to `letletme_web_auth`. The Data writer and GraphQL
  reader LOGIN names, generated credentials, and reviewed provisioning commands are staged but
  are not granted an owner/admin fallback before activation: their capability roles
  `letletme_data_writer` and `letletme_graphql_reader` are created by `0079`. Immediately after
  `0090_zzz`, provision those two LOGINs with `INHERIT`, all elevated attributes disabled, and
  exactly one capability membership each. No runtime may inherit an owner role or use the
  migration login. Data production startup and `cache:publish-core` must pass the Data runtime-role
  contract; GraphQL must pass `contract:check`. Web `DATABASE_URL` must pass
  `db:runtime-contract`, while its administrator connection is supplied only as
  `DIRECT_DATABASE_URL` to migration commands.
- Web migration `0008_web_auth_runtime_role.sql` is applied and its dedicated LOGIN is provisioned
  before maintenance starts. This migration changes only the Better Auth security boundary; it
  does not create or mutate any FPL/competition/provider fact. The accepted pre-cutover Web build
  must pass `db:runtime-contract` with that LOGIN before it can serve maintenance.

If any artifact differs from the latest reviewed commit, stop and repeat the affected rehearsal.

## Redis queue separation procedure

Run with all `CACHE_REDIS_*` and `QUEUE_REDIS_*` values explicit. The cache and queue endpoint
identities must differ. Stop Data workers and confirm no active queue job before this procedure.

1. Run `bun run redis:cutover copy-queues` and save its exact
   `payloadManifestSha256`.
2. Set `V3_REDIS_QUEUE_MANIFEST_SHA256` to that digest and run
   `bun run redis:cutover copy-queues --execute`.
3. Run `bun run redis:cutover verify-queues` with the same manifest digest. It must reproduce the
   exact key count, key manifest, and canonical payload manifest from the queue endpoint.
4. Do not remove the DB0 queue copy until the B1/legacy-drop approval gate. Starting a worker
   before the exact DB1 verification invalidates the copy and requires a new dry-run.

The command is idempotent for identical target keys and fails closed for a conflicting or
unexpected target key. It uses type-aware logical hashes because raw Redis `DUMP` bytes are not a
canonical equality contract for restored hashes.

## Production activation: `0079`-`0090_zzz`

1. Announce and enable maintenance on the accepted pre-cutover Web build.
2. Stop Data API, Data workers, and GraphQL. Pause queues without deleting jobs.
3. Verify:
   - no Data/GraphQL process remains;
   - no active application database session can write business data;
   - queue counts are stable;
   - v2 source counts/hashes equal the pre-cutover snapshot.
4. Run `bun run db:migration-contract` from the one-shot migration container, then set bounded
   PostgreSQL timeouts for that direct Supabase `postgres` session. The migration itself uses
   advisory locking and records each object/season conversion in `ops.migration_objects`.
5. Run Data migration status. Apply exactly `0079` through `0090_zzz` from the release manifest. Save
   stdout/stderr and exit status without connection secrets. Both commands use the isolated
   migration environment; API/worker `DATABASE_URL` is never substituted for it.
6. Re-run Web migration status (the pre-cutover `0008` application must be a no-op), revalidate the
   dedicated LOGIN, and switch from the accepted maintenance build to the candidate Web build
   while keeping maintenance enabled. `db:runtime-contract` and a private auth-session probe must
   pass; an admin URL must exit non-zero.
7. While every Data/GraphQL service remains stopped, use the isolated migration session to create
   the staged Data and GraphQL LOGINs and grant exactly `letletme_data_writer` and
   `letletme_graphql_reader`, respectively. Verify `LOGIN INHERIT NOSUPERUSER NOCREATEDB
   NOCREATEROLE NOREPLICATION NOBYPASSRLS`, exactly one recursive membership, no owner/admin
   membership, and `session_user = current_user`. Then run the Data runtime-role contract and
   GraphQL `contract:check` through their own URLs; each migration/admin URL must fail the
   corresponding runtime contract. Do not start an application or publish cache before this gate.
8. Run exact target schema checks, counts, hashes, constraints, FKs, join-shape, summary, market,
   tournament, provider, grant, and advisor checks.
9. Refresh initial reporting MVs and validate all publication gates.
10. Dry-run `bun run cache:publish-core`, verify its exact run/publication/revision/count contract,
   then execute it with `V3_CORE_CACHE_APPROVAL="APPROVE_V3_CORE_CACHE <CUTOVER_RUN_ID>"` and
   `--execute`, using the candidate Data writer `DATABASE_URL` rather than the migration URL. The
   command rejects admin/migration/GraphQL logins, reads the activated database publication,
   writes only immutable v3 Redis revision keys, atomically activates the pointer, and performs an
   exact read-back. Build the initial live revision only when a current event exists; preseason
   legitimately has none.
11. Start Data API/workers. Validate health, readiness, sync fencing, DB writes, and Redis manifests.
12. Start GraphQL with the read-only role. Validate startup contract and private smoke queries.
13. Run Web private smoke journeys. Disable maintenance only when all pass.
14. Record the v2 freeze timestamp and hashes. v2 objects remain physically present but read/write
    inaccessible to the v3 applications.

## Activation rollback

### Failure before `0090`

- Keep maintenance enabled.
- Stop the migration; preserve logs and partial v3 audit rows.
- Do not mutate v2. Diagnose on a fresh B0 restore and issue a new plan/migration version if needed.
- Restart the recorded v2 Data/GraphQL/Web images only after confirming v2 objects were unchanged.

### Failure after `0090`, before `0091`

- Re-enable maintenance and stop v3 Data/GraphQL.
- Atomically deactivate v3 publications/permissions and restore the frozen v2 writer contract using
  the rehearsed rollback migration/command.
- Deploy the recorded v2 SHAs/images, then resume queues.
- Verify no interval had both v2 and v3 writers.

### Failure after cleanup begins

- Keep maintenance enabled and all writers stopped.
- Verify the encrypted B1 full/legacy-public dump and generated capsule checksums.
- For selective recovery, run the B1 pre capsule with the exact recovery approval and raw
  legacy-public dump SHA-256, restore that dump using
  `pg_restore --clean --if-exists --exit-on-error`, then run the paired post capsule with the same
  approval/hash. The post capsule must pass the public catalog/security and ops-state hashes.
- For full recovery, restore the full B1 custom dump into a clean PG15 database and reconcile all
  public, v3, Auth/Web, ops, sequence, and security manifests before replacing the failed database.
- Do not recreate dropped objects from migration memory or ad hoc SQL.

The recovery capsules are generated before cleanup from the activated B1 database:

```text
psql -v cutover_run_id=<CUTOVER_RUN_ID> -v legacy_dump_sha256=<RAW_SHA256> \
  -v capsule_phase=pre -f sql/v3/generate-postcleanup-rollback.sql
psql -v cutover_run_id=<CUTOVER_RUN_ID> -v legacy_dump_sha256=<RAW_SHA256> \
  -v capsule_phase=post -f sql/v3/generate-postcleanup-rollback.sql
```

Encrypt the generated output immediately. Recovery execution requires exactly:

```text
APPROVE_V3_POSTCLEANUP_ROLLBACK <CUTOVER_RUN_ID>
```

This recovery phrase does not authorize activation or deletion.

## B1 and deletion approval

After v3 activation passes and v2 remains frozen:

1. Take encrypted B1 full and legacy-selective dumps with the same manifest/checksum rules as B0.
   Compute the raw selective-dump SHA-256 and generate/encrypt both post-cleanup rollback capsules
   from this same frozen B1 state.
2. Restore-spot-check representative legacy tables, partitions, views/MVs/functions, ledgers, and
   grants.
3. Generate the exact fully qualified object list for `0091`-`0093`. Compare it to the approved
   manifest and `pg_depend`; any outside dependency blocks cleanup.
4. Present B1 evidence, v3 acceptance report, v2 frozen-hash report, and exact drop list to the user.
5. Cleanup is authorized only by the exact phrase:

```text
APPROVE_V3_LEGACY_DROP <CUTOVER_RUN_ID>
```

Approval for planning, implementation, activation, or a different run ID is not deletion approval.

## Legacy cleanup: `0091`-`0093`

1. Enable maintenance and stop Data/GraphQL.
2. Revalidate B1 checksums/restore spot-check, v3 health, v2 frozen hashes, approval phrase, and run
   ID.
3. Apply exactly:
   - `0091`: approved v2 reporting views/MVs/RPCs;
   - `0092`: approved v2 tables/partitions/triggers/functions;
   - `0093`: compatibility migration ledger/view and obsolete GraphQL migration state.
4. Run exact object inventory. Any unexpected remaining v2 object or missing preserved object fails
   cleanup.
5. Rebuild reporting MVs/publications and run the full schema/data/security smoke suite.
6. Dry-run `bun run redis:cutover cleanup
   --groups=dataCache,dataCoordination,graphqlCache,legacyQueueDb0`, save its exact key manifest,
   and compare the explicit key list with the approved cleanup scope. Execute the same command
   with `--execute` only when `CUTOVER_RUN_ID`, `V3_LEGACY_DROP_APPROVAL`, and
   `V3_REDIS_CLEANUP_MANIFEST_SHA256` exactly match the approved run and dry-run. Record
   matched/unlinked counts, run `verify-queues` again, and verify unrelated/v3 keys are unchanged.
   The command uses bounded `SCAN` plus `UNLINK`; it has no `DEL` or Redis `FLUSH` path.
7. Start Data, then GraphQL, then disable maintenance after private Web smoke tests.

## B2 and 24-hour verification

1. Take encrypted B2 after cleanup and restore-spot-check it. Retain for 90 days.
2. Monitor continuously for the first hour, then at agreed intervals through 24 hours:
   - Data sync freshness and failed/retried jobs;
   - publication revisions, orphan staging generations, and cache memory;
   - GraphQL error rate, missing-relation/permission/mixed-revision errors, p95 latency;
   - PostgreSQL locks, connections, storage growth, slow queries, and advisor findings;
   - selections, player, live, market, tournament, login, binding, and profile journeys.
3. Keep B0 for one year, B1 per the cutover retention record, B2 for 90 days, and Redis RDB for 14
   days. Retention deletion is a separate, explicitly scoped operation.

## Incident rules

- Stop after two to three repetitions of the same failed approach; preserve evidence and reassess.
- Never resolve a permission issue by making GraphQL/Data superuser or adding undocumented
  `SECURITY DEFINER`.
- Never edit an applied migration checksum. Add a new forward migration and update the plan.
- Never repair production data manually without first reproducing the issue on a B0/B1 restore and
  adding a deterministic migration/test.
- Any discovered data loss, mixed grain, orphan, or unexpected dependency is critical until proven
  otherwise.
