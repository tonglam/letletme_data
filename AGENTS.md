# Repository Guidelines

## Project Structure & Module Organization
- Source: `src/` with feature-focused folders: `api/`, `services/`, `jobs/`, `clients/`, `transformers/`, `repositories/`, `cache/`, `db/` (schemas, config), `types/`, `utils/`.
- Tests: `tests/unit/*.test.ts`, `tests/integration/*.test.ts`, fixtures in `tests/fixtures/`.
- Data & migrations: `migrations/`, `sql/`.
- Deploy helper: `scripts/deploy.sh` (Docker compose + migrations). No ad-hoc Bun CLI scripts in-repo.

## Build, Test, and Development Commands
- `bun run dev` — start local server with watch (`src/index.ts`).
- `bun run build` — compile to `dist/` for Bun target.
- `bun start` — run compiled app in production mode.
- `bun test` / `bun run coverage` — run tests / with coverage.
- Lint/format: `bun run lint`, `bun run lint:fix`, `bun run format:fix`.
- Database: `bun run db:migrate`, `bun run db:migrate:status`, `bun run db:studio`.

## Coding Style & Naming Conventions
- Language: TypeScript (ESM). Indent 2 spaces; max line width 100; single quotes; semicolons.
- Tools: ESLint + Prettier enforced; no `any` in source (tests allowed). Run `lint:fix` before PRs.
- Naming: camelCase for vars/functions, PascalCase for types/interfaces/enums, UPPER_SNAKE for constants/env keys. File names use kebab-case with role suffixes (e.g., `player-stats.service.ts`, `events.api.ts`, `events.schema.ts`).
- Data mapping: database fields may be snake_case; convert to camelCase in domain/types (tests assert this).

## Testing Guidelines
- Runner: Bun test (`bun:test`). Place unit tests under `tests/unit/` and integration under `tests/integration/`.
- Naming: `*.test.ts`. Use clear `describe` blocks and deterministic fixtures from `tests/fixtures/`.
- Aim to cover transformers, repositories, and API handlers; prefer fast unit tests, with selective integration tests for DB/cache paths.

## Commit & Pull Request Guidelines
- Commits: short imperative summary (≤72 chars), optional scope (e.g., `db:`, `api:`). Example: `feat(api): add events next endpoint`.
- PRs: include purpose, linked issues, test plan (`bun test` output), and any DB migration notes. Attach sample requests/responses for API changes (e.g., `curl /events/next`). Ensure lint and tests pass.

## Review and Merge Gate
- Keep a PR in draft state until the final intended commit has been pushed. Mark it ready for review only after the head SHA is stable.
- Before requesting review, capture the full current head SHA. Request Codex review with an auditable marker tied to that SHA:
  ```text
  @codex review

  Review gate head: `<full-sha>`
  ```
- After submitting a review request, allow 10–30 minutes for queueing and completion. During that window, poll the request and do not send duplicate `@codex review` comments. Re-request only after an explicit connector/authentication failure, a confirmed timeout with no request in progress, or a changed head SHA.
- By default, do not merge on green CI, review silence, a generic acknowledgement, or a review of an older commit. Require an explicit clean/no-findings result for the unchanged current head, and inspect review threads for unresolved actionable findings. If Tong explicitly instructs in the current task to skip the Codex review gate, that instruction authorizes merging without the clean-review result; record the override in the PR/merge note and keep all other safety checks below.
- Every P1/P2 finding must be fixed or justified with evidence, tested, replied to, and resolved before merge. Any later commit invalidates the prior review; capture the new SHA and request a fresh review.
- Immediately before merge, recheck `headRefOid`, review state, unresolved threads, and required checks. Merge only the unchanged reviewed head, using a head guard such as `gh pr merge <number> --match-head-commit <full-sha>`.
- If the PR is already merged or closed, stop the normal review loop. Treat it as unreviewed if no current-head clean gate exists, and do not report a post-merge audit as approval for the original PR.
- If a qualified human reviewer is available, the GitHub ruleset should require at least one approving review plus required CI checks. If no qualified approver is available, do not configure an impossible approval gate or treat self-approval/Codex `COMMENTED` as approval; keep the approval count at 0 but require the exact-head Codex clean review, required CI, and resolved actionable threads, and record that the merge has no human approval. The exact-head Codex clean review may be omitted only when Tong has explicitly authorized the override above.

## Security & Configuration Tips
- Configure via `.env` (copy from `.env.example`); do not commit secrets. Required: `DATABASE_URL`, `REDIS_*`, `SUPABASE_*`, `PORT`.
- Add schema changes as the next hand-written SQL migration and update the typed Drizzle mapping;
  use `bun run db:migrate` before local runs and `db:studio` to inspect schema.

## Codex-maintained routing

- Data is the canonical producer and sole writer for business data. Keep provider validation -> domain/services -> repositories -> PostgreSQL, and treat Redis publications and BullMQ as derived delivery state.
- Use `$letletme-data-pipeline` for ingestion, scheduler/queue, persistence, migration, or publication work. Use `$letletme-stack-audit` only when the contract crosses Data, GraphQL, Web, Mini, or Ops. The repository-local skill is `.agents/skills/letletme-data-pipeline/SKILL.md`.
- Never repair canonical facts by editing Redis; use bounded, namespace-checked read/cleanup procedures and preserve the last accepted durable state when provider evidence is incomplete.

## Governance and review

- Global routes in `.codex/global-skills.json` are provisioned from immutable `tonglam/codex-workspace-config@7e92336ec04d38f7bb95620e304ce6ec6567c896:registry/workspace-assets.json` into the host Codex mount; use `python3 .codex/provision_global_skills.py --manifest .codex/global-skills.json --registry-source "$CODEX_WORKSPACE_CONFIG_CHECKOUT" --apply` with an authenticated local checkout, or explicitly add `--allow-network` only when approved. Do not vendor or copy unrelated global/plugin skills into this repository.
- Use `$gh-codex-review-loop` for PR work. A review may be skipped only after two consecutive explicit quota-limit responses for the unchanged head; record both responses and the exact SHA. This never waives CI, findings, or cleanup.
- Every P0-P3 finding must be dispositioned and its thread resolved. Only a finding confined to tests/scripts gets the time exception: implement P0/P1, and explain plus resolve P2/P3 without implementation time. P2/P3 anywhere else must be actually fixed and verified.
- Keep a complete finding ledger for the exact head; merge is prohibited while any finding is undispositioned or any review thread is unresolved. A quota override can skip only a new review request and never finding resolution.
- After merge, clean only the exact corresponding worktree, local branch, and remote branch after verifying identity; leave unrelated WIP untouched.
