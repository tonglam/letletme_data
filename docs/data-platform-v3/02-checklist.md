# Data Platform v3 Strict Execution Checklist

Plan version: 3.2.5

Rule: an item is complete only when its checkbox is checked and the Evidence column contains a
durable path, SHA, query result, run URL, or backup manifest. Verbal confirmation is not evidence.

## Execution record

| Field | Value |
| --- | --- |
| Run ID | `v3-20260808T160008Z-b9eddc0` |
| Data baseline | `62f134a` |
| GraphQL baseline | `3cc9951` (fetched `origin/main`; supersedes planned `8cf4ddc`) |
| Web baseline | `c290d91` |
| Production project | `gtwcfjoviibmtkevurjw` |
| Plan version | 3.2.5 |
| Cutover approver | User |
| Current phase | Plan 3.2.5 fresh PG15 migration gate passed; Run 5 rejected at full-restore identity gate; first clean full B0 replay is Run 6, followed by one identical replay |

## P0 - Freeze and inventory

| Done | ID | Check | Acceptance | Evidence |
| --- | --- | --- | --- | --- |
| [x] | P0-01 | Fetch Data remote and create clean D0 worktree | D0 tracks `origin/main`; original Understat worktree untouched | Data `62f134a`; `/Users/tong/CursorProjects/letletme_data-data-platform-v3` |
| [x] | P0-02 | Record production PostgreSQL baseline | Version, size, timestamp recorded | PG 15.8; 445 MB; captured 2026-08-08 15:27:47 UTC |
| [x] | P0-03 | Record production relation summary | Counts by schema/kind recorded | public: 180 tables, 12 partitioned parents, 22 sequences, 2 MVs, 4 views; 442,368,000 table/view bytes |
| [x] | P0-04 | Record migration tail and ledgers | Data tail and managed duplicate entries identified | Data tail `0078`; live ledger query captured in task output |
| [x] | P0-05 | Save approved plan set | All seven documents exist on D0 | `docs/data-platform-v3/` |
| [x] | P0-06 | Inventory all production relations | Every non-system object classified | `03-object-migration-manifest.md`; 198 table/view/MV objects + 22 sequences + 20 enums; zero unmatched |
| [x] | P0-07 | Inventory functions, triggers, policies, grants, FKs, indexes | No unclassified executable/security object | `06-p0-baseline.md`; 1,571 effective ACL rows; reproducible `sql/v3/p0-object-inventory.sql` |
| [x] | P0-08 | Inventory Data SQL and Redis references | Every reference mapped or retired | `06-p0-baseline.md`; `03-object-migration-manifest.md` |
| [x] | P0-09 | Inventory GraphQL SQL/Data API/RPC/cache references | Every reference mapped or retired | `06-p0-baseline.md`; 123 reads, 5 RPCs classified |
| [x] | P0-10 | Inventory Web DB/cache/GraphQL contracts | Every direct DB use has an owner | `06-p0-baseline.md`; Web auth preserved, Data writes prohibited |
| [x] | P0-11 | Record Redis queue/cache topology, key types, TTLs, memory | Endpoints and namespaces are explicit; secrets excluded | `06-p0-baseline.md`; same endpoint/DB0, 177.35 MB |
| [x] | P0-12 | Add v3 deploy lock | External manifest + exact SHA/digest/token required; automatic v3 deploy blocked | `07-p0-verification.md`; 12/12 gate tests; actionlint/shellcheck pass |
| [x] | P0-13 | Commit D0 | Clean tree; checks pass; SHA recorded | substantive `7622ce9b318d4b020eaac02abcbf1d86ec56ffd0`; evidence closure `b9eddc0`; complete inventory `2844b83f1d57896cf6cdce324a9b189a4f8a3be6` |

P0 exit gate: P0-01 through P0-13 complete and no object/reference remains unclassified.

## P1 - B0 backup and restore

