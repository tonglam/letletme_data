# P5 Post-Cleanup B1 Restore Rehearsal

Date: 2026-08-09

Run ID: `v3-20260808T160008Z-b9eddc0`

Status: **P5-04 and P5-07 accepted**. This is a disposable local B1-equivalent rehearsal; it does
not satisfy production P7, authorize production activation, or authorize production legacy
deletion.

Evidence root:
`/Users/tong/Documents/LetLetMe Backups/v3-cutover/v3-20260808T160008Z-b9eddc0/p5/postcleanup-b1`

Manifest: `manifests/b1-rehearsal-manifest.json`, SHA-256
`beb2ce3403ece550b80c655751827ebc52b7a040cceb90b3b8220c1ddebbe2be`.
The 81-file evidence checksum inventory is `manifests/evidence-sha256.txt`, SHA-256
`7dcba6c2ce67b795479c9b165eee396bd41224795b363f930480527e52453924`.

## Safety boundary

- Production PostgreSQL, Redis, queues, deployments, and application processes were not changed.
- All destructive SQL was limited to the disposable databases `p5_rehearsal_1_postcleanup` and
  its recovery clones in the retained PostgreSQL 15.8 container.
- The accepted source `p5_rehearsal_1_clean` remained the B1 input; application fixtures were not
  added to it.
- Full and selective dumps and both recovery capsules were streamed directly into AES-256 GPG
  encryption. No plaintext database dump was written. The passphrase came from the accepted
  Keychain service/account and was not printed or passed as a command argument.
- The exact local rehearsal approval was used only against the disposable database. Production
  still requires a fresh production B1 and the user's exact production approval.

## Recovery implementation added

`sql/v3/generate-postcleanup-rollback.sql` generates two dump-bound, run-bound capsules before
cleanup:

1. the **pre** capsule accepts only a completed `0091`, `0092`, or `0093` transaction boundary,
   validates the cleanup ledger/object cardinality for that phase, and restores the exact
   `ops.reject_v2_mutation()` dependency needed by the public dump;
2. `pg_restore --clean --if-exists` restores all legacy public objects and data from the exact B1
   custom dump; and
3. the **post** capsule validates the B1 public catalog/security fingerprint, restores the exact
   pre-cleanup `ops.migration_runs`, `ops.migration_objects`, and `ops.schema_migrations` state,
   then verifies their complete hashes.

Both capsules require:

```text
APPROVE_V3_POSTCLEANUP_ROLLBACK <CUTOVER_RUN_ID>
```

and the exact raw SHA-256 of the paired legacy-public dump. Missing approval, the wrong run, the
wrong dump hash, an unexpected cleanup phase, an unexpected target object, or changed ops state
fails before the corresponding mutation.

The rehearsal exposed and fixed two real recovery gaps:

- PostgreSQL 15 `pg_dump` omitted the source's `PUBLIC USAGE` on the recreated `public` schema
  because it treated that privilege as a default. The post capsule now normalizes all non-owner
  schema grantees and replays the exact captured B1 ACL before its catalog check.
- `validate-p5-quality.sql` previously required the deleted v2 `player_values*` tables. It now
  performs the direct source/target comparison while v2 exists and, after physical cleanup,
  verifies the retained passed reconciliation evidence against the current derived target hash.

The reusable evidence queries also now hash the full public catalog contract and every preserved
relation in `auth`, `bauth`, `drizzle`, `ops`, `storage`, `supabase_functions`,
`supabase_migrations`, and `vault`.

## Encrypted B1-equivalent artifacts

| Artifact | Encrypted bytes | Encrypted SHA-256 | Raw SHA-256 |
| --- | ---: | --- | --- |
| Full custom dump | 101,334,744 | `bd52fd9c4b3c927cd804fea375312409da20954d3c01359bc43031168abcd377` | `0b0be29c5afbdb3b6d002d42ba89c1ddd5f286089ed3448b8d48767c82191f63` |
| Legacy-public custom dump | 50,629,383 | `a9236ee8e14933a2c6bf3002d255ad142c28624649486ba14fa5ecd0406b8f0e` | `a188f2dc43d875936147841482a4ffa96f502a3320ca7189fe363b6c30d94972` |
| Pre capsule | 1,912 | `8ea1780a2576c93fd805a18612b6329a076d8df9b9c7972da5a56e066bd73c2b` | `463210d102ed5cb24c53059a1cdcdf48e92e42123b00d5ed957c45cb54c91bfe` |
| Post capsule | 3,911 | `d3f5e8c0d74b5df60fb3621c7cc53eda8991b9edeed8b26018dfb3019ecb341f` | `31c066613b06d1437e39604ff9615ce61834d9613e215fef4842a3bc27cf6364` |

