# B0 Backup and Restore Acceptance

Status: **ACCEPTED**

## Identity

- Cutover run: `v3-20260808T160008Z-b9eddc0`
- Source project: `gtwcfjoviibmtkevurjw`
- Source PostgreSQL: 15.8
- Production baseline commit used to start the run: `b9eddc0`
- Evidence root:
  `/Users/tong/Documents/LetLetMe Backups/v3-cutover/v3-20260808T160008Z-b9eddc0/b0`
- Machine-readable acceptance manifest: `manifests/b0-manifest.json`
- Human-readable acceptance report: `manifests/b0-restore-report.md`
- Evidence checksum ledger: `manifests/evidence-sha256.txt`

The evidence root is intentionally external to Git because it contains encrypted database and
Redis recovery artifacts. No credential or recovery passphrase is committed to this repository.

## Accepted backup set

- PostgreSQL globals/roles dump
- PostgreSQL schema-only dump
- Full PostgreSQL custom-format dump
- Selective Data-owned public-object custom-format dump
- Data, GraphQL, and Supabase-managed migration ledgers
- Complete public object, sequence, enum, function, trigger, policy, grant, FK, and index evidence
- Canonical row hashes for all 198 public table/view/materialized-view objects
- Sequence state for all 22 public sequences
- Redis RDB, server evidence, and type/cardinality/TTL inventory

There are 14 encrypted artifacts. Each encrypted artifact was independently decrypted as a
stream and matched against the raw SHA-256 checksum before plaintext cleanup.

## Restore results

### Full database

- Restore image: `public.ecr.aws/supabase/postgres:15.8.1.069`
- Final restore command used `--exit-on-error --no-owner --jobs=4` and exited 0.
- The accepted run started from a clean database after restore prerequisites were made explicit.
- All-schema and public-schema normalized diffs are 0 bytes.
- Relation hashes, sequence states, ledgers, effective ACLs, and role evidence have 0 differences.

### Selective Data-owned scope

- Final restore exited 0 with no ignored error.
- The standard `public` schema from `template0` was preserved; only the redundant dump TOC entry
  that creates the schema was excluded.
- Relation hashes, sequence states, public schema, ledgers, and ACLs have 0 differences.

### Redis

- RDB integrity check passed.
- The RDB contained 493 keys. Eight had expired before restore, leaving 485 restored keys.
- No unexpected key, type mismatch, or cardinality mismatch was found.
- Type-aware logical hashes matched for all 65 stable Data publication keys.
- Redis `DUMP` byte hashes are not used because hash serialization order is non-canonical across
  RDB reloads.

## Representative data gates

- FPL 2025/26: 20 teams, 38 events, 841 players, 380 fixtures, 0 fixture-team orphans.
- Understat: 4,560 matches, 6,424 player seasons, 129,576 player-match-stat rows.
- Bridge: 1,909 verified entity links and 0 match links.
- Integrity: 606 foreign keys, 0 invalid constraints, 0 invalid indexes.
- Effective non-owner public ACL evidence: 1,571 rows.

## Cleanup and retention

- All 14 raw plaintext backup artifacts were removed after encryption/decryption verification.
- The three temporary decrypted restore inputs were removed.
- They remain recoverable from the encrypted B0 set and checksum ledgers.
- The temporary Redis restore container was removed after reconciliation.
- The PostgreSQL restore container and its `b0_full` and `b0_selective` databases are retained for
  P2 production-B0 migration replay.
- B0 retention is one year; Redis RDB retention is 14 days.
- The recovery passphrase reference is stored in macOS Keychain under the cutover run ID.

P1 is accepted only on the strength of the full and selective restore drills; dump command success
alone was not treated as acceptance.