| Done | ID | Check | Acceptance | Evidence |
| --- | --- | --- | --- | --- |
| [x] | P1-01 | Assign and validate run ID | Matches documented format; directory is explicit and new | `v3-20260808T160008Z-b9eddc0`; `08-b0-backup-restore.md` |
| [x] | P1-02 | Record source and tool versions | pg_dump/pg_restore/psql/redis/GPG versions present | External `b0/manifests/b0-manifest.json` |
| [x] | P1-03 | Dump roles/globals | Exit 0; encrypted; checksum verified | `globals.sql.gpg`; manifest decryption verification `true` |
| [x] | P1-04 | Dump schema-only | Exit 0; encrypted; checksum verified | `schema.sql.gpg`; manifest decryption verification `true` |
| [x] | P1-05 | Dump full custom-format database | Exit 0; encrypted; checksum verified | `full.dump.gpg`; catalog parsed; manifest decryption verification `true` |
| [x] | P1-06 | Dump Data-owned objects selectively | Exit 0; encrypted; checksum verified | `data-public.dump.gpg`; catalog parsed; manifest decryption verification `true` |
| [x] | P1-07 | Export migration ledgers and object definitions | Exact ledgers/views/functions/grants retained | 75 Data + 3 GraphQL + 17 managed ledger rows; complete object inventory encrypted |
| [x] | P1-08 | Capture exact row-count/hash baseline | Every manifest source object covered | 198 canonical relation hashes + 22 sequence states; `08-b0-backup-restore.md` |
| [x] | P1-09 | Snapshot Redis and BullMQ inventory | RDB/snapshot evidence plus key/type/TTL/count manifest | RDB 493 keys; 14 encrypted artifacts; canonical reconciliation accepted |
| [x] | P1-10 | Restore full B0 on PostgreSQL 15 | No ignored errors; server version recorded | Final PG 15.8 restore exit 0; external `b0/logs/full-restore.log` |
| [x] | P1-11 | Restore selective B0 on PostgreSQL 15 | No ignored errors | Final restore exit 0; external `b0/logs/selective-restore.log` |
| [x] | P1-12 | Reconcile restored full/selective databases | Counts/hashes/FKs/views/grants pass | External `b0/manifests/b0-restore-report.md`; every accepted diff 0 |
| [x] | P1-13 | Record retention and recovery owner | B0 one year; Redis RDB 14 days | External manifest; recovery owner Tong; Keychain passphrase reference |

P1 exit gate: both restore drills pass. A backup that has not been restored does not satisfy P1.

## P2 - Schema and migration implementation

| Done | ID | Check | Acceptance | Evidence |
| --- | --- | --- | --- | --- |
| [x] | P2-01 | Create D1 from accepted D0 | Exact predecessor SHA recorded | D0 predecessor `6f66095b162160c1c0b55076b6960f92d7754881`; isolated schema worktree |
| [x] | P2-02 | Implement `0079` ops/roles/schemas | Private schemas and least-privilege roles pass | `0079`; `10-p2-implementation-and-acceptance.md` |
| [x] | P2-03 | Implement `0080` FPL dimensions | Keys, constraints, FK indexes pass | `0080`; accepted fresh/B0 replay report |
| [x] | P2-04 | Implement `0081` FPL facts | Grain and numeric/timestamp types pass | `0081`; 51/51 B0 audit checks |
| [x] | P2-05 | Implement `0082` competition facts | Season-aware keys and tournament facts pass | `0082`; accepted B0 hashes |
| [x] | P2-06 | Implement `0083` Understat/bridge | Provider isolation and verified-link rules pass | `0083`; 4,560/129,576/1,909 reconciled rows |
| [x] | P2-07 | Implement `0084` reporting | View security and MV unique indexes pass | `0084`; 3/3 secure views; 2/2 populated/indexed MVs |
| [x] | P2-08 | Implement `0085` FPL conversion | Every season/object reconciles | P2 report; final B0 hash diffs 0 bytes |
| [x] | P2-09 | Audit PlayerValue reconstructability | Zero mismatches, or execution stops for plan revision | `09-p2-source-contract-audit.md`; P2 report |
| [x] | P2-10 | Implement `0086` competition conversion | Counts/hashes/business invariants pass | P2 report; `ops.migration_objects` passed |
| [x] | P2-11 | Implement `0087` Understat/ops conversion | Counts/hashes/provider boundaries pass | P2 report; `ops.migration_objects` passed |
| [x] | P2-12 | Implement `0088` constraint validation | All deferred constraints validated | 125 FKs; missing indexes 0; unvalidated 0 |
| [x] | P2-13 | Implement `0089` publication preparation | Complete inactive initial revision exists | Fresh/B0 replay and publication contract passed |
| [x] | P2-14 | Implement `0090` activation/freeze and final reader contracts | One active revision; v2 writes denied; publication authority and public-league catalog have one Data owner and read-only GraphQL access | Validation: 192 frozen relations/fences; 1 active publication; ACL correction `175ac00`; public-league contract `e91a355c9d2253c2ebff07256c3793a57c7f49b9` |
| [x] | P2-15 | Implement approval-gated `0091`-`0093` | Exact manifest only; blocked without approval env/token | Cleanup rehearsal report; v3 hash diff 0 bytes |
| [x] | P2-16 | Fresh migration replay twice on PG15 | Both runs pass; second run is a no-op/status-clean | Plan 3.2.5 independent PG 15.8 target `p2_fresh_325_final`; external `p5/plan-3.2.5-correction/fresh-pg15-final/` (48/48 audit checks; second SQL pass skipped every migration; status clean) |
| [ ] | P2-17 | Production-B0 upgrade replay twice on PG15 | Both runs pass; no manual correction | 3.2.4 evidence retained at external `p2/logs/p2-b0-final-5-*`; 3.2.5 replay pending |
| [x] | P2-18 | Run Supabase advisors | No unaccepted v3 security/performance finding | `10-p2-implementation-and-acceptance.md`; local v3 lint 0 |
| [x] | P2-19 | Commit D1 | Clean tree; SHA recorded | Substantive D1 `aad7225654d2cacf353bb00e441804cf2bc2dce3` |
| [ ] | P2-20 | Enforce publication identity/plan contract | Every publication ID is an RFC UUID; every v3 manifest is plan 3.2.5; sync-run references survive normalization | `0090_zzz_enforce_v3_publication_identity.sql`; 3.2.5 replay pending |
| [ ] | P2-21 | Replay publication correction on fresh and B0 PG15 twice | Both paths pass; second runs are no-op/status-clean; legacy cleanup remains gated | 3.2.4 evidence retained; 3.2.5 replay pending |
| [ ] | P2-22 | Enforce core-cache cutover preflight privilege | Writer reads exactly `migration_runs(run_id,status,metadata)`; no broad/provenance/write privilege | Source validators added after `24-p5-rehearsal-run-4-rejected.md`; PG15 positive/negative replay pending |
| [ ] | P2-23 | Enforce Data reporting operational privilege | Writer reads/refreshes only two tournament MVs; ordinary views, DML, and schema CREATE denied | Focused rejected-run probe identified missing schema usage; corrected migrations/validators pending clean replay |