All four decrypted streams were independently hashed after encryption. Both custom dump catalogs
parsed successfully. The source database was 824,103,727 bytes before cleanup.

## Full restore

The full dump restored with `--exit-on-error` into `p5_b1_full_restore`. This local Supabase image
binds `pg_cron` to the database named `b0_full`, so the checked restore list excludes exactly 19
extension-owned `pg_cron` catalog/data/ACL entries. The complete list diff is retained as
`manifests/full-restore-list.diff`; no application, auth, v3, public, or ops item is excluded.

The accepted full restore produced:

| Comparison to B1 source | Difference |
| --- | ---: |
| Public relation row/hash manifest | 0 bytes |
| Public owner/ACL manifest | 0 bytes |
| Public sequence state | 0 bytes |
| 45 v3 business relation hashes | 0 bytes |
| 55 preserved Auth/Web/ops/system relation hashes | 0 bytes |

The complete P5 quality validator passed with 51 passed reconciliation items, 7,931 players and
player summaries, 4,180 fixtures, 4,560 Understat matches, 129,576 player-match facts, and 1,909
verified bridge links.

## Exact cleanup and post-cleanup state

Before cleanup:

- no approval left all 221 public objects and zero cleanup-ledger rows unchanged;
- a correctly formatted approval for a different run failed inside `0091`, with the same unchanged
  state.

The exact local rehearsal approval then applied only the three allowlisted migrations:

| Migration | Duration |
| --- | ---: |
| `0091_drop_v2_reporting_and_rpcs.sql` | 27.78 ms |
| `0092_drop_v2_tables_partitions_triggers.sql` | 340.47 ms |
| `0093_finalize_v3_migration_ownership.sql` | 13.31 ms |

After cleanup:

- public relations/functions/enums were `0/0/0`;
- the cleanup ledger contained exactly three migrations and eight passed evidence rows;
- `legacyDropPhase=complete`;
- all 45 v3 business relation hashes had a zero-byte difference; and
- the complete post-cleanup P5 quality validator passed with 59 passed evidence rows.

## Selective post-cleanup recovery

`p5_b1_selective_restore` started as an exact clone of the cleaned database.

- missing rollback approval and a wrong dump hash both exited non-zero with zero public objects and
  no recreated fence function;
- the accepted pre capsule recreated the exact fence function/owner/ACL;
- the encrypted legacy-public dump restored with `--exit-on-error --clean --if-exists`;
- a wrong post-capsule dump hash left the three cleanup ledger rows, eight evidence rows, and
  `legacyDropPhase=complete` unchanged; and
- the accepted post capsule passed all public fingerprints, deleted exactly 8/3 cleanup rows, and
  restored the exact B1 migration-run row.

Final selective-restore differences were all zero bytes:

| Comparison to B1 source | Difference |
| --- | ---: |
| Public relation rows/hashes | 0 bytes |
| Public catalog contract | 0 bytes |
| Public owners/ACLs | 0 bytes |
| Public sequence state | 0 bytes |
| v3 business relations | 0 bytes |
| Preserved Auth/Web/ops/system relations | 0 bytes |

The complete quality validator then passed in its pre-cleanup mode with the original 51 passed
evidence rows. Cleanup migration/evidence counts were both zero and `legacyDropPhase` was absent,
exactly matching B1.

## Database-size performance gate

| Measurement | Bytes | Relative to B0 |
| --- | ---: | ---: |
| Accepted B0 full restore | 426,849,071 | baseline |
| Activated B1 source with v2 + v3 | 824,103,727 | +93.08% |
| Post-`0091`-`0093` v3 database | 391,545,347 | **-8.27%** |
| Allowed B0 + 20% ceiling | 512,218,885 | limit |

The cleaned database is 120,673,538 bytes below the ceiling and is smaller than B0. Combined with
the accepted query budgets in `19-p5-rehearsal-run-1.md` and the 177,093,288-byte Redis reduction
in `20-p5-redis-cutover-rehearsal.md`, this closes P5-07.

## Repository and runtime verification

- Data unit suite: 667 passed, 0 failed;
- focused recovery contract suite: 9 passed, 0 failed;
- ESLint: passed;
- TypeScript: passed;
- production build: passed;
- P5 quality validator: passed on full B1, cleaned post-0093, and selectively recovered B1; and
- every full/selective content, security, sequence, catalog, v3, and preserved-schema diff listed
  above is zero bytes.

P5-04 and P5-07 are complete. P5-01, P5-05, and P5-10 remain open for the exact-order second
rehearsal and immutable candidate freeze.
