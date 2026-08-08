# Data Platform v3 Strict Execution Checklist

Plan version: 3.0.0

Rule: an item is complete only when its checkbox is checked and the Evidence column contains a
durable path, SHA, query result, run URL, or backup manifest. Verbal confirmation is not evidence.

## Execution record

| Field | Value |
| --- | --- |
| Run ID | Not assigned until B0 |
| Data baseline | `62f134a` |
| GraphQL baseline | `8cf4ddc` |
| Web baseline | `c290d91` |
| Production project | `gtwcfjoviibmtkevurjw` |
| Plan version | 3.0.0 |
| Cutover approver | User |

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
| [x] | P0-13 | Commit D0 | Clean tree; checks pass; SHA recorded | substantive `7622ce9b318d4b020eaac02abcbf1d86ec56ffd0`; evidence closure `b9eddc0` + follow-up inventory commit |

P0 exit gate: P0-01 through P0-13 complete and no object/reference remains unclassified.

## P1 - B0 backup and restore

| Done | ID | Check | Acceptance | Evidence |
| --- | --- | --- | --- | --- |
| [ ] | P1-01 | Assign and validate run ID | Matches documented format; directory is explicit and new | Run ID/path: |
| [ ] | P1-02 | Record source and tool versions | pg_dump/pg_restore/psql/redis/GPG versions present | Manifest: |
| [ ] | P1-03 | Dump roles/globals | Exit 0; encrypted; checksum verified | File/hash: |
| [ ] | P1-04 | Dump schema-only | Exit 0; encrypted; checksum verified | File/hash: |
| [ ] | P1-05 | Dump full custom-format database | Exit 0; encrypted; checksum verified | File/hash: |
| [ ] | P1-06 | Dump Data-owned objects selectively | Exit 0; encrypted; checksum verified | File/hash: |
| [ ] | P1-07 | Export migration ledgers and object definitions | Exact ledgers/views/functions/grants retained | Files: |
| [ ] | P1-08 | Capture exact row-count/hash baseline | Every manifest source object covered | Report: |
| [ ] | P1-09 | Snapshot Redis and BullMQ inventory | RDB/snapshot evidence plus key/type/TTL/count manifest | Manifest: |
| [ ] | P1-10 | Restore full B0 on PostgreSQL 15 | No ignored errors; server version recorded | Restore log: |
| [ ] | P1-11 | Restore selective B0 on PostgreSQL 15 | No ignored errors | Restore log: |
| [ ] | P1-12 | Reconcile restored full/selective databases | Counts/hashes/FKs/views/grants pass | Report: |
| [ ] | P1-13 | Record retention and recovery owner | B0 one year; Redis RDB 14 days | Manifest: |

P1 exit gate: both restore drills pass. A backup that has not been restored does not satisfy P1.

## P2 - Schema and migration implementation

| Done | ID | Check | Acceptance | Evidence |
| --- | --- | --- | --- | --- |
| [ ] | P2-01 | Create D1 from accepted D0 | Exact predecessor SHA recorded | SHA: |
| [ ] | P2-02 | Implement `0079` ops/roles/schemas | Private schemas and least-privilege roles pass | Migration/test: |
| [ ] | P2-03 | Implement `0080` FPL dimensions | Keys, constraints, FK indexes pass | Migration/test: |
| [ ] | P2-04 | Implement `0081` FPL facts | Grain and numeric/timestamp types pass | Migration/test: |
| [ ] | P2-05 | Implement `0082` competition facts | Season-aware keys and tournament facts pass | Migration/test: |
| [ ] | P2-06 | Implement `0083` Understat/bridge | Provider isolation and verified-link rules pass | Migration/test: |
| [ ] | P2-07 | Implement `0084` reporting | View security and MV unique indexes pass | Migration/test: |
| [ ] | P2-08 | Implement `0085` FPL conversion | Every season/object reconciles | Report: |
| [ ] | P2-09 | Audit PlayerValue reconstructability | Zero mismatches, or execution stops for plan revision | Report: |
| [ ] | P2-10 | Implement `0086` competition conversion | Counts/hashes/business invariants pass | Report: |
| [ ] | P2-11 | Implement `0087` Understat/ops conversion | Counts/hashes/provider boundaries pass | Report: |
| [ ] | P2-12 | Implement `0088` constraint validation | All deferred constraints validated | Query output: |
| [ ] | P2-13 | Implement `0089` publication preparation | Complete inactive initial revision exists | Test: |
| [ ] | P2-14 | Implement `0090` activation/freeze | One active revision; v2 writes denied | Test: |
| [ ] | P2-15 | Implement approval-gated `0091`-`0093` | Exact manifest only; blocked without approval env/token | Tests: |
| [ ] | P2-16 | Fresh migration replay twice on PG15 | Both runs pass; second run is a no-op/status-clean | Logs: |
| [ ] | P2-17 | Production-B0 upgrade replay twice on PG15 | Both runs pass; no manual correction | Logs: |
| [ ] | P2-18 | Run Supabase advisors | No unaccepted v3 security/performance finding | Advisor report: |
| [ ] | P2-19 | Commit D1 | Clean tree; SHA recorded | SHA: |

P2 exit gate: migrations reproduce the target from fresh and B0 schemas and all data gates pass.

## P3 - Data runtime and cache