P2 exit gate: P2-01 through P2-23 complete; migrations reproduce the target from fresh and B0
schemas and all data gates pass.

## P3 - Data runtime and cache

| Done | ID | Check | Acceptance | Evidence |
| --- | --- | --- | --- | --- |
| [x] | P3-01 | Create D2 from accepted D1 | Exact predecessor SHA recorded | `e81696dddda7ff51b1c735e8e0d612cc5294ade7` |
| [x] | P3-02 | Replace schema/table definitions | Only target plural schema-qualified objects exported | PG15 export/catalog parity, 13 assertions |
| [x] | P3-03 | Replace repositories/services | Explicit season required; no suffix construction | Residual scan + 664 unit tests + 26-table PG15 persistence contract |
| [x] | P3-04 | Replace current-season authority | `fpl.seasons.is_current` is sole authority | DB trust-boundary + season unit tests |
| [x] | P3-05 | Remove physical reporting writes | Player summaries and tournament selection stats are reporting reads only | Reporting relation/physical-copy assertions |
| [x] | P3-06 | Consolidate ops run/publication writes | Idempotent run/item/publication state | `sync-operations`: 5/5 |
| [x] | P3-07 | Separate queue and cache Redis clients | Cross-wiring fails configuration/tests | Unit + Redis integration separation |
| [x] | P3-08 | Implement v3 immutable publication | Atomic pointer and TTL behavior pass | `data-publication`: 8/8 |
| [x] | P3-09 | Remove Data Understat cache | No writer/key/config remains | Source/config scan; cleanup allowlist only |
| [x] | P3-10 | Remove retired summary/value keys | No writer/key/config remains | Source scan + publication contract tests |
| [x] | P3-11 | Add scoped Redis cleanup | Only configured v2 namespaces deleted; no FLUSH | `6fc38cc`; formal manifest-gated queue copy/verify and `SCAN` + `UNLINK`; `20-p5-redis-cutover-rehearsal.md` |
| [x] | P3-12 | Run lint/typecheck/unit/integration/build | All pass | Plan-3.2.5: 680 unit + 31 integration pass, 0 fail; lint/typecheck/build/format pass; external `p5/plan-3.2.5-correction/` |
| [x] | P3-13 | Commit D2 | Clean tree; SHA recorded | Substantive SHA: `51201b40ec3187ad38a18171a7267836326a6fec` |
| [x] | P3-14 | Advance immutable publication contract to plan 3.2.5 | Data rejects stale plans; corrected writer dry-run and execute/readback pass | Rejected-run focused probe: exact 38/20/573/11/380; seven keys; six-item 3.2.5 manifest; current event null |
| [x] | P3-15 | Run Data with exact reporting capability | Tournament refresh/readback succeeds; no access to ordinary views | Real writer refreshed/read both MVs; ordinary-view SELECT, MV DML, schema DDL all denied; trust-boundary 5/5 |

