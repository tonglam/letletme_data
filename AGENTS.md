# Repository Instructions

## Repository profile

- `letletme_data` is the producer and sole writer for LetLetMe business data. It is a Bun/TypeScript ESM service using Elysia for its internal API, BullMQ for delivery, PostgreSQL for durable state, Drizzle as a typed schema mapping, Zod at input/config boundaries, and Redis for rebuildable publications and coordination.
- Preserve the layer flow: provider clients and boundary validation -> transformers/domain -> services -> repositories -> PostgreSQL; scheduler/jobs -> queues -> workers execute the same services. Keep route handlers and job definitions thin. `src/cache` may publish read models but must not become canonical storage.
- The production image has seven entrypoints: API, general worker, standalone scheduler, live-picks worker, official-H2H worker, content worker, and media worker. Starting only the API can enqueue work but cannot prove completion.
- Data owns the `fpl`, `competition`, `understat`, `bridge`, `reporting`, and `ops` schemas, `llm:data:*` publications, BullMQ namespaces, and bounded coordination state. GraphQL owns public read shaping and `llm:gql:*`; Web owns identity and `bauth`; clients must not bypass those boundaries.

## Authority and invariants

- PostgreSQL is canonical. Exactly one `fpl.seasons.is_current = true` row selects the current season; Redis, wall-clock inference, logs, and worker liveness are not authorities. Provider or validation failure must preserve the last accepted durable state.
- `ops.scheduler_obligations` and scheduler lanes are schedule truth; BullMQ is delivery and retained history. Prove completion with the required durable checkpoint/publication and consumer evidence, not enqueue success, an empty queue, or a heartbeat alone.
- Keep cache and queue Redis endpoints distinct. Consume a publication as one verified revision: validate manifest fields, scope, item set, Redis types, counts, bytes, and hashes, then use all siblings from that revision or one coherent PostgreSQL fallback.
- Never repair canonical facts by editing Redis. Redis cleanup must be exact and bounded with validated `SCAN`/`UNLINK`; never use `KEYS`, `FLUSHDB`, `FLUSHALL`, or delete GraphQL-owned keys.
- Add schema changes through the next hand-written SQL migration and update the typed Drizzle mapping. The complete migration filename is immutable ledger identity: never rename, rewrite, squash, reuse, or delete an applied migration. Verify with `bun run db:migrate:status` and `bun run db:migration-contract`.

## Work and validation

- Inspect `git status --short --branch` and occupied worktrees before editing. Preserve unrelated dirty/untracked work and do not infer branch identity from a directory name.
- Use the Bun version pinned by `packageManager`/CI and the checked-in `bun.lock`; install with `bun install --frozen-lockfile`. Compare `bun --version` before broad gates and classify version drift instead of dismissing a failure. Read `package.json` before choosing a command.
- For unit coverage use `bun run test` or a targeted `bun test tests/unit/<file>.test.ts`; do not run bare `bun test`, which discovers guarded integration files. Normal code gates are the narrow test, `bun run typecheck`, `bun run lint`, and when relevant `bun run format:check`, `bun run docs:contract`, and `bun run build`.
- Integration tests require the repository guard, `RUN_INTEGRATION=1`, an isolated PostgreSQL test database, and distinct non-zero cache/queue Redis DBs. Never point tests, migrations, queue probes, publication scripts, or repairs at production-like targets.
- Use `$letletme-data-pipeline` for ingestion, scheduler/queue, persistence, migration, or publication work. Use `$letletme-stack-audit` when a symptom or contract crosses into GraphQL/Web/Mini/Ops, and `$letletme-release-acceptance` for an authorized end-to-end release.
- Use `scripts/deploy.sh` for an authorized deployment. Process health is not acceptance: bind the immutable image/SHA, verify migration and queue gates, `/ready`, publication identity, and at least one representative consumer path.
- Keep secrets in local environment files. Never print credentials, tokens, raw user identifiers, private payloads, or production connection strings.

## Governance and review

- Global routes in `.codex/global-skills.json` are provisioned from immutable `tonglam/codex-workspace-config@7e92336ec04d38f7bb95620e304ce6ec6567c896:registry/workspace-assets.json` with its recorded SHA-256 content digest into the host Codex mount. Provision that source before invoking a route; if provisioning or the mount is unavailable, stop and report the missing dependency rather than silently substituting it.
- Use `$gh-codex-review-loop` for PR work. A review may be skipped only after two consecutive explicit quota-limit responses for the unchanged head; record both responses and the exact SHA. This never waives CI, findings, or cleanup.
- Every P0-P3 finding must be dispositioned and its thread resolved. Only a finding confined to tests/scripts gets the time exception: implement P0/P1, and explain plus resolve P2/P3 without implementation time. P2/P3 anywhere else must be actually fixed and verified.
- Keep a complete finding ledger for the exact head; merge is prohibited while any finding is undispositioned or any review thread is unresolved. A quota override can skip only a new review request and never finding resolution.
- After merge, clean only the exact corresponding worktree, local branch, and remote branch after verifying identity; leave unrelated WIP untouched.