| Done | ID | Check | Acceptance | Evidence |
| --- | --- | --- | --- | --- |
| [ ] | P3-01 | Create D2 from accepted D1 | Exact predecessor SHA recorded | SHA: |
| [ ] | P3-02 | Replace schema/table definitions | Only target plural schema-qualified objects exported | Tests: |
| [ ] | P3-03 | Replace repositories/services | Explicit season required; no suffix construction | Search/test: |
| [ ] | P3-04 | Replace current-season authority | `fpl.seasons.is_current` is sole authority | Tests: |
| [ ] | P3-05 | Remove physical summary/stat writes | Summary and tournament stats are reporting reads only | Search/test: |
| [ ] | P3-06 | Consolidate ops run/publication writes | Idempotent run/item/publication state | Tests: |
| [ ] | P3-07 | Separate queue and cache Redis clients | Cross-wiring fails configuration/tests | Tests: |
| [ ] | P3-08 | Implement v3 immutable publication | Atomic pointer and TTL behavior pass | Integration tests: |
| [ ] | P3-09 | Remove Data Understat cache | No writer/key/config remains | Search/memory report: |
| [ ] | P3-10 | Remove retired summary/value keys | No writer/key/config remains | Search/test: |
| [ ] | P3-11 | Add scoped Redis cleanup | Only configured v2 namespaces deleted; no FLUSH | Tests: |
| [ ] | P3-12 | Run lint/typecheck/unit/integration/build | All pass | Logs: |
| [ ] | P3-13 | Commit D2 | Clean tree; SHA recorded | SHA: |

## P4 - GraphQL and Web

| Done | ID | Check | Acceptance | Evidence |
| --- | --- | --- | --- | --- |
| [ ] | P4-01 | Create G1 from GraphQL `origin/main` | Existing dirty worktree untouched | Path/SHA: |
| [ ] | P4-02 | Implement direct schema-qualified PG readers | No Supabase business reads | Search/tests: |
| [ ] | P4-03 | Implement read-only role/startup schema check | Missing contract fails closed; no DDL | Tests: |
| [ ] | P4-04 | Remove GraphQL business migration runner/deploy step | Deploy cannot mutate business schema | Workflow test: |
| [ ] | P4-05 | Commit G1 | Clean tree; SHA recorded | SHA: |
| [ ] | P4-06 | Create G2 from accepted G1 | Exact predecessor SHA | SHA: |
| [ ] | P4-07 | Implement reporting readers and v3 query cache | Dataset revision in every key | Tests: |
| [ ] | P4-08 | Remove v2 views/MVs/RPC fallbacks | Zero references | Search/tests: |
| [ ] | P4-09 | Commit G2 | Clean tree; SHA recorded | SHA: |
| [ ] | P4-10 | Create G3 from accepted G2 | Exact predecessor SHA | SHA: |
| [ ] | P4-11 | Implement limited `playerStateProfile` | Indexed PG path; 900/60 TTL | Tests/benchmark: |
| [ ] | P4-12 | Commit G3 | Clean tree; SHA recorded | SHA: |
| [ ] | P4-13 | Create W1 from Web `origin/main` | Existing dirty worktree untouched | Path/SHA: |
| [ ] | P4-14 | Update GraphQL operations/types | Schema validation passes | Tests: |
| [ ] | P4-15 | Implement maintenance UX | All v3-dependent pages fail coherently | E2E: |
| [ ] | P4-16 | Verify Better Auth ownership unchanged | Web-only writes; auth journeys pass | Tests: |
| [ ] | P4-17 | Commit W1 | Clean tree; SHA recorded | SHA: |

## P5 - Rehearsal and quality gates

| Done | ID | Check | Acceptance | Evidence |
| --- | --- | --- | --- | --- |
| [ ] | P5-01 | Rehearsal run 1 | Complete runbook, no undocumented intervention | Run report: |
| [ ] | P5-02 | Rollback before activation | v2 remains unchanged | Report: |
| [ ] | P5-03 | Rollback after activation/pre-cleanup | Old SHAs and v2 writer restore without overlap | Report: |
| [ ] | P5-04 | Simulated post-cleanup B1 restore | Selective/full recovery works | Report: |
| [ ] | P5-05 | Rehearsal run 2 | Same target hashes; timing within budget | Run report: |
| [ ] | P5-06 | Data quality matrix | All critical/high checks pass | Report: |
| [ ] | P5-07 | Performance budgets | Every budget passes or has accepted plan revision | Benchmark: |
| [ ] | P5-08 | Security/grant tests | Least privilege and private schemas pass | Report: |
| [ ] | P5-09 | End-to-end journeys | Selections/player/live/market/tournament/auth pass | Report: |
| [ ] | P5-10 | Freeze candidate SHAs/digests/checksums | External release manifest immutable; no self-reference | Manifest: |

## P6 - Production activation

| Done | ID | Check | Acceptance | Evidence |
| --- | --- | --- | --- | --- |
| [ ] | P6-01 | Confirm B0 and rehearsal gates | Every prior gate green | Approval record: |
| [ ] | P6-02 | Enable maintenance | Web serves maintenance state | Screenshot/check: |
| [ ] | P6-03 | Stop Data/GraphQL writers/readers | No application DB writer session; queues paused | Evidence: |
| [ ] | P6-04 | Apply `0079`-`0090` | Checksums and durations recorded; exit 0 | Migration log: |
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