## P4 - GraphQL and Web

| Done | ID | Check | Acceptance | Evidence |
| --- | --- | --- | --- | --- |
| [x] | P4-01 | Create G1 from GraphQL `origin/main` | Existing dirty worktree untouched | `/Users/tong/CursorProjects/letletme-graphql-data-platform-v3-pg-readers`; baseline `3cc9951450ac5c631ea8930b0eb8c7a71a572fb6` |
| [x] | P4-02 | Implement direct schema-qualified PG readers | No Supabase business reads | `13-p4-g1-acceptance.md`; 348 tests; B0 HTTP smoke |
| [x] | P4-03 | Implement read-only role/startup schema check | Missing contract fails closed; no DDL | 17 focused cases; fresh/B0 PG15 contract checks |
| [x] | P4-04 | Remove GraphQL business migration runner/deploy step | Deploy cannot mutate business schema | CI/deploy boundary scan; no migration directory/command |
| [x] | P4-05 | Commit G1 | Clean tree; SHA recorded | `886351b1c26d86f5e8010cb57e8d5f33469423c8` |
| [x] | P4-06 | Create G2 from accepted G1 | Exact predecessor SHA | `/Users/tong/CursorProjects/letletme-graphql-data-platform-v3-reporting-cache`; predecessor `886351b1c26d86f5e8010cb57e8d5f33469423c8` |
| [x] | P4-07 | Implement reporting readers and v3 query cache | Dataset revision in every key; plan 3.2.5 authority required | Plan-3.2.5 GraphQL suite 312 pass/0 fail; lint/format/typecheck pass |
| [x] | P4-08 | Remove v2 views/MVs/RPC fallbacks | Zero references | Exact runtime scans; only G3-owned history-parent paths remain |
| [x] | P4-09 | Commit G2 | Clean tree; SHA recorded | `e2612ad2db91db5a9841ed03812403e0082a4906` |
| [x] | P4-10 | Create G3 from accepted G2 | Exact predecessor SHA | `/Users/tong/CursorProjects/letletme-graphql-data-platform-v3-player-state`; predecessor `e2612ad2db91db5a9841ed03812403e0082a4906` |
| [x] | P4-11 | Implement limited `playerStateProfile` | Indexed PG path; 900/60 TTL | `15-p4-g3-acceptance.md`; 311 tests + 4 B0; p95 61.028/0.039 ms |
| [x] | P4-12 | Commit G3 | Clean tree; SHA recorded | `3b426383a13ddc4b2d1d22452216bfe77826e420` |
| [x] | P4-13 | Create W1 from Web `origin/main` | Existing dirty worktree untouched | `/Users/tong/CursorProjects/letletme-web-data-platform-v3-contract`; baseline `c290d912dfc3756237d65794c47e78f2193771e8` |
| [x] | P4-14 | Update GraphQL operations/types | Schema validation passes | `16-p4-w1-acceptance.md`; 32/32 operations; one root and <200 AST nodes |
| [x] | P4-15 | Implement maintenance UX | All v3-dependent pages fail coherently | `16-p4-w1-acceptance.md`; true 503; English/Chinese desktop/mobile; Data API and Auth boundaries pass |
| [x] | P4-16 | Verify Better Auth ownership unchanged | Web-only writes; auth journeys pass | `16-p4-w1-acceptance.md`; direct `.from(` count 13 -> 13; owned paths unchanged; unit/E2E pass |
| [x] | P4-17 | Commit W1 | Clean tree; SHA recorded | `7c7a2bcf4d355f0539f4e0ea7679d78d8253beb2` |
| [x] | P4-18 | Advance GraphQL startup/cache contract to plan 3.2.5 | Stale DB/Redis plans fail closed; exact 3.2.5 candidate passes | Unit stale-plan negative passes; real `p5_graphql_run4` contract reports 3.2.5; postgres admin exits 1 |

## P5 - Rehearsal and quality gates

| Done | ID | Check | Acceptance | Evidence |
| --- | --- | --- | --- | --- |
| [ ] | P5-01 | Rehearsal run 1 | Complete runbook, no undocumented intervention | `19-p5-rehearsal-run-1.md`; rejected runs `22`, `23`, `24`, `25`; first clean plan-3.2.5 replay required |
| [x] | P5-02 | Rollback before activation | v2 remains unchanged | `17-p5-rollback-drills.md`; full public data/sequence/security diffs 0 bytes; old Data SHA status and readiness pass |
| [x] | P5-03 | Rollback after activation/pre-cleanup | Old SHAs and v2 writer restore without overlap | `17-p5-rollback-drills.md`; full B0 public/sequence/security/bauth diffs 0 bytes; old Data/GraphQL/Web stack all probes 200 |
| [x] | P5-04 | Simulated post-cleanup B1 restore | Selective/full recovery works | `21-p5-postcleanup-b1-restore.md`; external `p5/postcleanup-b1/manifests/b1-rehearsal-manifest.json` SHA-256 `beb2ce3403ece550b80c655751827ebc52b7a040cceb90b3b8220c1ddebbe2be`; all full/selective data/security/ops diffs 0 |
| [ ] | P5-05 | Rehearsal run 2 | Same target hashes; timing within budget | Rejected reports `22`-`25`; two clean plan-3.2.5 replays required |
| [x] | P5-06 | Data quality matrix | All critical/high checks pass | `19-p5-rehearsal-run-1.md`; 51 passed, 0 failed; B0/v3 hash diffs 0 |
| [x] | P5-07 | Performance budgets | Every budget passes or has accepted plan revision | `19-p5-rehearsal-run-1.md`; `20-p5-redis-cutover-rehearsal.md`; `21-p5-postcleanup-b1-restore.md`; cleaned DB 391,545,347 bytes vs 512,218,885-byte ceiling |
| [ ] | P5-08 | Security/grant tests | Least privilege and private schemas pass | Focused real-writer grants pass exact positive/negative matrix and GraphQL 3.2.5 role gate; clean migration replay still required |
| [ ] | P5-09 | End-to-end journeys | Selections/player/live/market/tournament/auth pass | Run 4 stopped before service start/cache publication; all journeys must repeat after a clean activation using the corrected dedicated Data writer |
| [ ] | P5-10 | Freeze candidate SHAs/digests/checksums | External release manifest immutable; no self-reference | Manifest: |

## P6 - Production activation

| Done | ID | Check | Acceptance | Evidence |
| --- | --- | --- | --- | --- |
| [ ] | P6-01 | Confirm B0, rehearsal, role, and platform gates | Every prior gate green; PG patch warning resolved/accepted; runtime logins are not the migration login | Approval record: |
| [ ] | P6-02 | Enable maintenance | Web serves maintenance state | Screenshot/check: |
| [ ] | P6-03 | Stop Data/GraphQL writers/readers | No application DB writer session; queues paused | Evidence: |
| [ ] | P6-04 | Apply `0079`-`0090_zzz` | Checksums and durations recorded; exit 0 | Migration log: |
| [ ] | P6-05 | Run production data gates | All critical/high gates pass | Report: |
| [ ] | P6-06 | Build/validate first v3 Redis revision | One coherent active manifest | Report: |
| [ ] | P6-07 | Start Data then GraphQL | Health/readiness pass | Deployment runs: |
| [ ] | P6-08 | Run private smoke tests | All representative queries pass | Report: |
| [ ] | P6-09 | Disable maintenance | Public journeys healthy | Report: |
| [ ] | P6-10 | Verify v2 freeze | Counts/hashes unchanged; writes denied | Report: |

## P7 - B1 and cleanup approval gate

| Done | ID | Check | Acceptance | Evidence |
| --- | --- | --- | --- | --- |
| [ ] | P7-01 | Take encrypted B1 full/selective backup | Checksums and manifests pass | Manifest: |
| [ ] | P7-02 | Restore-spot-check B1 | Selected objects/rows/functions restore | Report: |
| [ ] | P7-03 | Present exact drop manifest | No wildcard or unrelated object | Manifest: |
| [ ] | P7-04 | Capture explicit approval | Exact phrase and run ID match runbook | Approval: |
| [ ] | P7-05 | Apply `0091`-`0093` | Exit 0; exact approved object set | Log: |
| [ ] | P7-06 | Remove scoped v2 Redis keys | Count/types captured; no other namespace changed | Report: |
| [ ] | P7-07 | Re-run complete schema/data/security checks | All pass | Report: |

## P8 - Final verification

| Done | ID | Check | Acceptance | Evidence |
| --- | --- | --- | --- | --- |
| [ ] | P8-01 | Take encrypted B2 | Restore spot-check; 90-day retention | Manifest: |
| [ ] | P8-02 | Monitor first hour | No critical/high alert | Dashboard/log: |
| [ ] | P8-03 | Monitor 24 hours | Freshness, errors, cache, DB, journeys pass | Report: |
| [ ] | P8-04 | Run final advisors and object inventory | No v2 residue/unaccepted finding | Report: |
| [ ] | P8-05 | Close execution | Every checklist item complete or explicitly superseded by a versioned plan | Final report: |
